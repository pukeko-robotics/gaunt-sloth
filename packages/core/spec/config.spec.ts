import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawGthConfig } from '#src/config.js';
import { StatusLevel } from '#src/core/types.js';
import { platform } from 'node:os';

const fsMock = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const urlMock = {
  pathToFileURL: vi.fn(),
};
vi.mock('node:url', () => urlMock);

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

const utilsMock = {
  ProgressIndicator: vi.fn(),
  extractLastMessageContent: vi.fn(),
};
vi.mock('#src/utils/utils.js', () => utilsMock);

const fileUtilsMock = {
  writeFileIfNotExistsWithMessages: vi.fn(),
  importExternalFile: vi.fn(),
  importFromFilePath: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  toFileSafeString: vi.fn(),
  readFileSyncWithMessages: vi.fn(),
  getGslothConfigReadPath: vi.fn().mockImplementation((path: string) => `/mock/read/${path}`),
  getGslothConfigWritePath: vi.fn().mockImplementation((path: string) => `/mock/write/${path}`),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

const systemUtilsMock = {
  exit: vi.fn(),
  getCurrentWorkDir: vi.fn(),
  getInstallDir: vi.fn(),
  setUseColour: vi.fn(),
  isTTY: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

// Global config layer (CFG-3). By default the global path is a sentinel that the
// fs mocks below treat as non-existent, so existing tests see no global config.
// Individual tests override getGlobalGslothConfigReadPath to point at a real path.
const globalConfigUtilsMock = {
  getGlobalGslothConfigReadPath: vi
    .fn()
    .mockImplementation(() => '/mock/global-absent/no-such-config'),
  getGlobalGslothConfigWritePath: vi
    .fn()
    .mockImplementation((filename: string) => `/mock/global-write/${filename}`),
};
vi.mock('#src/utils/globalConfigUtils.js', () => globalConfigUtilsMock);

describe('config', async () => {
  beforeEach(async () => {
    // Reset mocks
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    // Reset and set up systemUtils mocks
    systemUtilsMock.getCurrentWorkDir.mockReturnValue('/mock/current/dir');
    systemUtilsMock.getInstallDir.mockReturnValue('/mock/install/dir');
    systemUtilsMock.isTTY.mockReturnValue(true);
    // Default: global config path is absent (sentinel never matched by fs mocks).
    globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
      () => '/mock/global-absent/no-such-config'
    );
    globalConfigUtilsMock.getGlobalGslothConfigWritePath.mockImplementation(
      (filename: string) => `/mock/global-write/${filename}`
    );
  });

  const customPathPrefix =
    platform() == 'win32' ? 'C:\\custom\\path\\config' : '/custom/path/config';

  describe('initConfig', () => {
    it('Should load JSON config when it exists', async () => {
      // Create a test config
      const jsonConfig = {
        llm: {
          type: 'vertexai',
        },
      } as RawGthConfig;

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the vertexai config module to process the config
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({});

      // It is easier to debug if messages checked first
      expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.display).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();

      expect(config).toEqual({
        consoleLevel: StatusLevel.INFO,
        llm: { type: 'vertexai' },
        contentSource: 'file',
        requirementSource: 'file',
        contentProvider: 'file',
        requirementsProvider: 'file',
        projectGuidelines: '.gsloth.guidelines.md',
        projectReviewInstructions: '.gsloth.review.md',
        streamOutput: true,
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
        useColour: true,
        filesystem: 'none',
        aiignore: {
          enabled: true,
          patterns: undefined,
        },
        debugLog: false,
        canInterruptInferenceWithEsc: true,
        streamSessionInferenceLog: true,
        commands: {
          pr: {
            contentSource: 'github',
            requirementSource: 'github',
            contentProvider: 'github',
            requirementsProvider: 'github',
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all' },
          ask: { filesystem: 'read' },
          chat: { filesystem: 'read' },
          api: {
            filesystem: 'read',
            port: 3000,
            cors: {
              allowOrigin: 'http://localhost:3000',
              allowMethods: 'POST, GET, OPTIONS',
              allowHeaders: 'Content-Type, Accept',
            },
          },
        },
        includeCurrentDateAfterGuidelines: false,
        modelDisplayName: undefined,
      });
    });

    it('Should try JS config when JSON config does not exist', async () => {
      const mockConfig = { llm: { type: 'anthropic' } };
      const mockConfigModule = {
        configure: vi.fn().mockResolvedValue(mockConfig),
      };

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return false;
        return path && path.includes('.gsloth.config.js');
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the import function - ensure it resolves successfully for JS config
      fileUtilsMock.importExternalFile.mockImplementation((path: string) => {
        if (path.includes('.gsloth.config.js')) {
          return Promise.resolve(mockConfigModule);
        }
        return Promise.reject(new Error('Not found'));
      });

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({});

      // It is easier to debug if messages checked first
      expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.display).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();

      expect(config).toEqual({
        consoleLevel: StatusLevel.INFO,
        llm: { type: 'anthropic' },
        contentSource: 'file',
        requirementSource: 'file',
        contentProvider: 'file',
        requirementsProvider: 'file',
        projectGuidelines: '.gsloth.guidelines.md',
        projectReviewInstructions: '.gsloth.review.md',
        streamOutput: true,
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
        useColour: true,
        filesystem: 'none',
        aiignore: {
          enabled: true,
          patterns: undefined,
        },
        debugLog: false,
        canInterruptInferenceWithEsc: true,
        streamSessionInferenceLog: true,
        commands: {
          pr: {
            contentSource: 'github',
            requirementSource: 'github',
            contentProvider: 'github',
            requirementsProvider: 'github',
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all' },
          ask: { filesystem: 'read' },
          chat: { filesystem: 'read' },
          api: {
            filesystem: 'read',
            port: 3000,
            cors: {
              allowOrigin: 'http://localhost:3000',
              allowMethods: 'POST, GET, OPTIONS',
              allowHeaders: 'Content-Type, Accept',
            },
          },
        },
        includeCurrentDateAfterGuidelines: false,
      });
    });

    it('Should accept consoleLevel as string in JSON config', async () => {
      const jsonConfig = {
        llm: {
          type: 'vertexai',
        },
        consoleLevel: 'debug',
      } as RawGthConfig;

      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');

      const config = await initConfig({});

      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.setConsoleLevel).toHaveBeenCalledWith(StatusLevel.DEBUG);
      expect(config.consoleLevel).toBe(StatusLevel.DEBUG);
    });

    it('Should try MJS config when JSON and JS configs do not exist', async () => {
      const mockConfigModule = {
        configure: vi.fn(),
      };
      const mockConfig = { llm: { type: 'groq' } };
      mockConfigModule.configure.mockResolvedValue(mockConfig);

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return false;
        if (path && path.includes('.gsloth.config.js')) return false;
        return path && path.includes('.gsloth.config.mjs');
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the import function
      fileUtilsMock.importExternalFile.mockImplementation((path: string) => {
        if (path.includes('.gsloth.config.mjs')) return Promise.resolve(mockConfigModule);
        return Promise.reject(new Error('Not found'));
      });

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({});

      // It is easier to debug if messages checked first
      expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.display).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();

      expect(config).toEqual({
        consoleLevel: StatusLevel.INFO,
        llm: { type: 'groq' },
        contentSource: 'file',
        requirementSource: 'file',
        contentProvider: 'file',
        requirementsProvider: 'file',
        projectGuidelines: '.gsloth.guidelines.md',
        projectReviewInstructions: '.gsloth.review.md',
        streamOutput: true,
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
        useColour: true,
        filesystem: 'none',
        aiignore: {
          enabled: true,
          patterns: undefined,
        },
        debugLog: false,
        canInterruptInferenceWithEsc: true,
        streamSessionInferenceLog: true,
        commands: {
          pr: {
            contentSource: 'github',
            requirementSource: 'github',
            contentProvider: 'github',
            requirementsProvider: 'github',
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all' },
          ask: { filesystem: 'read' },
          chat: { filesystem: 'read' },
          api: {
            filesystem: 'read',
            port: 3000,
            cors: {
              allowOrigin: 'http://localhost:3000',
              allowMethods: 'POST, GET, OPTIONS',
              allowHeaders: 'Content-Type, Accept',
            },
          },
        },
        includeCurrentDateAfterGuidelines: false,
      });
    });

    it('Should exit when no config files exist', async () => {
      // Set up fs mocks for this specific test
      fsMock.existsSync.mockReturnValue(false);

      // Ensure pathUtils returns mock paths
      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Ensure custom config path is cleared
      const { initConfig } = await import('#src/config.js');

      // Function under test
      try {
        await initConfig({});
      } catch {
        // the mock exit does not exit, so we reach to unexpected error
      }

      // It is easier to debug if messages checked first
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        'No configuration file found. Please create one of: ' +
          '.gsloth.config.json, .gsloth.config.js, or .gsloth.config.mjs ' +
          'in your project directory.'
      );

      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('global config layer (CFG-3)', () => {
    const GLOBAL_JSON_PATH = '/mock/global/.gsloth.config.json';
    const PROJECT_JSON_MARKER = '.gsloth.config.json';

    /**
     * Wire the global config path to a distinct location and serve the supplied
     * global + project JSON. Project JSON is served for any project-relative path
     * (`/mock/read/...`), global JSON only for the global path.
     */
    function setupGlobalAndProject(
      globalConfig: Record<string, unknown> | undefined,
      projectConfig: Record<string, unknown>
    ) {
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation((filename: string) => {
        if (filename === PROJECT_JSON_MARKER) return GLOBAL_JSON_PATH;
        // JS/MJS global variants resolve to non-existent sentinel paths.
        return `/mock/global-absent/${filename}`;
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );

      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return globalConfig !== undefined;
        // Project JSON lives under /mock/read/ and is the only project format present.
        return path === `/mock/read/${PROJECT_JSON_MARKER}`;
      });

      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return JSON.stringify(globalConfig ?? {});
        if (path === `/mock/read/${PROJECT_JSON_MARKER}`) return JSON.stringify(projectConfig);
        return '';
      });

      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockImplementation((llm: Record<string, unknown>) => ({
          type: 'vertexai',
          ...llm,
        })),
        postProcessJsonConfig: undefined,
      }));
    }

    it('Should apply global-only config when project does not set the key', async () => {
      setupGlobalAndProject(
        { projectGuidelines: 'GLOBAL.md', streamOutput: false },
        { llm: { type: 'vertexai' } }
      );

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Global value flows through where the project config is silent.
      expect(config.projectGuidelines).toBe('GLOBAL.md');
      expect(config.streamOutput).toBe(false);
    });

    it('Should let project config override global on a conflicting key', async () => {
      setupGlobalAndProject(
        { projectGuidelines: 'GLOBAL.md', streamOutput: false },
        { llm: { type: 'vertexai' }, projectGuidelines: 'PROJECT.md' }
      );

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Project wins on the conflicting key, global still wins where project is silent.
      expect(config.projectGuidelines).toBe('PROJECT.md');
      expect(config.streamOutput).toBe(false);
    });

    it('Should deep-merge global llm under project llm (project type wins)', async () => {
      setupGlobalAndProject(
        { llm: { type: 'anthropic', apiKeyEnvironmentVariable: 'GLOBAL_KEY_ENV' } },
        { llm: { type: 'vertexai', model: 'project-model' } }
      );

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Project llm.type wins; global-only llm sub-key is inherited.
      expect((config.llm as unknown as Record<string, unknown>).type).toBe('vertexai');
      expect((config.llm as unknown as Record<string, unknown>).model).toBe('project-model');
      expect((config.llm as unknown as Record<string, unknown>).apiKeyEnvironmentVariable).toBe(
        'GLOBAL_KEY_ENV'
      );
      expect(config.modelDisplayName).toBe('project-model');
    });

    it('Should fall back to defaults when neither global nor project sets a key', async () => {
      setupGlobalAndProject({ projectGuidelines: 'GLOBAL.md' }, { llm: { type: 'vertexai' } });

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // writeOutputToFile is set by neither layer -> DEFAULT_CONFIG default of true.
      expect(config.writeOutputToFile).toBe(true);
      expect(config.useColour).toBe(true);
    });

    it('Should be a no-op (unchanged behaviour) when no global config exists', async () => {
      setupGlobalAndProject(undefined, {
        llm: { type: 'vertexai' },
        projectGuidelines: 'PROJECT.md',
      });

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect(config.projectGuidelines).toBe('PROJECT.md');
      // Defaults intact, no global influence.
      expect(config.writeOutputToFile).toBe(true);
      expect(config.streamOutput).toBe(true);
      // Absent global must not warn.
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    it('Should ignore (and warn about) malformed global JSON without breaking project load', async () => {
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation((filename: string) => {
        if (filename === PROJECT_JSON_MARKER) return GLOBAL_JSON_PATH;
        return `/mock/global-absent/${filename}`;
      });
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return true;
        return path === `/mock/read/${PROJECT_JSON_MARKER}`;
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return '{ this is not valid json';
        if (path === `/mock/read/${PROJECT_JSON_MARKER}`)
          return JSON.stringify({ llm: { type: 'vertexai' }, projectGuidelines: 'PROJECT.md' });
        return '';
      });
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Project config still loads; bad global is ignored with a warning (no secrets logged).
      expect(config.projectGuidelines).toBe('PROJECT.md');
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read global config')
      );
    });
  });

  describe('writeOutputToFile configuration', () => {
    it('Should set writeOutputToFile to true by default in config', async () => {
      // Create a test config
      const jsonConfig = {
        llm: {
          type: 'vertexai',
        },
      } as RawGthConfig;

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the vertexai config module to process the config
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({});

      // Verify that writeOutputToFile is true by default
      expect(config.writeOutputToFile).toBe(true);
    });

    it('Should respect writeOutputToFile setting when explicitly set to false', async () => {
      // Create a test config with writeOutputToFile set to false
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
        },
        writeOutputToFile: false,
      } as Partial<RawGthConfig>;

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the vertexai config module to process the config
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({});

      // Verify that writeOutputToFile is false when explicitly set
      expect(config.writeOutputToFile).toBe(false);
    });

    it('Should override writeOutputToFile from CLI parameter', async () => {
      // Create a test config with writeOutputToFile set to true
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
        },
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
      } as Partial<RawGthConfig>;

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the vertexai config module to process the config
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test with CLI override
      const config = await initConfig({ writeOutputToFile: false });

      // Verify that CLI override takes precedence
      expect(config.writeOutputToFile).toBe(false);
    });

    it('Should allow writeOutputToFile to be a string in config (explicit path)', async () => {
      // Create a test config with writeOutputToFile set to a string path
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
        },
        writeOutputToFile: 'review.md',
      } as Partial<RawGthConfig>;

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the vertexai config module to process the config
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({});

      // Verify string value is preserved
      expect(config.writeOutputToFile).toBe('review.md');
    });

    it('Should allow CLI override with string path and preserve value', async () => {
      // Create a baseline test config
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
        },
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
      } as Partial<RawGthConfig>;

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the vertexai config module to process the config
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test with CLI override to string
      const config = await initConfig({ writeOutputToFile: 'out/review.md' });

      // Verify that CLI string override takes precedence and is preserved
      expect(config.writeOutputToFile).toBe('out/review.md');
    });

    it('Should interpret CLI -wn and -w0 as false (backward compatible)', async () => {
      // Simulate config default true and CLI override false-like values
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
        },
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
      } as Partial<RawGthConfig>;

      // Set up fs mocks
      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the vertexai config module
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Verify -wn equivalent handling (we simulate by passing false explicitly)
      const config1 = await initConfig({ writeOutputToFile: false });
      expect(config1.writeOutputToFile).toBe(false);

      // Verify -w0 equivalent handling (again, equivalent to explicit false in overrides)
      const config2 = await initConfig({ writeOutputToFile: false });
      expect(config2.writeOutputToFile).toBe(false);
    });

    it('Should accept CLI string for bare filename and absolute/relative paths', async () => {
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
        },
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
      } as Partial<RawGthConfig>;

      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');

      const c1 = await initConfig({ writeOutputToFile: 'review.md' });
      expect(c1.writeOutputToFile).toBe('review.md');

      const c2 = await initConfig({ writeOutputToFile: 'out/rev.md' });
      expect(c2.writeOutputToFile).toBe('out/rev.md');
    });
  });

  describe('writeBinaryOutputsToFile configuration', () => {
    it('Should set writeBinaryOutputsToFile to true by default in config', async () => {
      const jsonConfig = {
        llm: {
          type: 'vertexai',
        },
      } as RawGthConfig;

      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect(config.writeBinaryOutputsToFile).toBe(true);
    });

    it('Should respect writeBinaryOutputsToFile when explicitly set to false', async () => {
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
        },
        writeBinaryOutputsToFile: false,
      } as Partial<RawGthConfig>;

      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect(config.writeBinaryOutputsToFile).toBe(false);
    });
  });

  describe('useColour configuration', () => {
    it('Should set useColour to true by default in config', async () => {
      // Create a test config
      const jsonConfig = {
        llm: {
          type: 'vertexai',
        },
      } as RawGthConfig;

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the vertexai config module to process the config
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({});

      // Verify that useColour is true by default
      expect(config.useColour).toBe(true);

      // Verify that setUseColour was called with true
      expect(systemUtilsMock.setUseColour).toHaveBeenCalledWith(true);
    });

    it('Should respect useColour setting when explicitly set to true', async () => {
      // Create a test config with useColour set to true
      const jsonConfig = {
        llm: {
          type: 'vertexai',
        },
        useColour: true,
      } as RawGthConfig;

      // Set up fs mocks for this specific test
      fsMock.existsSync.mockImplementation((path: string) => {
        return path && path.includes('.gsloth.config.json');
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path && path.includes('.gsloth.config.json')) return JSON.stringify(jsonConfig);
        return '';
      });

      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Mock the vertexai config module to process the config
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      // Import the module under test
      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({});

      // Verify that useColour is true when explicitly set
      expect(config.useColour).toBe(true);

      // Verify that setUseColour was called with true
      expect(systemUtilsMock.setUseColour).toHaveBeenCalledWith(true);
    });
  });

  describe('processJsonLlmConfig', () => {
    it('Should process valid LLM type', async () => {
      // Create a test config
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
        },
      } as RawGthConfig;

      // Mock the vertexai config module
      const mockLlm = {
        type: 'vertexai',
        model: 'test-model',
      };
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue(mockLlm),
        postProcessJsonConfig: undefined,
      }));

      const { tryJsonConfig } = await import('#src/config.js');

      // Function under test
      const config = await tryJsonConfig(jsonConfig, {});

      // It is easier to debug if messages checked first
      expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.display).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();

      expect(config).toEqual({
        consoleLevel: StatusLevel.INFO,
        llm: mockLlm,
        modelDisplayName: 'test-model',
        contentSource: 'file',
        requirementSource: 'file',
        contentProvider: 'file',
        requirementsProvider: 'file',
        projectGuidelines: '.gsloth.guidelines.md',
        projectReviewInstructions: '.gsloth.review.md',
        canInterruptInferenceWithEsc: true,
        streamOutput: true,
        streamSessionInferenceLog: true,
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
        useColour: true,
        filesystem: 'none',
        aiignore: {
          enabled: true,
          patterns: undefined,
        },
        debugLog: false,
        commands: {
          pr: {
            contentSource: 'github',
            requirementSource: 'github',
            contentProvider: 'github',
            requirementsProvider: 'github',
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all' },
          ask: { filesystem: 'read' },
          chat: { filesystem: 'read' },
          api: {
            filesystem: 'read',
            port: 3000,
            cors: {
              allowOrigin: 'http://localhost:3000',
              allowMethods: 'POST, GET, OPTIONS',
              allowHeaders: 'Content-Type, Accept',
            },
          },
        },
        includeCurrentDateAfterGuidelines: false,
      });
    });

    it('Should handle unsupported LLM type', async () => {
      const jsonConfig = {
        llm: {
          type: 'unsupported',
          model: 'test-model',
        },
      } as RawGthConfig;

      // When importing a non-existent config module, it should throw

      const { tryJsonConfig } = await import('#src/config.js');

      try {
        await tryJsonConfig(jsonConfig, {});
        // Should not reach here due to error
        expect(true).toBe(false);
      } catch {
        // Expected to throw
      }

      // It is easier to debug if messages checked first
      expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('not supported')
      );
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.display).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();

      // Verify system exit was called
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('Should handle missing LLM type', async () => {
      const jsonConfig = {
        llm: {
          type: 'test',
        },
      } as RawGthConfig;

      const { tryJsonConfig } = await import('#src/config.js');

      try {
        await tryJsonConfig(jsonConfig, {});
        // Should not reach here due to error
        expect(true).toBe(false);
      } catch {
        // Expected to throw
      }

      // It is easier to debug if messages checked first
      expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('not supported')
      );
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.display).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();

      // Verify system exit was called
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('Should handle config module without processJsonConfig', async () => {
      const jsonConfig = {
        llm: {
          type: 'badconfig',
          model: 'test-model',
        },
      } as RawGthConfig;

      // Mock a config module without processJsonConfig
      vi.doMock('#src/providers/badconfig.js', () => ({
        processJsonConfig: undefined,
      }));

      const { tryJsonConfig } = await import('#src/config.js');

      try {
        await tryJsonConfig(jsonConfig, {});
        // Should not reach here due to error
        expect(true).toBe(false);
      } catch {
        // Expected to throw
      }

      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        'Config module for badconfig does not have processJsonConfig function.'
      );
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('Should handle missing LLM configuration', async () => {
      const jsonConfig = {
        // No llm property
      } as RawGthConfig;

      const { tryJsonConfig } = await import('#src/config.js');

      try {
        await tryJsonConfig(jsonConfig, {});
        // Should not reach here due to error
        expect(true).toBe(false);
      } catch {
        // Expected to throw
      }

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        'No LLM configuration found in config.'
      );
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('Should handle mcpServers and customTools', async () => {
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
          configuration: {},
        },
        mcpServers: {
          filesystem: {
            command: 'echo',
            args: ['hello'],
          },
        },
        customTools: {
          deploy: {
            command: 'npm run deploy',
            description: 'Deploy application',
          },
        },
        builtInTools: ['jira', 'github'],
      } as Partial<RawGthConfig>;

      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { tryJsonConfig } = await import('#src/config.js');
      const config = await tryJsonConfig(jsonConfig as RawGthConfig, {});

      expect(config.mcpServers).toBeDefined();
      expect(config.mcpServers!.filesystem).toEqual({
        command: 'echo',
        args: ['hello'],
      });
      expect(config.customTools).toBeDefined();
      expect(config.builtInTools).toEqual(['jira', 'github']);
    });

    it('Should handle configuration with devTools', async () => {
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
          configuration: {},
        },
        commands: {
          code: {
            filesystem: 'all',
            builtInTools: ['jira', 'dev-tools'],
            devTools: {
              run_tests: 'npm test',
              run_lint: 'npm run lint',
              run_build: 'npm run build',
            },
          },
        },
      } as RawGthConfig;

      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { tryJsonConfig } = await import('#src/config.js');
      const config = await tryJsonConfig(jsonConfig, {});

      expect(config.commands?.code?.devTools).toEqual({
        run_tests: 'npm test',
        run_lint: 'npm run lint',
        run_build: 'npm run build',
      });
    });

    it('Should handle missing LLM type property', async () => {
      const jsonConfig = {
        llm: {
          model: 'test-model',
          // No type property
        },
      } as RawGthConfig;

      const { tryJsonConfig } = await import('#src/config.js');

      try {
        await tryJsonConfig(jsonConfig, {});
        // Should not reach here due to error
        expect(true).toBe(false);
      } catch {
        // Expected to throw
      }

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        'LLM type not specified in config.'
      );
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('Should call postProcessJsonConfig if it exists on the preset module', async () => {
      // 1. Setup mock config
      const jsonConfig = {
        llm: {
          type: 'anthropic',
          model: 'test-model',
        },
      } as RawGthConfig;

      // 2. Mock the preset module
      const postProcessedConfig = { llm: { type: 'anthropic', processed: true } };
      const postProcessJsonConfigMock = vi.fn().mockReturnValue(postProcessedConfig);
      const mockLlm = {
        type: 'anthropic',
        model: 'test-model',
      };

      vi.doMock('#src/providers/anthropic.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue(mockLlm),
        postProcessJsonConfig: postProcessJsonConfigMock,
      }));

      // 3. Call function under test
      const { tryJsonConfig } = await import('#src/config.js');
      const finalConfig = await tryJsonConfig(jsonConfig, {});

      // 4. Assert
      expect(postProcessJsonConfigMock).toHaveBeenCalledOnce();
      expect(finalConfig).toEqual(postProcessedConfig);
    });
  });

  describe('custom config path', () => {
    it('Should use custom config path when specified', async () => {
      const customConfigPath = customPathPrefix + '.json';
      const jsonConfig = {
        llm: {
          type: 'vertexai',
        },
      } as RawGthConfig;

      // Set up fs mocks for custom path
      fsMock.existsSync.mockImplementation((path: string) => {
        return path === customConfigPath;
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === customConfigPath) return JSON.stringify(jsonConfig);
        return '';
      });

      // Mock the vertexai config module
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({ customConfigPath });

      expect(config).toEqual({
        consoleLevel: StatusLevel.INFO,
        llm: { type: 'vertexai' },
        modelDisplayName: undefined,
        contentSource: 'file',
        requirementSource: 'file',
        contentProvider: 'file',
        requirementsProvider: 'file',
        projectGuidelines: '.gsloth.guidelines.md',
        projectReviewInstructions: '.gsloth.review.md',
        streamOutput: true,
        streamSessionInferenceLog: true,
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
        useColour: true,
        filesystem: 'none',
        aiignore: {
          enabled: true,
          patterns: undefined,
        },
        debugLog: false,
        canInterruptInferenceWithEsc: true,
        commands: {
          pr: {
            contentSource: 'github',
            requirementSource: 'github',
            contentProvider: 'github',
            requirementsProvider: 'github',
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all' },
          ask: { filesystem: 'read' },
          chat: { filesystem: 'read' },
          api: {
            filesystem: 'read',
            port: 3000,
            cors: {
              allowOrigin: 'http://localhost:3000',
              allowMethods: 'POST, GET, OPTIONS',
              allowHeaders: 'Content-Type, Accept',
            },
          },
        },
        includeCurrentDateAfterGuidelines: false,
      });
    });

    it('Should handle custom JS config path', async () => {
      const customConfigPath = customPathPrefix + '.js';
      const mockConfig = { llm: { type: 'anthropic' } };
      const mockConfigModule = {
        configure: vi.fn().mockResolvedValue(mockConfig),
      };

      // Set up fs mocks for custom path
      fsMock.existsSync.mockImplementation((path: string) => {
        return path === customConfigPath;
      });

      // Mock the import function
      fileUtilsMock.importExternalFile.mockImplementation((path: string) => {
        if (path === customConfigPath) return Promise.resolve(mockConfigModule);
        return Promise.reject(new Error('Not found'));
      });

      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({ customConfigPath });

      expect(config).toEqual({
        consoleLevel: StatusLevel.INFO,
        llm: { type: 'anthropic' },
        contentSource: 'file',
        requirementSource: 'file',
        contentProvider: 'file',
        requirementsProvider: 'file',
        projectGuidelines: '.gsloth.guidelines.md',
        projectReviewInstructions: '.gsloth.review.md',
        streamOutput: true,
        streamSessionInferenceLog: true,
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
        useColour: true,
        filesystem: 'none',
        aiignore: {
          enabled: true,
          patterns: undefined,
        },
        debugLog: false,
        canInterruptInferenceWithEsc: true,
        commands: {
          pr: {
            contentSource: 'github',
            requirementSource: 'github',
            contentProvider: 'github',
            requirementsProvider: 'github',
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all' },
          ask: { filesystem: 'read' },
          chat: { filesystem: 'read' },
          api: {
            filesystem: 'read',
            port: 3000,
            cors: {
              allowOrigin: 'http://localhost:3000',
              allowMethods: 'POST, GET, OPTIONS',
              allowHeaders: 'Content-Type, Accept',
            },
          },
        },
        includeCurrentDateAfterGuidelines: false,
      });
    });

    it('Should handle custom MJS config path', async () => {
      const customConfigPath = customPathPrefix + '.mjs';
      const mockConfig = { llm: { type: 'groq' } };
      const mockConfigModule = {
        configure: vi.fn().mockResolvedValue(mockConfig),
      };

      // Set up fs mocks for custom path
      fsMock.existsSync.mockImplementation((path: string) => {
        return path === customConfigPath;
      });

      // Mock the import function
      fileUtilsMock.importExternalFile.mockImplementation((path: string) => {
        if (path === customConfigPath) return Promise.resolve(mockConfigModule);
        return Promise.reject(new Error('Not found'));
      });

      const { initConfig } = await import('#src/config.js');

      // Function under test
      const config = await initConfig({ customConfigPath });

      expect(config).toEqual({
        consoleLevel: StatusLevel.INFO,
        llm: { type: 'groq' },
        contentSource: 'file',
        requirementSource: 'file',
        contentProvider: 'file',
        requirementsProvider: 'file',
        projectGuidelines: '.gsloth.guidelines.md',
        projectReviewInstructions: '.gsloth.review.md',
        streamOutput: true,
        streamSessionInferenceLog: true,
        writeOutputToFile: true,
        writeBinaryOutputsToFile: true,
        useColour: true,
        filesystem: 'none',
        aiignore: {
          enabled: true,
          patterns: undefined,
        },
        debugLog: false,
        canInterruptInferenceWithEsc: true,
        commands: {
          pr: {
            contentSource: 'github',
            requirementSource: 'github',
            contentProvider: 'github',
            requirementsProvider: 'github',
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all' },
          ask: { filesystem: 'read' },
          chat: { filesystem: 'read' },
          api: {
            filesystem: 'read',
            port: 3000,
            cors: {
              allowOrigin: 'http://localhost:3000',
              allowMethods: 'POST, GET, OPTIONS',
              allowHeaders: 'Content-Type, Accept',
            },
          },
        },
        includeCurrentDateAfterGuidelines: false,
      });
    });

    it('Should throw error when custom config file does not exist', async () => {
      const customConfigPath = customPathPrefix + 'nonexistent.json';

      // Set up fs mocks
      fsMock.existsSync.mockImplementation((path: string) => {
        return path !== customConfigPath;
      });

      const { initConfig } = await import('#src/config.js');

      // Function under test
      try {
        await initConfig({ customConfigPath });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          `Provided manual config "${customConfigPath}" does not exist`
        );
      }
    });

    it('Should fall back to default config loading when custom config has unsupported extension', async () => {
      const customConfigPath = customPathPrefix + '.txt';

      // Set up fs mocks - custom path exists but has wrong extension, no default configs exist
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === customConfigPath) return true;
        // Make sure no default configs exist so we get the expected error
        return false;
      });

      const { initConfig } = await import('#src/config.js');

      // Function under test - should fall back to default config loading and fail
      try {
        await initConfig({ customConfigPath });
        expect(true).toBe(false); // Should not reach here
      } catch {
        // Expected to throw due to no config files found
      }

      // Should show error about no configuration file found since the custom path doesn't match supported extensions
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        'No configuration file found. Please create one of: ' +
          '.gsloth.config.json, .gsloth.config.js, or .gsloth.config.mjs ' +
          'in your project directory.'
      );
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('Should fall back to default config when custom JSON config is invalid', async () => {
      const customConfigPath = customPathPrefix + '.json';
      const jsonConfig = {
        llm: {
          // Missing type field
        },
      } as RawGthConfig;

      // Set up fs mocks - custom path exists but has invalid JSON, no default configs exist
      fsMock.existsSync.mockImplementation((path: string) => {
        return path === customConfigPath;
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === customConfigPath) return JSON.stringify(jsonConfig);
        return '';
      });

      const { initConfig } = await import('#src/config.js');

      // Function under test
      try {
        await initConfig({ customConfigPath });
        expect(true).toBe(false); // Should not reach here
      } catch {
        // Expected to throw due to invalid config falling back to no configs found
      }

      // Should show fallback error message and then no config found error
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        'Failed to read config from .gsloth.config.json, will try other formats.'
      );
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        'No configuration file found. Please create one of: ' +
          '.gsloth.config.json, .gsloth.config.js, or .gsloth.config.mjs ' +
          'in your project directory.'
      );
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('createProjectConfig', () => {
    it('Should create project config for valid config type', async () => {
      const configType = 'vertexai';
      const mockInit = vi.fn();

      // Mock the vertexai config module
      vi.doMock('#src/providers/vertexai.js', () => ({
        init: mockInit,
      }));

      // Ensure the pathUtils mock is properly set for different files
      fileUtilsMock.getGslothConfigWritePath.mockImplementation(
        (filename: string) => `/mock/write/${filename}`
      );

      const { createProjectConfig } = await import('#src/commands/configSetup.js');

      await createProjectConfig(configType);

      // Verify .gsloth directory was created
      expect(fsMock.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.gsloth'), {
        recursive: true,
      });
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith('Created .gsloth directory');

      // Verify displayInfo was called
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith('Setting up your project\n');
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        'Creating project config for vertexai'
      );

      // Verify displayWarning was called
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        'Make sure you add as much detail as possible to your .gsloth.guidelines.md.\n'
      );

      // Verify init was called with correct parameters
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json');

      // Verify writeFileIfNotExistsWithMessages was called for guidelines and review instructions
      expect(fileUtilsMock.writeFileIfNotExistsWithMessages).toHaveBeenCalledTimes(2);
      expect(fileUtilsMock.writeFileIfNotExistsWithMessages).toHaveBeenCalledWith(
        '/mock/write/.gsloth.guidelines.md',
        expect.stringContaining('# Development Guidelines')
      );
      expect(fileUtilsMock.writeFileIfNotExistsWithMessages).toHaveBeenCalledWith(
        '/mock/write/.gsloth.review.md',
        expect.stringContaining('# Code Review Guidelines')
      );
    });

    it('Should not recreate .gsloth directory if it already exists', async () => {
      const configType = 'vertexai';
      const mockInit = vi.fn();

      vi.doMock('#src/providers/vertexai.js', () => ({
        init: mockInit,
      }));

      fileUtilsMock.getGslothConfigWritePath.mockImplementation(
        (filename: string) => `/mock/write/${filename}`
      );

      // .gsloth directory already exists
      fsMock.existsSync.mockImplementation((path: string) => {
        if (String(path).endsWith('.gsloth')) return true;
        return false;
      });

      const { createProjectConfig } = await import('#src/commands/configSetup.js');

      await createProjectConfig(configType);

      // Should NOT create directory since it already exists
      expect(fsMock.mkdirSync).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalledWith('Created .gsloth directory');
    });

    it('Should handle invalid config type', async () => {
      const configType = 'invalid-config';

      const { createProjectConfig } = await import('#src/commands/configSetup.js');

      try {
        await createProjectConfig(configType);
        // Should not reach here
        expect(true).toBe(false);
      } catch {
        // Expected to throw
      }

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        'Unknown config type: invalid-config. Available options: vertexai, anthropic, groq, deepseek, openai, google-genai, xai, openrouter'
      );
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('Should create project config for anthropic', async () => {
      const configType = 'anthropic';
      const mockInit = vi.fn();

      // Mock the anthropic config module
      vi.doMock('#src/providers/anthropic.js', () => ({
        init: mockInit,
      }));

      // Ensure the pathUtils mock is properly set for different files
      fileUtilsMock.getGslothConfigWritePath.mockImplementation(
        (filename: string) => `/mock/write/${filename}`
      );

      const { createProjectConfig } = await import('#src/commands/configSetup.js');

      await createProjectConfig(configType);

      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        'Creating project config for anthropic'
      );
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json');
    });

    it('Should create project config for groq', async () => {
      const configType = 'groq';
      const mockInit = vi.fn();

      // Mock the groq config module
      vi.doMock('#src/providers/groq.js', () => ({
        init: mockInit,
      }));

      // Ensure the pathUtils mock is properly set for different files
      fileUtilsMock.getGslothConfigWritePath.mockImplementation(
        (filename: string) => `/mock/write/${filename}`
      );

      const { createProjectConfig } = await import('#src/commands/configSetup.js');

      await createProjectConfig(configType);

      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith('Creating project config for groq');
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json');
    });

    it('Should create project config for google-genai', async () => {
      const configType = 'google-genai';
      const mockInit = vi.fn();

      // Mock the google-genai config module
      vi.doMock('#src/providers/google-genai.js', () => ({
        init: mockInit,
      }));

      // Ensure the pathUtils mock is properly set for different files
      fileUtilsMock.getGslothConfigWritePath.mockImplementation(
        (filename: string) => `/mock/write/${filename}`
      );

      const { createProjectConfig } = await import('#src/commands/configSetup.js');

      await createProjectConfig(configType);

      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        'Creating project config for google-genai'
      );
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json');
    });

    it('Should create project config for xai', async () => {
      const configType = 'xai';
      const mockInit = vi.fn();

      // Mock the xai config module
      vi.doMock('#src/providers/xai.js', () => ({
        init: mockInit,
      }));

      // Ensure the pathUtils mock is properly set for different files
      fileUtilsMock.getGslothConfigWritePath.mockImplementation(
        (filename: string) => `/mock/write/${filename}`
      );

      const { createProjectConfig } = await import('#src/commands/configSetup.js');

      await createProjectConfig(configType);

      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith('Creating project config for xai');
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json');
    });
  });
});
