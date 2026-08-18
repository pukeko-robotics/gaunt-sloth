import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { isConfigDiscoveryError } from '#src/config/configDiscovery.js';

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

let mockProjectDir: string | undefined = undefined;
let mockCwd: string = '';

vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return {
    ...actual,
    getCurrentWorkDir: () => mockCwd,
    getProjectDir: () => mockProjectDir ?? mockCwd,
    setProjectDir: (dir: string | undefined) => {
      mockProjectDir = dir;
    },
    isTTY: () => true,
    isStdoutTTY: () => true,
  };
});

// Override getGlobalGslothDir and getGlobalGslothConfigReadPath to a dedicated temp global dir.
const globalDirMock = {
  dir: '',
};
vi.mock('#src/utils/globalConfigUtils.js', async () => {
  const actual = await vi.importActual<typeof import('#src/utils/globalConfigUtils.js')>(
    '#src/utils/globalConfigUtils.js'
  );
  return {
    ...actual,
    getGlobalGslothDir: () => globalDirMock.dir,
    getGlobalGslothConfigReadPath: (filename: string, identityProfile?: string) => {
      const p = identityProfile?.trim();
      if (p) {
        return resolve(globalDirMock.dir, '.gsloth-settings', p, filename);
      }
      return resolve(globalDirMock.dir, filename);
    },
  };
});

describe('CFG-56: -g / --global flag (bypass project config)', () => {
  let projectRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectDir = undefined;
    projectRoot = mkdtempSync(resolve(tmpdir(), 'gsloth-project-'));
    globalRoot = mkdtempSync(resolve(tmpdir(), 'gsloth-global-'));
    mockCwd = projectRoot;
    globalDirMock.dir = globalRoot;

    mkdirSync(resolve(projectRoot, '.git'), { recursive: true });

    vi.doMock('#src/providers/vertexai.js', () => ({
      processJsonConfig: vi.fn().mockImplementation((llm: Record<string, unknown>) => ({
        type: 'vertexai',
        ...llm,
      })),
      postProcessJsonConfig: undefined,
    }));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(globalRoot, { recursive: true, force: true });
  });

  const writeProjectConfig = (
    content: Record<string, unknown>,
    filename = '.gsloth.config.json'
  ) => {
    const p = resolve(projectRoot, filename);
    writeFileSync(p, JSON.stringify(content));
    return p;
  };

  const writeGlobalConfig = (
    content: Record<string, unknown>,
    filename = '.gsloth.config.json'
  ) => {
    const p = resolve(globalRoot, filename);
    writeFileSync(p, JSON.stringify(content));
    return p;
  };

  const writeGlobalProfileConfig = (
    profile: string,
    content: Record<string, unknown>,
    filename = '.gsloth.config.json'
  ) => {
    const dir = resolve(globalRoot, '.gsloth-settings', profile);
    mkdirSync(dir, { recursive: true });
    const p = resolve(dir, filename);
    writeFileSync(p, JSON.stringify(content));
    return p;
  };

  const writeProjectProfileConfig = (
    profile: string,
    content: Record<string, unknown>,
    filename = '.gsloth.config.json'
  ) => {
    const dir = resolve(projectRoot, '.gsloth', '.gsloth-settings', profile);
    mkdirSync(dir, { recursive: true });
    const p = resolve(dir, filename);
    writeFileSync(p, JSON.stringify(content));
    return p;
  };

  it('findProjectConfigPath returns undefined and hasProjectConfig returns false when global is active', async () => {
    writeProjectConfig({ llm: { type: 'vertexai', model: 'project-model' } });
    const { findProjectConfigPath, hasProjectConfig } = await import('#src/config/loader.js');

    // Without global override: finds project config
    expect(findProjectConfigPath({})).toBeDefined();
    expect(hasProjectConfig({})).toBe(true);

    // With global override: bypasses project config
    expect(findProjectConfigPath({ global: true })).toBeUndefined();
    expect(hasProjectConfig({ global: true })).toBe(false);
  });

  it('initConfig({ global: true }) loads only global configuration, ignoring project config', async () => {
    writeProjectConfig({
      llm: { type: 'vertexai', model: 'project-model' },
      prompts: { guidelines: 'PROJECT-GUIDELINES.md' },
    });
    writeGlobalConfig({
      llm: { type: 'vertexai', model: 'global-model' },
      prompts: { guidelines: 'GLOBAL-GUIDELINES.md' },
    });

    const { initConfig } = await import('#src/config/loader.js');

    // Default run (no global flag): project config takes precedence
    const projectResolved = await initConfig({});
    expect(projectResolved.modelDisplayName).toBe('project-model');
    expect(projectResolved.prompts?.guidelines).toBe('PROJECT-GUIDELINES.md');

    // With global flag: loads only global config
    const globalResolved = await initConfig({ global: true });
    expect(globalResolved.modelDisplayName).toBe('global-model');
    expect(globalResolved.prompts?.guidelines).toBe('GLOBAL-GUIDELINES.md');
  });

  it('initConfig({ global: true, identityProfile: "sec" }) resolves profile in ~/.gsloth/.gsloth-settings/sec/', async () => {
    writeProjectProfileConfig('sec', {
      llm: { type: 'vertexai', model: 'project-sec-model' },
    });
    writeGlobalProfileConfig('sec', {
      llm: { type: 'vertexai', model: 'global-sec-model' },
    });

    const { initConfig } = await import('#src/config/loader.js');

    const resolved = await initConfig({ global: true, identityProfile: 'sec' });
    expect(resolved.modelDisplayName).toBe('global-sec-model');
  });

  it('resolves extends chain under ~/.gsloth/.gsloth-settings/ when global is active', async () => {
    writeGlobalProfileConfig('base-profile', {
      llm: { type: 'vertexai', model: 'global-base-model' },
      organization: { name: 'GlobalBaseOrg' },
    });
    writeGlobalProfileConfig('child-profile', {
      extends: 'base-profile',
      organization: { name: 'GlobalChildOrg' },
    });

    const { initConfig } = await import('#src/config/loader.js');

    const resolved = await initConfig({ global: true, identityProfile: 'child-profile' });
    expect(resolved.modelDisplayName).toBe('global-base-model');
    expect(resolved.organization?.name).toBe('GlobalChildOrg');
  });

  it('throws ConfigDiscoveryError when explicit profile is missing globally', async () => {
    // Only exists in project, not in global
    writeProjectProfileConfig('project-only', {
      llm: { type: 'vertexai', model: 'project-model' },
    });

    const { initConfig } = await import('#src/config/loader.js');

    const error = await initConfig({ global: true, identityProfile: 'project-only' }).catch(
      (e: unknown) => e
    );
    expect(isConfigDiscoveryError(error)).toBe(true);
    expect((error as Error).message).toContain('identity profile "project-only" not found');
  });

  it('throws ConfigDiscoveryError when global config does not exist and global is true', async () => {
    writeProjectConfig({ llm: { type: 'vertexai', model: 'project-model' } });

    const { initConfig } = await import('#src/config/loader.js');

    const error = await initConfig({ global: true }).catch((e: unknown) => e);
    expect(isConfigDiscoveryError(error)).toBe(true);
    expect((error as Error).message).toContain('No configuration file found');
  });

  it('validateConfig({ global: true }) inspects only the global layer', async () => {
    writeProjectConfig({ llm: { type: 'vertexai', model: 'project-model' } });
    writeGlobalConfig({ llm: { type: 'vertexai', model: 'global-model' } });

    const { validateConfig } = await import('#src/config/loader.js');

    // Default validation: validates both project and global layers
    const reportDefault = await validateConfig({});
    expect(reportDefault.found).toBe(true);
    expect(reportDefault.ok).toBe(true);
    expect(reportDefault.layers).toHaveLength(2);

    // Global-only validation: validates only the global layer
    const reportGlobal = await validateConfig({ global: true });
    expect(reportGlobal.found).toBe(true);
    expect(reportGlobal.ok).toBe(true);
    expect(reportGlobal.layers).toHaveLength(1);
    expect(reportGlobal.layers[0].sourceLabel).toBe('.gsloth.config.json (global)');
  });

  it('loadConfiguredTui({ global: true }) ignores project tui and returns global tui', async () => {
    writeProjectConfig({ llm: { type: 'vertexai' }, tui: false });
    writeGlobalConfig({ llm: { type: 'vertexai' }, tui: true });

    const { loadConfiguredTui } = await import('#src/config/loader.js');

    expect(await loadConfiguredTui({})).toBe(false);
    expect(await loadConfiguredTui({ global: true })).toBe(true);
  });
});
