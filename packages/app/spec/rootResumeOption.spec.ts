/**
 * GS2-20 fix round, finding 4 — **the root `--resume` in front of a subcommand that cannot take
 * it.** Commander accepts a root option before every subcommand, and only the session commands
 * read this one, so `gth --resume 1 ask "hello"` used to run a fresh `ask` and exit 0 without a
 * word about the conversation the person named.
 *
 * Asserted through the built CLI, because `cli.ts` parses argv and dispatches at module load:
 * there is no exported parser to call, and the option's placement on the program is only
 * observable by running it. `--nopipe` makes the CLI parse immediately instead of waiting on
 * stdin; HOME/USERPROFILE point at a throwaway dir so nothing reads or writes a real `~/.gsloth`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, '../cli.js');

describe('gth --resume in front of a subcommand (real CLI definition)', () => {
  let dir: string;
  let homeDir: string;
  let projectDir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-root-resume-'));
    homeDir = resolve(dir, 'home');
    projectDir = resolve(dir, 'proj');
    mkdirSync(resolve(homeDir, '.gsloth'), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runCli = (args: string[]): { status: number | null; output: string } => {
    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
    delete env.INIT_CWD;
    const result = spawnSync('node', [cliEntry, '--nopipe', ...args], {
      encoding: 'utf8',
      cwd: projectDir,
      env,
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  it('refuses ask, names where --resume applies and that nothing ran, and exits 1', () => {
    const { status, output } = runCli(['--resume', '1', 'ask', 'hello there']);
    expect(status).toBe(1);
    expect(output).toContain('Cannot resume into `gth ask`');
    expect(output).toContain('`gth chat`');
    expect(output).toContain('`gth code`');
    expect(output).toContain('not available yet');
    expect(output).toContain('Nothing was run, and conversation #1 was not touched.');
  });

  it('refuses exec the same way, and any other subcommand that cannot resume', () => {
    for (const command of ['exec', 'review', 'history']) {
      const { status, output } = runCli(['--resume', '2', command, 'anything']);
      expect(status, command).toBe(1);
      expect(output, command).toContain(`Cannot resume into \`gth ${command}\``);
      expect(output, command).toContain('conversation #2 was not touched');
    }
  });

  // CONTROL — the refusal is about the pairing, not about the flag or the command. `ask` with no
  // `--resume` never sees this message (it fails later, for its own reasons), and the session
  // commands are not refused: `gth --resume 1 chat --help` prints chat's help and exits 0.
  it('says nothing when ask is run without --resume, and does not refuse the session commands', () => {
    const plain = runCli(['ask', 'hello there']);
    expect(plain.output).not.toContain('Cannot resume into');

    for (const command of ['chat', 'code']) {
      const { status, output } = runCli(['--resume', '1', command, '--help']);
      expect(status, command).toBe(0);
      expect(output, command).not.toContain('Cannot resume into');
      expect(output, command).toContain('--resume <id>');
    }
  });

  it('rejects an id that is not one before any command is chosen', () => {
    const { status, output } = runCli(['--resume', 'abc', 'ask', 'hello']);
    expect(status).not.toBe(0);
    expect(output).toContain('positive whole number');
  });
});
