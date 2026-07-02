import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
// Real fs + temp dirs (no mocks), mirroring config.uptree.spec: exercises the actual discovery
// walk, JSONC parse, and schema validation through the read-side `validateConfig`. cwd is driven
// via INIT_CWD, which getCurrentWorkDir() honours before process.cwd().
import { validateConfig } from '#src/config/loader.js';

describe('validateConfig (GS2-1 `gth config validate`)', () => {
  let root: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-validate-'));
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

  it('reports a valid config as ok, with its source path', async () => {
    const p = project('{"llm":{"type":"openai"}}');
    const report = await validateConfig({});
    expect(report.found).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.sourceLabel).toBe(p);
    expect(report.errorMessage).toBeUndefined();
  });

  it('reports a schema violation as not ok with a path-scoped message', async () => {
    project('{"llm":{"type":"openai"},"streamOutput":"yes"}');
    const report = await validateConfig({});
    expect(report.found).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.errorMessage).toContain('streamOutput');
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
    expect(report.warnings.some((w) => w.includes('totallyMadeUpKey'))).toBe(true);
  });

  it('warns on a deprecated key name (mapped, not failed)', async () => {
    project('{"llm":{"type":"openai"},"contentProvider":"github"}');
    const report = await validateConfig({});
    expect(report.ok).toBe(true);
    expect(report.warnings.some((w) => w.includes('contentProvider'))).toBe(true);
  });

  it('throws a clear error on a malformed config file', async () => {
    project('{"llm":{"type":"openai" ');
    await expect(validateConfig({})).rejects.toThrow(/Invalid JSON\/JSONC/);
  });

  it('reports found:false when no config exists within the boundary', async () => {
    mkdirSync(resolve(root, '.git'), { recursive: true });
    process.env.INIT_CWD = root;
    const report = await validateConfig({});
    expect(report.found).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('honours an explicit --config path override', async () => {
    const p = resolve(root, 'custom.gsloth.json');
    writeFileSync(p, '{"llm":{"type":"openai"},"recursionLimit":"NaN"}');
    const report = await validateConfig({ customConfigPath: p });
    expect(report.found).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.errorMessage).toContain('recursionLimit');
  });
});
