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
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  error: vi.fn(),
  exit: vi.fn(),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true },
}));

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
  setToolApprovalCallback: vi.fn(),
  toggleSessionYolo: vi.fn(),
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
