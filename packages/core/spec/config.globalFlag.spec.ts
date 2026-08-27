import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
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

// The home dir is the ONLY seam faked here, so `getGlobalGslothDir` and
// `getGlobalGslothConfigReadPath` run for real — including the `.gsloth-settings/<profile>/`
// segment this node adds. Faking the resolver instead would test a reimplementation of that rule
// and could not tell the profile-scoped lookup from the plain one.
const homeDirMock = { dir: '' };
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeDirMock.dir };
});

describe('CFG-56: -g / --global flag (bypass project config)', () => {
  let projectRoot: string;
  let homeRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectDir = undefined;
    projectRoot = mkdtempSync(resolve(tmpdir(), 'gsloth-project-'));
    homeRoot = mkdtempSync(resolve(tmpdir(), 'gsloth-home-'));
    mockCwd = projectRoot;
    homeDirMock.dir = homeRoot;
    globalRoot = resolve(homeRoot, '.gsloth');
    mkdirSync(globalRoot, { recursive: true });

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
    rmSync(homeRoot, { recursive: true, force: true });
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

  it('names the global profile dir with real path separators when a profile is missing', async () => {
    const { initConfig } = await import('#src/config/loader.js');

    const error = await initConfig({ global: true, identityProfile: 'ghost' }).catch(
      (e: unknown) => e
    );
    expect((error as Error).message).toContain(
      `${resolve(globalRoot, '.gsloth-settings', 'ghost')}${sep}`
    );
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

  /**
   * The global layer is profile-scoped ONLY under `--global`. Without it, `-i <name>` selects a
   * PROJECT directory and the global layer stays the plain `~/.gsloth/.gsloth.config.*` — which is
   * what a run loads (`applyGlobalConfigBase` reads it with no profile). Every reader that scoped
   * the global lookup by the profile alone made `-i` runs diverge from the run they describe.
   */
  describe('the global layer stays unscoped for an -i run without --global', () => {
    it('validateConfig(-i) still validates the plain global layer', async () => {
      writeProjectProfileConfig('reviewer', { llm: { type: 'vertexai', model: 'reviewer' } });
      writeGlobalConfig({ llm: { type: 'vertexai' }, streamOutput: 'yes' });

      const { validateConfig } = await import('#src/config/loader.js');

      const report = await validateConfig({ identityProfile: 'reviewer' });
      expect(report.layers).toHaveLength(2);
      expect(report.layers.map((l) => l.sourceLabel)).toContain('.gsloth.config.json (global)');
      // The run dies on this same file, so the validator must not report the config as valid.
      expect(report.ok).toBe(false);
    });

    it('loadConfiguredTui(-i) inherits tui from the plain global config', async () => {
      writeProjectProfileConfig('reviewer', { llm: { type: 'vertexai', model: 'reviewer' } });
      writeGlobalConfig({ llm: { type: 'vertexai' }, tui: true });

      const { loadConfiguredTui } = await import('#src/config/loader.js');

      expect(await loadConfiguredTui({ identityProfile: 'reviewer' })).toBe(true);
    });

    it('hasAnyConfig(-i) sees a plain global config', async () => {
      writeGlobalConfig({ llm: { type: 'vertexai' } });

      const { hasAnyConfig } = await import('#src/config/loader.js');

      expect(await hasAnyConfig({ identityProfile: 'reviewer' })).toBe(true);
    });
  });

  describe("the global layer's extends is walked exactly where a run walks it", () => {
    it('is not walked when a project config exists', async () => {
      // With a project config the run underlays the RAW global config (applyGlobalConfigBase) and
      // never resolves its `extends`, so a base that resolves nowhere cannot fail that run.
      writeProjectConfig({ llm: { type: 'vertexai', model: 'project-model' } });
      writeGlobalConfig({ llm: { type: 'vertexai' }, extends: 'nowhere' });

      const { validateConfig } = await import('#src/config/loader.js');

      const report = await validateConfig({});
      expect(report.ok).toBe(true);
    });

    it('is walked when the global config is the only layer', async () => {
      // No project config: the run loads the global config and DOES resolve its `extends`, so an
      // unresolvable base is a real failure the validator must report.
      writeGlobalConfig({ llm: { type: 'vertexai' }, extends: 'nowhere' });

      const { validateConfig } = await import('#src/config/loader.js');

      const report = await validateConfig({});
      expect(report.ok).toBe(false);
      expect(report.layers[0].errorMessage).toContain('nowhere');
    });

    /**
     * CFG-57 — the same rule for the OTHER reader of the global layer. `loadConfiguredTui` answers
     * the surface question before a session exists, so a `tui` it fails to see is a surface the
     * user asked for and did not get. Each cell asserts the reader AND the config `initConfig`
     * builds: one assertion alone cannot tell agreement from a shared mistake.
     */
    it('loadConfiguredTui reads a tui inherited through the global extends under --global', async () => {
      // The node's repro: with `-g` the global layer is the only layer, so a `tui` reached through
      // `extends` is the whole answer rather than an underlay.
      writeGlobalProfileConfig('base-profile', { tui: true });
      writeGlobalConfig({ llm: { type: 'vertexai' }, extends: 'base-profile' });

      const { loadConfiguredTui, initConfig } = await import('#src/config/loader.js');

      expect(await loadConfiguredTui({ global: true })).toBe(true);
      const resolved = await initConfig({ global: true });
      expect(resolved.tui).toBe(true);
    });

    it('reads it for a global-only run without --global too, from the scope the run searches', async () => {
      // No `-g`, no project config: `initConfig` still takes its global-only branch and resolves
      // `extends` there — with the PROJECT scope, because only `--global` confines profile names to
      // `~/.gsloth/.gsloth-settings/`. A reader that hardcoded the global scope would fail to find
      // this base and raise, so this cell pins the scope as well as the walk.
      writeProjectProfileConfig('base-profile', { tui: true });
      writeGlobalConfig({ llm: { type: 'vertexai' }, extends: 'base-profile' });

      const { loadConfiguredTui, initConfig } = await import('#src/config/loader.js');

      expect(await loadConfiguredTui({})).toBe(true);
      const resolved = await initConfig({});
      expect(resolved.tui).toBe(true);
    });

    it('does NOT read it when a project config exists, because the run does not resolve it there', async () => {
      // The negative cell that pins the gate. With a project layer the run underlays the RAW global
      // config (applyGlobalConfigBase) and never resolves its `extends`, so the inherited `tui` is
      // not part of that run — a reader that walked the chain unconditionally would hand the
      // dispatcher a surface the session it is choosing for does not agree with. The base sits in
      // the PROJECT profile scope, which is exactly where an unconditional walk would find it.
      writeProjectProfileConfig('base-profile', { tui: true });
      writeProjectConfig({ llm: { type: 'vertexai', model: 'project-model' } });
      writeGlobalConfig({ llm: { type: 'vertexai' }, extends: 'base-profile' });

      const { loadConfiguredTui, initConfig } = await import('#src/config/loader.js');

      expect(await loadConfiguredTui({})).toBeUndefined();
      const resolved = await initConfig({});
      expect(resolved.tui).toBeUndefined();
    });
  });

  /**
   * CFG-57 — `-g` and `-c` both choose WHERE configuration comes from, so the pair is refused. The
   * CLI refuses it at flag-parse time; the loader refuses it wherever config is BUILT, which is the
   * only place an embedder calling `initConfig` directly can be refused at all.
   */
  describe('--global and --config are refused by the loader, not only at the CLI edge', () => {
    it('refuses the pair instead of silently loading the global config and ignoring the named file', async () => {
      const customPath = resolve(projectRoot, 'custom.gsloth.config.json');
      writeFileSync(
        customPath,
        JSON.stringify({ llm: { type: 'vertexai', model: 'custom-model' } })
      );
      writeGlobalConfig({ llm: { type: 'vertexai', model: 'global-model' } });

      const { initConfig } = await import('#src/config/loader.js');

      const error = await initConfig({ global: true, customConfigPath: customPath }).catch(
        (e: unknown) => e
      );
      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('--global and --config');
    });

    it('names the conflict rather than the missing file when the named path does not exist', async () => {
      // Ordering: the conflict is decided before the `-c` existence check, so a user who passed both
      // is told what is actually wrong instead of being sent to look for a file they never needed.
      writeGlobalConfig({ llm: { type: 'vertexai', model: 'global-model' } });

      const { initConfig } = await import('#src/config/loader.js');

      const error = await initConfig({
        global: true,
        customConfigPath: resolve(projectRoot, 'no-such-config.json'),
      }).catch((e: unknown) => e);
      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('--global and --config');
      expect((error as Error).message).not.toContain('does not exist');
    });

    it('still loads a lone --config, so the guard refuses only the pair', async () => {
      // The control: without `global` the same named file loads exactly as before. A guard that
      // fired on `customConfigPath` alone would pass both cells above and break every `-c` run.
      const customPath = resolve(projectRoot, 'custom.gsloth.config.json');
      writeFileSync(
        customPath,
        JSON.stringify({ llm: { type: 'vertexai', model: 'custom-model' } })
      );

      const { initConfig } = await import('#src/config/loader.js');

      const resolved = await initConfig({ customConfigPath: customPath });
      expect(resolved.modelDisplayName).toBe('custom-model');
    });
  });

  /**
   * The `approvals.rater` existence check runs on the LAYER, so it must resolve the named profile
   * in that layer's scope. Under `--global` that is `~/.gsloth/.gsloth-settings/` — the same scope
   * `gth -g config validate` reports on.
   */
  describe('approvals.rater resolves in the scope of the run', () => {
    it('accepts a rater profile that exists globally', async () => {
      writeGlobalProfileConfig('safety', { llm: { type: 'vertexai', model: 'safety-model' } });
      writeGlobalConfig({
        llm: { type: 'vertexai', model: 'global-model' },
        approvals: { rater: 'safety' },
      });

      const { initConfig, validateConfig } = await import('#src/config/loader.js');

      const report = await validateConfig({ global: true });
      expect(report.ok).toBe(true);

      const resolved = await initConfig({ global: true });
      expect(resolved.modelDisplayName).toBe('global-model');
    });

    it('rejects a rater profile that exists only in the project', async () => {
      writeProjectProfileConfig('safety', { llm: { type: 'vertexai', model: 'project-safety' } });
      writeGlobalConfig({
        llm: { type: 'vertexai', model: 'global-model' },
        approvals: { rater: 'safety' },
      });

      const { initConfig, validateConfig } = await import('#src/config/loader.js');

      const report = await validateConfig({ global: true });
      expect(report.ok).toBe(false);

      const error = await initConfig({ global: true }).catch((e: unknown) => e);
      expect(isConfigDiscoveryError(error)).toBe(true);
      expect((error as Error).message).toContain('identity profile "safety" not found');
      // The message must name the directory that was actually searched, not the project one.
      expect((error as Error).message).toContain(
        `${resolve(globalRoot, '.gsloth-settings', 'safety')}${sep}`
      );
    });

    it("names the global profile directory in validateConfig's own rater message", async () => {
      // The case above asserts on the message initConfig throws. `validateConfig` builds its own
      // rater message through the schema's `describeProfileDir` hook, so the directory it names is
      // a separate code path — and the one `gth -g config validate` prints. Without the hook it
      // falls back to the PROJECT directory and sends the user to a place nothing searched.
      writeProjectProfileConfig('safety', { llm: { type: 'vertexai', model: 'project-safety' } });
      writeGlobalConfig({
        llm: { type: 'vertexai', model: 'global-model' },
        approvals: { rater: 'safety' },
      });

      const { validateConfig } = await import('#src/config/loader.js');

      const report = await validateConfig({ global: true });
      expect(report.ok).toBe(false);
      // Under `--global` the project layer is skipped, so the global layer is the only one.
      const globalLayer = report.layers.find((layer) => layer.sourceLabel.includes('(global)'));
      expect(globalLayer).toBeDefined();
      expect(globalLayer!.errorMessage).toContain('identity profile "safety" not found');
      // An absolute path under the fake home: the project fallback `.gsloth/.gsloth-settings/
      // safety/` is a suffix of it, so only the home-rooted form can satisfy this.
      expect(globalLayer!.errorMessage).toContain(
        `${resolve(globalRoot, '.gsloth-settings', 'safety')}${sep}`
      );
    });
  });
});
