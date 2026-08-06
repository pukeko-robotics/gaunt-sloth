import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GS2-89 — process-level e2e proving `gth exec` actually WRITES the report file asked for by the
 * global `-w/--write-output-to-file`.
 *
 * Why a spawned CLI rather than a unit assertion on the config: `-w` is declared on the PROGRAM,
 * so commander never puts it on the `exec` subcommand's own options object. `exec` used to read
 * `options.writeOutputToFile`, which is therefore always `undefined`, and `?? false` turned the
 * write off — a silent no-op that no assertion about `exec`'s own options could ever see. Only a
 * real run through cli.ts's program-level parsing, ending at a file on disk, closes that gap.
 *
 * Hermetic and key-free: the `fake` provider ({@link import('@gaunt-sloth/core/providers/fake.js')})
 * replays a canned answer, so no network and no API key is involved. HOME/USERPROFILE point at an
 * empty temp dir so an ambient `~/.gsloth` global config can't decide the outcome, and the run's
 * cwd is the temp project dir (which is also where the `-c` config lives, so the project root the
 * output path resolves against is unambiguous).
 *
 * Requires the app build — `pnpm test` builds before vitest runs. `--nopipe` makes the CLI parse
 * immediately instead of waiting on stdin EOF.
 */
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, '../cli.js'); // packages/app/cli.js (sets install dir, loads dist)

const FAKE_ANSWER = 'FAKE-EXEC-ANSWER-GS2-89';

describe('gth exec -w writes the report file (e2e)', () => {
  let dir: string;
  let home: string;
  let configPath: string;

  /** Run the built CLI in the temp project dir, with a hermetic HOME and the fake provider. */
  const runCli = (args: string[]): { status: number | null; output: string } => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    // The CLI's cwd is `INIT_CWD` when set (systemUtils.getCurrentWorkDir), and pnpm sets it to
    // wherever `pnpm test` was invoked — the repo root. Inherited, it would aim this run's
    // project-relative paths at the repository instead of the temp dir under test.
    delete env.INIT_CWD;
    // LangSmith tracing turns a hermetic run into a networked one; keep it out of this spec.
    delete env.LANGCHAIN_TRACING_V2;
    delete env.LANGCHAIN_TRACING;
    delete env.LANGSMITH_TRACING;
    const result = spawnSync('node', [cliEntry, '--nopipe', '-c', configPath, ...args], {
      encoding: 'utf8',
      cwd: dir,
      env,
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  /** The .md files the run left in the project dir (report files land at the project root here). */
  const reportFiles = (): string[] => readdirSync(dir).filter((name) => name.endsWith('.md'));

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-exec-w-e2e-'));
    home = mkdtempSync(resolve(tmpdir(), 'gsloth-exec-w-home-'));
    configPath = resolve(dir, 'gth-fake.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: { type: 'fake', responses: [FAKE_ANSWER] },
        commands: { exec: { filesystem: 'none' } },
      })
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('writes the named file when -w follows the subcommand', () => {
    const { output } = runCli(['exec', '-m', 'say hi', '-w', 'out.md']);
    const written = resolve(dir, 'out.md');
    expect(existsSync(written), `no report file was written; CLI said:\n${output}`).toBe(true);
    expect(readFileSync(written, 'utf8')).toContain(FAKE_ANSWER);
  });

  it('writes the named file when -w precedes the subcommand', () => {
    const { output } = runCli(['-w', 'out.md', 'exec', '-m', 'say hi']);
    const written = resolve(dir, 'out.md');
    expect(existsSync(written), `no report file was written; CLI said:\n${output}`).toBe(true);
    expect(readFileSync(written, 'utf8')).toContain(FAKE_ANSWER);
  });

  it('writes a generated gth_<timestamp>_EXEC.md when -w asks for the standard name', () => {
    const { output } = runCli(['exec', '-m', 'say hi', '-w', 'true']);
    const generated = reportFiles().filter((name) => /^gth_.*_EXEC\.md$/.test(name));
    expect(generated, `no generated report file was written; CLI said:\n${output}`).toHaveLength(1);
    expect(readFileSync(resolve(dir, generated[0]), 'utf8')).toContain(FAKE_ANSWER);
  });

  it('writes nothing without -w (stdout-only stays the default, so exec keeps piping cleanly)', () => {
    const { output } = runCli(['exec', '-m', 'say hi']);
    expect(output).toContain(FAKE_ANSWER);
    expect(reportFiles()).toEqual([]);
  });

  it('writes nothing when -w is explicitly turned off with the -wn shortcut', () => {
    runCli(['exec', '-m', 'say hi', '-wn']);
    expect(reportFiles()).toEqual([]);
  });
});
