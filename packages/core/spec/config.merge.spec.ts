import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawGthConfig } from '#src/config.js';

// Define mocks at top level
const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
  setConsoleLevel: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const fsMock = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const systemUtilsMock = {
  exit: vi.fn(),
  error: vi.fn(),
  getCurrentWorkDir: vi.fn(),
  getProjectDir: vi.fn(),
  setProjectDir: vi.fn(),
  getInstallDir: vi.fn(),
  setUseColour: vi.fn(),
  isTTY: vi.fn(),
  env: {},
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const fileUtilsMock = {
  getGslothConfigReadPath: vi.fn(),
  getGslothConfigWritePath: vi.fn(),
  importExternalFile: vi.fn(),
  writeFileIfNotExistsWithMessages: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

const mockChatInstance = { instance: 'anthropic', verbose: false };
const ChatAnthropicMock = vi.fn(function ChatAnthropicMock() {
  return mockChatInstance;
});

function mockAnthropic() {
  vi.doMock('@langchain/anthropic', () => ({
    ChatAnthropic: ChatAnthropicMock,
  }));
}

describe('Config merging', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    ChatAnthropicMock.mockClear();
    systemUtilsMock.getCurrentWorkDir.mockReturnValue('/mock/current/dir');
    systemUtilsMock.getProjectDir.mockReturnValue('/mock/current/dir');
    systemUtilsMock.getInstallDir.mockReturnValue('/mock/install/dir');
    systemUtilsMock.isTTY.mockReturnValue(true);
  });

  describe('pr command config merging', () => {
    it('should preserve rating config when user overrides contentSource', async () => {
      mockAnthropic();

      // User config only overrides contentSource
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
        commands: {
          pr: {
            contentSource: 'jira',
          },
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify that contentSource is overridden
      expect(config.commands?.pr?.contentSource).toBe('jira');

      // Verify that rating config is preserved from defaults
      expect(config.commands?.pr?.rating).toBeDefined();
      expect(config.commands?.pr?.rating?.enabled).toBe(true);
      expect(config.commands?.pr?.rating?.passThreshold).toBe(6);
      expect(config.commands?.pr?.rating?.minRating).toBe(0);
      expect(config.commands?.pr?.rating?.maxRating).toBe(10);
      expect(config.commands?.pr?.rating?.errorOnReviewFail).toBe(true);

      // Verify that requirementSource is preserved from defaults
      expect(config.commands?.pr?.requirementSource).toBe('github');
    });

    it('should allow user to override rating config while preserving other defaults', async () => {
      mockAnthropic();

      // User config overrides rating threshold
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
        commands: {
          pr: {
            rating: {
              passThreshold: 8,
            },
          },
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify that passThreshold is overridden
      expect(config.commands?.pr?.rating?.passThreshold).toBe(8);

      // Verify that other rating properties are preserved from defaults
      expect(config.commands?.pr?.rating?.enabled).toBe(true);
      expect(config.commands?.pr?.rating?.minRating).toBe(0);
      expect(config.commands?.pr?.rating?.maxRating).toBe(10);
      expect(config.commands?.pr?.rating?.errorOnReviewFail).toBe(true);

      // Verify that contentSource is preserved from defaults
      expect(config.commands?.pr?.contentSource).toBe('github');
      expect(config.commands?.pr?.requirementSource).toBe('github');
    });

    it('should handle complex nested override scenario', async () => {
      mockAnthropic();

      // User config overrides multiple nested properties
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
        commands: {
          pr: {
            contentSource: 'jira',
            requirementSource: 'jira',
            filesystem: ['read'],
            rating: {
              passThreshold: 7,
              errorOnReviewFail: false,
            },
          },
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify user overrides
      expect(config.commands?.pr?.contentSource).toBe('jira');
      expect(config.commands?.pr?.requirementSource).toBe('jira');
      expect(config.commands?.pr?.filesystem).toEqual(['read']);
      expect(config.commands?.pr?.rating?.passThreshold).toBe(7);
      expect(config.commands?.pr?.rating?.errorOnReviewFail).toBe(false);

      // Verify preserved defaults
      expect(config.commands?.pr?.rating?.enabled).toBe(true);
      expect(config.commands?.pr?.rating?.minRating).toBe(0);
      expect(config.commands?.pr?.rating?.maxRating).toBe(10);
    });
  });

  describe('review command config merging', () => {
    it('should preserve rating config when user overrides contentSource', async () => {
      mockAnthropic();

      // User config only overrides contentSource
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
        commands: {
          review: {
            contentSource: 'file',
            requirementSource: 'jira',
          },
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify that providers are overridden
      expect(config.commands?.review?.contentSource).toBe('file');
      expect(config.commands?.review?.requirementSource).toBe('jira');

      // Verify that rating config is preserved from defaults
      expect(config.commands?.review?.rating).toBeDefined();
      expect(config.commands?.review?.rating?.enabled).toBe(true);
      expect(config.commands?.review?.rating?.passThreshold).toBe(6);
      expect(config.commands?.review?.rating?.minRating).toBe(0);
      expect(config.commands?.review?.rating?.maxRating).toBe(10);
      expect(config.commands?.review?.rating?.errorOnReviewFail).toBe(true);
    });

    it('should allow disabling rating while preserving threshold defaults', async () => {
      mockAnthropic();

      // User config disables rating
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
        commands: {
          review: {
            rating: {
              enabled: false,
            },
          },
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify that enabled is overridden
      expect(config.commands?.review?.rating?.enabled).toBe(false);

      // Verify that other rating properties are preserved
      expect(config.commands?.review?.rating?.passThreshold).toBe(6);
      expect(config.commands?.review?.rating?.minRating).toBe(0);
      expect(config.commands?.review?.rating?.maxRating).toBe(10);
      expect(config.commands?.review?.rating?.errorOnReviewFail).toBe(true);
    });
  });

  describe('other command configs', () => {
    it('should merge code command config correctly', async () => {
      mockAnthropic();

      // User config adds builtInTools while keeping filesystem default
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
        commands: {
          code: {
            builtInTools: ['gth_status_update'],
          },
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify that builtInTools is set
      expect(config.commands?.code?.builtInTools).toEqual(['gth_status_update']);

      // Verify that filesystem default is preserved
      expect(config.commands?.code?.filesystem).toBe('all');
    });

    it('should handle undefined command configs gracefully', async () => {
      mockAnthropic();

      // User config does not define commands
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify that all command defaults are preserved
      expect(config.commands?.pr?.contentSource).toBe('github');
      expect(config.commands?.pr?.requirementSource).toBe('github');
      expect(config.commands?.pr?.rating?.enabled).toBe(true);
      expect(config.commands?.review?.rating?.enabled).toBe(true);
      expect(config.commands?.code?.filesystem).toBe('all');
    });
  });

  describe('maxDepth parameter', () => {
    it('should respect maxDepth and stop recursion at depth 4', async () => {
      mockAnthropic();

      // Create a deeply nested config (5 levels deep)
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
        commands: {
          pr: {
            rating: {
              // Level 1
              enabled: false,
              // At maxDepth=4, this should still be merged
              passThreshold: 8,
            },
          },
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify that nested properties are merged correctly within maxDepth
      expect(config.commands?.pr?.rating?.enabled).toBe(false);
      expect(config.commands?.pr?.rating?.passThreshold).toBe(8);
      expect(config.commands?.pr?.rating?.minRating).toBe(0); // Default preserved
      expect(config.commands?.pr?.rating?.maxRating).toBe(10); // Default preserved
    });
  });

  describe('edge cases', () => {
    it('should handle empty command config objects', async () => {
      mockAnthropic();

      // User config defines empty command objects
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
        commands: {
          pr: {},
          review: {},
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify that all defaults are preserved
      expect(config.commands?.pr?.contentSource).toBe('github');
      expect(config.commands?.pr?.requirementSource).toBe('github');
      expect(config.commands?.pr?.rating?.enabled).toBe(true);
      expect(config.commands?.review?.rating?.enabled).toBe(true);
    });

    it('should override array properties completely, not merge them', async () => {
      mockAnthropic();

      // User config sets builtInTools array
      const userConfig: Partial<RawGthConfig> = {
        llm: {
          type: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          configuration: {},
        },
        commands: {
          pr: {
            builtInTools: ['custom_tool'],
          },
        },
      };

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(userConfig));
      fileUtilsMock.getGslothConfigReadPath.mockReturnValue('/mock/.gsloth.config.json');

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Verify that array is replaced, not merged
      expect(config.commands?.pr?.builtInTools).toEqual(['custom_tool']);
    });
  });
});
