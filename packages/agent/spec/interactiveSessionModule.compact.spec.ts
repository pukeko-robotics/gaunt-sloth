/**
 * GS2-23 — `/compact` on the readline (`--no-tui`) surface: the module awaits
 * `runner.compactConversation` with the focus, prints the in-progress line first, renders the
 * landed notice through the single notice writer, never sends the command to the model, and
 * reports a failed compaction without ending the session.
 *
 * Same scaffold as `interactiveSessionModule.slash.spec.ts`: a scripted readline, a mocked runner,
 * and the REAL slash-command registry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

let inputs: string[] = [];
const rlQuestionMock = vi.fn(async () => inputs.shift() ?? 'exit');
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
  stdout: { isTTY: true },
}));

const consoleUtilsMock = {
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayLaunchBanner: vi.fn(),
  displayNotice: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const initConfigMock = vi.fn();
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

const runnerInstanceMock = {
  init: vi.fn(),
  processMessages: vi.fn(),
  compactConversation: vi.fn(),
  setApprovalOutcomeCallback: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  setAttackHaltCallback: vi.fn(),
  setNegotiationDisplay: vi.fn(),
  setSessionApprovalRung: vi.fn(),
  getSessionApprovals: vi.fn(),
  getAllowlistCounts: vi.fn(),
  getRefusals: vi.fn(),
  liftRefusal: vi.fn(),
  getGrants: vi.fn(),
  getMcpAnnotationTrust: vi.fn(),
  setMcpAnnotationTrust: vi.fn(),
  getAgent: vi.fn(),
  getApprovalCaptures: vi.fn(() => []),
  getTerminationReason: vi.fn(() => null),
  getFinishReasonObservations: vi.fn(() => []),
  cleanup: vi.fn(),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('@gaunt-sloth/core/utils/debugDump.js', () => ({
  writeDebugDump: vi.fn(() => ({ archiveDir: '/fake/.gsloth/debug-dumps/stamp' })),
  readTermination: () => ({ reason: null, finishReasons: [] }),
}));
class FakeAbstractAgent {
  lastModelRequest: unknown;
}
vi.mock('@gaunt-sloth/core/core/GthAbstractAgent.js', () => ({
  GthAbstractAgent: FakeAbstractAgent,
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
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
  mode: 'chat',
  readModePrompt: () => null,
  description: 'chat',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

const outcome = (over: Record<string, unknown> = {}) => ({
  changed: true,
  removedCount: 4,
  keptCount: 6,
  keepRecent: 6,
  summaryText: 'SUMMARY',
  before: { messages: 10, characters: 12345 },
  after: { messages: 7, characters: 2100 },
  ...over,
});

/** All output joined, channel-blind, as the sibling slash spec reads it. */
const allOutput = (): string =>
  [
    ...consoleUtilsMock.display.mock.calls,
    ...consoleUtilsMock.displayInfo.mock.calls,
    ...consoleUtilsMock.displayWarning.mock.calls,
  ]
    .map((c) => String(c[0]))
    .concat(
      consoleUtilsMock.displayNotice.mock.calls.flatMap((c) => [
        String(c[0]),
        ...(c[1] as readonly string[]).map((line) => `  ${line}`),
      ])
    )
    .join('\n');

const noticeCalls = (): Array<{ title: string; lines: readonly string[] }> =>
  consoleUtilsMock.displayNotice.mock.calls.map((c) => ({
    title: String(c[0]),
    lines: c[1] as readonly string[],
  }));

const runSession = async (...userInputs: string[]) => {
  inputs = [...userInputs];
  const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
  await createInteractiveSession(sessionConfig, {});
};

describe('interactiveSessionModule — /compact (GS2-23)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    inputs = [];
    initConfigMock.mockResolvedValue({
      streamSessionInferenceLog: false,
      modelDisplayName: 'test-model',
    });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('answer');
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    runnerInstanceMock.getSessionApprovals.mockReturnValue({
      rung: 'assisted',
      allow: [],
      deny: [],
    });
    runnerInstanceMock.getAllowlistCounts.mockReturnValue({ session: 0, always: undefined });
    runnerInstanceMock.getRefusals.mockReturnValue([]);
    runnerInstanceMock.getGrants.mockReturnValue([]);
    runnerInstanceMock.getMcpAnnotationTrust.mockReturnValue({ defaults: [], servers: [] });
  });

  it('awaits the runner with the focus, prints the in-progress line, and renders the landed notice', async () => {
    runnerInstanceMock.compactConversation.mockResolvedValue(outcome());
    await runSession('/compact keep the file names', 'exit');

    expect(runnerInstanceMock.compactConversation).toHaveBeenCalledTimes(1);
    expect(runnerInstanceMock.compactConversation).toHaveBeenCalledWith({
      focus: 'keep the file names',
    });
    const out = allOutput();
    expect(out).toContain('Compacting the conversation');
    expect(out).toContain('Conversation compacted');
    expect(out).toContain(
      'Folded 4 older messages into a summary and kept the last 6 word for word.'
    );
    expect(out).toContain('Summary focus: keep the file names');
    // The notice reached the single writer whole, title and body together ([[EXT-165]]).
    const notices = noticeCalls();
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe('Conversation compacted');
    // Never sent to the model.
    expect(runnerInstanceMock.processMessages).not.toHaveBeenCalled();
  });

  it('a bare /compact passes no focus, and a no-op outcome reads as nothing to compact', async () => {
    runnerInstanceMock.compactConversation.mockResolvedValue(
      outcome({
        changed: false,
        removedCount: 0,
        keptCount: 2,
        before: { messages: 2, characters: 40 },
        after: { messages: 2, characters: 40 },
      })
    );
    await runSession('/compact', 'exit');

    expect(runnerInstanceMock.compactConversation).toHaveBeenCalledWith({});
    const out = allOutput();
    expect(out).toContain('Nothing to compact');
    expect(out).toContain('Nothing was changed.');
  });

  it('a failed compaction is reported with its reason and the session goes on', async () => {
    runnerInstanceMock.compactConversation.mockRejectedValue(new Error('provider down'));
    await runSession('/compact', '/status', 'exit');

    const out = allOutput();
    expect(out).toContain('Compaction did not happen');
    expect(out).toContain('The conversation was left unchanged: provider down');
    // The next command still ran: the failure did not end the session.
    expect(out).toContain('Session status');
    expect(runnerInstanceMock.processMessages).not.toHaveBeenCalled();
  });

  it('/help lists /compact on this surface too', async () => {
    await runSession('/help', 'exit');
    expect(allOutput()).toContain('/compact — ');
  });
});
