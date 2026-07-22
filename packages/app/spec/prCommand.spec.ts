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

const displayErrorMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async () => {
  const actual = await vi.importActual<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>(
    '@gaunt-sloth/core/utils/consoleUtils.js'
  );
  return {
    ...actual,
    displayError: displayErrorMock,
  };
});
const review = vi.fn();
const runPrDiscovery = vi.fn();
const prompt = {
  readBackstory: vi.fn(),
  readGuidelines: vi.fn(),
  readReviewInstructions: vi.fn(),
  readSystemPrompt: vi.fn(),
};

// Use a direct mock for the review function instead of a nested implementation
vi.mock('#src/modules/reviewModule.js', () => ({
  review: review,
}));
vi.mock('#src/commands/prDiscovery.js', () => ({
  runPrDiscovery,
  // commandIntrospection imports readPrDiscoveryPrompt from the same module; stub it so this mock
  // stays complete even if a future test path loads the introspection module.
  readPrDiscoveryPrompt: vi.fn(() => ''),
}));

const utilsMock = {
  readFileFromCurrentDir: vi.fn(),
  readMultipleFilesFromProjectDir: vi.fn(),
  readFileSyncWithMessages: vi.fn(),
  execAsync: vi.fn(),
  ProgressIndicator: vi.fn(),
  extractLastMessageContent: vi.fn(),
  toFileSafeString: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  generateStandardFileName: vi.fn(),
};

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
    readBackstory: prompt.readBackstory,
    readGuidelines: prompt.readGuidelines,
    readReviewInstructions: prompt.readReviewInstructions,
    readSystemPrompt: prompt.readSystemPrompt,
  };
});
vi.mock('#src/config.js', () => configMock);
vi.mock('#src/utils/utils.js', () => utilsMock);

describe('prCommand', () => {
  beforeEach(async () => {
    vi.resetAllMocks();

    // Setup default mock returns
    configMock.initConfig.mockResolvedValue(mockConfig);
    utilsMock.readFileFromCurrentDir.mockReturnValue('FILE TO REVIEW');
    utilsMock.readMultipleFilesFromProjectDir.mockReturnValue(
      'test.file:\n```\nFILE TO REVIEW\n```'
    );
    utilsMock.readFileSyncWithMessages.mockReturnValue('content-id');
    utilsMock.execAsync.mockResolvedValue('');
    prompt.readBackstory.mockReturnValue('INTERNAL BACKSTORY');
    prompt.readGuidelines.mockReturnValue('PROJECT GUIDELINES');
    prompt.readReviewInstructions.mockReturnValue('REVIEW INSTRUCTIONS');
    prompt.readSystemPrompt.mockReturnValue('');

    runPrDiscovery.mockResolvedValue({
      requirements: 'Auto requirements',
      diff: 'Auto PR Diff Content',
    });

    resolversMock.createResolvers.mockReturnValue({ resolveTools: vi.fn(), cleanupTools: vi.fn() });
  });

  it('Should discover change requirements when no PR id and requirements id are provided', async () => {
    const testConfig = {
      ...mockConfig,
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'github',
          discovery: {
            enabled: true,
            deterministicDiff: true,
          },
        },
        review: {},
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    prCommand(program, {});
    await program.parseAsync(['na', 'na', 'pr']);

    expect(runPrDiscovery).toHaveBeenCalledWith(testConfig);
    expect(review).toHaveBeenCalledWith(
      'PR-discovery',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      '\nProvided requirements follows within discovered-requirements-1234567 block\n<discovered-requirements-1234567>\nAuto requirements\n</discovered-requirements-1234567>\n\n\nProvided GitHub diff follows within discovered-diff-1234567 block\n<discovered-diff-1234567>\nAuto PR Diff Content\n</discovered-diff-1234567>\n',
      expect.objectContaining({}),
      'pr',
      expect.any(Object),
      { prId: undefined }
    );
  });

  it('Should reject no-argument pr command when discovery is disabled', async () => {
    const testConfig = {
      ...mockConfig,
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'github',
          discovery: {
            enabled: false,
          },
        },
        review: {},
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    prCommand(program, {});
    await program.parseAsync(['na', 'na', 'pr']);

    expect(runPrDiscovery).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it('Should reject requirements-only pr command syntax with an explicit error', async () => {
    const testConfig = {
      ...mockConfig,
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'jira',
        },
        review: {},
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    prCommand(program, {});
    await program.parseAsync(['na', 'na', 'pr', 'PROJ-123']);

    expect(displayErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('requirements-only mode is not supported')
    );
    expect(runPrDiscovery).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it('Should reject a non-numeric PR id even when a requirements id is present', async () => {
    const testConfig = {
      ...mockConfig,
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'github',
        },
        review: {},
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    prCommand(program, {});
    // Not requirements-only mode (a requirements id follows), but the PR id is garbage that
    // would otherwise only be caught downstream by the source's own validation.
    await program.parseAsync(['na', 'na', 'pr', '42;rm-rf', '45']);

    expect(displayErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('Invalid pull request ID "42;rm-rf"')
    );
    expect(runPrDiscovery).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it('Should accept a non-numeric content id when the content source is not github', async () => {
    const testConfig = {
      ...mockConfig,
      requirementSource: 'text',
      commands: {
        pr: {
          contentSource: 'text',
          requirementSource: 'text',
        },
        review: {},
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    prCommand(program, {});
    await program.parseAsync(['na', 'na', 'pr', 'some-content-id', 'req-1']);

    expect(displayErrorMock).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalled();
  });

  it('Should call pr command', async () => {
    // Setup specific config for this test
    const testConfig = {
      ...mockConfig,
      contentSource: 'text',
      requirementSource: 'text',
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'text',
        },
        review: {
          requirementSource: 'text',
          contentSource: 'text',
        },
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    // Mock the gh provider
    const ghProvider = vi.fn().mockResolvedValue('PR Diff Content');
    vi.doMock('#src/sources/ghPrDiffSource.js', () => ({
      get: ghProvider,
    }));

    prCommand(program, {});
    await program.parseAsync(['na', 'na', 'pr', '123']);

    expect(review).toHaveBeenCalledWith(
      'PR-123',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      '\nProvided GitHub diff follows within github-1234567 block\n<github-1234567>\nPR Diff Content\n</github-1234567>\n',
      expect.objectContaining({
        contentSource: 'text',
      }),
      'pr',
      expect.any(Object),
      { prId: '123' }
    );
  });

  it('Should fail loudly when the content provider resolves to no content', async () => {
    const testConfig = {
      ...mockConfig,
      contentSource: 'text',
      requirementSource: 'text',
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'text',
        },
        review: {
          requirementSource: 'text',
          contentSource: 'text',
        },
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    // ghPrDiffSource returns null (with a warning) for an invalid PR number instead of throwing.
    // Mock the exact module the github content provider imports (CONTENT_SOURCES.github) so the
    // null genuinely flows through getCommandSourceInput rather than the test passing by accident.
    const ghProvider = vi.fn().mockResolvedValue(null);
    vi.doMock('@gaunt-sloth/review/sources/ghPrDiffSource.js', () => ({
      get: ghProvider,
    }));

    prCommand(program, {});
    await program.parseAsync(['na', 'na', 'pr', '123']);

    // Prove the mocked provider was actually exercised, then assert the guard fired.
    expect(ghProvider).toHaveBeenCalled();
    expect(displayErrorMock).toHaveBeenCalledWith(
      'Could not retrieve PR content for "123". Cannot continue with review.'
    );
    expect(review).not.toHaveBeenCalled();
  });

  it('Should call pr command with requirements', async () => {
    // Setup specific config for this test
    const testConfig = {
      ...mockConfig,
      requirementSource: 'text',
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'text',
        },
        review: {},
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    // Mock the gh provider
    const ghProvider = vi.fn().mockResolvedValue('PR Diff Content');
    vi.doMock('#src/sources/ghPrDiffSource.js', () => ({
      get: ghProvider,
    }));

    // Mock the text provider for requirements
    const textProvider = vi.fn().mockResolvedValue('Requirements content');
    vi.doMock('#src/sources/textSource.js', () => ({
      get: textProvider,
    }));

    prCommand(program, {});
    await program.parseAsync(['na', 'na', 'pr', '123', 'req-456']);

    expect(review).toHaveBeenCalledWith(
      'PR-123',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      '\nProvided requirements follows within text-1234567 block\n<text-1234567>\nRequirements content\n</text-1234567>\n\n\nProvided GitHub diff follows within github-1234567 block\n<github-1234567>\nPR Diff Content\n</github-1234567>\n',
      expect.objectContaining({}),
      'pr',
      expect.any(Object),
      { prId: '123' }
    );
  });

  it('Should display meaningful error, when JIRA is enabled, but JIRA token is absent', async () => {
    // Setup config that will trigger JIRA error (missing token)
    const errorConfig = {
      ...mockConfig,
      requirementSource: 'jira-legacy',
      requirementSourceConfig: {
        'jira-legacy': {
          username: 'test-user',
          baseUrl: 'https://test-jira.atlassian.net/rest/api/2/issue/',
          // Note: no token provided
        },
      },
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'jira-legacy',
        },
        review: {},
      },
    };
    configMock.initConfig.mockResolvedValue(errorConfig);

    const testOutput = { text: '' };

    // Mock systemUtils to ensure environment variables don't interfere with the test
    vi.mock('#src/utils/systemUtils.js', () => ({
      env: {}, // Empty env object to ensure no environment variables are used
      error: vi.fn(),
      exit: vi.fn(),
      getCurrentWorkDir: vi.fn().mockReturnValue('/mock/dir'),
      getUseColour: vi.fn().mockReturnValue(false),
      log: vi.fn(),
      setExitCode: vi.fn(),
    }));

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();
    program.configureOutput({
      writeOut: (str: string) => (testOutput.text += str),
      writeErr: (str: string) => (testOutput.text += str),
    });

    prCommand(program, {});

    // prId must be numeric now (the pr command validates it upfront for the github content
    // source); the requirements fetch below is what this test exercises.
    await expect(program.parseAsync(['na', 'na', 'pr', '42', 'JIRA-123'])).rejects.toThrow(
      'Missing JIRA Legacy API token. ' +
        'The legacy token can be defined as JIRA_LEGACY_API_TOKEN environment variable ' +
        'or as "token" in config.'
    );
  });

  it('Should display predefined providers in help', async () => {
    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();
    const testOutput = { text: '' };

    program.configureOutput({
      writeOut: (str: string) => (testOutput.text += str),
      writeErr: (str: string) => (testOutput.text += str),
    });

    prCommand(program, {});

    const commandUnderTest = program.commands.find((c) => c.name() === 'pr');
    expect(commandUnderTest).toBeDefined();
    commandUnderTest?.outputHelp();

    // Verify requirements providers are displayed
    expect(testOutput.text).toContain('--requirements-source <requirementSource>');
    expect(testOutput.text).toContain('(choices: "jira-legacy", "jira", "github", "text", "file")');
  });

  it('Should call pr command with message parameter', async () => {
    // Setup specific config for this test
    const testConfig = {
      ...mockConfig,
      contentSource: 'text',
      requirementSource: 'text',
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'text',
        },
        review: {
          requirementSource: 'text',
          contentSource: 'text',
        },
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    // Mock the gh provider
    const ghProvider = vi.fn().mockResolvedValue('PR Diff Content');
    vi.doMock('#src/sources/ghPrDiffSource.js', () => ({
      get: ghProvider,
    }));

    prCommand(program, {});
    await program.parseAsync([
      'na',
      'na',
      'pr',
      '123',
      '-m',
      'Please pay attention to security issues',
    ]);

    expect(review).toHaveBeenCalledWith(
      'PR-123',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      '\nProvided GitHub diff follows within github-1234567 block\n<github-1234567>\nPR Diff Content\n</github-1234567>\n\n\nProvided user message follows within message-1234567 block\n<message-1234567>\nPlease pay attention to security issues\n</message-1234567>\n',
      expect.objectContaining({
        contentSource: 'text',
      }),
      'pr',
      expect.any(Object),
      { prId: '123' }
    );
  });

  it('Should call pr command with message and requirements', async () => {
    // Setup specific config for this test
    const testConfig = {
      ...mockConfig,
      requirementSource: 'text',
      commands: {
        pr: {
          contentSource: 'github',
          requirementSource: 'text',
        },
        review: {},
      },
      streamOutput: false,
    };
    configMock.initConfig.mockResolvedValue(testConfig);

    const { prCommand } = await import('#src/commands/prCommand.js');
    const program = new Command();

    // Mock the gh provider
    const ghProvider = vi.fn().mockResolvedValue('PR Diff Content');
    vi.doMock('#src/sources/ghPrDiffSource.js', () => ({
      get: ghProvider,
    }));

    // Mock the text provider for requirements
    const textProvider = vi.fn().mockResolvedValue('Requirements content');
    vi.doMock('#src/sources/textSource.js', () => ({
      get: textProvider,
    }));

    prCommand(program, {});
    await program.parseAsync(['na', 'na', 'pr', '123', 'req-456', '-m', 'Focus on performance']);

    expect(review).toHaveBeenCalledWith(
      'PR-123',
      'INTERNAL BACKSTORY\nPROJECT GUIDELINES\nREVIEW INSTRUCTIONS',
      '\nProvided requirements follows within text-1234567 block\n<text-1234567>\nRequirements content\n</text-1234567>\n\n\nProvided GitHub diff follows within github-1234567 block\n<github-1234567>\nPR Diff Content\n</github-1234567>\n\n\nProvided user message follows within message-1234567 block\n<message-1234567>\nFocus on performance\n</message-1234567>\n',
      expect.objectContaining({}),
      'pr',
      expect.any(Object),
      { prId: '123' }
    );
  });
});
