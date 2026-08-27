import { beforeEach, describe, expect, it, vi } from 'vitest';
// REAL node:path (never mocked here — see MOCK_DIR below) and the REAL constants production uses,
// so every expectation is built by the same calls the code under test makes (OPS-28).
import { resolve } from 'node:path';
import { GSLOTH_DIR, GSLOTH_SETTINGS_DIR } from '#src/constants.js';

const nodeFsMock = {
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
};
vi.mock('node:fs', () => nodeFsMock);

// `fileUtils.ts` computes `corePackageDir` at MODULE SCOPE from
// `resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')`, so this stub runs at import time,
// before any `beforeEach`. It is a plain function rather than `vi.fn().mockReturnValue(...)`
// deliberately: with the real `dirname` now in play, a reset that cleared the return value would
// hand `dirname` an `undefined` and make the module fail to import. A plain function cannot be
// reset, so importability no longer depends on `vi.resetAllMocks()` semantics.
vi.mock('node:url', () => ({
  default: { pathToFileURL: vi.fn() },
  fileURLToPath: () => '/mock/core/dist/utils/fileUtils.js',
}));

const systemUtilsMock = {
  getCurrentWorkDir: vi.fn(),
  getProjectDir: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

/**
 * The project dir production reads through the mocked `getProjectDir()`, and therefore the base it
 * feeds to the real `resolve()`.
 *
 * Everything below is derived from it through that same real `resolve()`. A hand-written POSIX
 * literal would only match on POSIX: on win32 `resolve()` returns a drive-lettered,
 * backslash-separated path, so a literal `'/test/project/.gsloth'` compared by exact equality is
 * never equal — and where the comparison sits inside an `existsSync` predicate it does not merely
 * fail, it silently steers the code down the OTHER branch while the test stays green. That is why
 * `node:path` is deliberately NOT mocked in this file: mocking `resolve` to `args.join('/')` made
 * the mock the definition of joining, so the assertions could only confirm the mock agreed with
 * itself and would have passed even if production concatenated strings.
 */
const MOCK_DIR = '/test/project';
const GSLOTH_DIR_PATH = resolve(MOCK_DIR, GSLOTH_DIR);
const GSLOTH_SETTINGS_PATH = resolve(GSLOTH_DIR_PATH, GSLOTH_SETTINGS_DIR);
const SETTINGS_CONFIG_PATH = resolve(GSLOTH_SETTINGS_PATH, '.gsloth.config.json');

describe('pathUtils', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default mock values
    systemUtilsMock.getCurrentWorkDir.mockImplementation(() => MOCK_DIR);
    systemUtilsMock.getProjectDir.mockImplementation(() => MOCK_DIR);
  });

  it('gslothDirExists should return true when .gsloth directory exists', async () => {
    nodeFsMock.existsSync.mockImplementation((path: string) => {
      return path === GSLOTH_DIR_PATH;
    });

    const { gslothDirExists } = await import('#src/utils/fileUtils.js');

    expect(gslothDirExists()).toBe(true);
    expect(nodeFsMock.existsSync).toHaveBeenCalledWith(GSLOTH_DIR_PATH);
  });

  it('gslothDirExists should return false when .gsloth directory does not exist', async () => {
    nodeFsMock.existsSync.mockImplementation((path: string) => {
      return path !== GSLOTH_DIR_PATH;
    });

    const { gslothDirExists } = await import('#src/utils/fileUtils.js');

    expect(gslothDirExists()).toBe(false);
    expect(nodeFsMock.existsSync).toHaveBeenCalledWith(GSLOTH_DIR_PATH);
  });

  it('getGslothFilePath should return path within .gsloth directory when it exists', async () => {
    nodeFsMock.existsSync.mockImplementation((path: string) => {
      return path === GSLOTH_DIR_PATH;
    });

    const { getGslothFilePath } = await import('#src/utils/fileUtils.js');

    const result = getGslothFilePath('test-file.md');

    expect(result).toBe(resolve(GSLOTH_DIR_PATH, 'test-file.md'));
    expect(nodeFsMock.existsSync).toHaveBeenCalledWith(GSLOTH_DIR_PATH);
  });

  it('getGslothFilePath should return path in project root when .gsloth directory does not exist', async () => {
    nodeFsMock.existsSync.mockImplementation((path: string) => {
      return path !== GSLOTH_DIR_PATH;
    });

    const { getGslothFilePath } = await import('#src/utils/fileUtils.js');

    const result = getGslothFilePath('test-file.md');

    expect(result).toBe(resolve(MOCK_DIR, 'test-file.md'));
    expect(nodeFsMock.existsSync).toHaveBeenCalledWith(GSLOTH_DIR_PATH);
  });

  it('getGslothConfigWritePath should create .gsloth-settings directory when it does not exist', async () => {
    // First call to existsSync returns true for .gsloth dir, second call returns false for .gsloth-settings dir
    let callCount = 0;
    nodeFsMock.existsSync.mockImplementation((_path: string) => {
      callCount++;
      if (callCount === 1) return true; // .gsloth exists
      return false; // .gsloth-settings does not exist
    });

    const { getGslothConfigWritePath } = await import('#src/utils/fileUtils.js');

    const result = getGslothConfigWritePath('.gsloth.config.json');

    expect(result).toBe(SETTINGS_CONFIG_PATH);
    expect(
      nodeFsMock.mkdirSync,
      'getGslothConfigWritePath should create the .gsloth/.gsloth-settings'
    ).toHaveBeenCalledWith(GSLOTH_SETTINGS_PATH, {
      recursive: true,
    });
  });

  it('getGslothConfigReadPath should return path in .gsloth-settings when config file exists there', async () => {
    // Mock existsSync to return true for both .gsloth dir and config file within .gsloth-settings
    nodeFsMock.existsSync.mockImplementation((_path: string) => true);

    const { getGslothConfigReadPath } = await import('#src/utils/fileUtils.js');

    const result = getGslothConfigReadPath('.gsloth.config.json', undefined);

    expect(result).toBe(SETTINGS_CONFIG_PATH);
  });

  it('getGslothConfigReadPath should return path in project root when .gsloth exists but config file does not exist in .gsloth-settings', async () => {
    // .gsloth exists, but the config file inside .gsloth-settings does not. Compared by exact
    // equality against the path production actually builds — a `includes('.gsloth-settings/...')`
    // substring test would never match win32's backslashes, so existsSync would answer true for the
    // config file and this test would silently assert the OTHER branch.
    nodeFsMock.existsSync.mockImplementation((_path: string) => {
      return _path !== SETTINGS_CONFIG_PATH;
    });

    const { getGslothConfigReadPath } = await import('#src/utils/fileUtils.js');

    const result = getGslothConfigReadPath('.gsloth.config.json', undefined);

    expect(result).toBe(resolve(MOCK_DIR, '.gsloth.config.json'));
  });

  it('getGslothConfigReadPath should return path for identity when identity profile provided', async () => {
    // Mock existsSync to return true for both .gsloth dir and config file within .gsloth-settings
    nodeFsMock.existsSync.mockImplementation((_path: string) => true);

    const { getGslothConfigReadPath } = await import('#src/utils/fileUtils.js');

    const result = getGslothConfigReadPath('.gsloth.config.json', 'devops');

    expect(result).toBe(resolve(GSLOTH_SETTINGS_PATH, 'devops', '.gsloth.config.json'));
  });

  it('getGslothConfigWritePath should write under .gsloth-settings/<profile> when a profile is given, creating .gsloth as needed', async () => {
    // .gsloth does not exist yet, profile dir does not exist yet either.
    nodeFsMock.existsSync.mockReturnValue(false);

    const { getGslothConfigWritePath } = await import('#src/utils/fileUtils.js');

    const result = getGslothConfigWritePath('.gsloth.config.json', 'test2');

    expect(result).toBe(resolve(GSLOTH_SETTINGS_PATH, 'test2', '.gsloth.config.json'));
    expect(nodeFsMock.mkdirSync).toHaveBeenCalledWith(resolve(GSLOTH_SETTINGS_PATH, 'test2'), {
      recursive: true,
    });
  });

  it('getGslothConfigWritePath should not recreate an existing profile directory', async () => {
    nodeFsMock.existsSync.mockReturnValue(true);

    const { getGslothConfigWritePath } = await import('#src/utils/fileUtils.js');

    const result = getGslothConfigWritePath('.gsloth.config.json', 'test2');

    expect(result).toBe(resolve(GSLOTH_SETTINGS_PATH, 'test2', '.gsloth.config.json'));
    expect(nodeFsMock.mkdirSync).not.toHaveBeenCalled();
  });

  it('getGslothConfigWritePath should treat a blank profile as no profile', async () => {
    let callCount = 0;
    nodeFsMock.existsSync.mockImplementation((_path: string) => {
      callCount++;
      if (callCount === 1) return true; // .gsloth exists
      return false; // .gsloth-settings does not exist
    });

    const { getGslothConfigWritePath } = await import('#src/utils/fileUtils.js');

    const result = getGslothConfigWritePath('.gsloth.config.json', '   ');

    expect(result).toBe(SETTINGS_CONFIG_PATH);
  });
});
