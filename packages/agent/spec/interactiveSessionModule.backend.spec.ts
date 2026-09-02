import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

// B5: interactive code/chat must select the agent backend via resolveAgentFactory(config, 'deep')
// and hand the resulting factory to GthAgentRunner (3rd ctor arg). Defaults stay deep; an explicit
// config.agent.backend flows through resolveAgentFactory (whose own selection is unit-tested
// separately). Here we assert the DELEGATION + wiring, mocking the readline/runner so nothing runs.

// readline / stdin — the main '  > ' prompt returns 'exit' so the session sets up and ends.
const rlQuestionMock = vi.fn(async (prompt: string) => {
  if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
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
  stdout: { isTTY: true },
}));

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayLaunchBanner: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

// initConfig returns the config the module then resolves the backend from.
const initConfigMock = vi.fn();
vi.mock('@gaunt-sloth/core/config.js', () => ({
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

// Capture GthAgentRunner ctor args.
const runnerCtorArgs: unknown[][] = [];
const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: vi.fn().mockResolvedValue(undefined),
  setApprovalOutcomeCallback: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  cleanup: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock(...args: unknown[]) {
    runnerCtorArgs.push(args);
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

const createResolversResult = { RESOLVERS: true };
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn(() => createResolversResult) }));

// resolveAgentFactory: return a sentinel + record the args it was called with.
const factorySentinel = vi.fn();
const resolveAgentFactoryMock = vi.fn(() => factorySentinel);
vi.mock('#src/core/resolveAgentFactory.js', () => ({
  resolveAgentFactory: resolveAgentFactoryMock,
}));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

describe('interactiveSessionModule backend selection (B5)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runnerCtorArgs.length = 0;
    rlQuestionMock.mockImplementation(async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
      return '';
    });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue(undefined);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    resolveAgentFactoryMock.mockReturnValue(factorySentinel);
  });

  it("resolves the factory via resolveAgentFactory(config, 'lean') and passes it to the runner", async () => {
    const config = { streamSessionInferenceLog: false, agent: { backend: 'deep' } };
    initConfigMock.mockResolvedValue(config);

    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});

    // Delegated to resolveAgentFactory with the resolved config and the 'lean' per-command default
    // (an explicit config.agent.backend still wins inside resolveAgentFactory itself).
    expect(resolveAgentFactoryMock).toHaveBeenCalledTimes(1);
    expect(resolveAgentFactoryMock.mock.calls[0][0]).toMatchObject({ agent: { backend: 'deep' } });
    expect(resolveAgentFactoryMock.mock.calls[0][1]).toBe('lean');

    // The resolved factory is the runner's 3rd ctor arg; resolvers (2nd arg) are unchanged.
    expect(runnerCtorArgs).toHaveLength(1);
    expect(runnerCtorArgs[0][1]).toBe(createResolversResult);
    expect(runnerCtorArgs[0][2]).toBe(factorySentinel);
  });

  it("uses the 'lean' default when agent.backend is unset", async () => {
    initConfigMock.mockResolvedValue({ streamSessionInferenceLog: false });

    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});

    expect(resolveAgentFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ streamSessionInferenceLog: false }),
      'lean'
    );
    expect(runnerCtorArgs[0][2]).toBe(factorySentinel);
  });
});
