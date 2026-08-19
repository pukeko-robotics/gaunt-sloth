import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CFG-56 — coverage of the REAL `-g`/`--global` option as `packages/app/src/cli.ts` declares it.
 *
 * `cli.ts` parses argv and dispatches at module load, so there is no exported parser to call: the
 * option definition is only observable by running the built CLI. Every assertion here therefore
 * goes through the binary, which is what makes removing or renaming the flag in `cli.ts` turn this
 * file red. Requires the app build (`pnpm test` builds before vitest runs); `--nopipe` makes the
 * CLI parse immediately instead of waiting on stdin.
 *
 * `configValidate.e2e.spec.ts` covers `-g` bypassing a broken project config and the `-g`/`-c`
 * refusal; what is asserted here is the flag's own declaration and its interaction with
 * `-i`/`--identity-profile`, which resolves under `~/.gsloth/.gsloth-settings/<name>/` only under
 * `-g`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, '../cli.js'); // packages/app/cli.js (sets install dir, loads dist)

function runCli(
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> }
): { status: number | null; output: string } {
  const env = { ...process.env, ...options?.env };
  if (!options?.env?.INIT_CWD) {
    delete env.INIT_CWD;
  }
  const result = spawnSync('node', [cliEntry, '--nopipe', ...args], {
    encoding: 'utf8',
    cwd: options?.cwd ?? tmpdir(),
    env,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('gth -g / --global (real CLI definition)', () => {
  let dir: string;
  let projectDir: string;
  let homeDir: string;
  // `os.homedir()` reads HOME on POSIX and USERPROFILE on win32, so a fake home must set BOTH or
  // the spawned CLI resolves ~/.gsloth to the real profile dir on the Windows CI cells.
  let fakeHome: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-global-cli-'));
    projectDir = resolve(dir, 'proj');
    homeDir = resolve(dir, 'home');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(resolve(homeDir, '.gsloth'), { recursive: true });
    fakeHome = { HOME: homeDir, USERPROFILE: homeDir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeGlobalProfileConfig = (profile: string, content: string) => {
    const profileDir = resolve(homeDir, '.gsloth', '.gsloth-settings', profile);
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(resolve(profileDir, '.gsloth.config.json'), content);
  };

  it('declares -g, --global in its help output', () => {
    const { status, output } = runCli(['--help']);
    expect(status).toBe(0);
    expect(output).toContain('-g, --global');
  });

  it('resolves an identity profile under the global settings dir when -g is passed', () => {
    writeFileSync(
      resolve(projectDir, '.gsloth.config.json'),
      '{"llm":{"type":"openai"},"streamOutput":"yes"}'
    );
    writeGlobalProfileConfig('devops', '{"llm":{"type":"openai"}}');

    const { status, output } = runCli(['-g', '-i', 'devops', 'config', 'validate'], {
      cwd: projectDir,
      env: fakeHome,
    });

    expect(status).toBe(0);
    expect(output).toContain('Configuration is valid');
    // The layer label names the file that was read: the profile's config under ~/.gsloth.
    expect(output).toContain('.gsloth-settings/devops/.gsloth.config.json (global)');
  });

  it('does not resolve a globally-defined identity profile without -g', () => {
    writeGlobalProfileConfig('devops', '{"llm":{"type":"openai"}}');

    const { status, output } = runCli(['-i', 'devops', 'config', 'validate'], {
      cwd: projectDir,
      env: fakeHome,
    });

    expect(status).not.toBe(0);
    expect(output).toContain('identity profile "devops" not found');
  });
});
