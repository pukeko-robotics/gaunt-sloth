import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

// EXT-18 regression: the readline (--no-tui) cooked-mode prompts that can run AFTER a
// stream end (the shell-approval prompt and the retry prompt) must re-ref stdin before
// rl.question(), otherwise the unref applied by the stream's finally (stopWaitingForEscape)
// lets the event loop drain and the process exits to the shell before the user can answer.
// A vitest run can never reproduce the actual exit (the runner keeps the loop alive), so we
// assert the MECHANISM: refStdin() is invoked before rl.question() for those prompts.

// ── recorder: shared call-order log across the two mocked sites we care about ──
const callOrder: string[] = [];

// ── @gaunt-sloth/core/utils/systemUtils.js ────────────────────────────────────
const refStdinMock = vi.fn(() => {
  callOrder.push('refStdin');
});
const rlQuestionMock = vi.fn(async (prompt: string) => {
  callOrder.push('question');
  // The main loop prompt ('  > ') ends the session; the approval/retry prompts return a
  // canned answer the individual test sets via mockResolvedValueOnce on top of this.
  if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
  return '';
});
const rlCloseMock = vi.fn();
const setRawModeMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: rlCloseMock })),
  error: vi.fn(),
  exit: vi.fn(),
  refStdin: refStdinMock,
  setRawMode: setRawModeMock,
  stdin: { isTTY: true },
  stdout: { isTTY: true },
}));

// ── @gaunt-sloth/core/utils/consoleUtils.js ───────────────────────────────────
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

// ── @gaunt-sloth/core/config.js ───────────────────────────────────────────────
vi.mock('@gaunt-sloth/core/config.js', () => ({
  initConfig: vi.fn().mockResolvedValue({ streamSessionInferenceLog: false }),
}));

// ── @gaunt-sloth/core/utils/fileUtils.js ──────────────────────────────────────
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null), // null -> no session logging branch
}));

// ── GthAgentRunner: capture the approval callback the module registers ─────────
let capturedApprovalCallback:
  | ((_pending: {
      name: string;
      args: Record<string, unknown>;
      safetyVerdict?: { risk: string; reason: string };
    }) => Promise<{ type: string; scope?: string; message?: string }>)
  | undefined;
const processMessagesMock = vi.fn().mockResolvedValue(undefined);
const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: processMessagesMock,
  setToolApprovalCallback: vi.fn((cb) => {
    capturedApprovalCallback = cb;
  }),
  toggleSessionYolo: vi.fn(),
  cleanup: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

// ── langchain + agent-internal deps (kept inert) ──────────────────────────────
vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn() }));
vi.mock('#src/core/gthDeepAgentFactory.js', () => ({ gthDeepAgentFactory: vi.fn() }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

describe('interactiveSessionModule EXT-18 (--no-tui readline stdin re-ref)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    callOrder.length = 0;
    capturedApprovalCallback = undefined;
    refStdinMock.mockImplementation(() => {
      callOrder.push('refStdin');
    });
    rlQuestionMock.mockImplementation(async (prompt: string) => {
      callOrder.push('question');
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

  it('refs stdin before rl.question() in the shell-approval prompt, and approves on "o"', async () => {
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    // Run the session: no initial message -> the main loop prompt ('  > ') returns 'exit',
    // so the session sets up (and registers the approval callback) and then ends.
    await createInteractiveSession(sessionConfig, {});

    expect(capturedApprovalCallback).toBeTypeOf('function');

    // Only record what the approval callback itself does.
    callOrder.length = 0;
    rlQuestionMock.mockImplementationOnce(async () => {
      callOrder.push('question');
      return 'o'; // user approves once
    });

    const decision = await capturedApprovalCallback!({
      name: 'run_shell_command',
      args: { command: 'echo hi' },
    });

    // MECHANISM: stdin was re-ref'd before the prompt awaited input.
    const refIdx = callOrder.indexOf('refStdin');
    const qIdx = callOrder.indexOf('question');
    expect(refIdx).toBeGreaterThanOrEqual(0);
    expect(qIdx).toBeGreaterThanOrEqual(0);
    expect(refIdx).toBeLessThan(qIdx);
    // Not a pure ordering tautology: the answer is honoured.
    expect(decision).toEqual({ type: 'approve', scope: 'once' });
  });

  it('rejects (fail-closed) on "N" at the approval prompt', async () => {
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});
    expect(capturedApprovalCallback).toBeTypeOf('function');

    rlQuestionMock.mockResolvedValueOnce('N');
    const decision = await capturedApprovalCallback!({
      name: 'run_shell_command',
      args: { command: 'rm -rf /' },
    });
    expect(decision.type).toBe('reject');
  });

  it('refs stdin before rl.question() in the retry prompt after a failed turn', async () => {
    // Drive the askQuestion loop: 1st '  > ' -> a real prompt, processMessages throws, the
    // catch asks the retry question (-> 'n' to skip), 2nd '  > ' -> 'exit' to end.
    rlQuestionMock
      .mockImplementationOnce(async (prompt: string) => {
        callOrder.push('question');
        void prompt;
        return 'do something'; // first '  > ' main prompt
      })
      .mockImplementationOnce(async (prompt: string) => {
        callOrder.push('question'); // the retry prompt
        void prompt;
        return 'n';
      })
      .mockImplementationOnce(async (prompt: string) => {
        callOrder.push('question');
        void prompt;
        return 'exit'; // second '  > ' main prompt -> end session
      });
    runnerInstanceMock.processMessages.mockRejectedValueOnce(new Error('boom'));

    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});

    // Sequence: question(main) , refStdin(askLine before retry) , question(retry) , question(main->exit)
    const firstRef = callOrder.indexOf('refStdin');
    expect(firstRef).toBeGreaterThanOrEqual(0);
    // The retry question is the one immediately following the first refStdin.
    expect(callOrder[firstRef + 1]).toBe('question');
    // And that refStdin came after the first main prompt (i.e. it is the retry path, post-turn).
    expect(callOrder.indexOf('question')).toBeLessThan(firstRef);
  });
});
