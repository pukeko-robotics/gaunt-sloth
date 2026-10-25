import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REL-20 — process-level e2e proving that a review which fails BEFORE inference still writes the
 * report file `writeOutputToFile` promised.
 *
 * Why spawned CLIs rather than unit assertions: the defect is that no file exists on disk. It was
 * never a missing `displayError` call — the error was reported perfectly well, to a terminal
 * nobody was reading, while the next CI step died on `ENOENT ... 'review.md'`. An assertion about
 * which console helper was called cannot see that, which is why the bug survived a suite that
 * already covered these error paths.
 *
 * **Both entry points are exercised from one file on purpose.** `gth pr` / `gth review` and the
 * standalone `gaunt-sloth-review` bin have separate catches and cannot share a spec cell, and the
 * requirement on them is that they do not diverge — so their cells sit side by side, driven by one
 * config and one stub, where a divergence shows up as one red cell next to a green one.
 *
 * The failure is the real one from the issue: a stub `gh` on PATH exits non-zero with GitHub's
 * verbatim HTTP 406 for a pull request over the 300-file diff limit. That message names the limit
 * and both ways around it, so what the report must carry is the source's own text rather than a
 * summary of it. The stub is written twice — an extensionless shebang script POSIX shells execute,
 * and a `.cmd` that Windows resolves through PATHEXT — because this suite has a Windows cell.
 *
 * Hermetic and key-free: the `fake` provider replays a canned answer for the cells that reach
 * inference, and HOME/USERPROFILE point at an empty temp dir so an ambient `~/.gsloth` config
 * cannot decide the outcome. Requires the build — `pnpm test` builds before vitest runs.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appCli = resolve(here, '../cli.js'); // packages/app/cli.js — `gth`
const reviewBin = resolve(here, '../../review/cli.js'); // packages/review/cli.js — `gaunt-sloth-review`

/** GitHub's own 406 for a PR whose diff exceeds the 300-file limit, as `gh` prints it. */
const GH_406 =
  "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'gh pr view' or the Files changed tab instead.";

const FAKE_VERDICT = 'FAKE-REVIEW-VERDICT-REL-20';

/** The line the report carries in place of a verdict; kept in step with the module that writes it. */
const DID_NOT_RUN = 'This review did not run.';

describe('a review that fails before inference still writes its report (e2e)', () => {
  let dir: string;
  let home: string;
  let stubBin: string;

  const reportPath = (): string => resolve(dir, 'review.md');

  /** Write the project config both entry points discover from the temp cwd. */
  const writeConfig = (extra: Record<string, unknown> = {}): void => {
    writeFileSync(
      resolve(dir, '.gsloth.config.json'),
      JSON.stringify({
        llm: { type: 'fake', responses: [FAKE_VERDICT] },
        contentSource: 'github',
        requirementSource: 'github',
        writeOutputToFile: './review.md',
        streamOutput: false,
        commands: {
          pr: { contentSource: 'github', rating: { enabled: false } },
          review: { contentSource: 'github', rating: { enabled: false } },
        },
        ...extra,
      })
    );
  };

  /** Run a built entry point in the temp project dir, with the stub `gh` ahead of any real one. */
  const run = (entry: string, args: string[]): { status: number | null; output: string } => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    // Windows spells the variable `Path`, so write back to whichever key is already there. Adding
    // a second spelling instead leaves the child process launcher to choose between two PATHs,
    // and the one it picks is the one without the stub.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = `${stubBin}${delimiter}${env[pathKey] ?? ''}`;
    // The CLI's cwd is `INIT_CWD` when set (systemUtils.getCurrentWorkDir), and pnpm sets it to
    // wherever `pnpm test` was invoked — the repo root. Inherited, it would aim this run's
    // project-relative paths at the repository instead of the temp dir under test.
    delete env.INIT_CWD;
    // The Jira cells below need the token to be absent; an ambient one would let them reach Jira.
    delete env.JIRA_LEGACY_API_TOKEN;
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      cwd: dir,
      env,
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-rel20-'));
    home = mkdtempSync(resolve(tmpdir(), 'gsloth-rel20-home-'));
    stubBin = resolve(dir, 'stub-bin');
    mkdirSync(stubBin);

    const stubBody = `process.stderr.write(${JSON.stringify(`${GH_406}\n`)});\nprocess.exit(1);\n`;
    const ghStub = resolve(stubBin, 'gh');
    writeFileSync(ghStub, `#!/usr/bin/env node\n${stubBody}`);
    chmodSync(ghStub, 0o755);
    writeFileSync(resolve(stubBin, 'gh.cmd'), `@echo off\r\nnode "%~dp0gh" %*\r\n`);

    writeConfig();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // Entry point 1 of 2 — the `gth` CLI. This is the invocation from issue #447.
  it('gth pr writes the promised report, headed and naming the 406, and still exits 1', () => {
    const { status, output } = run(appCli, ['--nopipe', 'pr', '427']);

    expect(existsSync(reportPath()), `no report file was written; CLI said:\n${output}`).toBe(true);
    const report = readFileSync(reportPath(), 'utf8');
    expect(report.split('\n')[0]).toBe('Gaunt Sloth · pr');
    expect(report).toContain(DID_NOT_RUN);
    expect(report).toContain(GH_406);
    expect(report).not.toContain(FAKE_VERDICT);
    expect(status).toBe(1);
  });

  // The same command's sibling: `gth review` shares neither the catch nor the source label, and a
  // fix applied only to `gth pr` leaves it writing nothing.
  it('gth review against the GitHub source writes the report too', () => {
    const { status, output } = run(appCli, [
      '--nopipe',
      'review',
      '427',
      '--content-source',
      'github',
    ]);

    expect(existsSync(reportPath()), `no report file was written; CLI said:\n${output}`).toBe(true);
    const report = readFileSync(reportPath(), 'utf8');
    expect(report.split('\n')[0]).toBe('Gaunt Sloth · review');
    expect(report).toContain(GH_406);
    expect(status).toBe(1);
  });

  // Entry point 2 of 2 — the standalone bin CI installs, which has its own catch and its own
  // source label, and is what `_review-shared.yml` actually runs.
  it('gaunt-sloth-review writes the promised report, headed and naming the 406, and still exits 1', () => {
    const { status, output } = run(reviewBin, ['427']);

    expect(existsSync(reportPath()), `no report file was written; CLI said:\n${output}`).toBe(true);
    const report = readFileSync(reportPath(), 'utf8');
    expect(report.split('\n')[0]).toBe('Gaunt Sloth · pr');
    expect(report).toContain(DID_NOT_RUN);
    expect(report).toContain(GH_406);
    expect(report).not.toContain(FAKE_VERDICT);
    expect(status).toBe(1);
  });

  // A failure the content source reports without throwing: `gh` is never reached, so this is the
  // argument guard rather than the fetch. It ends the run before inference just the same.
  it('writes the report when the run is rejected before any fetch is attempted', () => {
    const { status } = run(appCli, ['--nopipe', 'pr', 'not-a-number', '123']);

    expect(existsSync(reportPath())).toBe(true);
    expect(readFileSync(reportPath(), 'utf8')).toContain('Invalid pull request ID "not-a-number"');
    expect(status).toBe(1);
  });

  // REL-24 — the two inputs `gth pr` / `gth review` read outside the content fetch: `--file` and
  // the requirements source. Each used to escape as an unhandled rejection, which exits 1 through
  // the crash handler but never reaches the report, so the file is what these cells discriminate
  // on. `gaunt-sloth-review` already treated them as reported failures; these hold `gth` to it.
  const MISSING_FILE = 'no-such-notes.md';
  const NO_JIRA_TOKEN = 'Missing JIRA Legacy API token.';

  /** A Jira Legacy requirements source with every setting but the token. */
  const jiraWithoutToken = {
    requirementSourceConfig: {
      'jira-legacy': {
        username: 'test-user',
        baseUrl: 'https://test-jira.invalid/rest/api/2/issue/',
      },
    },
  };

  /** A local diff and the file content source, so `gth review` gets past its content fetch. */
  const useFileContent = (extra: Record<string, unknown> = {}): void => {
    writeFileSync(resolve(dir, 'change.diff'), 'diff --git a/a.txt b/a.txt\n+new\n');
    writeConfig({
      contentSource: 'file',
      commands: {
        pr: { contentSource: 'github', rating: { enabled: false } },
        review: { contentSource: 'file', rating: { enabled: false } },
      },
      ...extra,
    });
  };

  it('gth pr writes the report when a --file cannot be read', () => {
    const { status, output } = run(appCli, ['--nopipe', 'pr', '427', '--file', MISSING_FILE]);

    expect(existsSync(reportPath()), `no report file was written; CLI said:\n${output}`).toBe(true);
    const report = readFileSync(reportPath(), 'utf8');
    expect(report).toContain(DID_NOT_RUN);
    expect(report).toContain(MISSING_FILE);
    expect(report).not.toContain(FAKE_VERDICT);
    expect(status).toBe(1);
  });

  it('gth review writes the report when a --file cannot be read', () => {
    useFileContent();

    const { status, output } = run(appCli, [
      '--nopipe',
      'review',
      'change.diff',
      '--content-source',
      'file',
      '--file',
      MISSING_FILE,
    ]);

    expect(existsSync(reportPath()), `no report file was written; CLI said:\n${output}`).toBe(true);
    const report = readFileSync(reportPath(), 'utf8');
    expect(report).toContain(DID_NOT_RUN);
    expect(report).toContain(MISSING_FILE);
    expect(report).not.toContain(FAKE_VERDICT);
    expect(status).toBe(1);
  });

  it('gth pr writes the report when the requirements source cannot be resolved', () => {
    writeConfig(jiraWithoutToken);

    const { status, output } = run(appCli, [
      '--nopipe',
      'pr',
      '427',
      'JIRA-123',
      '--requirements-source',
      'jira-legacy',
    ]);

    expect(existsSync(reportPath()), `no report file was written; CLI said:\n${output}`).toBe(true);
    const report = readFileSync(reportPath(), 'utf8');
    expect(report).toContain(DID_NOT_RUN);
    expect(report).toContain(NO_JIRA_TOKEN);
    expect(status).toBe(1);
  });

  it('gth review writes the report when the requirements source cannot be resolved', () => {
    useFileContent(jiraWithoutToken);

    const { status, output } = run(appCli, [
      '--nopipe',
      'review',
      'change.diff',
      '--content-source',
      'file',
      '--requirements',
      'JIRA-123',
      '--requirements-source',
      'jira-legacy',
    ]);

    expect(existsSync(reportPath()), `no report file was written; CLI said:\n${output}`).toBe(true);
    const report = readFileSync(reportPath(), 'utf8');
    expect(report).toContain(DID_NOT_RUN);
    expect(report).toContain(NO_JIRA_TOKEN);
    expect(status).toBe(1);
  });

  // The control: a run that reaches the agent must be untouched by any of the above — no failure
  // line, and the verdict where it has always been.
  it('a successful review still writes an ordinary report with no failure line', () => {
    writeFileSync(resolve(dir, 'change.diff'), 'diff --git a/a.txt b/a.txt\n+new\n');
    writeConfig({
      contentSource: 'file',
      commands: {
        pr: { contentSource: 'file', rating: { enabled: false } },
        review: { contentSource: 'file', rating: { enabled: false } },
      },
    });

    const { status, output } = run(appCli, [
      '--nopipe',
      'review',
      'change.diff',
      '--content-source',
      'file',
    ]);

    expect(existsSync(reportPath()), `no report file was written; CLI said:\n${output}`).toBe(true);
    const report = readFileSync(reportPath(), 'utf8');
    expect(report).toContain(FAKE_VERDICT);
    expect(report).not.toContain(DID_NOT_RUN);
    expect(status).toBe(0);
  });

  // The other control: the default is still stdout-only. A failed run must not start creating
  // files for someone who never asked for one.
  it('writes nothing when the config asks for no report file', () => {
    writeConfig({ writeOutputToFile: false });

    const { status } = run(appCli, ['--nopipe', 'pr', '427']);

    expect(existsSync(reportPath())).toBe(false);
    expect(status).toBe(1);
  });
});
