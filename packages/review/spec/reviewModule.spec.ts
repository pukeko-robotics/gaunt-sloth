import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { GthConfig } from '#src/config.js';
import {
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  type BaseMessage as Message,
} from '@langchain/core/messages';
import {
  BaseChatModel,
  BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';

const gthAgentRunnerMock = vi.fn(function GthAgentRunnerMock() {
  return gthAgentRunnerInstanceMock;
});
const gthAgentRunnerInstanceMock = {
  init: vi.fn(),
  processMessages: vi.fn(),
  cleanup: vi.fn(),
};
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
  default: {
    resolve: vi.fn(),
  },
};
vi.mock('node:path', () => pathMock);

// Mock systemUtils module. `execAsync` is here because the gh read-file tool the review module
// injects shells out through this same module; the CFG-52 cap test below actually INVOKES that
// tool, so the `gh` calls have to land on a mock rather than the machine's real GitHub CLI.
const systemUtilsMock = {
  getCurrentWorkDir: vi.fn(),
  exit: vi.fn(),
  setExitCode: vi.fn(),
  execAsync: vi.fn(),
  stdout: {
    write: vi.fn(),
  },
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

// Mock consoleUtils module
const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayError: vi.fn(),
  displayDebug: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  defaultStatusCallback: vi.fn(),
  initSessionLogging: vi.fn(),
  flushSessionLog: vi.fn(),
  stopSessionLogging: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

// Mock pathUtils module
const fileUtilsMock = {
  getGslothFilePath: vi.fn(),
  gslothDirExists: vi.fn(),
  getCommandOutputFilePath: vi.fn(),
  toFileSafeString: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  generateStandardFileName: vi.fn(),
  appendToFile: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

const ProgressIndicatorMock = vi.fn(function ProgressIndicatorMock() {
  return ProgressIndicatorInstanceMock;
});
const ProgressIndicatorInstanceMock = {
  stop: vi.fn(),
  indicate: vi.fn(),
};
vi.mock('#src/utils/ProgressIndicator.js', () => ({
  ProgressIndicator: ProgressIndicatorMock,
}));

const artifactStoreMock = {
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
};
vi.mock('#src/state/artifactStore.js', () => artifactStoreMock);

// Mock llmUtils module
const llmUtilsMock = {
  invoke: vi.fn(),
  getNewRunnableConfig: vi.fn().mockReturnValue({
    recursionLimit: 1000,
    configurable: { thread_id: 'test-thread-id' },
  }),
};
vi.mock('#src/utils/llmUtils.js', () => llmUtilsMock);

// Create a complete mock config for prop drilling
const BASE_GTH_CONFIG: Pick<
  GthConfig,
  | 'contentSource'
  | 'requirementSource'
  | 'streamOutput'
  | 'commands'
  | 'filesystem'
  | 'useColour'
  | 'writeOutputToFile'
  | 'streamSessionInferenceLog'
  | 'canInterruptInferenceWithEsc'
  | 'includeCurrentDateAfterGuidelines'
> = {
  contentSource: 'file',
  requirementSource: 'file',
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
  streamSessionInferenceLog: true,
  canInterruptInferenceWithEsc: true,
  includeCurrentDateAfterGuidelines: false,
};

const mockConfig: GthConfig = {
  ...BASE_GTH_CONFIG,
  llm: new FakeListChatModel({
    responses: ['LLM Review Response'],
  }) as BaseChatModel<BaseChatModelCallOptions, AIMessageChunk>,
} as GthConfig;

// Mock config module. CFG-52 — this is a PARTIAL mock: the module now also supplies the built-in
// tool resolvers the review module calls, and these tests assert what config actually resolves to,
// so those must be the real implementations rather than stubs.
vi.mock('#src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#src/config.js')>()),
  GthConfig: {},
}));

describe('reviewModule', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    artifactStoreMock.getArtifact.mockReturnValue(undefined);

    // Setup mock for our new generateStandardFileName function
    fileUtilsMock.generateStandardFileName.mockReturnValue('gth_2025-05-17_21-00-00_REVIEW.md');
    // Setup both the top-level resolve and the default.resolve functions
    const resolveMock = (path: string, name: string) => {
      if (name && name.includes('gth_')) return 'test-review-file-path.md';
      return '';
    };
    pathMock.resolve.mockImplementation(resolveMock);
    pathMock.default.resolve.mockImplementation(resolveMock);

    // Setup pathUtils mocks
    fileUtilsMock.getGslothFilePath.mockReturnValue('test-review-file-path.md');
    fileUtilsMock.gslothDirExists.mockReturnValue(false);
    fileUtilsMock.getCommandOutputFilePath.mockImplementation((config: any, _source: string) => {
      if (config.writeOutputToFile === false) return null;
      if (config.writeOutputToFile === true) return 'test-review-file-path.md';
      return String(config.writeOutputToFile);
    });

    ProgressIndicatorMock.mockClear();
    ProgressIndicatorInstanceMock.stop.mockReset();
    ProgressIndicatorInstanceMock.indicate.mockReset();

    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('LLM Review Response');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);
  });

  it('should invoke LLM and write review to file using prop drilling', async () => {
    // Import the module after setting up mocks
    const { review } = await import('#src/modules/reviewModule.js');

    // Call review function with config (prop drilling)
    await review('test-source', 'test-preamble', 'test-diff', mockConfig);

    // Verify that runner was called with correct parameters
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledWith([
      new HumanMessage('test-diff'),
    ]);

    expect(consoleUtilsMock.initSessionLogging).toHaveBeenCalled();

    // Verify that displaySuccess was called
    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
      expect.stringContaining('test-review-file-path.md')
    );

    // Verify that ProgressIndicator.stop() was called
    expect(ProgressIndicatorInstanceMock.stop).toHaveBeenCalled();
    expect(artifactStoreMock.deleteArtifact).toHaveBeenCalledWith('gsloth.review.rate');
  });

  // GS2-79 — the review/rating composition site, which the GS2-65 provider-contract guard does not
  // reach: that guard exercises runSingleShot/runConversation, both of which were converted long
  // ago, so it stayed green through the whole window in which `gth review` and `gth pr` were broken
  // on Anthropic. This is the site that regressed.
  //
  // The assertion is derived from the MECHANISM, not from a literal message list: the agent
  // composes its own system prompt and hands it to createAgent as `systemPrompt`, so what the
  // provider finally receives is [<agent-composed system>, ...whatever the caller passed]. That
  // request is rejected by @langchain/anthropic ("System messages are only permitted as the first
  // passed message") exactly when a system message lands at any index above 0 — which is precisely
  // what a caller-side leading SystemMessage produces. Asserting the rejected SHAPE rather than
  // "review still works" is what makes this bite for both defects at once: a second system message
  // anywhere, and a system message that is not first.
  it.each(['review', 'pr'] as const)(
    'hands the runner a message list that cannot produce a non-first system message (%s)',
    async (command) => {
      const { review } = await import('#src/modules/reviewModule.js');

      await review('test-source', 'test-preamble', 'test-diff', mockConfig, command);

      const messages = gthAgentRunnerInstanceMock.processMessages.mock.calls.at(
        -1
      )?.[0] as Message[];
      expect(messages).toBeDefined();

      // What the provider actually sees once the agent prepends its own composed system prompt.
      const asTheProviderSeesIt: Message[] = [new SystemMessage('AGENT-COMPOSED'), ...messages];
      const offendingIndex = asTheProviderSeesIt.findIndex(
        (message, index) => SystemMessage.isInstance(message) && index > 0
      );
      expect(offendingIndex).toBe(-1);
      // Stated the other way round too, so the guard reads as the rule it enforces: at most ONE
      // system message reaches the provider, and it is the agent's own.
      expect(asTheProviderSeesIt.filter((m) => SystemMessage.isInstance(m))).toHaveLength(1);

      // The caller contributes the human turn and nothing else; the preamble it still passes
      // positionally must not be smuggled in under some other message type either.
      expect(messages).toHaveLength(1);
      expect(HumanMessage.isInstance(messages[0])).toBe(true);
      expect(messages.map((m) => m.content)).not.toContain('test-preamble');
    }
  );

  it('should write review to a specified string path when writeOutputToFile is a string', async () => {
    // Arrange: configure to use a specific filename via string path
    const configWithStringPath = {
      ...mockConfig,
      writeOutputToFile: 'custom/review.md',
    } as unknown as GthConfig;

    // Mock resolver to respect provided path as-is
    fileUtilsMock.getGslothFilePath.mockReturnValue('custom/review.md');
    fileUtilsMock.getCommandOutputFilePath.mockImplementation((config: any, _source: string) => {
      if (config.writeOutputToFile === false) return null;
      if (config.writeOutputToFile === true) return 'test-review-file-path.md';
      return String(config.writeOutputToFile);
    });

    // Act
    const { review } = await import('#src/modules/reviewModule.js');
    await review('test-source', 'test-preamble', 'test-diff', configWithStringPath);

    // Assert
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledWith([
      new HumanMessage('test-diff'),
    ]);
    expect(consoleUtilsMock.initSessionLogging).toHaveBeenCalled();

    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
      expect.stringContaining('custom/review.md')
    );
  });

  // Specific test to verify that prop drilling works with different config objects
  it('should work with different config objects via prop drilling', async () => {
    // Create a different config object to prove prop drilling works
    const differentConfig: GthConfig = {
      ...BASE_GTH_CONFIG,
      streamOutput: true, // Different from default mockConfig
      llm: {} as BaseChatModel, // Model shoudn't matter here, because agent runner is mocked
      writeBinaryOutputsToFile: true,
    };

    // Set a different response for this specific test
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('Different LLM Response');

    // Import the module after setting up mocks
    const { review } = await import('#src/modules/reviewModule.js');

    // Call review with the different config to prove prop drilling works
    await review('test-source', 'test-preamble', 'test-diff', differentConfig);

    // Verify the different config was used
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledWith([
      new HumanMessage('test-diff'),
    ]);

    expect(consoleUtilsMock.initSessionLogging).toHaveBeenCalled();

    // Since streamOutput is true, the model's answer is written through the STREAM channel — the
    // only thing `display` emits on a review run is the REL-12 run header, exactly once.
    expect(consoleUtilsMock.display).toHaveBeenCalledTimes(1);
    expect(consoleUtilsMock.display).toHaveBeenCalledWith(
      // This config resolves no model, so the label is dropped and the line ends after the command.
      expect.stringContaining('Gaunt Sloth · review')
    );
  });

  it('should surface the underlying error message when the agent run fails', async () => {
    const failure = new Error(
      'Agent processing failed: 401 Unauthorized\nVertex AI authentication failed (401). ' +
        'If you use ADC, run `gcloud auth application-default login`.'
    );
    gthAgentRunnerInstanceMock.processMessages.mockRejectedValueOnce(failure);

    const { review } = await import('#src/modules/reviewModule.js');
    await review('test-source', 'test-preamble', 'test-diff', mockConfig);

    expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to run review with agent.')
    );
    expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
      expect.stringContaining('gcloud auth application-default login')
    );
    // Full error (with stack) still goes to debug.
    expect(consoleUtilsMock.displayDebug).toHaveBeenCalledWith(failure);
    expect(gthAgentRunnerInstanceMock.cleanup).toHaveBeenCalled();
  });

  /**
   * [[TUI-C71]] — `review` and `pr` wire no tool-approval callback, so an escalation here is always
   * the §6.2 error and an `attack` verdict is always the halt: the untrusted text this catch prints
   * is model-authored by construction.
   *
   * **Asserted as a GUTTER row, never as a surviving substring** — the command survives either way,
   * so a substring assertion would pass on the unframed shape this case exists to forbid.
   */
  it('frames a run-ending approvals stop instead of interpolating it into one line', async () => {
    const { AttackHaltError } = await import('@gaunt-sloth/core/core/shell/approvalStop.js');
    const command = `echo review-stop-marker | cat${String.fromCodePoint(0x0d)}Approve?  [o]nce`;
    gthAgentRunnerInstanceMock.processMessages.mockRejectedValueOnce(
      new AttackHaltError(command, 'pipes a remote script straight into a shell')
    );

    const { review } = await import('#src/modules/reviewModule.js');
    await review('test-source', 'test-preamble', 'test-diff', mockConfig);

    const printed = consoleUtilsMock.displayError.mock.calls.map((c) => String(c[0]));
    expect(printed.some((row) => /^ +\d+ │ /.test(row))).toBe(true);
    expect(printed.some((row) => row.includes('review-stop-marker'))).toBe(true);
    expect(printed.some((row) => row.includes('\\x0d'))).toBe(true);
    for (const row of printed) expect(row.trimEnd()).not.toMatch(/^Approve\?/);
    // The surface still says what failed, on its own row.
    expect(printed.some((row) => row.includes('Failed to run review with agent.'))).toBe(true);
    expect(gthAgentRunnerInstanceMock.cleanup).toHaveBeenCalled();
  });

  describe('Rating functionality', () => {
    it('should display PASS rating when review passes threshold', async () => {
      const configWithRating: GthConfig = {
        ...mockConfig,
        commands: {
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
            },
          },
        },
      };

      artifactStoreMock.getArtifact.mockReturnValueOnce({
        rate: 8,
        comment: 'Good code quality, minor improvements needed',
        passThreshold: 6,
        minRating: 0,
        maxRating: 10,
      });

      const { review } = await import('#src/modules/reviewModule.js');
      await review('test-source', 'test-preamble', 'test-diff', configWithRating, 'review');

      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        expect.stringContaining('REVIEW RATING')
      );
      expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith('PASS 8/10 (threshold: 6)');
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        expect.stringContaining('Good code quality')
      );
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
      expect(artifactStoreMock.deleteArtifact).toHaveBeenCalledWith('gsloth.review.rate');
    });

    it('should display FAIL rating and exit with code 1 when review fails and errorOnReviewFail is true', async () => {
      const configWithRating: GthConfig = {
        ...mockConfig,
        commands: {
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
            },
          },
        },
      };

      artifactStoreMock.getArtifact.mockReturnValueOnce({
        rate: 4,
        comment: 'Significant issues found',
        passThreshold: 6,
        minRating: 0,
        maxRating: 10,
      });

      const { review } = await import('#src/modules/reviewModule.js');
      await review('test-source', 'test-preamble', 'test-diff', configWithRating, 'review');

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith('FAIL 4/10 (threshold: 6)');
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
    });

    it('should display FAIL rating but not exit when errorOnReviewFail is false', async () => {
      const configWithRating: GthConfig = {
        ...mockConfig,
        commands: {
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: false,
            },
          },
        },
      };

      artifactStoreMock.getArtifact.mockReturnValueOnce({
        rate: 3,
        comment: 'Major refactoring needed',
        passThreshold: 6,
        minRating: 0,
        maxRating: 10,
      });

      const { review } = await import('#src/modules/reviewModule.js');
      await review('test-source', 'test-preamble', 'test-diff', configWithRating, 'review');

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith('FAIL 3/10 (threshold: 6)');
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('should not display rating when rating config is not provided', async () => {
      const configWithoutRating: GthConfig = {
        ...mockConfig,
        commands: {},
      };

      gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('Regular review response');

      const { review } = await import('#src/modules/reviewModule.js');
      await review('test-source', 'test-preamble', 'test-diff', configWithoutRating, 'review');

      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalledWith(
        expect.stringContaining('REVIEW RATING')
      );
      expect(artifactStoreMock.getArtifact).not.toHaveBeenCalled();
      expect(artifactStoreMock.deleteArtifact).toHaveBeenCalledWith('gsloth.review.rate');
    });

    it('should use default values when rating config is empty object', async () => {
      const configWithEmptyRating: GthConfig = {
        ...mockConfig,
        commands: {
          review: {
            rating: {},
          },
        },
      };

      artifactStoreMock.getArtifact.mockReturnValueOnce({
        rate: 7,
        comment: 'Meets standards',
        passThreshold: 6,
        minRating: 0,
        maxRating: 10,
      });

      const { review } = await import('#src/modules/reviewModule.js');
      await review('test-source', 'test-preamble', 'test-diff', configWithEmptyRating, 'review');

      // Should use default threshold of 6 and default errorOnReviewFail of true
      expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith('PASS 7/10 (threshold: 6)');
    });

    it('should handle pr command with rating config', async () => {
      const configWithPrRating: GthConfig = {
        ...mockConfig,
        commands: {
          pr: {
            rating: {
              enabled: true,
              passThreshold: 7,
              errorOnReviewFail: true,
            },
          },
        },
      };

      artifactStoreMock.getArtifact.mockReturnValueOnce({
        rate: 9,
        comment: 'Excellent PR',
        passThreshold: 7,
        minRating: 0,
        maxRating: 10,
      });

      const { review } = await import('#src/modules/reviewModule.js');
      await review('PR-123', 'test-preamble', 'test-diff', configWithPrRating, 'pr');

      expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith('PASS 9/10 (threshold: 7)');
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('should warn when rating artifact is missing', async () => {
      const configWithRating: GthConfig = {
        ...mockConfig,
        commands: {
          review: {
            rating: {
              enabled: true,
            },
          },
        },
      };

      artifactStoreMock.getArtifact.mockReturnValueOnce(undefined);

      const { review } = await import('#src/modules/reviewModule.js');
      await review('test-source', 'test-preamble', 'test-diff', configWithRating, 'review');

      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        'Rating middleware did not return a score for review command.'
      );
    });
  });

  describe('REL-2 gh api file-read tool injection', () => {
    it('injects the gh read-file tool when the pr content source is github', async () => {
      const config = {
        ...mockConfig,
        tools: undefined,
        commands: { pr: { contentSource: 'github' } },
      } as unknown as GthConfig;

      const { review } = await import('#src/modules/reviewModule.js');
      await review('PR-1', 'preamble', 'diff', config, 'pr');

      expect(config.tools).toBeDefined();
      expect(
        (config.tools ?? []).some(
          (t) => typeof t === 'object' && t !== null && 'name' in t && t.name === 'gth_gh_read_file'
        )
      ).toBe(true);
    });

    it('does NOT inject the tool for non-github (file) reviews', async () => {
      const config = {
        ...mockConfig,
        tools: undefined,
        contentSource: 'file',
        commands: { review: { contentSource: 'file' } },
      } as unknown as GthConfig;

      const { review } = await import('#src/modules/reviewModule.js');
      await review('test-source', 'preamble', 'diff', config, 'review');

      const tools = config.tools ?? [];
      expect(
        tools.some(
          (t) => typeof t === 'object' && t !== null && 'name' in t && t.name === 'gth_gh_read_file'
        )
      ).toBe(false);
    });

    it('does not register the tool twice', async () => {
      const config = {
        ...mockConfig,
        tools: undefined,
        commands: { pr: { contentSource: 'github' } },
      } as unknown as GthConfig;

      const { review } = await import('#src/modules/reviewModule.js');
      await review('PR-1', 'preamble', 'diff', config, 'pr');
      await review('PR-1', 'preamble', 'diff', config, 'pr');

      const count = (config.tools ?? []).filter(
        (t) => typeof t === 'object' && t !== null && 'name' in t && t.name === 'gth_gh_read_file'
      ).length;
      expect(count).toBe(1);
    });
  });

  /**
   * CFG-52 — the tool is now gated on the unified `builtInTools` registry, resolved per-command
   * first and then root. Each case is a PAIR: the "off" half alone would also pass against an
   * implementation that never injects, and the "on" half alone against one that never reads config.
   */
  describe('CFG-52 builtInTools gating of the gh api file-read tool', () => {
    const hasGhReadFile = (config: GthConfig) =>
      (config.tools ?? []).some(
        (t) => typeof t === 'object' && t !== null && 'name' in t && t.name === 'gth_gh_read_file'
      );

    const runPr = async (extra: Record<string, unknown>) => {
      const config = {
        ...mockConfig,
        tools: undefined,
        commands: { pr: { contentSource: 'github' } },
        ...extra,
      } as unknown as GthConfig;
      const { review } = await import('#src/modules/reviewModule.js');
      await review('PR-1', 'preamble', 'diff', config, 'pr');
      return config;
    };

    it('injects it with the default registry and NOT when the registry disables it', async () => {
      // Opt-out: the shipped default names other tools, never this one, and it is still injected.
      expect(hasGhReadFile(await runPr({ builtInTools: ['gth_checklist', 'gth_grep'] }))).toBe(
        true
      );
      // …and a user who writes it as false gets no tool.
      expect(hasGhReadFile(await runPr({ builtInTools: { gth_gh_read_file: false } }))).toBe(false);
    });

    it('lets commands.pr disable it over a root entry enabling it, and applies the root entry alone', async () => {
      const perCommandWins = await runPr({
        builtInTools: { gth_gh_read_file: true },
        commands: {
          pr: { contentSource: 'github', builtInTools: { gth_gh_read_file: false } },
        },
      });
      expect(hasGhReadFile(perCommandWins)).toBe(false);

      // No per-command registry at all → the root entry governs the pr run.
      const rootApplies = await runPr({ builtInTools: { gth_gh_read_file: false } });
      expect(hasGhReadFile(rootApplies)).toBe(false);
      const rootEnables = await runPr({ builtInTools: { gth_gh_read_file: true } });
      expect(hasGhReadFile(rootEnables)).toBe(true);
    });

    it('gates the review command on its own commands.review registry', async () => {
      const base = {
        ...mockConfig,
        tools: undefined,
        contentSource: 'github',
      };
      const { review } = await import('#src/modules/reviewModule.js');

      const disabled = {
        ...base,
        commands: {
          review: { contentSource: 'github', builtInTools: { gth_gh_read_file: false } },
        },
      } as unknown as GthConfig;
      await review('src', 'preamble', 'diff', disabled, 'review');
      expect(hasGhReadFile(disabled)).toBe(false);

      const enabled = {
        ...base,
        commands: { review: { contentSource: 'github' } },
      } as unknown as GthConfig;
      await review('src', 'preamble', 'diff', enabled, 'review');
      expect(hasGhReadFile(enabled)).toBe(true);
    });

    /**
     * The injected tool must carry the cap from the registry of the command it was injected FOR.
     * The tool factory defaults its `command` argument to `pr`, so an injection site that does not
     * pass one still compiles and still injects — and a `gth review` then silently runs under
     * `commands.pr`'s cap. Every other cap test calls the factory directly and therefore cannot
     * see that wiring at all; this one goes through the review module, which is where it lives.
     *
     * ONE file, over BOTH caps, so each command truncates and the marker it returns names its own
     * cap number. Sizing the file between the two caps would only BOUND the `review` half — "some
     * cap at least as big as this file" — which any larger cap satisfies, including the shipped
     * 600 KiB default a `gth review` gets when it ignores its configured `maxBytes` entirely.
     * Naming the number is what closes that. The whole-file (under-cap) path is covered directly
     * in `ghReadFileTool.spec.ts` and is not what this case is for.
     */
    it('gives each command the cap from its OWN registry, through the injected tool', async () => {
      const PR_CAP = 40;
      const REVIEW_CAP = 400;
      const FILE_TEXT = 'w'.repeat(500); // over BOTH caps, so each marker names its own number

      systemUtilsMock.execAsync.mockImplementation(async (command: string) => {
        if (command.startsWith('gh pr view')) {
          return JSON.stringify({
            headRefName: 'main',
            headRepository: { name: 'hello-world' },
            headRepositoryOwner: { login: 'octocat' },
          });
        }
        return JSON.stringify({
          type: 'file',
          encoding: 'base64',
          path: 'a.txt',
          content: Buffer.from(FILE_TEXT, 'utf8').toString('base64'),
        });
      });

      const commands = {
        pr: {
          contentSource: 'github',
          builtInTools: { gth_gh_read_file: { maxBytes: PR_CAP } },
        },
        review: {
          contentSource: 'github',
          builtInTools: { gth_gh_read_file: { maxBytes: REVIEW_CAP } },
        },
      };

      const { review } = await import('#src/modules/reviewModule.js');

      const readOneFileVia = async (command: 'pr' | 'review'): Promise<string> => {
        // A FRESH config per run: the injector appends into `config.tools` in place and dedupes by
        // tool name, so a reused object would hand the second command the FIRST command's tool.
        const config = {
          ...mockConfig,
          tools: undefined,
          commands,
        } as unknown as GthConfig;
        await review('src', 'preamble', 'diff', config, command);
        const injected = (config.tools ?? []).find(
          (t) => typeof t === 'object' && t !== null && 'name' in t && t.name === 'gth_gh_read_file'
        ) as unknown as { invoke: (args: { path: string }) => Promise<string> } | undefined;
        expect(injected).toBeDefined();
        return await injected!.invoke({ path: 'a.txt' });
      };

      // `pr`'s own 40-byte cap bites, and the marker names that cap rather than some other one…
      const asPr = await readOneFileVia('pr');
      expect(asPr).toContain('Partial contents of');
      expect(asPr).toContain(`gth_gh_read_file: file truncated at the ${PR_CAP}-byte cap`);

      // …and the very same file comes back cut at `review`'s own 400-byte cap, named as such.
      const asReview = await readOneFileVia('review');
      expect(asReview).toContain('Partial contents of');
      expect(
        asReview,
        `The review run did not truncate at its own ${REVIEW_CAP}-byte cap. Two causes produce an ` +
          `IDENTICAL failure here, so rule out both before looking further: (a) production — the ` +
          `review module stopped passing the command to the tool factory, whose argument defaults ` +
          `to pr; (b) this test — the fresh config per run above was removed, so the review run ` +
          `got back the tool the pr run had already injected. Otherwise read the cap the marker ` +
          `above actually names; it says which one was applied.`
      ).toContain(`gth_gh_read_file: file truncated at the ${REVIEW_CAP}-byte cap`);
    });
  });
});
