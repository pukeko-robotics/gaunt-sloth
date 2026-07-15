import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
// Real fs + temp dirs (no fs mocks), mirroring config.uptree.spec: exercises the actual discovery
// walk, JSONC parse, and schema validation through the read-side `validateConfig`. cwd is driven
// via INIT_CWD, which getCurrentWorkDir() honours before process.cwd().
//
// GS2-29 — validateConfig now ALSO validates the GLOBAL layer (it did before only when no project
// config existed). So every test here would otherwise read the real `~/.gsloth`; we redirect the
// global config path into a per-test temp dir. Only `getGlobalGslothConfigReadPath` is overridden;
// every other export stays real.
// vi.hoisted so the mock fn exists when loader.ts is statically imported below (which pulls in
// globalConfigUtils and triggers the factory during module evaluation, before a plain top-level
// const would be initialized).
const { getGlobalGslothConfigReadPathMock } = vi.hoisted(() => ({
  getGlobalGslothConfigReadPathMock: vi.fn<(_filename: string) => string>(),
}));
vi.mock('#src/utils/globalConfigUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/globalConfigUtils.js')>();
  return { ...actual, getGlobalGslothConfigReadPath: getGlobalGslothConfigReadPathMock };
});

import { validateConfig } from '#src/config/loader.js';

const GLOBAL_JSON_LABEL = '.gsloth.config.json (global)';

describe('validateConfig (GS2-1 `gth config validate`)', () => {
  let root: string;
  let globalDir: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-validate-'));
    // A dedicated, EMPTY global dir per test: `getGlobalGslothConfigReadPath('<name>')` resolves
    // inside it, so with no global file written the global layer is simply absent (the historical
    // single-layer behaviour). Tests opt into a global layer via `global(...)`.
    globalDir = resolve(root, '__global__');
    mkdirSync(globalDir, { recursive: true });
    getGlobalGslothConfigReadPathMock.mockImplementation((filename: string) =>
      resolve(globalDir, filename)
    );
  });

  afterEach(() => {
    if (origInitCwd === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = origInitCwd;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** Make a git-rooted project dir at cwd with a config file, and point cwd at it. */
  const project = (content: string, name = '.gsloth.config.json'): string => {
    mkdirSync(resolve(root, '.git'), { recursive: true });
    const p = resolve(root, name);
    writeFileSync(p, content);
    process.env.INIT_CWD = root;
    return p;
  };

  /** Make a git-rooted, config-less project dir at cwd (used by global-only / no-config tests). */
  const bareProjectDir = (): void => {
    mkdirSync(resolve(root, '.git'), { recursive: true });
    process.env.INIT_CWD = root;
  };

  /** Write a GLOBAL config file into the redirected global dir. */
  const global = (content: string, name = '.gsloth.config.json'): string => {
    const p = resolve(globalDir, name);
    writeFileSync(p, content);
    return p;
  };

  it('reports a valid config as ok, with its source path (single project layer)', async () => {
    const p = project('{"llm":{"type":"openai"}}');
    const report = await validateConfig({});
    expect(report.found).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.layers).toHaveLength(1);
    expect(report.layers[0].sourceLabel).toBe(p);
    expect(report.layers[0].ok).toBe(true);
    expect(report.layers[0].errorMessage).toBeUndefined();
  });

  it('reports a schema violation as not ok with a path-scoped message', async () => {
    project('{"llm":{"type":"openai"},"streamOutput":"yes"}');
    const report = await validateConfig({});
    expect(report.found).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.layers[0].ok).toBe(false);
    expect(report.layers[0].errorMessage).toContain('streamOutput');
  });

  it('accepts a JSONC config (comments + trailing commas)', async () => {
    project(`{
      // provider
      "llm": { "type": "anthropic", },
      /* stream deltas */
      "streamOutput": true,
    }`);
    const report = await validateConfig({});
    expect(report.ok).toBe(true);
  });

  it('warns (but does NOT fail) on an unknown top-level key', async () => {
    project('{"llm":{"type":"openai"},"totallyMadeUpKey":123}');
    const report = await validateConfig({});
    expect(report.ok).toBe(true);
    expect(report.layers[0].warnings.some((w) => w.includes('totallyMadeUpKey'))).toBe(true);
  });

  it('HARD-rejects a deprecated *Provider* name, naming its *Source* replacement (GS2-28)', async () => {
    project('{"llm":{"type":"openai"},"contentProvider":"github"}');
    const report = await validateConfig({});
    expect(report.ok).toBe(false);
    expect(report.layers[0].errorMessage).toContain('contentSource');
    // The removed shape errors; it is not doubled as an unknown-key warning.
    expect(report.layers[0].warnings).toEqual([]);
  });

  it('HARD-rejects a deprecated *Provider* name inside commands.<name> (GS2-28)', async () => {
    project('{"llm":{"type":"openai"},"commands":{"pr":{"requirementsProvider":"jira"}}}');
    const report = await validateConfig({});
    expect(report.ok).toBe(false);
    expect(report.layers[0].errorMessage).toContain('commands.pr.requirementsProvider');
    expect(report.layers[0].errorMessage).toContain('requirementSource');
  });

  it('HARD-rejects a top-level command key, naming commands.<cmd> (GS2-28)', async () => {
    project('{"llm":{"type":"openai"},"pr":{"contentSource":"github"},"review":{}}');
    const report = await validateConfig({});
    expect(report.ok).toBe(false);
    expect(report.layers[0].errorMessage).toContain('commands.pr');
    expect(report.layers[0].errorMessage).toContain('commands.review');
  });

  it('accepts the canonical shapes clean (commands.pr, contentSource, rating.enabled)', async () => {
    project(
      '{"llm":{"type":"openai"},"contentSource":"file",' +
        '"commands":{"pr":{"contentSource":"github","rating":{"enabled":false}}}}'
    );
    const report = await validateConfig({});
    expect(report.ok).toBe(true);
    expect(report.layers[0].errorMessage).toBeUndefined();
    expect(report.layers[0].warnings).toEqual([]);
  });

  it('throws a clear error on a malformed project config file', async () => {
    project('{"llm":{"type":"openai" ');
    await expect(validateConfig({})).rejects.toThrow(/Invalid JSON\/JSONC/);
  });

  it('reports found:false when no config exists within the boundary', async () => {
    bareProjectDir();
    const report = await validateConfig({});
    expect(report.found).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.layers).toEqual([]);
  });

  it('honours an explicit --config path override', async () => {
    const p = resolve(root, 'custom.gsloth.json');
    writeFileSync(p, '{"llm":{"type":"openai"},"recursionLimit":"NaN"}');
    const report = await validateConfig({ customConfigPath: p });
    expect(report.found).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.layers[0].errorMessage).toContain('recursionLimit');
  });

  // GS2-29 — the read-side must validate the SAME layers a run does (project + global), so a
  // removed shape in the GLOBAL layer is no longer silently missed when the project config is clean.
  describe('GS2-29: global layer is validated alongside the project layer', () => {
    it('reports a deprecated shape in the GLOBAL layer (clean project), naming the global layer', async () => {
      project('{"llm":{"type":"openai"}}');
      global('{"contentProvider":"github"}');

      const report = await validateConfig({});

      expect(report.found).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.layers).toHaveLength(2);

      const globalLayer = report.layers.find((l) => l.sourceLabel === GLOBAL_JSON_LABEL);
      expect(globalLayer).toBeDefined();
      expect(globalLayer!.ok).toBe(false);
      expect(globalLayer!.errorMessage).toContain('contentSource');

      // The clean project layer is still reported as valid (the offending layer is identifiable).
      const projectLayer = report.layers.find((l) => l.sourceLabel !== GLOBAL_JSON_LABEL);
      expect(projectLayer!.ok).toBe(true);
    });

    it('reports a top-level command key in the GLOBAL layer (clean project)', async () => {
      project('{"llm":{"type":"openai"}}');
      global('{"pr":{"contentSource":"github"}}');

      const report = await validateConfig({});

      expect(report.ok).toBe(false);
      const globalLayer = report.layers.find((l) => l.sourceLabel === GLOBAL_JSON_LABEL);
      expect(globalLayer!.ok).toBe(false);
      expect(globalLayer!.errorMessage).toContain('commands.pr');
    });

    it('is OK when BOTH the project and global layers are clean (both layers reported)', async () => {
      project('{"llm":{"type":"openai"}}');
      global('{"projectGuidelines":"GLOBAL.md"}');

      const report = await validateConfig({});

      expect(report.found).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.layers).toHaveLength(2);
      expect(report.layers.every((l) => l.ok)).toBe(true);
      expect(report.layers.map((l) => l.sourceLabel)).toContain(GLOBAL_JSON_LABEL);
    });

    it('reports a deprecated shape in a global-only config (no project config)', async () => {
      bareProjectDir();
      global('{"requirementsProvider":"jira"}');

      const report = await validateConfig({});

      expect(report.found).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.layers).toHaveLength(1);
      expect(report.layers[0].sourceLabel).toBe(GLOBAL_JSON_LABEL);
      expect(report.layers[0].errorMessage).toContain('requirementSource');
    });

    it('reports BOTH layers when both carry a problem (project still reported, no regression)', async () => {
      project('{"llm":{"type":"openai"},"contentProvider":"github"}');
      global('{"requirementsProvider":"jira"}');

      const report = await validateConfig({});

      expect(report.ok).toBe(false);
      expect(report.layers).toHaveLength(2);
      expect(report.layers.every((l) => !l.ok)).toBe(true);

      const projectLayer = report.layers.find((l) => l.sourceLabel !== GLOBAL_JSON_LABEL);
      const globalLayer = report.layers.find((l) => l.sourceLabel === GLOBAL_JSON_LABEL);
      expect(projectLayer!.errorMessage).toContain('contentSource');
      expect(globalLayer!.errorMessage).toContain('requirementSource');
    });

    it('IGNORES a malformed global config (matches a run), keeping a valid project valid', async () => {
      project('{"llm":{"type":"openai"}}');
      global('{ this is not valid json');

      const report = await validateConfig({});

      // A run treats an unparseable global as absent (loadGlobalRawConfig catches + ignores), so
      // the diagnostic must too: only the project layer survives, and it is valid.
      expect(report.found).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.layers).toHaveLength(1);
      expect(report.layers[0].sourceLabel).not.toBe(GLOBAL_JSON_LABEL);
    });
  });
});
