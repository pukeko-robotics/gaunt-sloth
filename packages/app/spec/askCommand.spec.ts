import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Make randomUUID deterministic across this spec
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomUUID: () => '12345678-aaaa-bbbb-cccc-1234567890ab',
  };
});

// Define mocks at top level
const resolversMock = {
  createResolvers: vi.fn(),
};
vi.mock('@gaunt-sloth/agent/resolvers.js', () => resolversMock);

// B5: askCommand resolves the backend factory (default lean) and passes it to runSingleShot.
const resolvedFactory = vi.fn();
const resolveAgentFactoryMock = {
  resolveAgentFactory: vi.fn(() => resolvedFactory),
};
vi.mock('@gaunt-sloth/agent/core/resolveAgentFactory.js', () => resolveAgentFactoryMock);

const runSingleShot = vi.fn();
const prompt = {
  readBackstory: vi.fn(),
  readGuidelines: vi.fn(),
  readSystemPrompt: vi.fn(),
};

const singleShotModule = { runSingleShot };

const utilsMock = {
  ProgressIndicator: vi.fn(),
  extractLastMessageContent: vi.fn(),
};
vi.mock('#src/utils/utils.js', () => utilsMock);
const fileUtilsMock = {
  readFileFromCurrentDir: vi.fn(),
  readMultipleFilesFromProjectDir: vi.fn(),
  toFileSafeString: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  generateStandardFileName: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => fileUtilsMock);

// Mock config to return specific test values
const mockConfig = {
  llm: {
    invoke: vi.fn(),
  },
  projectGuidelines: '.gsloth.guidelines.md',
  projectReviewInstructions: '.gsloth.review.md',
  contentSource: 'file',
  requirementSource: 'file',
  streamOutput: true,
  commands: {
    pr: {
      contentSource: 'github',
      requirementSource: 'github',
    },
  },
  filesystem: 'none',
  useColour: false,
  writeOutputToFile: true,
  streamSessionInferenceLog: true,
  canInterruptInferenceWithEsc: true,
};

// Set up static mocks
vi.mock('#src/utils/llmUtils.js', async () => {
  const actual = await import('#src/utils/llmUtils.js');
  return {
    ...actual,
    readBackstory: prompt.readBackstory,
    readGuidelines: prompt.readGuidelines,
    readSystemPrompt: prompt.readSystemPrompt,
  };
});
vi.mock('@gaunt-sloth/core/runtime/singleShot.js', () => singleShotModule);
const systemUtilsMock = {
  getStringFromStdin: vi.fn().mockReturnValue(''),
  setExitCode: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);
const consoleUtilsMock = {
  displayError: vi.fn(),
  displayWarning: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);
const configMock = {
  initConfig: vi.fn(),
  createDefaultConfig: vi.fn(),
};

vi.mock('#src/config.js', () => configMock);

describe('askCommand', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();

    // Set up config mock
    configMock.initConfig.mockResolvedValue(mockConfig);
    configMock.createDefaultConfig.mockReturnValue(mockConfig);

    // A run succeeds unless a test says otherwise.
    runSingleShot.mockResolvedValue(true);

    // Mock the util functions
    fileUtilsMock.readMultipleFilesFromProjectDir.mockImplementation((files: string[]) => {
      if (files.includes('test.file')) {
        return 'test.file:\n```\nFILE CONTENT\n```';
      }
      return '';
    });

    // Mock the prompt functions
    prompt.readBackstory.mockReturnValue('INTERNAL PREAMBLE');
    prompt.readGuidelines.mockReturnValue('PROJECT GUIDELINES');
    prompt.readSystemPrompt.mockReturnValue('');

    resolversMock.createResolvers.mockReturnValue({ resolveTools: vi.fn(), cleanupTools: vi.fn() });

    const progressIndicator = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    utilsMock.ProgressIndicator.mockImplementation(() => progressIndicator);
  });

  it('Should call runSingleShot with message', async () => {
    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    await program.parseAsync(['na', 'na', 'ask', 'test message']);
    // With deterministic UUID, the block id will be message-1234567
    expect(runSingleShot).toHaveBeenCalledWith(
      'ASK',
      'INTERNAL PREAMBLE\nPROJECT GUIDELINES',
      '\nProvided user message follows within message-1234567 block\n<message-1234567>\ntest message\n</message-1234567>\n',
      mockConfig,
      expect.any(Object),
      'ask',
      resolvedFactory
    );
    // ask defaults to the lean backend; an explicit agent.backend would override it.
    expect(resolveAgentFactoryMock.resolveAgentFactory).toHaveBeenCalledWith(mockConfig, 'lean');
    expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
  });

  it('sets a non-zero exit code when the run fails', async () => {
    runSingleShot.mockResolvedValue(false);
    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    await program.parseAsync(['na', 'na', 'ask', 'test message']);

    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
  });

  it('sets a non-zero exit code when the run throws', async () => {
    runSingleShot.mockRejectedValue(new Error('boom'));
    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    await program.parseAsync(['na', 'na', 'ask', 'test message']);

    expect(consoleUtilsMock.displayError).toHaveBeenCalled();
    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
  });

  it('Should call runSingleShot with message and file content', async () => {
    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    await program.parseAsync(['na', 'na', 'ask', 'test message', '-f', 'test.file']);
    expect(runSingleShot).toHaveBeenCalledWith(
      'ASK',
      'INTERNAL PREAMBLE\nPROJECT GUIDELINES',
      'test.file:\n```\nFILE CONTENT\n```\n' +
        '\nProvided user message follows within message-1234567 block\n<message-1234567>\ntest message\n</message-1234567>\n',
      mockConfig,
      expect.any(Object),
      'ask',
      resolvedFactory
    );
  });

  it('Should call runSingleShot with message and multiple file contents', async () => {
    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    fileUtilsMock.readMultipleFilesFromProjectDir.mockImplementation((files: string[]) => {
      if (files.includes('test.file') && files.includes('test2.file')) {
        return 'test.file:\n```\nFILE CONTENT\n```\n\ntest2.file:\n```\nFILE2 CONTENT\n```';
      }
      return '';
    });
    await program.parseAsync(['na', 'na', 'ask', 'test message', '-f', 'test.file', 'test2.file']);
    expect(runSingleShot).toHaveBeenCalledWith(
      'ASK',
      'INTERNAL PREAMBLE\nPROJECT GUIDELINES',
      'test.file:\n```\nFILE CONTENT\n```\n\ntest2.file:\n```\nFILE2 CONTENT\n```\n' +
        '\nProvided user message follows within message-1234567 block\n<message-1234567>\ntest message\n</message-1234567>\n',
      mockConfig,
      expect.any(Object),
      'ask',
      resolvedFactory
    );
  });

  it('Should display help correctly', async () => {
    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    expect(program.commands[0].name()).toEqual('ask');
    expect(program.commands[0].description()).toEqual('Ask a question');
  });

  it('Should call runSingleShot with file content only (no message)', async () => {
    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    await program.parseAsync(['na', 'na', 'ask', '-f', 'test.file']);
    expect(runSingleShot).toHaveBeenCalledWith(
      'ASK',
      'INTERNAL PREAMBLE\nPROJECT GUIDELINES',
      'test.file:\n```\nFILE CONTENT\n```',
      mockConfig,
      expect.any(Object),
      'ask',
      resolvedFactory
    );
  });

  it('Should call runSingleShot with stdin content only (no message)', async () => {
    const { getStringFromStdin } = await import('#src/utils/systemUtils.js');
    vi.mocked(getStringFromStdin).mockReturnValue('STDIN CONTENT');

    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    await program.parseAsync(['na', 'na', 'ask']);
    // With deterministic UUID, the block id will be stdin-content-1234567
    expect(runSingleShot).toHaveBeenCalledWith(
      'ASK',
      'INTERNAL PREAMBLE\nPROJECT GUIDELINES',
      '\nProvided content follows within stdin-content-1234567 block\n<stdin-content-1234567>\nSTDIN CONTENT\n</stdin-content-1234567>\n',
      mockConfig,
      expect.any(Object),
      'ask',
      resolvedFactory
    );
  });

  it('Should throw error when no input source is provided', async () => {
    const { getStringFromStdin } = await import('#src/utils/systemUtils.js');
    vi.mocked(getStringFromStdin).mockReturnValue('');

    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});

    await expect(program.parseAsync(['na', 'na', 'ask'])).rejects.toThrow(
      'At least one of the following is required: file, stdin, or message'
    );
  });

  it('Should pass writeOutputToFile config parameter through to runSingleShot module', async () => {
    // Create a config with writeOutputToFile set to false
    const configWithWriteOutputDisabled = {
      ...mockConfig,
      writeOutputToFile: false,
    };

    // Mock initConfig to return our test config
    configMock.initConfig.mockResolvedValue(configWithWriteOutputDisabled);

    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    await program.parseAsync(['na', 'na', 'ask', 'integration test message']);

    // Verify that runSingleShot was called with the config containing writeOutputToFile: false
    expect(runSingleShot).toHaveBeenCalledWith(
      'ASK',
      'INTERNAL PREAMBLE\nPROJECT GUIDELINES',
      '\nProvided user message follows within message-1234567 block\n<message-1234567>\nintegration test message\n</message-1234567>\n',
      configWithWriteOutputDisabled,
      expect.any(Object),
      'ask',
      resolvedFactory
    );

    // Specifically verify the writeOutputToFile parameter was passed through
    const calledConfig = runSingleShot.mock.calls[0][3];
    expect(calledConfig.writeOutputToFile).toBe(false);
  });

  it('applyAskWriteMode returns config untouched without --write', async () => {
    const { applyAskWriteMode } = await import('#src/commands/askCommand.js');
    const cfg = { ...mockConfig, commands: { ask: { filesystem: 'read' } } } as any;
    const result = applyAskWriteMode(cfg, {});
    expect(result).toBe(cfg);
    expect(result.askWriteMode).toBeUndefined();
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });

  it('applyAskWriteMode upgrades filesystem to all, sets askWriteMode, warns, and inherits exec builtInTools', async () => {
    const { applyAskWriteMode } = await import('#src/commands/askCommand.js');
    const cfg = {
      ...mockConfig,
      commands: {
        ask: { filesystem: 'read' },
        exec: { builtInTools: { run_shell_command: true } },
      },
    } as any;
    const result = applyAskWriteMode(cfg, { write: true });

    expect(result.askWriteMode).toBe(true);
    expect(result.commands.ask.filesystem).toBe('all');
    // Dev/shell tools are inherited from commands.exec.builtInTools so the user need not configure
    // commands.ask separately (CFG-18: dev tools live in the unified builtInTools registry).
    expect(result.commands.ask.builtInTools).toEqual({ run_shell_command: true });
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
  });

  it('applyAskWriteMode falls back to code builtInTools when exec has none', async () => {
    const { applyAskWriteMode } = await import('#src/commands/askCommand.js');
    const cfg = {
      ...mockConfig,
      commands: {
        ask: { filesystem: 'read' },
        code: { builtInTools: { run_shell_command: true } },
      },
    } as any;
    const result = applyAskWriteMode(cfg, { write: true });
    expect(result.commands.ask.builtInTools).toEqual({ run_shell_command: true });
  });

  it('ask --write passes the write-enabled config (filesystem all + askWriteMode) to runSingleShot', async () => {
    configMock.initConfig.mockResolvedValue({
      ...mockConfig,
      commands: {
        ask: { filesystem: 'read' },
        exec: { builtInTools: { run_shell_command: true } },
      },
    });
    const { askCommand } = await import('#src/commands/askCommand.js');
    const program = new Command();
    askCommand(program, {});
    await program.parseAsync(['na', 'na', 'ask', '--write', 'create test.txt']);

    const calledConfig = runSingleShot.mock.calls[0][3];
    expect(calledConfig.askWriteMode).toBe(true);
    expect(calledConfig.commands.ask.filesystem).toBe('all');
    expect(calledConfig.commands.ask.builtInTools).toEqual({ run_shell_command: true });
  });
});
