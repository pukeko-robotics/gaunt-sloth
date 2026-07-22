import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { GthConfig } from '#src/config.js';
import { AIMessageChunk, HumanMessage, SystemMessage } from '@langchain/core/messages';
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

// Mock systemUtils module
const systemUtilsMock = {
  getCurrentWorkDir: vi.fn(),
  exit: vi.fn(),
  setExitCode: vi.fn(),
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

// Mock config module
vi.mock('#src/config.js', () => ({
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
      new SystemMessage('test-preamble'),
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
      new SystemMessage('test-preamble'),
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
      new SystemMessage('test-preamble'),
      new HumanMessage('test-diff'),
    ]);

    expect(consoleUtilsMock.initSessionLogging).toHaveBeenCalled();

    // Since streamOutput is true, display should not be called
    expect(consoleUtilsMock.display).not.toHaveBeenCalled();
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
});
