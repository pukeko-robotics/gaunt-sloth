import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawGthConfig } from '#src/config.js';
import { StatusLevel } from '#src/core/types.js';
import { platform } from 'node:os';
// REAL node:path (never mocked here — see MOCK_CWD below) and the REAL constants the loader uses,
// so an expected path built in this file is byte-identical to the one production builds.
import { resolve } from 'node:path';
import { GSLOTH_DIR, GSLOTH_SETTINGS_DIR } from '#src/constants.js';

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
  getProjectDir: vi.fn(),
  setProjectDir: vi.fn(),
  getInstallDir: vi.fn(),
  setUseColour: vi.fn(),
  isTTY: vi.fn(),
  // CFG-30 — colour now auto-detects from stdout when nothing else decides. Declared per-test
  // (see beforeEach) so the `useColour` expectations below describe a terminal run rather than
  // inheriting the test runner's piped stdout.
  isStdoutTTY: vi.fn(),
  // CFG-14: createProjectConfig now resolves the init model via modelDiscovery, which reads
  // `env` to look for provider API keys. An empty env means no keys → no live discovery →
  // resolveInitModel returns undefined and `init` is called with model=undefined (omit).
  env: {} as Record<string, string | undefined>,
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

/**
 * The mocked cwd every test in this file runs from. `walkConfigSearchDirs()` in
 * `config/loader.ts` starts its up-tree walk at `getCurrentWorkDir()` (NOT `getProjectDir()`),
 * so this is the base production feeds to the real `resolve()`.
 *
 * OPS-27 — any expected path this file compares by exact equality against a value the loader
 * builds with the real `resolve()`/`join()` MUST be derived from this same base through that same
 * real `resolve()` (see RATER_PROFILE_CONFIG below). A hand-written POSIX literal only matches on
 * POSIX: on win32 a leading-slash string is drive-relative, so the loader produces
 * `<drive>:\mock\current\dir\...` instead, the exact-equality check silently fails, and
 * the test exercises the opposite branch. `node:path` is deliberately NOT mocked in this file —
 * mocking it (or comparing with `endsWith`/`includes`/a separator-normalising regex) would go green
 * everywhere while proving nothing about how the path is assembled.
 */
const MOCK_CWD = '/mock/current/dir';

describe('config', async () => {
  beforeEach(async () => {
    // Reset mocks
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    // Reset and set up systemUtils mocks
    systemUtilsMock.getCurrentWorkDir.mockReturnValue(MOCK_CWD);
    systemUtilsMock.getProjectDir.mockReturnValue(MOCK_CWD);
    systemUtilsMock.getInstallDir.mockReturnValue('/mock/install/dir');
    systemUtilsMock.isTTY.mockReturnValue(true);
    systemUtilsMock.isStdoutTTY.mockReturnValue(true);
    // TUI-C37 — a terminal run means a real TERM too, not just TTY file descriptors. Without this
    // the mouse ladder would resolve on the unset-TERM rung and these expectations would describe
    // something other than the interactive session they claim to.
    systemUtilsMock.env.TERM = 'xterm-256color';
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
        builtInTools: ['gth_checklist', 'gth_grep'],
        llm: { type: 'vertexai' },
        contentSource: 'file',
        requirementSource: 'file',
        streamOutput: true,
        writeOutputToFile: false,
        writeBinaryOutputsToFile: true,
        useColour: true,
        useMouse: true,
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
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          exec: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          ask: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          chat: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          api: {
            filesystem: 'read',
            builtInTools: ['gth_checklist', 'gth_grep'],
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
        modelProviderType: 'vertexai',
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
        builtInTools: ['gth_checklist', 'gth_grep'],
        llm: { type: 'anthropic' },
        contentSource: 'file',
        requirementSource: 'file',
        streamOutput: true,
        writeOutputToFile: false,
        writeBinaryOutputsToFile: true,
        useColour: true,
        useMouse: true,
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
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          exec: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          ask: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          chat: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          api: {
            filesystem: 'read',
            builtInTools: ['gth_checklist', 'gth_grep'],
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
        builtInTools: ['gth_checklist', 'gth_grep'],
        llm: { type: 'groq' },
        contentSource: 'file',
        requirementSource: 'file',
        streamOutput: true,
        writeOutputToFile: false,
        writeBinaryOutputsToFile: true,
        useColour: true,
        useMouse: true,
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
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          exec: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          ask: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          chat: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          api: {
            filesystem: 'read',
            builtInTools: ['gth_checklist', 'gth_grep'],
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

    // CFG-47 — "no config anywhere" is raised, not exited on. It is the terminal case of the class
    // CFG-36 converted, and it needs converting for the same reason: `gth eval` has to be able to
    // report "the harness has no configuration" as a harness error (exit 2) rather than as the
    // exit 1 that means the system under test ran and failed. The message is unchanged; the CLI's
    // top-level guard prints it and exits 1, so a person at a terminal sees what they saw before.
    it('Should raise a catchable error when no config files exist', async () => {
      // Set up fs mocks for this specific test
      fsMock.existsSync.mockReturnValue(false);

      // Ensure pathUtils returns mock paths
      fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => {
        return `/mock/read/${filename}`;
      });

      // Ensure custom config path is cleared
      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');

      const error = await initConfig({}).catch((e: unknown) => e);

      // It is easier to debug if messages checked first
      expect((error as Error).message).toBe(
        'No configuration file found. Please create one of: ' +
          '.gsloth.config.json, .gsloth.config.js, or .gsloth.config.mjs ' +
          'in your project directory.'
      );
      expect(isConfigDiscoveryError(error)).toBe(true);
      // The loader neither prints nor exits: the message rides on the error for the top level.
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('Should HARD-reject deprecated *Provider* names naming their *Source* fix (GS2-28)', async () => {
      // 2.0 dropped back-compat coercion: a deprecated `*Provider*` name (root or per-command)
      // is a validation error that names the canonical `*Source*` replacement, not a remap.
      const jsonConfig = {
        llm: { type: 'vertexai' },
        contentProvider: 'github',
        commands: { pr: { requirementsProvider: 'jira' } },
      } as unknown as RawGthConfig;

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

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      // CFG-36 — the rejection is the assertion. A bare `rejects.toThrow()` would NOT discriminate:
      // the old code called exit(1) (a no-op here) and then threw a generic sentinel, so it threw
      // too. Pinning the error TYPE and its message, and asserting exit was never called, is what
      // tells the catchable error apart from the process kill it replaced.
      const error = await initConfig({}).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('Invalid configuration');
      expect((error as Error).message).toContain('contentSource'); // contentProvider → contentSource
      expect((error as Error).message).toContain('commands.pr.requirementsProvider');
      expect((error as Error).message).toContain('requirementSource'); // per-command fix named
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      // The loader neither prints nor swallows: the message rides on the error for the top level to
      // print. A `displayError` here would mean a catch downgraded this to a format fall-through.
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      // A removed shape errors; it is NOT remapped-and-warned.
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalledWith(
        expect.stringContaining('"contentProvider"')
      );
    });

    /**
     * EXT-71 §2.2 — "a hard config error" means the config **fails to load**, so the rule-grammar
     * scan has to be wired into the LOADER, not only into the pure read-side validator that
     * `gth config validate` calls. Every other test of this grammar goes through
     * `validateRawGthConfig`, which would stay green if the loader forgot to call the scan — the
     * config would then load with a rule list the runtime cannot honour, which for a safety gate
     * is the worst available failure. This is the one test that only the loader call site can
     * satisfy.
     */
    it('Should HARD-reject a bare-string approvals entry at LOAD, showing the object form (EXT-71)', async () => {
      const jsonConfig = {
        llm: { type: 'vertexai' },
        approvals: { mode: 'assisted', deny: ['npm publish'] },
      } as unknown as RawGthConfig;

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

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      const error = await initConfig({}).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('Invalid configuration');
      expect((error as Error).message).toContain('approvals.deny[0]');
      expect((error as Error).message).toContain(
        '{ "type": "shell", "matcher": "exact", "pattern": "npm publish" }'
      );
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    });

    /**
     * The control for the test above: the very entry that message told the user to write must
     * LOAD. Without it, a loader that rejected every `approvals` block outright would pass.
     */
    it('Should LOAD the object form of that same approvals entry (EXT-71 control)', async () => {
      const jsonConfig = {
        llm: { type: 'vertexai' },
        approvals: {
          mode: 'assisted',
          deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
        },
      } as unknown as RawGthConfig;

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

      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(config.approvals).toEqual({
        mode: 'assisted',
        deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
      });
    });

    it('Should HARD-reject a top-level command key naming commands.<cmd> (GS2-28)', async () => {
      // A command config placed at the config ROOT (the removed pre-2.0 shape) must move under
      // `commands.<cmd>`; it hard-fails rather than being kept as a warn-only unknown key.
      const jsonConfig = {
        llm: { type: 'vertexai' },
        pr: { contentSource: 'github' },
      } as unknown as RawGthConfig;

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

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      const error = await initConfig({}).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('Invalid configuration');
      expect((error as Error).message).toContain('commands.pr');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    });

    it('Should fail with a path-scoped error on schema type mismatch (B1)', async () => {
      const jsonConfig = {
        llm: { type: 'vertexai' },
        commands: { api: { port: '3000' } },
      } as unknown as RawGthConfig;

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

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      const error = await initConfig({}).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('commands.api.port');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
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
        { prompts: { guidelines: 'GLOBAL.md' }, streamOutput: false },
        { llm: { type: 'vertexai' } }
      );

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Global value flows through where the project config is silent.
      expect(config.prompts?.guidelines).toBe('GLOBAL.md');
      expect(config.streamOutput).toBe(false);
    });

    it('Should let project config override global on a conflicting key', async () => {
      setupGlobalAndProject(
        { prompts: { guidelines: 'GLOBAL.md' }, streamOutput: false },
        { llm: { type: 'vertexai' }, prompts: { guidelines: 'PROJECT.md' } }
      );

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Project wins on the conflicting key, global still wins where project is silent.
      expect(config.prompts?.guidelines).toBe('PROJECT.md');
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
      setupGlobalAndProject(
        { prompts: { guidelines: 'GLOBAL.md' } },
        { llm: { type: 'vertexai' } }
      );

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // writeOutputToFile is set by neither layer -> DEFAULT_CONFIG default of false.
      expect(config.writeOutputToFile).toBe(false);
      expect(config.useColour).toBe(true);
    });

    it('Should be a no-op (unchanged behaviour) when no global config exists', async () => {
      setupGlobalAndProject(undefined, {
        llm: { type: 'vertexai' },
        prompts: { guidelines: 'PROJECT.md' },
      });

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect(config.prompts?.guidelines).toBe('PROJECT.md');
      // Defaults intact, no global influence.
      expect(config.writeOutputToFile).toBe(false);
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
          return JSON.stringify({
            llm: { type: 'vertexai' },
            prompts: { guidelines: 'PROJECT.md' },
          });
        return '';
      });
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Project config still loads; bad global is ignored with a warning (no secrets logged).
      expect(config.prompts?.guidelines).toBe('PROJECT.md');
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read global config')
      );
    });
  });

  describe('global-only config (CFG-8)', () => {
    const GLOBAL_JSON_PATH = '/mock/global/.gsloth.config.json';
    const PROJECT_JSON_MARKER = '.gsloth.config.json';

    /** Serve a global JSON config while NO project config file of any format exists. */
    function setupGlobalOnly(globalConfig: Record<string, unknown> | undefined) {
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation((filename: string) => {
        if (filename === PROJECT_JSON_MARKER) return GLOBAL_JSON_PATH;
        return `/mock/global-absent/${filename}`;
      });
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      // Only the global JSON path exists; every project path is absent.
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return globalConfig !== undefined;
        return false;
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return JSON.stringify(globalConfig ?? {});
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

    it('Should load a standalone global config when no project config exists', async () => {
      setupGlobalOnly({
        llm: { type: 'vertexai', model: 'global-model' },
        prompts: { guidelines: 'GLOBAL.md' },
      });

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect((config.llm as unknown as Record<string, unknown>).type).toBe('vertexai');
      expect((config.llm as unknown as Record<string, unknown>).model).toBe('global-model');
      expect(config.prompts?.guidelines).toBe('GLOBAL.md');
      // Must NOT error when a usable global config is the only config present.
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    // CFG-47 — raised rather than exited on (see the no-config-anywhere case above).
    it('Should raise a catchable error when a global config exists but lacks llm.type', async () => {
      setupGlobalOnly({ prompts: { guidelines: 'GLOBAL.md' } });

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      const error = await initConfig({}).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('not in valid format');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('Should still report "No configuration file found" when neither project nor global exists', async () => {
      setupGlobalOnly(undefined);

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      const error = await initConfig({}).catch((e: unknown) => e);

      expect((error as Error).message).toBe(
        'No configuration file found. Please create one of: ' +
          '.gsloth.config.json, .gsloth.config.js, or .gsloth.config.mjs ' +
          'in your project directory.'
      );
      expect(isConfigDiscoveryError(error)).toBe(true);
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('hasAnyConfig returns false when neither project nor global config exists', async () => {
      setupGlobalOnly(undefined);
      const { hasAnyConfig } = await import('#src/config.js');
      expect(await hasAnyConfig({})).toBe(false);
    });

    it('hasAnyConfig returns true when only a global config exists', async () => {
      setupGlobalOnly({ llm: { type: 'vertexai' } });
      const { hasAnyConfig } = await import('#src/config.js');
      expect(await hasAnyConfig({})).toBe(true);
    });

    it('hasAnyConfig returns true when a project config exists', async () => {
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
        () => '/mock/global-absent/no-such-config'
      );
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      fsMock.existsSync.mockImplementation(
        (path: string) => path === `/mock/read/${PROJECT_JSON_MARKER}`
      );
      const { hasAnyConfig } = await import('#src/config.js');
      expect(await hasAnyConfig({})).toBe(true);
    });

    // GS2-62 — the fix + its regression guard, tested against ONE global-present fixture. An
    // EXPLICITLY named identity profile that discovered no project config must ERROR (not silently
    // load the global), while a run with NO profile must still fall back to the global exactly as
    // before (CFG-8). The pair is the whole behaviour change.
    it('GS2-62: an explicit-but-missing identity profile ERRORS instead of silently loading the global', async () => {
      setupGlobalOnly({
        llm: { type: 'vertexai', model: 'global-model' },
        prompts: { guidelines: 'GLOBAL.md' },
      });

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      // CFG-36 — a valid global IS present; the buggy behaviour would silently build a config from
      // it. The failure is now a CATCHABLE error rather than a process exit, which is what lets
      // `gth eval` classify it as a harness error (exit 2) instead of dying with the loader's
      // exit(1). Asserting the TYPE + message + `exit` never being called is what discriminates:
      // the old code threw a generic sentinel here too, so a bare `rejects.toThrow()` would pass
      // against it unchanged.
      const returned = await initConfig({ identityProfile: 'missing' }).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(returned)).toBe(true);
      expect((returned as Error).message).toContain('identity profile "missing" not found');
      expect((returned as Error).message).toContain('.gsloth-settings/missing');
      expect(
        (returned as { identityProfile?: string }).identityProfile,
        'the profile name rides as a FIELD, so a consumer can classify without parsing prose'
      ).toBe('missing');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      // The global was NOT silently loaded: nothing was printed and global parsing never ran
      // (its "not in valid format" branch — which a valid global wouldn't hit anyway — stays clear).
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    });

    it('GS2-62: a run with NO identity profile still falls back to the global config (CFG-8 preserved)', async () => {
      setupGlobalOnly({
        llm: { type: 'vertexai', model: 'global-model' },
        prompts: { guidelines: 'GLOBAL.md' },
      });

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect((config.llm as unknown as Record<string, unknown>).type).toBe('vertexai');
      expect(config.prompts?.guidelines).toBe('GLOBAL.md');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    // CFG-26 — `approvals.rater` gets the SAME strict resolution as an explicitly-named identity
    // profile (GS2-62): a name that does not resolve is a hard config error, never a silent
    // fallback to the main model. Checked in the loader (not the zod schema) because resolution
    // needs the filesystem and `schema.ts` must stay pure. CFG-27 flattened the key to a bare
    // profile NAME; the rule is unchanged.
    it('CFG-26: an unresolvable approvals.rater ERRORS instead of silently using the main model', async () => {
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      // ONLY the project config exists — no `.gsloth-settings/missing-rater/` profile dir.
      fsMock.existsSync.mockImplementation(
        (path: string) => path === `/mock/read/${PROJECT_JSON_MARKER}`
      );
      fsMock.readFileSync.mockImplementation((path: string) =>
        path === `/mock/read/${PROJECT_JSON_MARKER}`
          ? JSON.stringify({
              llm: { type: 'vertexai' },
              approvals: { mode: 'assisted', rater: 'missing-rater' },
            })
          : ''
      );

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      const error = await initConfig({}).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('approvals.rater');
      expect((error as Error).message).toContain('identity profile "missing-rater" not found');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    });

    it('CFG-26: a per-command approvals.rater is checked too', async () => {
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      fsMock.existsSync.mockImplementation(
        (path: string) => path === `/mock/read/${PROJECT_JSON_MARKER}`
      );
      fsMock.readFileSync.mockImplementation((path: string) =>
        path === `/mock/read/${PROJECT_JSON_MARKER}`
          ? JSON.stringify({
              llm: { type: 'vertexai' },
              commands: { code: { approvals: { rater: 'nope' } } },
            })
          : ''
      );

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      const error = await initConfig({}).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('commands.code.approvals.rater');
      expect((error as Error).message).toContain('identity profile "nope" not found');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    });

    it('CFG-26: an approvals.rater that DOES resolve loads without erroring', async () => {
      // Built the way `resolveIdentityProfileConfigPath()` builds it — real `resolve()`, from the
      // same mocked `getCurrentWorkDir()` base, through the same `GSLOTH_DIR`/`GSLOTH_SETTINGS_DIR`
      // constants. So it is win32-shaped on Windows exactly as the loader's own path is, and it
      // still goes red if the loader's segment sequence ever changes (OPS-27).
      const RATER_PROFILE_CONFIG = resolve(
        MOCK_CWD,
        GSLOTH_DIR,
        GSLOTH_SETTINGS_DIR,
        'safety-rater',
        PROJECT_JSON_MARKER
      );
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      fsMock.existsSync.mockImplementation(
        (path: string) =>
          path === `/mock/read/${PROJECT_JSON_MARKER}` || path === RATER_PROFILE_CONFIG
      );
      fsMock.readFileSync.mockImplementation((path: string) =>
        path === `/mock/read/${PROJECT_JSON_MARKER}`
          ? JSON.stringify({
              llm: { type: 'vertexai' },
              approvals: { mode: 'assisted', rater: 'safety-rater' },
            })
          : ''
      );
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(config.approvals).toEqual({
        mode: 'assisted',
        rater: 'safety-rater',
      });
    });

    it('GS2-62: an explicit identity profile that resolves to a config loads without erroring', async () => {
      // The named profile genuinely HAS its own config, so the strict guard must not fire and the
      // config loads. CFG-36 — the profile config has to exist on the (mocked) filesystem for that
      // to be true: the guard now resolves the profile STRICTLY rather than accepting whatever
      // discovery happened to find, so a fixture where only a plain config exists is the Case C
      // failure, not this success. Path built with the real `resolve()` from the same mocked cwd
      // the loader walks (OPS-27), exactly as the CFG-26 rater test above builds its own.
      const EXISTING_PROFILE_CONFIG = resolve(
        MOCK_CWD,
        GSLOTH_DIR,
        GSLOTH_SETTINGS_DIR,
        'existing',
        PROJECT_JSON_MARKER
      );
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
        () => '/mock/global-absent/no-such-config'
      );
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      fsMock.existsSync.mockImplementation(
        (path: string) =>
          path === `/mock/read/${PROJECT_JSON_MARKER}` || path === EXISTING_PROFILE_CONFIG
      );
      fsMock.readFileSync.mockImplementation((path: string) =>
        path === `/mock/read/${PROJECT_JSON_MARKER}`
          ? JSON.stringify({ llm: { type: 'vertexai' } })
          : ''
      );
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({ identityProfile: 'existing' });

      expect((config.llm as unknown as Record<string, unknown>).type).toBe('vertexai');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalledWith(
        expect.stringContaining('not found')
      );
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    /**
     * CFG-36 — "Case C", the gap the discovery gate could not see, and the reason `gth eval` needed
     * a pre-check of its own.
     *
     * `findProjectConfigPath` deliberately falls back to a plain `<dir>/<config>` when a named
     * profile has no config (see its note, and the Case C spec in config.uptree.spec.ts). So a
     * guard gated on "nothing was discovered" fires only in a project with NO config at all: give
     * the project an ordinary config and `-i typo` sailed past it and ran under THAT config —
     * silently, under the wrong model, while appearing to use the named profile. The guard now
     * resolves the profile STRICTLY, which is what lets the eval pre-check be deleted rather than
     * merely moved.
     */
    const setupPlainProjectOnly = () => {
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
        () => '/mock/global-absent/no-such-config'
      );
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      // ONLY a plain project config exists — no `.gsloth/.gsloth-settings/<profile>/` anywhere.
      fsMock.existsSync.mockImplementation(
        (path: string) => path === `/mock/read/${PROJECT_JSON_MARKER}`
      );
      fsMock.readFileSync.mockImplementation((path: string) =>
        path === `/mock/read/${PROJECT_JSON_MARKER}`
          ? JSON.stringify({ llm: { type: 'vertexai', model: 'plain-config-model' } })
          : ''
      );
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockImplementation((llm: Record<string, unknown>) => ({
          type: 'vertexai',
          ...llm,
        })),
        postProcessJsonConfig: undefined,
      }));
    };

    it('CFG-36: a named profile with no config does NOT fall back to the plain project config', async () => {
      setupPlainProjectOnly();

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      const error = await initConfig({ identityProfile: 'typo' }).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('identity profile "typo" not found');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('CFG-36 control: with NO profile named, that same plain config loads (the guard cannot fire)', async () => {
      // The discriminating half of the pair: the guard keys on a profile having been NAMED, so the
      // no-profile path through the very same function is untouched. Without this, a guard that
      // rejected every config would pass the test above.
      setupPlainProjectOnly();

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect((config.llm as unknown as Record<string, unknown>).model).toBe('plain-config-model');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('CFG-36 control: a blank profile name is "no profile", not a missing one', async () => {
      setupPlainProjectOnly();

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({ identityProfile: '   ' });

      expect((config.llm as unknown as Record<string, unknown>).model).toBe('plain-config-model');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('CFG-36: an explicit --config path wins outright, so the profile guard does not fire', async () => {
      // `--config` names the file to load and bypasses discovery entirely; the profile guard is
      // gated on its absence so an explicit path keeps behaving as an explicit path.
      const customConfigPath = customPathPrefix + '.json';
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
        () => '/mock/global-absent/no-such-config'
      );
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      fsMock.existsSync.mockImplementation((path: string) => path === customConfigPath);
      fsMock.readFileSync.mockImplementation((path: string) =>
        path === customConfigPath
          ? JSON.stringify({ llm: { type: 'vertexai', model: 'custom-path-model' } })
          : ''
      );
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockImplementation((llm: Record<string, unknown>) => ({
          type: 'vertexai',
          ...llm,
        })),
        postProcessJsonConfig: undefined,
      }));

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({ customConfigPath, identityProfile: 'typo' });

      expect((config.llm as unknown as Record<string, unknown>).model).toBe('custom-path-model');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('CFG-36: a MALFORMED global config is a hard error, not a silently ignored one', async () => {
      // The catcher audit in one test. `loadGlobalRawConfig` catches read failures and treats the
      // global as absent; a malformed global reaches that same catch, and letting it be swallowed
      // would downgrade a hard config error (it used to exit(1)) into "ignoring it" plus a run
      // under a different config — the false-green this change exists to prevent. The re-raise is
      // what keeps it hard, and this goes red if the re-raise is removed.
      setupGlobalOnly({
        llm: { type: 'vertexai', model: 'global-model' },
        commands: { api: { port: '3000' } }, // port must be a number
      });

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
      const error = await initConfig({}).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('commands.api.port');
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalledWith(
        expect.stringContaining('ignoring it')
      );
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });
  });

  describe('writeOutputToFile configuration', () => {
    it('Should set writeOutputToFile to false by default in config', async () => {
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

      // Verify that writeOutputToFile is false by default
      expect(config.writeOutputToFile).toBe(false);
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
        builtInTools: ['gth_checklist', 'gth_grep'],
        llm: mockLlm,
        modelDisplayName: 'test-model',
        modelProviderType: 'vertexai',
        contentSource: 'file',
        requirementSource: 'file',
        canInterruptInferenceWithEsc: true,
        streamOutput: true,
        streamSessionInferenceLog: true,
        writeOutputToFile: false,
        writeBinaryOutputsToFile: true,
        useColour: true,
        useMouse: true,
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
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          exec: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          ask: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          chat: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          api: {
            filesystem: 'read',
            builtInTools: ['gth_checklist', 'gth_grep'],
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

      const { tryJsonConfig, isConfigDiscoveryError } = await import('#src/config.js');

      const error = await tryJsonConfig(jsonConfig, {}).catch((e: unknown) => e);

      // CFG-47 — the message is unchanged and now rides on a catchable error instead of being
      // printed here and exited on. Every display channel must stay silent: a print from the
      // loader would mean a catch downgraded this failure on its way out.
      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('not supported');
      // The resolver's own failure is reachable through `cause` rather than being discarded.
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.display).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('Should handle missing LLM type', async () => {
      const jsonConfig = {
        llm: {
          type: 'test',
        },
      } as RawGthConfig;

      const { tryJsonConfig, isConfigDiscoveryError } = await import('#src/config.js');

      const error = await tryJsonConfig(jsonConfig, {}).catch((e: unknown) => e);

      // CFG-47 — the message is unchanged and now rides on a catchable error instead of being
      // printed here and exited on. Every display channel must stay silent: a print from the
      // loader would mean a catch downgraded this failure on its way out.
      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('not supported');
      // The resolver's own failure is reachable through `cause` rather than being discarded.
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.display).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
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

      const { tryJsonConfig, isConfigDiscoveryError } = await import('#src/config.js');

      const error = await tryJsonConfig(jsonConfig, {}).catch((e: unknown) => e);

      // CFG-47 — this site was proposed as "genuinely a different case" (an internal invariant
      // rather than a user's config). It is not: `#src/providers/<type>.js` resolves against the
      // directory that also holds modelCatalog, modelDiscovery, geminiThinking,
      // geminiSchemaSanitizer and configurationPassthrough, none of which export
      // `processJsonConfig` — so an ordinary config naming any of them as `llm.type` lands here.
      // It is a user-reachable "config present and unusable" failure and is raised like the rest.
      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toBe(
        'Config module for badconfig does not have processJsonConfig function.'
      );
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('Should handle missing LLM configuration', async () => {
      const jsonConfig = {
        // No llm property
      } as RawGthConfig;

      const { tryJsonConfig, isConfigDiscoveryError } = await import('#src/config.js');

      const error = await tryJsonConfig(jsonConfig, {}).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toBe('No LLM configuration found in config.');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
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

    it('Should handle configuration with dev tools in the builtInTools registry', async () => {
      const jsonConfig = {
        llm: {
          type: 'vertexai',
          model: 'test-model',
          configuration: {},
        },
        commands: {
          code: {
            filesystem: 'all',
            // CFG-18: dev/shell tools are configured under the unified builtInTools registry.
            builtInTools: {
              run_tests: { command: 'npm test' },
              run_lint: { command: 'npm run lint' },
              run_build: { command: 'npm run build' },
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

      expect(config.commands?.code?.builtInTools).toEqual({
        run_tests: { command: 'npm test' },
        run_lint: { command: 'npm run lint' },
        run_build: { command: 'npm run build' },
      });
    });

    it('Should handle missing LLM type property', async () => {
      const jsonConfig = {
        llm: {
          model: 'test-model',
          // No type property
        },
      } as RawGthConfig;

      const { tryJsonConfig, isConfigDiscoveryError } = await import('#src/config.js');

      const error = await tryJsonConfig(jsonConfig, {}).catch((e: unknown) => e);

      // CFG-47 — raised, not printed-and-exited. This one also pins `tryJsonConfig`'s own catch
      // re-raising the class: without that re-raise this clear message would be caught two lines
      // later, re-worded as "Error processing LLM config: …", and exited on anyway.
      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toBe('LLM type not specified in config.');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
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

    describe('commandLineConfigOverrides.model (BATCH-1)', () => {
      it('overrides llmConfig.model before the provider builds the instance', async () => {
        const jsonConfig = {
          llm: {
            type: 'vertexai',
            model: 'configured-model',
          },
        } as RawGthConfig;

        const processJsonConfigMock = vi
          .fn()
          .mockImplementation(async (llmConfig: Record<string, unknown>) => ({
            type: 'vertexai',
            model: llmConfig.model,
          }));
        vi.doMock('#src/providers/vertexai.js', () => ({
          processJsonConfig: processJsonConfigMock,
          postProcessJsonConfig: undefined,
        }));

        const { tryJsonConfig } = await import('#src/config.js');
        const config = await tryJsonConfig(jsonConfig, { model: 'override-model' });

        // The override must reach the provider's own construction call (the raw LLM *spec*),
        // not be applied after the fact to whatever instance was already built.
        expect(processJsonConfigMock).toHaveBeenCalledWith(
          expect.objectContaining({ model: 'override-model' })
        );
        expect(config.llm).toEqual({ type: 'vertexai', model: 'override-model' });
        // modelDisplayName is derived from the (now-overridden) raw jsonConfig.llm.model.
        expect(config.modelDisplayName).toEqual('override-model');
      });

      it(
        'regression (BATCH-1 finding 1): builds a genuine instance via the provider factory, so ' +
          'a provider class with a real private field keeps working — no Object.create/' +
          'getOwnPropertyDescriptors structural clone anywhere in this path',
        async () => {
          // A minimal stand-in for a LangChain chat-model class whose methods touch a genuine
          // private (#) field — the exact shape the old `cloneLlmWithModel` (Object.create +
          // getOwnPropertyDescriptors) could never support, because a structurally-cloned object
          // never runs the constructor and so never gets the original instance's private slots.
          class FakeProviderModelWithPrivateField {
            model: string;
            #internalClient: { greet: () => string };

            constructor(fields: { model: string }) {
              this.model = fields.model;
              // A "real internal client cache" a provider might build in its constructor —
              // exactly the kind of state a structural clone would never receive.
              this.#internalClient = { greet: () => `hello from ${fields.model}` };
            }

            // Any real call path (e.g. `.invoke()`) would touch private state like this;
            // this throws `TypeError: Cannot read private member ...` on an Object.create clone.
            callPrivate(): string {
              return this.#internalClient.greet();
            }
          }

          const jsonConfig = {
            llm: {
              type: 'vertexai',
              model: 'configured-model',
            },
          } as RawGthConfig;

          vi.doMock('#src/providers/vertexai.js', () => ({
            processJsonConfig: vi
              .fn()
              .mockImplementation(
                async (llmConfig: Record<string, unknown>) =>
                  new FakeProviderModelWithPrivateField({ model: llmConfig.model as string })
              ),
            postProcessJsonConfig: undefined,
          }));

          const { tryJsonConfig } = await import('#src/config.js');
          const config = await tryJsonConfig(jsonConfig, { model: 'model-with-private-state' });

          const llm = config.llm as unknown as FakeProviderModelWithPrivateField;
          expect(llm).toBeInstanceOf(FakeProviderModelWithPrivateField);
          // The critical assertion: calling a method that reaches into the private field does
          // NOT throw. A structurally-cloned object (Object.create + getOwnPropertyDescriptors)
          // would throw here, because it never ran the constructor that sets #internalClient.
          expect(llm.callPrivate()).toEqual('hello from model-with-private-state');
        }
      );

      it('leaves llmConfig.model untouched when no override is given', async () => {
        const jsonConfig = {
          llm: {
            type: 'vertexai',
            model: 'configured-model',
          },
        } as RawGthConfig;

        const processJsonConfigMock = vi
          .fn()
          .mockImplementation(async (llmConfig: Record<string, unknown>) => ({
            type: 'vertexai',
            model: llmConfig.model,
          }));
        vi.doMock('#src/providers/vertexai.js', () => ({
          processJsonConfig: processJsonConfigMock,
          postProcessJsonConfig: undefined,
        }));

        const { tryJsonConfig } = await import('#src/config.js');
        const config = await tryJsonConfig(jsonConfig, {});

        expect(processJsonConfigMock).toHaveBeenCalledWith(
          expect.objectContaining({ model: 'configured-model' })
        );
        expect(config.modelDisplayName).toEqual('configured-model');
      });
    });
  });

  /**
   * CFG-52 — the resolver's own spec (builtInToolsResolver.spec.ts) exercises hand-built configs,
   * which cannot see what the LOADER does to `builtInTools`: GS2-60 bakes the 4-layer precedence
   * into every command, so after a real load `commands.pr.builtInTools` is ALWAYS defined and the
   * per-command-vs-root ternary never falls through. These pin the resolver against the shape the
   * loader actually produces, which is the only shape production ever sees.
   */
  describe('gh read-file tool enablement against a loaded config (CFG-52)', () => {
    const loadWith = async (raw: Partial<RawGthConfig>) => {
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));
      const { tryJsonConfig } = await import('#src/config.js');
      return tryJsonConfig(
        { llm: { type: 'vertexai', model: 'test-model' }, ...raw } as RawGthConfig,
        {}
      );
    };

    it('is ON for pr and review with no builtInTools configured anywhere', async () => {
      const config = await loadWith({});
      const { isGhReadFileToolEnabled } = await import('#src/config.js');

      // The shipped default registry never names this tool, so absence-means-enabled is the
      // normal production path, not an edge case.
      expect(config.commands?.pr?.builtInTools).toEqual(['gth_checklist', 'gth_grep']);
      expect(isGhReadFileToolEnabled(config, 'pr')).toBe(true);
      expect(isGhReadFileToolEnabled(config, 'review')).toBe(true);
    });

    it('a ROOT-only disable reaches pr and review, because the loader bakes root into each command', async () => {
      const config = await loadWith({ builtInTools: { gth_gh_read_file: false } });
      const { isGhReadFileToolEnabled } = await import('#src/config.js');

      expect(config.commands?.pr?.builtInTools).toEqual({ gth_gh_read_file: false });
      expect(isGhReadFileToolEnabled(config, 'pr')).toBe(false);
      expect(isGhReadFileToolEnabled(config, 'review')).toBe(false);
    });

    it('a commands.pr disable wins over a root enable and leaves review alone', async () => {
      const config = await loadWith({
        builtInTools: { gth_gh_read_file: true },
        commands: { pr: { builtInTools: { gth_gh_read_file: false } } },
      });
      const { isGhReadFileToolEnabled } = await import('#src/config.js');

      expect(isGhReadFileToolEnabled(config, 'pr')).toBe(false);
      expect(isGhReadFileToolEnabled(config, 'review')).toBe(true);
    });

    it('carries a per-command maxBytes through the loader, defaulting where none is set', async () => {
      const config = await loadWith({
        builtInTools: { gth_gh_read_file: { maxBytes: 111 } },
        commands: { pr: { builtInTools: { gth_gh_read_file: { maxBytes: 222 } } } },
      });
      const { getGhReadFileMaxBytes } = await import('#src/config.js');

      expect(getGhReadFileMaxBytes(config, 'pr')).toBe(222);
      expect(getGhReadFileMaxBytes(config, 'review')).toBe(111);
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
        builtInTools: ['gth_checklist', 'gth_grep'],
        llm: { type: 'vertexai' },
        modelDisplayName: undefined,
        modelProviderType: 'vertexai',
        contentSource: 'file',
        requirementSource: 'file',
        streamOutput: true,
        streamSessionInferenceLog: true,
        writeOutputToFile: false,
        writeBinaryOutputsToFile: true,
        useColour: true,
        useMouse: true,
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
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          exec: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          ask: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          chat: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          api: {
            filesystem: 'read',
            builtInTools: ['gth_checklist', 'gth_grep'],
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
        builtInTools: ['gth_checklist', 'gth_grep'],
        llm: { type: 'anthropic' },
        contentSource: 'file',
        requirementSource: 'file',
        streamOutput: true,
        streamSessionInferenceLog: true,
        writeOutputToFile: false,
        writeBinaryOutputsToFile: true,
        useColour: true,
        useMouse: true,
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
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          exec: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          ask: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          chat: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          api: {
            filesystem: 'read',
            builtInTools: ['gth_checklist', 'gth_grep'],
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
        builtInTools: ['gth_checklist', 'gth_grep'],
        llm: { type: 'groq' },
        contentSource: 'file',
        requirementSource: 'file',
        streamOutput: true,
        streamSessionInferenceLog: true,
        writeOutputToFile: false,
        writeBinaryOutputsToFile: true,
        useColour: true,
        useMouse: true,
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
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          review: {
            filesystem: 'none',
            builtInTools: ['gth_checklist', 'gth_grep'],
            rating: {
              enabled: true,
              passThreshold: 6,
              errorOnReviewFail: true,
              maxRating: 10,
              minRating: 0,
            },
          },
          code: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          exec: { filesystem: 'all', builtInTools: ['gth_checklist', 'gth_grep'] },
          ask: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          chat: { filesystem: 'read', builtInTools: ['gth_checklist', 'gth_grep'] },
          api: {
            filesystem: 'read',
            builtInTools: ['gth_checklist', 'gth_grep'],
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
        // CFG-47 — a ConfigDiscoveryError, not a bare Error. As a bare Error this was invisible to
        // the CLI's top-level guard and to `gth eval`'s harness-error classification alike, so
        // `gth -c <missing path> code` printed a false "TUI unavailable … falling back to the
        // readline session" and then a crash snapshot instead of this one true line.
        const { isConfigDiscoveryError } = await import('#src/config.js');
        expect(isConfigDiscoveryError(error)).toBe(true);
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

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');

      // Function under test - should fall back to default config loading and fail
      const error = await initConfig({ customConfigPath }).catch((e: unknown) => e);

      // The custom path does not match a supported extension, so the format cascade runs and finds
      // nothing. CFG-47 — that terminal case raises rather than exiting; the message is unchanged.
      expect((error as Error).message).toBe(
        'No configuration file found. Please create one of: ' +
          '.gsloth.config.json, .gsloth.config.js, or .gsloth.config.mjs ' +
          'in your project directory.'
      );
      expect(isConfigDiscoveryError(error)).toBe(true);
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    // CFG-47 — RENAMED, because the behaviour it described never existed outside this file. A
    // custom JSON config that reads fine and defines no `llm.type` used to `error(...)` + `exit(1)`
    // and then throw a generic sentinel. In production `exit(1)` ended the run right there, so the
    // user saw "…is not in valid format" and nothing else; only under the mocked `exit` of this
    // suite did execution continue into the catch, get treated as an unreadable layer, and fall
    // through to the module formats and the terminal "No configuration file found". The site now
    // raises a ConfigDiscoveryError, which the catch re-raises rather than falling through — so
    // production behaviour is unchanged and the test-only fall-through is gone.
    it('Should raise, not fall through to other formats, when a custom JSON config defines no llm.type', async () => {
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

      const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');

      // Function under test
      const error = await initConfig({ customConfigPath }).catch((e: unknown) => e);

      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('is not in valid format');
      expect((error as Error).message).toContain('Should at least define llm.type');
      // The format cascade must NOT run: the config was read, it is invalid, and continuing would
      // end in "No configuration file found" — hiding the real and clearly-worded problem.
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalledWith(
        'Failed to read config from .gsloth.config.json, will try other formats.'
      );
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
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

      // Verify init was called with correct parameters
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json', false, undefined);

      // GS2-43: `gth init` scaffolds the config file ONLY — no planted
      // `.gsloth.guidelines.md` / `.gsloth.review.md` templates and no nag warning.
      expect(fileUtilsMock.writeFileIfNotExistsWithMessages).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(fileUtilsMock.getGslothConfigWritePath).toHaveBeenCalledWith('.gsloth.config.json');
      expect(fileUtilsMock.getGslothConfigWritePath).not.toHaveBeenCalledWith(
        '.gsloth.guidelines.md'
      );
      expect(fileUtilsMock.getGslothConfigWritePath).not.toHaveBeenCalledWith('.gsloth.review.md');
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
        'Unknown config type: invalid-config. Available options: vertexai, anthropic, groq, deepseek, openai, google-genai, xai, openrouter, huggingface, ollama'
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
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json', false, undefined);
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
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json', false, undefined);
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
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json', false, undefined);
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
      expect(mockInit).toHaveBeenCalledWith('/mock/write/.gsloth.config.json', false, undefined);
    });
  });
});
