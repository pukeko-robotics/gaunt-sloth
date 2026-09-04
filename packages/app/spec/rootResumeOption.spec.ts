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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // `INIT_CWD` is set by pnpm to wherever `pnpm test` ran, and the CLI prefers it as its working
    // directory — inherited, this run would aim at the repository instead of the temp project.
    delete env.INIT_CWD;
    // Tracing would turn a hermetic run into a networked one; this desktop exports it.
    delete env.LANGCHAIN_TRACING_V2;
    delete env.LANGCHAIN_TRACING;
    delete env.LANGSMITH_TRACING;
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

  /**
   * The cells above run in a project with no configuration, where `ask` exits 1 on its own — so an
   * assertion on the status there cannot tell a refusal from a warning followed by a real run. This
   * one runs in a project where `ask` SUCCEEDS: the `fake` provider replays a canned answer, so a
   * dropped `exit(1)` after the refusal would leave the flag's own message on the screen followed
   * by the model's answer and a status of 0 — which is precisely the defect the message alone
   * cannot rule out. Hermetic and key-free; no network and no API key.
   */
  describe('in a project where ask would otherwise succeed', () => {
    const FAKE_ANSWER = 'FAKE-ASK-ANSWER-GS2-20';
    let configPath: string;

    beforeEach(() => {
      configPath = resolve(projectDir, 'gth-fake.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          llm: { type: 'fake', responses: [FAKE_ANSWER] },
          commands: { ask: { filesystem: 'none' } },
        })
      );
    });

    it('CONTROL: ask answers and exits 0 when the flag is not in front of it', () => {
      const { status, output } = runCli(['-c', configPath, 'ask', 'hello there']);
      expect(status, output).toBe(0);
      expect(output).toContain(FAKE_ANSWER);
      expect(output).not.toContain('Cannot resume into');
    });

    it('the refusal ENDS the run: no answer is produced and the status is not 0', () => {
      const { status, output } = runCli(['--resume', '1', '-c', configPath, 'ask', 'hello there']);
      expect(status, output).toBe(1);
      expect(output).toContain('Cannot resume into `gth ask`');
      // The whole point: the command the person typed did not run in place of the one they meant.
      expect(output).not.toContain(FAKE_ANSWER);
    });
  });

  it('rejects an id that is not one before any command is chosen', () => {
    const { status, output } = runCli(['--resume', 'abc', 'ask', 'hello']);
    expect(status).not.toBe(0);
    expect(output).toContain('positive whole number');
  });
});
