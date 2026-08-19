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

function runCli(
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> }
): { status: number | null; stdout: string; stderr: string } {
  const targetCwd = options?.cwd ?? tmpdir();
  const env = { ...process.env, ...options?.env };
  if (!options?.env?.INIT_CWD) {
    delete env.INIT_CWD;
  }
  const result = spawnSync('node', [cliEntry, '--nopipe', ...args], {
    encoding: 'utf8',
    // Absolute --config paths make cwd irrelevant; a temp cwd keeps any incidental writes contained.
    cwd: targetCwd,
    env,
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

  it('bypasses a broken project config and validates global config when -g is passed', async () => {
    const { mkdirSync } = await import('node:fs');
    // Project dir with a malformed/invalid config
    const projDir = fixture('proj', '');
    rmSync(projDir, { recursive: true, force: true });
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      resolve(projDir, '.gsloth.config.json'),
      '{"llm":{"type":"openai"},"streamOutput":"yes"}'
    );

    // Global dir in fake HOME
    const homeDir = fixture('home', '');
    rmSync(homeDir, { recursive: true, force: true });
    const globalGsloth = resolve(homeDir, '.gsloth');
    mkdirSync(globalGsloth, { recursive: true });
    writeFileSync(resolve(globalGsloth, '.gsloth.config.json'), '{"llm":{"type":"openai"}}');

    // `os.homedir()` reads HOME on POSIX and USERPROFILE on win32, so a fake home must set BOTH
    // or the spawned CLI resolves ~/.gsloth to the real profile dir on the Windows CI cells.
    const fakeHome = { HOME: homeDir, USERPROFILE: homeDir };

    // Without -g: validates project config and fails
    const failRes = runCli(['config', 'validate'], { cwd: projDir, env: fakeHome });
    expect(failRes.status).not.toBe(0);

    // With -g: validates global config only and succeeds (exit 0)
    const successRes = runCli(['-g', 'config', 'validate'], {
      cwd: projDir,
      env: fakeHome,
    });
    expect(successRes.status).toBe(0);
    expect(`${successRes.stdout}${successRes.stderr}`).toContain('Configuration is valid');
  });

  it('refuses -g together with -c instead of silently ignoring one of them', () => {
    const cfg = fixture('named.json', '{"llm":{"type":"openai"}}');
    const { status, stdout, stderr } = runCli(['-g', '-c', cfg, 'config', 'validate']);
    expect(status).not.toBe(0);
    const output = `${stdout}${stderr}`;
    expect(output).toContain('--global');
    expect(output).toContain('--config');
    // The named file must not have been loaded and reported valid.
    expect(output).not.toContain('Configuration is valid');
  });
});
