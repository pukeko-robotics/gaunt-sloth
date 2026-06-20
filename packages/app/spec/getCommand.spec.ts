import { Command } from 'commander';
import { SystemMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomUUID: () => '12345678-aaaa-bbbb-cccc-1234567890ab',
  };
});

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  setExitCode: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', async () => {
  const actual = await vi.importActual<typeof import('#src/utils/systemUtils.js')>(
    '#src/utils/systemUtils.js'
  );
  return {
    ...actual,
    setExitCode: systemUtilsMock.setExitCode,
  };
});

const llmUtilsMock = {
  readBackstory: vi.fn(),
  readGuidelines: vi.fn(),
  readReviewInstructions: vi.fn(),
  readSystemPrompt: vi.fn(),
  readChatPrompt: vi.fn(),
  readCodePrompt: vi.fn(),
  buildSystemMessages: vi.fn(),
};
vi.mock('#src/utils/llmUtils.js', () => llmUtilsMock);

const configMock = {
  initConfig: vi.fn(),
};
vi.mock('#src/config.js', () => configMock);

describe('getCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();

    llmUtilsMock.readBackstory.mockReturnValue('INTERNAL BACKSTORY');
    llmUtilsMock.readGuidelines.mockReturnValue('PROJECT GUIDELINES');
    llmUtilsMock.readReviewInstructions.mockReturnValue('REVIEW INSTRUCTIONS');
    llmUtilsMock.readSystemPrompt.mockReturnValue('SYSTEM PROMPT');
    llmUtilsMock.readChatPrompt.mockReturnValue('CHAT PROMPT');
    llmUtilsMock.readCodePrompt.mockReturnValue('CODE PROMPT');
    llmUtilsMock.buildSystemMessages.mockImplementation((_config, modePrompt) => [
      new SystemMessage(`INTERNAL BACKSTORY\nPROJECT GUIDELINES\n${modePrompt}\nSYSTEM PROMPT`),
    ]);

    configMock.initConfig.mockResolvedValue({
      llm: { invoke: vi.fn() } as unknown as BaseChatModel,
      projectGuidelines: '.gsloth.guidelines.md',
      projectReviewInstructions: '.gsloth.review.md',
      contentProvider: 'text',
      requirementsProvider: 'text',
      streamOutput: true,
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: true,
      streamSessionInferenceLog: true,
      canInterruptInferenceWithEsc: true,
      commands: {
        pr: {
          contentProvider: 'github',
          requirementsProvider: 'text',
        },
        review: {
          contentProvider: 'text',
          requirementsProvider: 'text',
        },
      },
    });
  });

  it('Should print effective ask prompt', async () => {
    const { getCommand } = await import('#src/commands/getCommand.js');
    const program = new Command();

    getCommand(program, {});
    await program.parseAsync(['na', 'na', 'get', 'ask', 'prompt']);

    expect(consoleUtilsMock.display).toHaveBeenCalledWith(
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nSYSTEM PROMPT'
    );
  });

  it('Should print effective chat prompt', async () => {
    const { getCommand } = await import('#src/commands/getCommand.js');
    const program = new Command();

    getCommand(program, {});
    await program.parseAsync(['na', 'na', 'get', 'chat', 'prompt']);

    expect(llmUtilsMock.buildSystemMessages).toHaveBeenCalled();
    expect(consoleUtilsMock.display).toHaveBeenCalledWith(
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nCHAT PROMPT\nSYSTEM PROMPT'
    );
  });

  it('Should print wrapped review requirements payload', async () => {
    vi.doMock('#src/commands/commandUtils.js', async () => {
      const actual = await vi.importActual<typeof import('#src/commands/commandUtils.js')>(
        '#src/commands/commandUtils.js'
      );
      return {
        ...actual,
        getRequirementsFromProvider: vi
          .fn()
          .mockResolvedValue(
            '\nProvided requirements follows within text-1234567 block\n<text-1234567>\nRequirements content\n</text-1234567>\n'
          ),
      };
    });

    const { getCommand } = await import('#src/commands/getCommand.js');
    const program = new Command();

    getCommand(program, {});
    await program.parseAsync(['na', 'na', 'get', 'review', 'requirements', 'REQ-123']);

    expect(consoleUtilsMock.display).toHaveBeenCalledWith(
      '\nProvided requirements follows within text-1234567 block\n<text-1234567>\nRequirements content\n</text-1234567>\n'
    );
  });

  it('Should print wrapped pr content payload with github default', async () => {
    vi.doMock('#src/commands/commandUtils.js', async () => {
      const actual = await vi.importActual<typeof import('#src/commands/commandUtils.js')>(
        '#src/commands/commandUtils.js'
      );
      return {
        ...actual,
        getContentFromProvider: vi
          .fn()
          .mockResolvedValue(
            '\nProvided GitHub diff follows within github-1234567 block\n<github-1234567>\nPR Diff Content\n</github-1234567>\n'
          ),
      };
    });

    configMock.initConfig.mockResolvedValue({
      llm: { invoke: vi.fn() } as unknown as BaseChatModel,
      projectGuidelines: '.gsloth.guidelines.md',
      projectReviewInstructions: '.gsloth.review.md',
      contentProvider: 'text',
      requirementsProvider: 'text',
      streamOutput: true,
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: true,
      streamSessionInferenceLog: true,
      canInterruptInferenceWithEsc: true,
      commands: {
        pr: {},
        review: {},
      },
    });

    const { getCommand } = await import('#src/commands/getCommand.js');
    const program = new Command();

    getCommand(program, {});
    await program.parseAsync(['na', 'na', 'get', 'pr', 'content', '123']);

    expect(consoleUtilsMock.display).toHaveBeenCalledWith(
      '\nProvided GitHub diff follows within github-1234567 block\n<github-1234567>\nPR Diff Content\n</github-1234567>\n'
    );
  });

  it('Should report invalid command-subject combination', async () => {
    const { getCommand } = await import('#src/commands/getCommand.js');
    const program = new Command();

    getCommand(program, {});
    await program.parseAsync(['na', 'na', 'get', 'ask', 'content', '123']);

    expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
      'Unsupported provider-backed command: ask.'
    );
    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
  });
});
