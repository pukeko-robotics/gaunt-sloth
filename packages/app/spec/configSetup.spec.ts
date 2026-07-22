import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoisted, declared before the describe per AGENTS.md) ---

const constantsMock = {
  GSLOTH_DIR: '.gsloth',
  USER_PROJECT_CONFIG_JSON: '.gsloth.config.json',
};
vi.mock('@gaunt-sloth/core/constants.js', () => constantsMock);

vi.mock('@gaunt-sloth/core/config.js', () => ({
  availableDefaultConfigs: ['vertexai', 'anthropic', 'groq', 'openrouter'],
}));

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const getGslothConfigWritePath = vi.fn();
const writeFileIfNotExistsWithMessages = vi.fn();
vi.mock('@gaunt-sloth/review/utils/fileUtils.js', () => ({
  getGslothConfigWritePath,
  writeFileIfNotExistsWithMessages,
}));

const exit = vi.fn();
const getCurrentWorkDir = vi.fn();
// CFG-14: createProjectConfig resolves the init model via modelDiscovery, which reads `env`
// for provider API keys. An empty env → no live discovery → init model=undefined (omit).
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  exit,
  getCurrentWorkDir,
  env: {} as Record<string, string | undefined>,
}));

const fsMock = {
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

// The provider module that createProjectConfig dynamically imports for `vertexai`.
const vertexaiInit = vi.fn();
vi.mock('@gaunt-sloth/core/providers/vertexai.js', () => ({
  init: vertexaiInit,
}));

const CONFIG_PATH = '/proj/.gsloth.config.json';

describe('createProjectConfig (gth init <provider>)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getCurrentWorkDir.mockReturnValue('/proj');
    getGslothConfigWritePath.mockReturnValue(CONFIG_PATH);
    // .gsloth dir "exists" so ensureGslothDir does not mkdir; config existence is per-test.
    fsMock.existsSync.mockImplementation((p: string) => p !== CONFIG_PATH);
  });

  it('warns and keeps an existing config without writing when --force is absent', async () => {
    fsMock.existsSync.mockImplementation(() => true); // config (and dir) already present

    const { createProjectConfig } = await import('#src/commands/configSetup.js');
    await createProjectConfig('vertexai', false);

    expect(vertexaiInit).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('already exists and was kept')
    );
    // No false success trail.
    expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();
  });

  it('overwrites an existing config when --force is set (init called with force=true)', async () => {
    fsMock.existsSync.mockImplementation(() => true);

    const { createProjectConfig } = await import('#src/commands/configSetup.js');
    await createProjectConfig('vertexai', true);

    expect(vertexaiInit).toHaveBeenCalledTimes(1);
    // vertexai has no live model endpoint (kind:'none'), so the model is omitted (undefined).
    expect(vertexaiInit).toHaveBeenCalledWith(CONFIG_PATH, true, undefined);
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalledWith(
      expect.stringContaining('already exists and was kept')
    );
  });

  it('writes the config normally when none exists (init called with force=false)', async () => {
    fsMock.existsSync.mockImplementation((p: string) => p !== CONFIG_PATH);

    const { createProjectConfig } = await import('#src/commands/configSetup.js');
    await createProjectConfig('vertexai', false);

    expect(vertexaiInit).toHaveBeenCalledTimes(1);
    expect(vertexaiInit).toHaveBeenCalledWith(CONFIG_PATH, false, undefined);
  });

  // GS2-43: `gth init` scaffolds the config file ONLY — no planted `.gsloth.guidelines.md` /
  // `.gsloth.review.md` templates (the bundled defaults apply) and no guidelines nag warning.
  it('writes only .gsloth.config.json — no template files, no nag warning', async () => {
    fsMock.existsSync.mockImplementation((p: string) => p !== CONFIG_PATH);

    const { createProjectConfig } = await import('#src/commands/configSetup.js');
    await createProjectConfig('vertexai', false);

    expect(writeFileIfNotExistsWithMessages).not.toHaveBeenCalled();
    expect(getGslothConfigWritePath).toHaveBeenCalledTimes(1);
    expect(getGslothConfigWritePath).toHaveBeenCalledWith('.gsloth.config.json');
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });
});
