import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True process-level exit-code e2e for `gth config validate` (GS2-1 acceptance): spawns the
 * built CLI and asserts the REAL process exit code + the path-scoped message on stderr, rather
 * than a mocked `setExitCode`. Requires the app build (`pnpm test` builds before vitest runs);
 * `--nopipe` makes the CLI parse immediately instead of waiting on stdin.
 */
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, '../cli.js'); // packages/app/cli.js (sets install dir, loads dist)

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [cliEntry, '--nopipe', ...args], {
    encoding: 'utf8',
    // Absolute --config paths make cwd irrelevant; a temp cwd keeps any incidental writes contained.
    cwd: tmpdir(),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('gth config validate — process exit code (e2e)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-validate-e2e-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fixture = (name: string, content: string): string => {
    const p = resolve(dir, name);
    writeFileSync(p, content);
    return p;
  };

  it('exits 0 on a valid config', () => {
    const cfg = fixture('valid.json', '{"llm":{"type":"openai"}}');
    const { status, stdout, stderr } = runCli(['-c', cfg, 'config', 'validate']);
    expect(status).toBe(0);
    expect(`${stdout}${stderr}`).toContain('Configuration is valid');
  });

  it('exits non-zero with a path-scoped message on a schema violation', () => {
    const cfg = fixture('invalid.json', '{"llm":{"type":"openai"},"streamOutput":"yes"}');
    const { status, stdout, stderr } = runCli(['-c', cfg, 'config', 'validate']);
    expect(status).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain('streamOutput');
  });

  it('accepts a JSONC config with comments and trailing commas (exit 0)', () => {
    const cfg = fixture(
      'jsonc.json',
      `{
        // provider
        "llm": { "type": "anthropic", },
      }`
    );
    const { status } = runCli(['-c', cfg, 'config', 'validate']);
    expect(status).toBe(0);
  });

  it('exits non-zero on a malformed config file', () => {
    const cfg = fixture('broken.json', '{"llm": {"type": "openai" ');
    const { status } = runCli(['-c', cfg, 'config', 'validate']);
    expect(status).not.toBe(0);
  });
});
