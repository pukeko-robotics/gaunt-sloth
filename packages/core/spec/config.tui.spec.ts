import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// CFG-37 — the `tui` config key, asserted THROUGH THE REAL LOADER: real files in temp dirs, the
// actual up-tree discovery, the actual global lookup, the actual layering. Mirrors the
// config.jsonc.spec harness, and mocks nothing in the loader itself — only three seams:
// - globalConfigUtils.getGlobalGslothConfigReadPath → a per-test temp "global" dir, so a test
//   never reads (or is influenced by) the developer's real ~/.gsloth config;
// - the vertexai provider module → initConfig would otherwise build a real LLM;
// - systemUtils.exit → throws instead of killing the vitest worker if an error path is hit.
//
// Every path here is built with resolve() rather than a POSIX literal, so the assertions mean the
// same thing on the Windows CI cell.
const { getGlobalGslothConfigReadPathMock, exitMock, processJsonConfigMock } = vi.hoisted(() => ({
  getGlobalGslothConfigReadPathMock: vi.fn<(_filename: string) => string>(),
  exitMock: vi.fn<(_code?: number) => never>(),
  processJsonConfigMock: vi.fn(),
}));
vi.mock('#src/utils/globalConfigUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/globalConfigUtils.js')>();
  return { ...actual, getGlobalGslothConfigReadPath: getGlobalGslothConfigReadPathMock };
});
vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return { ...actual, exit: exitMock };
});
vi.mock('#src/providers/vertexai.js', () => ({
  processJsonConfig: processJsonConfigMock,
  postProcessJsonConfig: undefined,
}));

const FAKE_LLM = { fakeLlm: true };
const LLM_SPEC = { type: 'vertexai' };

describe('tui config key (CFG-37)', () => {
  let root: string;
  let globalDir: string;
  let projectDir: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(async () => {
    vi.resetAllMocks(); // AGENTS.md — reset first; re-apply implementations below.
    // A prior test's initConfig may have left projectDir pointing at its (now deleted) temp dir;
    // bare discovery resolves the cwd level through getProjectDir() (the GS2-11 ordering
    // invariant), so clear it to keep each test cwd-driven.
    const { setProjectDir } = await import('#src/utils/systemUtils.js');
    setProjectDir(undefined);

    root = mkdtempSync(resolve(tmpdir(), 'gsloth-tui-'));
    globalDir = resolve(root, '__global__');
    mkdirSync(globalDir, { recursive: true });
    // `.git` stops the up-tree walk here, so discovery can never escape into the real repo.
    projectDir = resolve(root, 'proj');
    mkdirSync(resolve(projectDir, '.git'), { recursive: true });
    process.env.INIT_CWD = projectDir;

    getGlobalGslothConfigReadPathMock.mockImplementation((filename: string) =>
      resolve(globalDir, filename)
    );
    exitMock.mockImplementation((code?: number) => {
      throw new Error(`exit(${code}) called`);
    });
    processJsonConfigMock.mockResolvedValue(FAKE_LLM);
  });

  afterEach(() => {
    if (origInitCwd === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = origInitCwd;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** Write a PROJECT config into the git-rooted temp project dir. */
  const writeProjectConfig = (config: Record<string, unknown>): void => {
    writeFileSync(resolve(projectDir, '.gsloth.config.json'), JSON.stringify(config));
  };
  /** Write a GLOBAL config into the redirected global dir. */
  const writeGlobalConfig = (config: Record<string, unknown>): void => {
    writeFileSync(resolve(globalDir, '.gsloth.config.json'), JSON.stringify(config));
  };
  /** Write a NAMED profile config under the project's `.gsloth/.gsloth-settings/<name>/`. */
  const writeProfileConfig = (name: string, config: Record<string, unknown>): void => {
    const dir = resolve(projectDir, '.gsloth', '.gsloth-settings', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, '.gsloth.config.json'), JSON.stringify(config));
  };

  describe('loadConfiguredTui — the value the session dispatcher reads', () => {
    it('reads a global-only config (the CFG-8 layer a beginner actually has)', async () => {
      writeGlobalConfig({ llm: LLM_SPEC, tui: false });

      const { loadConfiguredTui } = await import('#src/config/loader.js');
      expect(await loadConfiguredTui({})).toBe(false);
    });

    it('carries a global true as readily as a global false', async () => {
      writeGlobalConfig({ llm: LLM_SPEC, tui: true });

      const { loadConfiguredTui } = await import('#src/config/loader.js');
      expect(await loadConfiguredTui({})).toBe(true);
    });

    it('lets a PROJECT config override the global one, in both directions', async () => {
      // Both directions, because a reader that returned the global layer instead of the project one
      // would still look right if only the true-over-false case were asserted.
      writeGlobalConfig({ llm: LLM_SPEC, tui: false });
      writeProjectConfig({ llm: LLM_SPEC, tui: true });
      const { loadConfiguredTui } = await import('#src/config/loader.js');
      expect(await loadConfiguredTui({})).toBe(true);

      writeGlobalConfig({ llm: LLM_SPEC, tui: true });
      writeProjectConfig({ llm: LLM_SPEC, tui: false });
      expect(await loadConfiguredTui({})).toBe(false);
    });

    it('falls through to the global layer when the project config is silent', async () => {
      writeGlobalConfig({ llm: LLM_SPEC, tui: true });
      writeProjectConfig({ llm: LLM_SPEC });

      const { loadConfiguredTui } = await import('#src/config/loader.js');
      // A project layer that says nothing must DEFER, not overwrite the global with undefined.
      expect(await loadConfiguredTui({})).toBe(true);
    });

    it('is undefined when no layer sets it, so auto-detect stays in charge', async () => {
      writeProjectConfig({ llm: LLM_SPEC });

      const { loadConfiguredTui } = await import('#src/config/loader.js');
      expect(await loadConfiguredTui({})).toBeUndefined();
    });

    it('is undefined (never a throw) when there is no config at all', async () => {
      const { loadConfiguredTui } = await import('#src/config/loader.js');
      expect(await loadConfiguredTui({})).toBeUndefined();
      expect(exitMock).not.toHaveBeenCalled();
    });

    it('reads a MODULE-format project config, not just JSON', async () => {
      // The reader goes through readRawConfigAtPath, which imports a .js/.mjs/.ts config and awaits
      // its configure(). A user who needs custom middleware or live tools writes one of these, and
      // a `tui` key they cannot see honoured is worse than one they were never offered.
      writeFileSync(
        resolve(projectDir, '.gsloth.config.js'),
        'export async function configure() { return { llm: { type: "vertexai" }, tui: false }; }\n'
      );

      const { loadConfiguredTui } = await import('#src/config/loader.js');
      expect(await loadConfiguredTui({})).toBe(false);
    });

    it('inherits tui from the profile a named profile extends (GS2-41)', async () => {
      // The child sets no `tui` of its own, so only a reader that composes the extends chain the
      // way a run does can answer `true` here.
      writeProfileConfig('base-profile', { llm: LLM_SPEC, tui: true });
      writeProfileConfig('child-profile', { extends: 'base-profile', llm: LLM_SPEC });

      const { loadConfiguredTui } = await import('#src/config/loader.js');
      expect(await loadConfiguredTui({ identityProfile: 'child-profile' })).toBe(true);
    });

    it("lets a named profile's own tui win over the base it extends", async () => {
      writeProfileConfig('base-profile', { llm: LLM_SPEC, tui: true });
      writeProfileConfig('child-profile', {
        extends: 'base-profile',
        llm: LLM_SPEC,
        tui: false,
      });

      const { loadConfiguredTui } = await import('#src/config/loader.js');
      expect(await loadConfiguredTui({ identityProfile: 'child-profile' })).toBe(false);
    });

    it('stays quiet and undefined on an unreadable project config', async () => {
      // Fail-soft: initConfig reports this same file moments later, so warning here would double
      // the message; starting a session must not depend on the config parsing.
      writeFileSync(resolve(projectDir, '.gsloth.config.json'), '{ not json at all ');

      const { loadConfiguredTui } = await import('#src/config/loader.js');
      expect(await loadConfiguredTui({})).toBeUndefined();
      expect(exitMock).not.toHaveBeenCalled();
    });
  });

  describe('the resolved config carries it too', () => {
    it('initConfig surfaces the project-over-global tui on the resolved config', async () => {
      writeGlobalConfig({ llm: LLM_SPEC, tui: false });
      writeProjectConfig({ llm: LLM_SPEC, tui: true });

      const { initConfig } = await import('#src/config/loader.js');
      const config = await initConfig({});

      expect(exitMock).not.toHaveBeenCalled();
      expect(config.tui).toBe(true);
    });

    it('leaves tui absent on the resolved config when nobody set it', async () => {
      writeProjectConfig({ llm: LLM_SPEC });

      const { initConfig } = await import('#src/config/loader.js');
      const config = await initConfig({});

      // Absent, not `false`: DEFAULT_CONFIG must not supply a value, or "the user chose readline"
      // and "nobody said" become the same thing and the auto rung collapses.
      expect(config.tui).toBeUndefined();
    });
  });

  describe('no longer an unknown key', () => {
    it('validates a config that sets tui with zero warnings, in either layer', async () => {
      writeGlobalConfig({ llm: LLM_SPEC, tui: true });
      writeProjectConfig({ llm: LLM_SPEC, tui: false });

      const { validateConfig } = await import('#src/config/loader.js');
      const report = await validateConfig({});

      expect(report.ok).toBe(true);
      expect(report.layers).toHaveLength(2);
      for (const layer of report.layers) {
        expect(layer.warnings).toEqual([]);
      }
    });
  });
});
