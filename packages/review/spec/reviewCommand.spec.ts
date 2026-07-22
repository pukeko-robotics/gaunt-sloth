import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// Make randomUUID deterministic across this spec to stabilize wrapContent output
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomUUID: () => '12345678-aaaa-bbbb-cccc-1234567890ab',
  };
});

// Define mocks at the top level
const resolversMock = {
  createResolvers: vi.fn(),
};
vi.mock('@gaunt-sloth/agent/resolvers.js', () => resolversMock);

const review = vi.fn();
const llmUtils = {
  readBackstory: vi.fn(),
  readGuidelines: vi.fn(),
  readReviewInstructions: vi.fn(),
  readSystemPrompt: vi.fn(),
};

// Use a direct mock for the review function instead of a nested implementation
vi.mock('#src/modules/reviewModule.js', () => ({
  review: review,
}));

const utilsMock = {
  execAsync: vi.fn(),
  ProgressIndicator: vi.fn(),
  extractLastMessageContent: vi.fn(),
};
vi.mock('#src/utils/utils.js', () => utilsMock);

const fileUtilsMock = {
  readFileFromCurrentDir: vi.fn(),
  readMultipleFilesFromProjectDir: vi.fn(),
  readFileSyncWithMessages: vi.fn(),
  toFileSafeString: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  generateStandardFileName: vi.fn(),
};
vi.mock('@gaunt-sloth/review/utils/fileUtils.js', () => fileUtilsMock);

// Set up static mocks
const mockConfig = {
  llm: { invoke: vi.fn() } as unknown as BaseChatModel,
  contentSource: 'file',
  requirementSource: 'file',
  streamOutput: true,
  commands: {
    pr: {
      contentSource: 'github',
      requirementSource: 'github',
    },
    review: {},
  },
  filesystem: 'none',
  useColour: false,
  writeOutputToFile: true,
  streamSessionInferenceLog: true,
  canInterruptInferenceWithEsc: true,
};

const configMock = {
  initConfig: vi.fn(),
};

vi.mock('#src/utils/llmUtils.js', async () => {
  const actual = await import('#src/utils/llmUtils.js');
  return {
    ...actual,
    readBackstory: llmUtils.readBackstory,
    readGuidelines: llmUtils.readGuidelines,
    readReviewInstructions: llmUtils.readReviewInstructions,
    readSystemPrompt: llmUtils.readSystemPrompt,
  };
});
vi.mock('#src/config.js', () => configMock);

describe('reviewCommand', () => {
  beforeEach(async () => {
    vi.resetAllMocks();

    // Setup default mock returns
    configMock.initConfig.mockResolvedValue(mockConfig);
    fileUtilsMock.readFileFromCurrentDir.mockReturnValue('FILE TO REVIEW');
    fileUtilsMock.readMultipleFilesFromProjectDir.mockReturnValue(
      'test.file:\n```\nFILE TO REVIEW\n```'
    );
    fileUtilsMock.readFileSyncWithMessages.mockReturnValue('content-id');
    utilsMock.execAsync.mockResolvedValue('');
    llmUtils.readBackstory.mockReturnValue('INTERNAL BACKSTORY');
    llmUtils.readGuidelines.mockReturnValue('PROJECT GUIDELINES');
    llmUtils.readReviewInstructions.mockReturnValue('REVIEW INSTRUCTIONS');
    llmUtils.readSystemPrompt.mockReturnValue('');
    resolversMock.createResolvers.mockReturnValue({ resolveTools: vi.fn(), cleanupTools: vi.fn() });
  });

  it('Should call review with file contents', async () => {
    const { reviewCommand } = await import('#src/commands/reviewCommand.js');
    const program = new Command();

    reviewCommand(program, {});
    await program.parseAsync(['na', 'na', 'review', '-f', 'test.file']);

    expect(review).toHaveBeenCalledWith(
      'REVIEW',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      'test.file:\n```\nFILE TO REVIEW\n```',
      expect.objectContaining({}),
      'review',
      expect.any(Object)
    );
  });

  it('Should call review with multiple file contents', async () => {
    const { reviewCommand } = await import('#src/commands/reviewCommand.js');
    const program = new Command();

    reviewCommand(program, {});

    fileUtilsMock.readMultipleFilesFromProjectDir.mockReturnValue(
      'test.file:\n```\nFILE TO REVIEW\n```\n\ntest2.file:\n```\nFILE2 TO REVIEW\n```'
    );

    await program.parseAsync(['na', 'na', 'review', '-f', 'test.file', 'test2.file']);

    expect(review).toHaveBeenCalledWith(
      'REVIEW',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      'test.file:\n```\nFILE TO REVIEW\n```\n\ntest2.file:\n```\nFILE2 TO REVIEW\n```',
      expect.objectContaining({}),
      'review',
      expect.any(Object)
    );
  });

  it('Should display predefined providers in help', async () => {
    const { reviewCommand } = await import('#src/commands/reviewCommand.js');
    const program = new Command();
    const testOutput = { text: '' };

    program.configureOutput({
      writeOut: (str: string) => (testOutput.text += str),
      writeErr: (str: string) => (testOutput.text += str),
    });

    reviewCommand(program, {});

    const commandUnderTest = program.commands.find((c) => c.name() === 'review');
    expect(commandUnderTest).toBeDefined();
    commandUnderTest?.outputHelp();

    // Verify content providers are displayed
    expect(testOutput.text).toContain('--content-source <contentSource>');
    expect(testOutput.text).toContain('(choices: "github", "text", "file")');

    // Verify requirements providers are displayed
    expect(testOutput.text).toContain('--requirements-source <requirementSource>');
    expect(testOutput.text).toContain('(choices: "jira-legacy", "jira", "github", "text", "file")');
  });

  it('Should call review with predefined requirements provider', async () => {
    // Setup specific config for this test
    const testConfig = {
      ...mockConfig,
      requirementSource: 'jira-legacy',
      requirementSourceConfig: {
        'jira-legacy': {
          username: 'test-user',
          token: 'test-token',
          baseUrl: 'https://test-jira.atlassian.net/rest/api/2/issue/',
        },
      },
      contentSource: 'text',
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'jira-legacy',
        },
        review: {
          requirementSource: 'jira-legacy',
          contentSource: 'text',
        },
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { reviewCommand } = await import('#src/commands/reviewCommand.js');
    const program = new Command();

    // Mock the jira provider
    const jiraProvider = vi.fn().mockResolvedValue('JIRA Requirements');
    vi.doMock('#src/sources/jiraIssueLegacySource.js', () => ({
      get: jiraProvider,
    }));

    reviewCommand(program, {});
    await program.parseAsync(['na', 'na', 'review', 'content-id', '-r', 'JIRA-123']);

    expect(review).toHaveBeenCalledWith(
      'REVIEW',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      '\nProvided requirements follows within jira-legacy-1234567 block\n<jira-legacy-1234567>\nJIRA Requirements\n</jira-legacy-1234567>\n\n\nProvided content follows within text-1234567 block\n<text-1234567>\ncontent-id\n</text-1234567>\n',
      expect.objectContaining({
        requirementSource: 'jira-legacy',
      }),
      'review',
      expect.any(Object)
    );
  });

  it('Should call review with predefined content provider', async () => {
    // Setup specific config for this test
    const testConfig = {
      ...mockConfig,
      contentSource: 'github',
      requirementSource: 'text',
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'text',
        },
        review: {
          requirementSource: 'text',
          contentSource: 'github',
        },
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { reviewCommand } = await import('#src/commands/reviewCommand.js');
    const program = new Command();

    // Mock the gh provider
    const ghProvider = vi.fn().mockResolvedValue('PR Diff Content');
    vi.doMock('#src/sources/ghPrDiffSource.js', () => ({
      get: ghProvider,
    }));

    reviewCommand(program, {});
    await program.parseAsync(['na', 'na', 'review', '123']);

    expect(review).toHaveBeenCalledWith(
      'REVIEW',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      '\nProvided GitHub diff follows within github-1234567 block\n<github-1234567>\nPR Diff Content\n</github-1234567>\n',
      expect.objectContaining({
        contentSource: 'github',
      }),
      'review',
      expect.any(Object)
    );
  });

  it('Should call review with message parameter', async () => {
    const { reviewCommand } = await import('#src/commands/reviewCommand.js');
    const program = new Command();

    reviewCommand(program, {});
    await program.parseAsync([
      'na',
      'na',
      'review',
      '-f',
      'test.file',
      '-m',
      'Please check for memory leaks',
    ]);

    expect(review).toHaveBeenCalledWith(
      'REVIEW',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      'test.file:\n```\nFILE TO REVIEW\n```\n' +
        '\nProvided user message follows within message-1234567 block\n' +
        '<message-1234567>\n' +
        'Please check for memory leaks\n' +
        '</message-1234567>\n',
      expect.objectContaining({}),
      'review',
      expect.any(Object)
    );
  });

  it('Should call review with message and content provider', async () => {
    // Setup specific config for this test
    const testConfig = {
      ...mockConfig,
      contentSource: 'github',
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { reviewCommand } = await import('#src/commands/reviewCommand.js');
    const program = new Command();

    // Mock the gh provider
    const ghProvider = vi.fn().mockResolvedValue('PR Diff Content');
    vi.doMock('#src/sources/ghPrDiffSource.js', () => ({
      get: ghProvider,
    }));

    reviewCommand(program, {});
    await program.parseAsync(['na', 'na', 'review', '123', '-m', 'Focus on code style']);

    expect(review).toHaveBeenCalledWith(
      'REVIEW',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      '\nProvided GitHub diff follows within github-1234567 block\n<github-1234567>\nPR Diff Content\n</github-1234567>\n\n\nProvided user message follows within message-1234567 block\n<message-1234567>\nFocus on code style\n</message-1234567>\n',
      expect.objectContaining({
        contentSource: 'github',
      }),
      'review',
      expect.any(Object)
    );
  });
});
