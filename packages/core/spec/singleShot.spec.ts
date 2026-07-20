import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { GthConfig } from '#src/config.js';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';

const gthAgentRunnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  cleanup: vi.fn(),
}));
const gthAgentRunnerMock = vi.hoisted(() =>
  vi.fn(function GthAgentRunnerMock() {
    return gthAgentRunnerInstanceMock;
  })
);
vi.mock('#src/core/GthAgentRunner.js', () => ({
  GthAgentRunner: gthAgentRunnerMock,
}));

// Mock fs module
const fsMock = {
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

// Mock path module
const pathMock = {
  resolve: vi.fn(),
};
vi.mock('node:path', () => pathMock);

// Mock systemUtils module
const systemUtilsMock = {
  getCurrentWorkDir: vi.fn(),
  // GS2-7: singleShot now records opt-in history and reads the project dir for the record.
  getProjectDir: vi.fn(() => '/project'),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

// Mock consoleUtils module
const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayError: vi.fn(),
  defaultStatusCallback: vi.fn(),
  initSessionLogging: vi.fn(),
  flushSessionLog: vi.fn(),
  stopSessionLogging: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

// Mock utils module
const ProgressIndicatorInstanceMock = vi.hoisted(() => ({
  stop: vi.fn(),
  indicate: vi.fn(),
}));
const ProgressIndicatorMock = vi.hoisted(() =>
  vi.fn(function ProgressIndicatorMock() {
    return ProgressIndicatorInstanceMock;
  })
);
vi.mock('#src/utils/ProgressIndicator.js', () => ({
  ProgressIndicator: ProgressIndicatorMock,
}));

// Mock utils module
const fileUtilsMock = {
  toFileSafeString: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  generateStandardFileName: vi.fn(),
  appendToFile: vi.fn(),
  getGslothFilePath: vi.fn(),
  gslothDirExists: vi.fn(),
  getCommandOutputFilePath: vi.fn(),
  resolveOutputPath: vi.fn(),
};

vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

// Create a complete mock config for prop drilling
const mockConfig = {
  llm: new FakeStreamingChatModel({
    responses: ['LLM Response' as unknown as BaseMessage],
  }),
  contentSource: 'file',
  requirementSource: 'file',
  projectGuidelines: '.gsloth.guidelines.md',
  projectReviewInstructions: '.gsloth.review.md',
  streamOutput: false,
  commands: {
    pr: {
      contentSource: 'github',
      requirementSource: 'github',
    },
  },
  filesystem: 'none',
  useColour: false,
  writeOutputToFile: true,
} as Partial<GthConfig> as GthConfig;

// Mock config module
vi.mock('#src/config.js', () => ({
  GthConfig: {},
}));

// Mock llmUtils module
const llmUtilsMock = {
  invoke: vi.fn().mockResolvedValue('LLM Response'),
  getNewRunnableConfig: vi.fn().mockReturnValue({
    recursionLimit: 1000,
    configurable: { thread_id: 'test-thread-id' },
  }),
};
vi.mock('#src/utils/llmUtils.js', () => llmUtilsMock);

describe('singleShot', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    gthAgentRunnerMock.mockClear();
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);

    // Setup mock for our new generateStandardFileName function
    fileUtilsMock.generateStandardFileName.mockReturnValue('gth_2025-05-17_21-00-00_ASK.md');
    fileUtilsMock.getCommandOutputFilePath.mockReturnValue('/test-file-path.md');
    pathMock.resolve.mockImplementation((path: string, name: string) => {
      if (name && name.includes('gth_')) return 'test-file-path.md';
      return '';
    });

    ProgressIndicatorMock.mockClear();
    ProgressIndicatorInstanceMock.stop.mockReset();
    ProgressIndicatorInstanceMock.indicate.mockReset();

    // Setup pathUtils mocks
    fileUtilsMock.getGslothFilePath.mockReturnValue('test-file-path.md');
    fileUtilsMock.gslothDirExists.mockReturnValue(false);
  });

  it('should invoke LLM with prop drilling', async () => {
    // Reset the mock LLM for this test
    const testConfig = { ...mockConfig };
    testConfig.llm = new FakeStreamingChatModel({
      responses: ['LLM Response' as unknown as BaseMessage],
    });
    testConfig.llm.bindTools = vi.fn();

    // Prepare runner mocks
    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('LLM Response');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);

    // Import the module after setting up mocks
    const { runSingleShot } = await import('#src/runtime/singleShot.js');

    // Call runSingleShot with config (prop drilling)
    await runSingleShot('test-source', 'test-preamble', 'test-content', testConfig);

    // Verify that runner was called with correct parameters. BATCH-13: the preamble is no longer
    // injected as a SystemMessage — the agent backends compose the system prompt themselves (a
    // superset), and a second leading system message broke Anthropic single-shot. Only the human
    // turn is passed now.
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledWith([
      new HumanMessage('test-content'),
    ]);

    expect(consoleUtilsMock.initSessionLogging).toHaveBeenCalled();

    // Verify that displaySuccess was called
    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalled();

    // Verify that ProgressIndicator.stop() was called
    expect(ProgressIndicatorInstanceMock.stop).toHaveBeenCalled();
  });

  // Specific test to verify that prop drilling works with different config objects
  it('should work with different config objects via prop drilling', async () => {
    // Create a different config object to prove prop drilling works
    const differentConfig = {
      ...mockConfig,
      streamOutput: true, // Different from default mockConfig
      llm: new FakeStreamingChatModel({
        responses: ['Different LLM Response' as unknown as BaseMessage],
      }),
      writeOutputToFile: true,
    } as GthConfig;

    // Set a different response for this specific test
    llmUtilsMock.invoke.mockResolvedValue('Different LLM Response');

    // Prepare runner mocks
    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('Different LLM Response');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);

    // Import the module after setting up mocks
    const { runSingleShot } = await import('#src/runtime/singleShot.js');

    // Call runSingleShot with the different config to prove prop drilling works
    await runSingleShot('test-source', 'test-preamble', 'test-content', differentConfig);

    // Verify the different config was used. BATCH-13: only the human turn is passed (see above).
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledWith([
      new HumanMessage('test-content'),
    ]);

    expect(consoleUtilsMock.initSessionLogging).toHaveBeenCalled();

    // Since streamOutput is true, display should not be called
    expect(consoleUtilsMock.display).not.toHaveBeenCalled();
  });

  // B5: the optional trailing agentFactory param must be forwarded to GthAgentRunner's 3rd ctor
  // arg so `ask`/`exec` can select the backend. Undefined must keep the runner's lean default.
  it('forwards the agentFactory to GthAgentRunner (B5)', async () => {
    const testConfig = { ...mockConfig } as GthConfig;
    const { runSingleShot } = await import('#src/runtime/singleShot.js');
    const fakeFactory = vi.fn();

    await runSingleShot(
      'test-source',
      'test-preamble',
      'test-content',
      testConfig,
      undefined,
      'ask',
      fakeFactory as never
    );

    // 3rd ctor arg is the agent factory.
    expect(gthAgentRunnerMock).toHaveBeenCalledTimes(1);
    expect(gthAgentRunnerMock.mock.calls[0][2]).toBe(fakeFactory);
  });

  it('passes undefined agentFactory when none is supplied (keeps lean default)', async () => {
    const testConfig = { ...mockConfig } as GthConfig;
    const { runSingleShot } = await import('#src/runtime/singleShot.js');

    await runSingleShot('test-source', 'test-preamble', 'test-content', testConfig);

    expect(gthAgentRunnerMock).toHaveBeenCalledTimes(1);
    expect(gthAgentRunnerMock.mock.calls[0][2]).toBeUndefined();
  });
});
