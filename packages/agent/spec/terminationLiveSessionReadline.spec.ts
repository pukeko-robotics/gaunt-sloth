/**
 * [[EXT-159]] — **the reason reaches the live session on the plain / readline surface.**
 *
 * This is where a user lands whenever the Ink TUI cannot run — no TTY, `--no-tui`, a CI log, an
 * incomplete install — and it showed exactly what the TUI did about a stop: the wrapped error
 * sentence, or on a turn that ended without throwing, nothing at all. The prompt simply came back.
 *
 * The line is read from the RUNNER at the turn boundary rather than inferred from the answer text,
 * because the endings this exists for are the ones that return normally with nothing to infer from:
 * a cancelled turn, an exhausted approval drain, a turn that produced no content.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';
import { terminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import { TERMINATION_NOTICE_TITLE_PREFIX } from '@gaunt-sloth/core/core/terminationNotice.js';

let turnsAsked = 0;
let scriptedTurns: string[] = ['hello there'];
const rlQuestionMock = vi.fn(async (prompt: string) => {
  if (typeof prompt === 'string' && prompt.includes('>')) {
    const turn = scriptedTurns[turnsAsked] ?? 'exit';
    turnsAsked += 1;
    return turn;
  }
  return '';
});
// GS2-20 — the history recorder is stubbed: this spec does not test history, and with
// recording on by default a config naming no `dbPath` would resolve the user's real
// `~/.gsloth/history.db` and write to it. Plain functions, not vi.fn, so a
// `vi.resetAllMocks()` in beforeEach cannot strip their return values.
vi.mock('@gaunt-sloth/core/history/recordSession.js', () => ({
  openConversationSafe: () => null,
  recordSessionSafe: () => null,
  lookupConversationThreadSafe: () => null,
}));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  error: vi.fn(),
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  getUseColour: vi.fn(() => false),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true, columns: 120 },
}));

const consoleUtilsMock = vi.hoisted(() => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayDialogLine: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayLaunchBanner: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const initConfigMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

const runnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  getRunStats: vi.fn(() => ({ tools: [] })),
  getTerminationReason: vi.fn(),
  setApprovalOutcomeCallback: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  setAttackHaltCallback: vi.fn(),
  setNegotiationDisplay: vi.fn(),
  getAgent: vi.fn(() => null),
  cleanup: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
// GS2-20 — the session's checkpointer comes from this seam. Stubbed here so the spec does not
// load the real SQLite saver (which needs more of @langchain/langgraph than the stub above
// provides, and would open a database this spec has no interest in). A plain function, not a
// vi.fn, so a `vi.resetAllMocks()` in beforeEach cannot strip its return value.
vi.mock('@gaunt-sloth/core/history/sessionCheckpointer.js', () => ({
  openSessionCheckpointerSafe: () => ({
    saver: {},
    durable: false,
    threadId: 'test-thread-id',
    close: () => {},
  }),
}));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn(() => ({})) }));
vi.mock('#src/core/resolveAgentFactory.js', () => ({ resolveAgentFactory: vi.fn(() => vi.fn()) }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

/** Everything the session put in front of a person. */
const saidToUser = (): string =>
  [
    ...consoleUtilsMock.displayWarning.mock.calls,
    ...consoleUtilsMock.display.mock.calls,
    ...consoleUtilsMock.displayInfo.mock.calls,
  ]
    .map((call) => String(call[0]))
    .join('\n');

async function runOneTurn(): Promise<void> {
  const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
  await createInteractiveSession(sessionConfig, {});
}

describe('[[EXT-159]] SURFACE — the readline session says why the turn ended', () => {
  beforeEach(() => {
    turnsAsked = 0;
    scriptedTurns = ['hello there'];
    vi.clearAllMocks();
    initConfigMock.mockResolvedValue({ streamSessionInferenceLog: false });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('the answer');
    runnerInstanceMock.getRunStats.mockReturnValue({ tools: [] });
    runnerInstanceMock.getTerminationReason.mockReturnValue(null);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
  });

  /**
   * The exact shape [[TUI-C62]] describes: the turn returns cleanly, the answer is empty, and until
   * now the prompt just came back. Nothing threw, so no error rendering could have covered it.
   */
  it('states a cancellation that ended the turn with no error anywhere', async () => {
    runnerInstanceMock.processMessages.mockResolvedValue('');
    runnerInstanceMock.getTerminationReason.mockReturnValue(
      terminationReason('runner.events-cancelled', 'control', {
        category: 'cancelled',
        detail: 'signal',
      })
    );

    await runOneTurn();

    expect(saidToUser()).toContain(TERMINATION_NOTICE_TITLE_PREFIX);
    // The quotable code, which is the fact a bug report needs and the sentence is derived from.
    expect(saidToUser()).toContain('cancelled@runner.events-cancelled');
  });

  it('states a provider fault with the classification the wrapped sentence never carried', async () => {
    runnerInstanceMock.processMessages.mockResolvedValue('');
    runnerInstanceMock.getTerminationReason.mockReturnValue(
      terminationReason('runner.stream-error', 'exception', {
        category: 'rate_limited',
        detail: '429',
      })
    );

    await runOneTurn();

    expect(saidToUser()).toContain('rate_limited@runner.stream-error');
    // And what to do about it, read off the posture the taxonomy already decided.
    expect(saidToUser()).toContain('Wait a moment');
  });

  it('adds nothing to a turn that simply finished', async () => {
    runnerInstanceMock.getTerminationReason.mockReturnValue(
      terminationReason('runner.completed', 'control', 'completed')
    );

    await runOneTurn();

    expect(saidToUser()).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);
  });

  it('keeps the session alive when the runner cannot answer why the turn ended', async () => {
    runnerInstanceMock.getTerminationReason.mockImplementation(() => {
      throw new Error('no such method');
    });

    await expect(runOneTurn()).resolves.not.toThrow();
  });
});
