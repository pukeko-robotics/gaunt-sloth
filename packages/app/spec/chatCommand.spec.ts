import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = {
  initConfig: vi.fn(),
};
vi.mock('#src/config.js', () => configMock);

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displaySuccess: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displayDebug: vi.fn(),
  defaultStatusCallbacks: vi.fn(),
  formatInputPrompt: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const pathUtilsMock = {
  getGslothFilePath: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => pathUtilsMock);

const utilsMock = {
  generateStandardFileName: vi.fn(),
  appendToFile: vi.fn(),
  ProgressIndicator: vi.fn(),
};
vi.mock('#src/utils/utils.js', () => utilsMock);

const fsMock = {
  existsSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const llmUtilsMock = {
  invoke: vi.fn(),
  getNewRunnableConfig: vi.fn().mockReturnValue({
    recursionLimit: 1000,
    configurable: { thread_id: 'test-thread-id' },
  }),
  readBackstory: vi.fn().mockReturnValue('Mock backstory'),
  readGuidelines: vi.fn().mockReturnValue('Mock guidelines'),
  readSystemPrompt: vi.fn().mockReturnValue('Mock system prompt'),
  readChatPrompt: vi.fn().mockReturnValue('Mock chat prompt'),
};
vi.mock('#src/utils/llmUtils.js', () => llmUtilsMock);

const readlineMock = {
  createInterface: vi.fn(),
};
vi.mock('node:readline/promises', () => readlineMock);

const interactiveSessionModuleMock = {
  createInteractiveSession: vi.fn(),
};
vi.mock('#src/modules/interactiveSessionModule.js', () => interactiveSessionModuleMock);

describe('chatCommand', () => {
  let program: Command;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    program = new Command();

    configMock.initConfig.mockResolvedValue({
      llm: 'Mock LLM',
    });

    consoleUtilsMock.formatInputPrompt.mockImplementation((v) => v);

    pathUtilsMock.getGslothFilePath.mockReturnValue('mock/chat/file.txt');

    utilsMock.generateStandardFileName.mockReturnValue('mock-chat-file.txt');
    utilsMock.ProgressIndicator.mockImplementation(() => ({
      stop: vi.fn(),
    }));

    fsMock.existsSync.mockReturnValue(true);

    llmUtilsMock.invoke.mockResolvedValue('Mock response');
  });

  it('Should display help correctly', async () => {
    const { chatCommand } = await import('#src/commands/chatCommand.js');
    chatCommand(program, {});
    expect(program.commands[0].description()).toBe(
      'Start an interactive chat session with Gaunt Sloth'
    );
  });

  it('Should process initial message if provided', async () => {
    const { chatCommand } = await import('#src/commands/chatCommand.js');
    chatCommand(program, {});
    await program.parseAsync(['na', 'na', 'chat', 'test message']);

    expect(interactiveSessionModuleMock.createInteractiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'chat',
        description: 'Start an interactive chat session with Gaunt Sloth',
        readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
        exitMessage: "Type 'exit' or Ctrl+C to exit chat · /help for commands\n",
      }),
      {},
      'test message'
    );
  });

  it('Should handle empty message gracefully', async () => {
    const { chatCommand } = await import('#src/commands/chatCommand.js');
    chatCommand(program, {});
    await program.parseAsync(['na', 'na', 'chat']);

    expect(interactiveSessionModuleMock.createInteractiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'chat',
        description: 'Start an interactive chat session with Gaunt Sloth',
        readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
        exitMessage: "Type 'exit' or Ctrl+C to exit chat · /help for commands\n",
      }),
      {},
      undefined
    );
  });

  it('Should call createInteractiveSession with correct config', async () => {
    const { chatCommand } = await import('#src/commands/chatCommand.js');
    chatCommand(program, {});
    await program.parseAsync(['na', 'na', 'chat']);

    expect(interactiveSessionModuleMock.createInteractiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'chat',
        description: 'Start an interactive chat session with Gaunt Sloth',
        readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
        exitMessage: "Type 'exit' or Ctrl+C to exit chat · /help for commands\n",
      }),
      {},
      undefined
    );
  });

  it('Should pass readChatPrompt function to session config', async () => {
    const { chatCommand } = await import('#src/commands/chatCommand.js');
    chatCommand(program, {});
    await program.parseAsync(['na', 'na', 'chat']);

    expect(interactiveSessionModuleMock.createInteractiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'chat',
        readModePrompt: llmUtilsMock.readChatPrompt,
      }),
      {},
      undefined
    );
  });

  it('REL-3: chat does NOT register a no-subcommand default action', async () => {
    // The bare-`gth` default is now the agentic code session (registered in codeCommand),
    // so chatCommand must not start a chat session when no subcommand is given.
    const { chatCommand } = await import('#src/commands/chatCommand.js');
    chatCommand(program, {});
    program.exitOverride(); // commander would otherwise call process.exit when it shows help
    try {
      await program.parseAsync(['na', 'na']);
    } catch {
      // With no default action and no subcommand, commander shows help and exits — expected.
    }

    expect(interactiveSessionModuleMock.createInteractiveSession).not.toHaveBeenCalled();
  });
});

describe('Default Chat Behavior (no arguments)', () => {
  let program: Command;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    program = new Command();

    configMock.initConfig.mockResolvedValue({
      llm: 'Mock LLM',
    });

    consoleUtilsMock.formatInputPrompt.mockImplementation((v) => v);

    pathUtilsMock.getGslothFilePath.mockReturnValue('mock/chat/file.txt');

    utilsMock.generateStandardFileName.mockReturnValue('mock-chat-file.txt');
    utilsMock.ProgressIndicator.mockImplementation(() => ({
      stop: vi.fn(),
    }));

    fsMock.existsSync.mockReturnValue(true);

    llmUtilsMock.invoke.mockResolvedValue('Mock response');
  });

  it('Should create session config with correct mode and prompts', async () => {
    const { readChatPrompt } = await import('#src/utils/llmUtils.js');

    const sessionConfig = {
      mode: 'chat' as const,
      readModePrompt: readChatPrompt,
      description: 'Start an interactive chat session with Gaunt Sloth',
      readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
      exitMessage: "Type 'exit' or Ctrl+C to exit chat · /help for commands\n",
    };

    expect(sessionConfig.mode).toBe('chat');
    expect(sessionConfig.readModePrompt).toBe(readChatPrompt);
    expect(sessionConfig.description).toBe('Start an interactive chat session with Gaunt Sloth');
    expect(sessionConfig.readyMessage).toBe('\nGaunt Sloth is ready to chat. Type your prompt.');
    expect(sessionConfig.exitMessage).toBe(
      "Type 'exit' or Ctrl+C to exit chat · /help for commands\n"
    );
  });

  it('Should handle createInteractiveSession with initial message', async () => {
    const { chatCommand } = await import('#src/commands/chatCommand.js');
    chatCommand(program, {});
    await program.parseAsync(['na', 'na', 'chat', 'initial message']);

    expect(interactiveSessionModuleMock.createInteractiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'chat',
        description: 'Start an interactive chat session with Gaunt Sloth',
        readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
        exitMessage: "Type 'exit' or Ctrl+C to exit chat · /help for commands\n",
      }),
      {},
      'initial message'
    );
  });
});
