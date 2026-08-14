import { afterAll, afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { PendingToolInterrupt, StatusUpdateCallback } from '#src/core/types.js';
import { approvalPromptHeader } from '#src/core/approvals/promptHeader.js';
import { UNRESOLVED_MCP_SERVER } from '#src/core/approvals/mcpSubjects.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';

/**
 * [[TUI-C67]] — **the sentence an approval prompt opens with, and the field it is rendered from.**
 *
 * Two questions live here, and they are not the same one:
 *
 * 1. **Does each subject kind get the sentence that is true of it?** The three headers are fixed
 *    (ruled 2026-08-14), so they are asserted as literals typed out here rather than derived from
 *    the renderer — an assertion that rebuilt the expected string from the same parts the renderer
 *    uses would pass for any wording, including the false one this node replaced.
 * 2. **Does the runner actually attach the subject?** The renderer's `tool` arm is its floor for a
 *    call with no subject, and that floor is true of every gated call — which is exactly what makes
 *    it able to hide a regression. If the runner stopped attaching `subject`, every prompt would
 *    quietly fall back to *use the `<tool>` tool* and no assertion on the renderer alone would
 *    notice. So the last block drives the real gate and asserts the field arrives.
 *
 * The cross-surface half — that the Ink prompt and the readline prompt render *the same* sentence
 * for the same call — is `packages/app/spec/approvalHeaderCrossSurface.e2e.spec.tsx`, since only
 * the app package can reach both surfaces.
 */

const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  cleanup: vi.fn(),
};

vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class MockGthLangChainAgent {
    constructor() {
      return mockAgent;
    }
  },
  StatusUpdateCallback: vi.fn(),
}));

describe('approvalPromptHeader — one sentence per subject kind', () => {
  it('announces a shell call as a shell command, unchanged', () => {
    expect(
      approvalPromptHeader({
        name: 'run_shell_command',
        subject: { kind: 'shell', command: 'npm test' },
      })
    ).toBe('The agent wants to run a shell command via run_shell_command');
  });

  /**
   * Naming the server is the deliberate addition: the subject already carried it, and which server
   * a call reaches is the one load-bearing thing the old prompt hid.
   */
  it('names the MCP tool AND the server it reaches', () => {
    expect(
      approvalPromptHeader({
        name: 'mcp__jira__create_issue',
        subject: { kind: 'mcpTool', server: 'jira', name: 'create_issue' },
      })
    ).toBe(
      'The agent wants to call create_issue on the MCP server jira, via mcp__jira__create_issue'
    );
  });

  /**
   * Generic ON PURPOSE — [[TUI-C83]] derives the sentence that names the class of action from the
   * annotations the gate already read. What made the old prompt bad was that it was false; this is
   * merely unspecific, and "improving" it here is what that node is for.
   */
  it('announces a built-in or custom tool call by tool name alone', () => {
    expect(
      approvalPromptHeader({ name: 'write_file', subject: { kind: 'tool', name: 'write_file' } })
    ).toBe('The agent wants to use the write_file tool');
  });

  /**
   * An MCP call the configured keys could not attribute keeps `kind: 'mcpTool'` under an unnameable
   * server (the empty string, which is what makes it unspellable in config). Rendering the mcpTool
   * sentence for it would print "on the MCP server , via …" — a blank where the decisive word goes.
   * The tool arm names the full registered name instead, which still carries the `mcp__` namespace
   * on screen and claims no server.
   */
  it('falls back to the tool sentence when the MCP server could not be attributed', () => {
    const name = 'mcp__unconfigured__do_thing';
    expect(
      approvalPromptHeader({
        name,
        subject: { kind: 'mcpTool', server: UNRESOLVED_MCP_SERVER, name },
      })
    ).toBe(`The agent wants to use the ${name} tool`);
  });

  /** The floor for an interrupt built without a subject: vague, and true of every gated call. */
  it('falls back to the tool sentence when no subject travelled with the call', () => {
    expect(approvalPromptHeader({ name: 'gth_web_fetch' })).toBe(
      'The agent wants to use the gth_web_fetch tool'
    );
  });

  /**
   * [[TUI-C26]] — this line is the dialog's OWN chrome, at column 0, and the `mcpTool` arm prints
   * two identifiers a third party supplies (an MCP server's tool listing names them). A newline in
   * one lays down a row that looks exactly like the prompt's own; a carriage return walks the
   * cursor back over it. Both arrive as printable escapes instead, on one line.
   */
  it('neutralises a tool or server name that forges a row of the dialog', () => {
    const CR = String.fromCodePoint(0x0d);
    const LF = String.fromCodePoint(0x0a);
    const header = approvalPromptHeader({
      name: `mcp__ops__deploy${LF}Approve?  [o]nce`,
      subject: {
        kind: 'mcpTool',
        server: 'ops',
        name: `deploy${CR}${String.fromCodePoint(0x1b)}[2J`,
      },
    });
    expect(header.split('\n')).toHaveLength(1);
    // The forged break and the screen-clear are printable escapes, not control codes.
    expect(header).toContain('deploy\\x0d\\x1b[2J');
    expect(header).toContain('mcp__ops__deploy\\x0aApprove? [o]nce');
    expect(header).not.toContain(CR);
    expect(header).not.toContain(LF);
  });
});

/**
 * The mechanical guard that keeps the renderer's `tool` fallback a floor rather than a path.
 *
 * The harness is `GthAgentRunnerDenyMenu.spec.ts`'s: a mocked agent whose
 * `getPendingToolInterrupts` hands back the calls under test, driven at a deterministic rung so no
 * rating call is made and the gate's reason for asking is the rung alone.
 */
describe('GthAgentRunner — the subject travels to the approval surface', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdateCallback: Mock<StatusUpdateCallback>;
  let mockConfig: GthConfig;
  let priorProjectDir: string | undefined;

  /** The grant store is anchored at the project dir; clamp it or the spec reads the real one. */
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-prompt-header-spec-'));

  const streamOf = (...chunks: string[]) => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    rmSync(join(projectDir, SHELL_ALLOWLIST_FILE), { force: true });
    delete (mockAgent as unknown as Record<string, unknown>).getPendingToolInterrupts;
    delete (mockAgent as unknown as Record<string, unknown>).streamResume;
    statusUpdateCallback = vi.fn();
    mockConfig = {
      streamOutput: true,
      contentSource: 'file',
      requirementSource: 'file',
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: false,
      canInterruptInferenceWithEsc: true,
      includeCurrentDateAfterGuidelines: true,
      llm: { _llmType: vi.fn().mockReturnValue('test'), verbose: false },
    } as unknown as GthConfig;
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => setProjectDir(priorProjectDir));
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  /** Drive one gated call to the human and hand back the interrupt the prompt was given. */
  const shownFor = async (
    call: { name: string; args: Record<string, unknown> },
    mcpServers?: Record<string, unknown>
  ): Promise<PendingToolInterrupt> => {
    const runner = new GthAgentRunner(statusUpdateCallback);
    mockAgent.stream.mockResolvedValue(streamOf('working'));
    const getPending = vi.fn();
    getPending.mockResolvedValueOnce([call]);
    getPending.mockResolvedValue([]);
    (mockAgent as unknown as Record<string, unknown>).getPendingToolInterrupts = getPending;
    (mockAgent as unknown as Record<string, unknown>).streamResume = vi
      .fn()
      .mockResolvedValue(streamOf(' done'));
    await runner.init('code', {
      ...mockConfig,
      // `manual` gates every tool and consults no model, so each call below reaches the human for
      // the rung's reason alone — no rating, no escalate entry, nothing else on the interrupt.
      approvals: 'manual',
      ...(mcpServers ? { mcpServers } : {}),
    } as unknown as GthConfig);
    const shown: PendingToolInterrupt[] = [];
    runner.setToolApprovalCallback((async (pending: PendingToolInterrupt) => {
      shown.push(pending);
      return { type: 'reject' as const };
    }) as never);
    await runner.processMessages([new HumanMessage('do it')]);
    expect(shown).toHaveLength(1);
    return shown[0];
  };

  it('hands the shell subject to the surface, and the surface says shell command', async () => {
    const pending = await shownFor({
      name: 'run_shell_command',
      args: { command: 'rm -rf node_modules' },
    });
    expect(pending.subject).toEqual({ kind: 'shell', command: 'rm -rf node_modules' });
    expect(approvalPromptHeader(pending)).toBe(
      'The agent wants to run a shell command via run_shell_command'
    );
  });

  it('hands the tool subject to the surface for a built-in write tool', async () => {
    const pending = await shownFor({ name: 'write_file', args: { file_path: 'a.ts' } });
    expect(pending.subject).toMatchObject({ kind: 'tool', name: 'write_file' });
    expect(approvalPromptHeader(pending)).toBe('The agent wants to use the write_file tool');
  });

  /**
   * The case the unconditional attachment exists for. An `mcpTool` call has no rater verdict at a
   * deterministic rung, no escalate entry and no negotiation — and while it does carry a grant
   * here, the runner's spread must not make the subject depend on any of them, because an MCP call
   * whose server cannot be attributed has neither a grant nor a deny entry and would then arrive
   * subject-less.
   */
  it('hands the mcpTool subject, with the server resolved against the configured keys', async () => {
    const pending = await shownFor(
      { name: 'mcp__jira__create_issue', args: { summary: 'x' } },
      { jira: { command: 'x' } }
    );
    expect(pending.subject).toMatchObject({
      kind: 'mcpTool',
      server: 'jira',
      name: 'create_issue',
    });
    expect(approvalPromptHeader(pending)).toBe(
      'The agent wants to call create_issue on the MCP server jira, via mcp__jira__create_issue'
    );
  });

  /**
   * The interrupt with nothing else on it — no verdict, no escalate entry, no negotiation — which
   * is the one the old spread let through untouched. It must still carry a subject.
   */
  it('attaches the subject to an interrupt that carries nothing else', async () => {
    const pending = await shownFor({ name: 'mcp__ghost__do_thing', args: {} });
    expect(pending.subject).toBeDefined();
    expect(pending.safetyVerdict).toBeUndefined();
    expect(pending.escalatedBy).toBeUndefined();
    expect(pending.negotiationRounds).toBeUndefined();
  });
});
