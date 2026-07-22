import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// GS2-69 — first-class `.gsloth.config.jsonc` support. Real fs + temp dirs (no fs mocks, no
// loader mocks), mirroring config.uptree.spec / configValidate.spec: exercises the actual
// discovery walk, the initConfig JSON/JSONC branch, the global lookup, and the read-side
// validateConfig. cwd is driven via INIT_CWD, which getCurrentWorkDir() honours before
// process.cwd().
//
// Only three seams are mocked, none of them the loader:
// - globalConfigUtils.getGlobalGslothConfigReadPath → a per-test temp "global" dir, so tests
//   never read the real `~/.gsloth` and can plant global fixtures;
// - the vertexai provider module → initConfig's tryJsonConfig would otherwise build a real LLM;
// - systemUtils.exit → throws instead of killing the vitest worker if an error path is hit.
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

/** A config only a lenient JSONC parse accepts: line + block comments and trailing commas. */
const JSONC_CONTENT = `{
  // GS2-69: comments are allowed in .jsonc configs
  "llm": {
    "type": "vertexai", // provider
  },
  /* trailing commas everywhere */
  "prompts": { "guidelines": "FROM-JSONC.md" },
}`;

describe('.gsloth.config.jsonc support (GS2-69)', () => {
  let root: string;
  let globalDir: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(async () => {
    vi.resetAllMocks(); // AGENTS.md — reset first; re-apply implementations below.
    // A prior test's initConfig left projectDir pointing at its (now-deleted) temp dir; bare
    // discovery calls resolve the cwd level through getProjectDir() (the GS2-11 ordering
    // invariant), so clear it to keep each test cwd-driven.
    const { setProjectDir } = await import('#src/utils/systemUtils.js');
    setProjectDir(undefined);
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-jsonc-'));
    globalDir = resolve(root, '__global__');
    mkdirSync(globalDir, { recursive: true });
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

  const mk = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const setCwd = (dir: string): void => {
    process.env.INIT_CWD = dir;
  };
  /** Make a git-rooted project dir with a config file. */
  const project = (name: string, content: string): string => {
    mk(resolve(root, 'proj', '.git'));
    const p = resolve(root, 'proj', name);
    writeFileSync(p, content);
    setCwd(resolve(root, 'proj'));
    return p;
  };
  /** Write a GLOBAL config file into the redirected global dir. */
  const globalConfig = (name: string, content: string): string => {
    const p = resolve(globalDir, name);
    writeFileSync(p, content);
    return p;
  };

  it('discovers a project .gsloth.config.jsonc up-tree', async () => {
    const configPath = project('.gsloth.config.jsonc', JSONC_CONTENT);
    const nested = mk(resolve(root, 'proj', 'a', 'b'));
    setCwd(nested);

    const { findProjectConfigPath, hasProjectConfig } = await import('#src/config/loader.js');
    expect(findProjectConfigPath({})).toEqual({ dir: resolve(root, 'proj'), path: configPath });
    expect(hasProjectConfig({})).toBe(true);
  });

  it('initConfig loads a discovered .gsloth.config.jsonc (comments + trailing commas)', async () => {
    project('.gsloth.config.jsonc', JSONC_CONTENT);

    const { initConfig } = await import('#src/config/loader.js');
    const config = await initConfig({});

    expect(exitMock).not.toHaveBeenCalled();
    // The provider received the raw llm spec parsed OUT OF the jsonc file...
    expect(processJsonConfigMock).toHaveBeenCalledWith({ type: 'vertexai' });
    // ...and the rest of the jsonc content survived into the effective config.
    expect(config.llm).toBe(FAKE_LLM);
    expect(config.prompts?.guidelines).toBe('FROM-JSONC.md');
  });

  it('prefers .gsloth.config.json when BOTH .json and .jsonc exist', async () => {
    const jsonPath = project(
      '.gsloth.config.json',
      '{"llm":{"type":"vertexai"},"prompts":{"guidelines":"FROM-JSON.md"}}'
    );
    writeFileSync(resolve(root, 'proj', '.gsloth.config.jsonc'), JSONC_CONTENT);

    const { findProjectConfigPath, initConfig } = await import('#src/config/loader.js');
    expect(findProjectConfigPath({})?.path).toBe(jsonPath);

    const config = await initConfig({});
    expect(exitMock).not.toHaveBeenCalled();
    expect(config.prompts?.guidelines).toBe('FROM-JSON.md');
  });

  it('loads an explicit -c path/to/custom.jsonc via the JSONC branch (not the module importer)', async () => {
    // No project config at all — only the explicit path matters here.
    mk(resolve(root, 'proj', '.git'));
    setCwd(resolve(root, 'proj'));
    const customPath = resolve(mk(resolve(root, 'elsewhere')), 'custom.jsonc');
    writeFileSync(customPath, JSONC_CONTENT);

    const { initConfig } = await import('#src/config/loader.js');
    const config = await initConfig({ customConfigPath: customPath });

    expect(exitMock).not.toHaveBeenCalled();
    expect(config.llm).toBe(FAKE_LLM);
    expect(config.prompts?.guidelines).toBe('FROM-JSONC.md');
  });

  it('loads a global ~/.gsloth/.gsloth.config.jsonc (loadGlobalRawConfig)', async () => {
    globalConfig(
      '.gsloth.config.jsonc',
      '{\n  // global\n  "prompts": { "guidelines": "GLOBAL.md" },\n}'
    );

    const { loadGlobalRawConfig } = await import('#src/config/loader.js');
    expect(await loadGlobalRawConfig()).toEqual({ prompts: { guidelines: 'GLOBAL.md' } });
  });

  it('a global-only .gsloth.config.jsonc drives a full initConfig run (no project config)', async () => {
    mk(resolve(root, 'proj', '.git'));
    setCwd(resolve(root, 'proj'));
    globalConfig('.gsloth.config.jsonc', JSONC_CONTENT);

    const { initConfig } = await import('#src/config/loader.js');
    const config = await initConfig({});

    expect(exitMock).not.toHaveBeenCalled();
    expect(config.llm).toBe(FAKE_LLM);
    expect(config.prompts?.guidelines).toBe('FROM-JSONC.md');
  });

  it('prefers the global .json over the global .jsonc when both exist', async () => {
    globalConfig('.gsloth.config.json', '{"prompts":{"guidelines":"GLOBAL-JSON.md"}}');
    globalConfig('.gsloth.config.jsonc', '{"prompts":{"guidelines":"GLOBAL-JSONC.md"},}');

    const { loadGlobalRawConfig } = await import('#src/config/loader.js');
    expect(await loadGlobalRawConfig()).toEqual({ prompts: { guidelines: 'GLOBAL-JSON.md' } });
  });

  describe('gth config validate (read-side)', () => {
    it('validates a discovered project .gsloth.config.jsonc', async () => {
      const configPath = project('.gsloth.config.jsonc', JSONC_CONTENT);

      const { validateConfig } = await import('#src/config/loader.js');
      const report = await validateConfig({});

      expect(report.found).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.layers[0].sourceLabel).toBe(configPath);
    });

    it('honours -c custom.jsonc and still reports schema violations in it', async () => {
      mk(resolve(root, 'proj', '.git'));
      setCwd(resolve(root, 'proj'));
      const customPath = resolve(root, 'proj', 'custom.jsonc');
      writeFileSync(customPath, '{"llm":{"type":"vertexai"},"streamOutput":"yes", // bad\n}');

      const { validateConfig } = await import('#src/config/loader.js');
      const report = await validateConfig({ customConfigPath: customPath });

      expect(report.found).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.layers[0].sourceLabel).toBe(customPath);
      expect(report.layers[0].errorMessage).toContain('streamOutput');
    });

    it('reports the global .jsonc layer under its own label', async () => {
      project('.gsloth.config.json', '{"llm":{"type":"vertexai"}}');
      globalConfig('.gsloth.config.jsonc', '{"prompts":{"guidelines":"GLOBAL.md"},}');

      const { validateConfig } = await import('#src/config/loader.js');
      const report = await validateConfig({});

      expect(report.ok).toBe(true);
      expect(report.layers.map((l) => l.sourceLabel)).toContain('.gsloth.config.jsonc (global)');
    });
  });
});
