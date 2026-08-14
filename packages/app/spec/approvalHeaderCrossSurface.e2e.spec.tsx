import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import type { PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import { ApprovalPrompt } from '#src/tui/components/ApprovalPrompt.js';

/**
 * [[TUI-C67]] — **do the two approval surfaces announce one call the same way?**
 *
 * The node's acceptance is not "each surface says something sensible", it is *both surfaces render
 * the same wording*. Two specs asserting two literals cannot show that: they pass just as happily
 * when the surfaces have drifted apart, since each is only ever compared against its own copy of
 * the sentence. So every case here renders **both** surfaces for the **same** pending call and
 * asserts they are equal to each other **and** to the ruled string — the second half because two
 * surfaces that agree on the wrong sentence still agree.
 *
 * This lives in the app package because it is the only one that can reach both: the Ink prompt is
 * `packages/app`, the readline prompt is `packages/agent`, and `packages/app` depends on it.
 * `colourCrossSurface.e2e.spec.ts` is the same shape for the same reason.
 *
 * **Each surface keeps its own chrome, and that is what the normalisation below is for.** The
 * readline prompt opens with a blank line and closes the sentence with a colon before the framed
 * command; the Ink prompt draws a rule above it and paints it bold. Neither is the *wording*, so
 * both are stripped before the comparison — and only those two, spelled out one at a time, so a
 * normaliser cannot quietly absorb a real difference.
 */

// ── the readline surface's environment ────────────────────────────────────────
// The mock set of `packages/agent/spec/interactiveSessionApprovalFraming.spec.ts`, by the bare
// specifiers the built agent module imports — so the mocks bind to the same resolved files whether
// the importer is this spec or the agent's own dist.
const rlQuestionMock = vi.fn(async (prompt: string) => {
  if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
  return '';
});
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  error: vi.fn(),
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  getUseColour: vi.fn(() => false),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true, columns: 100 },
}));

const displayMock = vi.fn();
const displayInfoMock = vi.fn();
const displayWarningMock = vi.fn();
const displayErrorMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: displayMock,
  displayError: displayErrorMock,
  displayInfo: displayInfoMock,
  displayLaunchBanner: vi.fn(),
  displayWarning: displayWarningMock,
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: vi.fn().mockResolvedValue({ streamSessionInferenceLog: false }),
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

let capturedApprovalCallback:
  ((_pending: PendingToolInterrupt) => Promise<{ type: string }>) | undefined;
const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: vi.fn().mockResolvedValue(undefined),
  setToolApprovalCallback: vi.fn((cb) => {
    capturedApprovalCallback = cb;
  }),
  cleanup: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({ createResolvers: vi.fn() }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

/**
 * The readline prompt's opening sentence for one pending call, with this surface's own chrome
 * removed: the leading blank line it separates the prompt with, and the single trailing colon that
 * introduces the framed command beneath it. Both are asserted to have been there before they are
 * taken off, so the normalisation cannot hide the surface having stopped emitting them.
 */
async function readlineHeader(pending: PendingToolInterrupt): Promise<string> {
  const { createInteractiveSession } =
    await import('@gaunt-sloth/agent/modules/interactiveSessionModule.js');
  await createInteractiveSession(sessionConfig, {});
  expect(capturedApprovalCallback).toBeTypeOf('function');
  displayWarningMock.mockClear();
  rlQuestionMock.mockResolvedValueOnce('n');
  await capturedApprovalCallback!(pending);
  const raw = String(displayWarningMock.mock.calls[0]?.[0]);
  expect(raw.startsWith('\n')).toBe(true);
  const line = raw.slice(1);
  expect(line.endsWith(':')).toBe(true);
  return line.slice(0, -1);
}

/**
 * The Ink prompt's opening sentence: the row directly under the dialog's rule, ANSI stripped.
 *
 * Taken by position rather than by searching for the expected text — a search would find the
 * sentence anywhere on the dialog and would pass if the header row had been dropped while some
 * other line happened to carry the words.
 */
function tuiHeader(pending: PendingToolInterrupt): string {
  const { lastFrame, unmount } = render(<ApprovalPrompt pending={pending} />);
  const rows = stripAnsi(lastFrame() ?? '')
    .split('\n')
    .map((row) => row.replace(/\s+$/u, ''));
  unmount();
  return rows[1] ?? '';
}

/** The three ruled sentences, typed out here rather than rebuilt from the renderer's own parts. */
const CASES: ReadonlyArray<{ kind: string; pending: PendingToolInterrupt; header: string }> = [
  {
    kind: 'shell',
    pending: {
      name: 'run_shell_command',
      args: { command: 'npm test' },
      subject: { kind: 'shell', command: 'npm test' },
    },
    header: 'The agent wants to run a shell command via run_shell_command',
  },
  {
    kind: 'mcpTool',
    pending: {
      name: 'mcp__jira__create_issue',
      args: { summary: 'ship it' },
      subject: { kind: 'mcpTool', server: 'jira', name: 'create_issue' },
    },
    header:
      'The agent wants to call create_issue on the MCP server jira, via mcp__jira__create_issue',
  },
  {
    kind: 'tool',
    pending: {
      name: 'write_file',
      args: { file_path: 'src/a.ts' },
      subject: { kind: 'tool', name: 'write_file' },
    },
    header: 'The agent wants to use the write_file tool',
  },
];

describe('the approval prompt header is the same on both surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedApprovalCallback = undefined;
    rlQuestionMock.mockImplementation(async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
      return '';
    });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue(undefined);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    runnerInstanceMock.setToolApprovalCallback.mockImplementation((cb) => {
      capturedApprovalCallback = cb;
    });
  });

  for (const { kind, pending, header } of CASES) {
    it(`renders one sentence for a ${kind} subject on the Ink prompt and the readline prompt`, async () => {
      const ink = tuiHeader(pending);
      const readline = await readlineHeader(pending);
      expect(ink).toBe(readline);
      expect(ink).toBe(header);
    });
  }

  /**
   * The floor case, held to the same standard. A pending with no subject renders the generic tool
   * sentence — true of any gated call and false of none — and the two surfaces must not be free to
   * fall back differently, which is exactly what would happen if either kept a literal of its own.
   */
  it('agrees on the fallback sentence when no subject travelled with the call', async () => {
    const pending: PendingToolInterrupt = {
      name: 'gth_web_fetch',
      args: { url: 'https://example.test/' },
    };
    const ink = tuiHeader(pending);
    const readline = await readlineHeader(pending);
    expect(ink).toBe(readline);
    expect(ink).toBe('The agent wants to use the gth_web_fetch tool');
  });

  /**
   * The regression this node exists to close, stated as its own case: a gated call that is not a
   * shell command must not be announced as one, on either surface.
   */
  it('never calls a non-shell call a shell command', async () => {
    for (const { pending } of CASES.filter((c) => c.kind !== 'shell')) {
      expect(tuiHeader(pending)).not.toContain('shell command');
      expect(await readlineHeader(pending)).not.toContain('shell command');
    }
  });
});
