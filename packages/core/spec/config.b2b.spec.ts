import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '#src/core/types.js';
import type { RawGthConfig } from '#src/config.js';

const fsMock = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const urlMock = { pathToFileURL: vi.fn() };
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
  error: vi.fn(),
  getCurrentWorkDir: vi.fn(),
  getInstallDir: vi.fn(),
  setUseColour: vi.fn(),
  isTTY: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const globalConfigUtilsMock = {
  getGlobalGslothConfigReadPath: vi
    .fn()
    .mockImplementation(() => '/mock/global-absent/no-such-config'),
  getGlobalGslothConfigWritePath: vi
    .fn()
    .mockImplementation((filename: string) => `/mock/global-write/${filename}`),
};
vi.mock('#src/utils/globalConfigUtils.js', () => globalConfigUtilsMock);

describe('config B2b behavior changes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    systemUtilsMock.getCurrentWorkDir.mockReturnValue('/mock/current/dir');
    systemUtilsMock.getInstallDir.mockReturnValue('/mock/install/dir');
    systemUtilsMock.isTTY.mockReturnValue(true);
    globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
      () => '/mock/global-absent/no-such-config'
    );
    fileUtilsMock.getGslothConfigReadPath.mockImplementation(
      (path: string) => `/mock/read/${path}`
    );
  });

  describe('.ts config format (Part 2)', () => {
    it('loads and validates a .ts config via async configure()', async () => {
      const mockConfig = { llm: { type: 'anthropic' } };
      // Only the .ts file exists (no json/js/mjs).
      fsMock.existsSync.mockImplementation(
        (path: string) => !!path && path.includes('.gsloth.config.ts')
      );
      fileUtilsMock.importExternalFile.mockImplementation((path: string) =>
        path.includes('.gsloth.config.ts')
          ? Promise.resolve({ configure: vi.fn().mockResolvedValue(mockConfig) })
          : Promise.reject(new Error('not found'))
      );

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Module formats (js/mjs/ts) arrive pre-instantiated; llm passes through unchanged.
      expect(config.llm).toEqual({ type: 'anthropic' });
      // Defaults are merged in (validated through the same Zod path as js/mjs).
      expect(config.contentSource).toBe('file');
      expect(config.streamOutput).toBe(true);
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });
  });

  describe('array merge policy (Part 3)', () => {
    const GLOBAL_JSON_PATH = '/mock/global/.gsloth.config.json';
    const PROJECT_JSON_MARKER = '.gsloth.config.json';

    function setupGlobalAndProject(
      globalConfig: Record<string, unknown>,
      projectConfig: Record<string, unknown>
    ) {
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation((filename: string) =>
        filename === PROJECT_JSON_MARKER ? GLOBAL_JSON_PATH : `/mock/global-absent/${filename}`
      );
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return true;
        return path === `/mock/read/${PROJECT_JSON_MARKER}`;
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return JSON.stringify(globalConfig);
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

    it('unions + dedupes an ADDITIVE root field (allowDirs) across global → project', async () => {
      setupGlobalAndProject(
        { allowDirs: ['/a', '/shared'] },
        { llm: { type: 'vertexai' }, allowDirs: ['/b', '/shared'] }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});
      // global-first, de-duped.
      expect(config.allowDirs).toEqual(['/a', '/shared', '/b']);
    });

    it('unions + dedupes a nested ADDITIVE field (aiignore.patterns)', async () => {
      setupGlobalAndProject(
        { aiignore: { enabled: true, patterns: ['*.log', 'shared'] } },
        { llm: { type: 'vertexai' }, aiignore: { patterns: ['*.tmp', 'shared'] } }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});
      expect(config.aiignore).toEqual({ enabled: true, patterns: ['*.log', 'shared', '*.tmp'] });
    });

    it('REPLACES a non-additive array field (builtInTools) — project wins, no union', async () => {
      setupGlobalAndProject(
        { builtInTools: ['globalTool'] },
        { llm: { type: 'vertexai' }, builtInTools: ['projectTool'] }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});
      expect(config.builtInTools).toEqual(['projectTool']);
    });
  });

  describe('merge purity (resolveConfig has no console side-effects)', () => {
    it('resolveConfig resolves values WITHOUT calling setUseColour / setConsoleLevel', async () => {
      const { resolveConfig } = await import('#src/config/loader.js');
      const result = resolveConfig(
        { llm: { type: 'x' }, useColour: true, consoleLevel: 'debug' } as unknown as RawGthConfig,
        {}
      );
      // The pure resolver computes the numeric level...
      expect(result.consoleLevel).toBe(StatusLevel.DEBUG);
      // ...but applies NO process-global side effects (those live in the mergeConfig wrapper).
      expect(systemUtilsMock.setUseColour).not.toHaveBeenCalled();
      expect(consoleUtilsMock.setConsoleLevel).not.toHaveBeenCalled();
    });
  });
});
