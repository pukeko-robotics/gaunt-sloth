import { Command } from 'commander';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { display, displayInfo } from '#src/utils/consoleUtils.js';
import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { createInterface } from 'node:readline/promises';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { GthConfig } from '#src/config.js';

// Mock modules
vi.mock('#src/config.js', () => ({
  initConfig: vi.fn().mockResolvedValue({
    projectGuidelines: 'Mock guidelines',
    llm: 'Mock LLM',
    streamSessionInferenceLog: true,
    writeOutputToFile: true,
  }),
}));

vi.mock('#src/utils/consoleUtils.js', async () => {
  const actual = await vi.importActual('#src/utils/consoleUtils.js');
  return {
    ...actual,
    display: vi.fn(),
    displayError: vi.fn(),
    displaySuccess: vi.fn(),
    displayInfo: vi.fn(),
    displayWarning: vi.fn(),
    displayDebug: vi.fn(),
    defaultStatusCallbacks: vi.fn(),
    formatInputPrompt: vi.fn().mockImplementation((v) => v),
    initSessionLogging: vi.fn(),
    stopSessionLogging: vi.fn(),
    flushSessionLog: vi.fn(),
  };
});

vi.mock('#src/utils/systemUtils.js', async () => {
  const actual = await vi.importActual('#src/utils/systemUtils.js');
  return {
    ...actual,
    initLogStream: vi.fn(),
    writeToLogStream: vi.fn(),
    closeLogStream: vi.fn(),
  };
});

vi.mock('#src/utils/fileUtils.js', () => ({
  getGslothFilePath: vi.fn().mockReturnValue('mock/code/file.txt'),
  getCommandOutputFilePath: vi.fn((config: any, _source: string) => {
    // Preserve previous test expectation: when writeOutputToFile is true,
    // the path used is 'mock/code/file.txt'
    if (config.writeOutputToFile === false) return null;
    if (config.writeOutputToFile === true) return 'mock/code/file.txt';
    return String(config.writeOutputToFile);
  }),
  generateStandardFileName: vi.fn().mockReturnValue('mock-code-file.txt'),
  appendToFile: vi.fn(),
}));

vi.mock('#src/utils/utils.js', () => ({
  ProgressIndicator: vi.fn(function ProgressIndicatorMock() {
    return {
      stop: vi.fn(),
    };
  }),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('#src/utils/llmUtils.js', () => ({
  invoke: vi.fn().mockResolvedValue('Mock response'),
  getNewRunnableConfig: vi.fn().mockReturnValue({
    recursionLimit: 1000,
    configurable: { thread_id: 'test-thread-id' },
  }),
  readBackstory: vi.fn().mockReturnValue('Mock backstory'),
  readGuidelines: vi.fn().mockReturnValue('Mock guidelines'),
  readSystemPrompt: vi.fn().mockReturnValue('Mock system prompt'),
  readCodePrompt: vi.fn().mockReturnValue('Mock code prompt'),
  buildSystemMessages: vi
    .fn()
    .mockReturnValue([
      new SystemMessage('Mock backstory\nMock guidelines\nMock code prompt\nMock system prompt'),
    ]),
}));

const gthAgentRunnerMock = vi.fn(function GthAgentRunnerMock() {
  return gthAgentRunnerInstanceMock;
});
const gthAgentRunnerInstanceMock = {
  init: vi.fn(),
  processMessages: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  cleanup: vi.fn(),
};
vi.mock('#src/core/GthAgentRunner.js', () => ({
  GthAgentRunner: gthAgentRunnerMock,
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));

describe('codeCommand', () => {
  let program: Command;
  let codeCommand: typeof import('#src/commands/codeCommand.js').codeCommand;

  beforeEach(async () => {
    vi.resetModules();
    ({ codeCommand } = await import('#src/commands/codeCommand.js'));
    program = new Command();
    vi.clearAllMocks();

    // Set up GthAgentRunner mock implementation
    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('Mock response');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);
  });

  beforeAll(async () => {
    ({ codeCommand } = await import('#src/commands/codeCommand.js'));
  });

  it('Should display help correctly', () => {
    codeCommand(program, {});
    expect(program.commands[0].description()).toBe(
      'Interactively write code with sloth (has full file system access within your project)'
    );
  });

  it('REL-3: bare gth (no subcommand) defaults to the code session', async () => {
    const mockReadline = {
      question: vi.fn().mockResolvedValue('exit'),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValue(mockReadline as unknown as ReadlineInterface);

    codeCommand(program, {});
    await program.parseAsync(['na', 'na']); // no subcommand

    expect(gthAgentRunnerInstanceMock.init).toHaveBeenCalledWith(
      'code',
      expect.any(Object),
      expect.any(MemorySaver)
    );
  });

  it('Should process initial message if provided', async () => {
    const mockReadline = {
      question: vi.fn().mockResolvedValue('exit'),
      close: vi.fn(),
      terminal: true,
      line: '',
      cursor: 0,
      getPrompt: vi.fn(),
      setPrompt: vi.fn(),
      prompt: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      write: vi.fn(),
      addListener: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      prependListener: vi.fn(),
      prependOnceListener: vi.fn(),
      removeListener: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
      setMaxListeners: vi.fn(),
      getMaxListeners: vi.fn(),
      listeners: vi.fn(),
      rawListeners: vi.fn(),
      eventNames: vi.fn(),
      listenerCount: vi.fn(),
    } as unknown as ReadlineInterface;

    vi.mocked(createInterface).mockReturnValue(mockReadline);

    codeCommand(program, {});
    await program.parseAsync(['na', 'na', 'code', 'test message']);

    expect(gthAgentRunnerInstanceMock.init).toHaveBeenCalledWith(
      'code',
      expect.any(Object),
      expect.any(MemorySaver)
    );

    // The system prompt now lives in the deep-agent graph (createDeepAgent({ systemPrompt }));
    // the interactive session no longer prepends a SystemMessage to the first turn.
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledWith([
      new HumanMessage('test message'),
    ]);
  });

  it('Should handle empty message gracefully', async () => {
    let callCount = 0;
    const mockReadline = {
      question: vi.fn().mockImplementation(() => {
        if (callCount === 0) {
          callCount++;
          return Promise.resolve(''); // Simulate empty input
        } else {
          return Promise.resolve('exit'); // Simulate exit on next call
        }
      }),
      close: vi.fn(),
      terminal: true,
      line: '',
      cursor: 0,
      getPrompt: vi.fn(),
      setPrompt: vi.fn(),
      prompt: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      write: vi.fn(),
      addListener: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      prependListener: vi.fn(),
      prependOnceListener: vi.fn(),
      removeListener: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
      setMaxListeners: vi.fn(),
      getMaxListeners: vi.fn(),
      listeners: vi.fn(),
      rawListeners: vi.fn(),
      eventNames: vi.fn(),
      listenerCount: vi.fn(),
    } as unknown as ReadlineInterface;

    vi.mocked(createInterface).mockReturnValue(mockReadline);

    codeCommand(program, {});
    await program.parseAsync(['na', 'na', 'code']);

    expect(mockReadline.question).toHaveBeenCalledWith('  > ');
    expect(mockReadline.close).toHaveBeenCalled();
  });

  it('Should greet user on empty first message', async () => {
    let callCount = 0;
    const mockReadline = {
      question: vi.fn().mockImplementation(() => {
        if (callCount === 0) {
          callCount++;
          return Promise.resolve(''); // Simulate empty input
        } else {
          return Promise.resolve('exit'); // Simulate exit on next call
        }
      }),
      close: vi.fn(),
      terminal: true,
      line: '',
      cursor: 0,
      getPrompt: vi.fn(),
      setPrompt: vi.fn(),
      prompt: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      write: vi.fn(),
      addListener: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      prependListener: vi.fn(),
      prependOnceListener: vi.fn(),
      removeListener: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
      setMaxListeners: vi.fn(),
      getMaxListeners: vi.fn(),
      listeners: vi.fn(),
      rawListeners: vi.fn(),
      eventNames: vi.fn(),
      listenerCount: vi.fn(),
    } as unknown as ReadlineInterface;

    vi.mocked(createInterface).mockReturnValue(mockReadline);
    vi.mocked(display).mockImplementation(() => {});

    codeCommand(program, {});
    await program.parseAsync(['na', 'na', 'code']);

    expect(mockReadline.question).toHaveBeenCalledWith('  > ');
    expect(vi.mocked(display)).toHaveBeenCalledWith(
      '\nGaunt Sloth is ready to code. Type your prompt.'
    );
    expect(vi.mocked(displayInfo)).toHaveBeenCalledWith(
      "Type 'exit' or Ctrl+C to exit code session · /help for commands\n"
    );
    expect(mockReadline.close).toHaveBeenCalled();
  });

  it('Should maintain conversation context between messages', async () => {
    const mockConfig = {
      projectGuidelines: 'Mock guidelines',
      llm: new FakeStreamingChatModel({}),
      streamOutput: false,
      contentProvider: 'file',
      requirementsProvider: 'file',
      projectReviewInstructions: '.gsloth.review.md',
      filesystem: 'none' as const,
      streamSessionInferenceLog: true,
    } as Partial<GthConfig>;
    const { initConfig } = await import('#src/config.js');
    vi.mocked(initConfig).mockResolvedValue(mockConfig as GthConfig);

    const messages = ['first message', 'second message', 'exit'];
    let messageIndex = 0;
    const mockReadline = {
      question: vi.fn().mockImplementation(() => {
        return Promise.resolve(messages[messageIndex++]);
      }),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValue(mockReadline as any);

    codeCommand(program, {});
    await program.parseAsync(['na', 'na', 'code']); // Start code session

    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledTimes(2);
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenNthCalledWith(1, [
      new HumanMessage('first message'),
    ]);
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenNthCalledWith(2, [
      new HumanMessage('second message'),
    ]);
  });

  it('Should configure logging for the session', async () => {
    const mockConfig = {
      projectGuidelines: 'Mock guidelines',
      llm: new FakeStreamingChatModel({}),
      streamOutput: false,
      contentProvider: 'file',
      requirementsProvider: 'file',
      projectReviewInstructions: '.gsloth.review.md',
      filesystem: 'none' as const,
      streamSessionInferenceLog: true,
      writeOutputToFile: true,
    } as Partial<GthConfig>;
    const { initConfig } = await import('#src/config.js');
    vi.mocked(initConfig).mockResolvedValue({ ...mockConfig } as GthConfig);
    const { initSessionLogging } = await import('#src/utils/consoleUtils.js');
    const messages = ['first message', 'exit'];
    let messageIndex = 0;
    const mockReadline = {
      question: vi.fn().mockImplementation(() => {
        return Promise.resolve(messages[messageIndex++]);
      }),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValue(mockReadline as any);
    codeCommand(program, {});
    await program.parseAsync(['na', 'na', 'code']); // Start code session
    expect(vi.mocked(initSessionLogging)).toHaveBeenCalledWith('mock/code/file.txt', true);
  });

  it('Should flush session log after processing user input', async () => {
    const mockConfig = {
      projectGuidelines: 'Mock guidelines',
      llm: new FakeStreamingChatModel({}),
      streamOutput: false,
      contentProvider: 'file',
      requirementsProvider: 'file',
      projectReviewInstructions: '.gsloth.review.md',
      filesystem: 'none' as const,
      streamSessionInferenceLog: true,
    } as Partial<GthConfig>;
    const { initConfig } = await import('#src/config.js');
    vi.mocked(initConfig).mockResolvedValue(mockConfig as GthConfig);
    const { flushSessionLog } = await import('#src/utils/consoleUtils.js');
    const messages = ['test message', 'exit'];
    let messageIndex = 0;
    const mockReadline = {
      question: vi.fn().mockImplementation(() => {
        return Promise.resolve(messages[messageIndex++]);
      }),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValue(mockReadline as any);
    codeCommand(program, {});
    await program.parseAsync(['na', 'na', 'code']); // Start code session
    expect(vi.mocked(flushSessionLog)).toHaveBeenCalled();
  });
});
