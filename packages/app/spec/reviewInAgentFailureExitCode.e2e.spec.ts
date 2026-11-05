import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REL-24 (a) — process-level e2e proving that a review which fails INSIDE the agent exits non-zero.
 *
 * The sibling file `reviewFailureReport.e2e.spec.ts` covers the opposite condition: a run that
 * fails BEFORE inference. Those exits already set the code; this one did not. `review()`'s runner
 * catch reported the provider error perfectly well and then returned normally, so the process
 * drained with exit 0.
 *
 * **Why that has to be a spawned process.** The defect is a property of the process, not of a
 * function call: the console output was already correct, and a mock cannot observe an exit code at
 * all. `review.yml` keys its "Check review step result" step on the review step's OUTCOME,
 * so a review that exited 0 posted a failure comment on a run CI called green — the same failure
 * the console said had happened.
 *
 * **The induced failure is a real provider error and needs no key and no network.** The config
 * points the Ollama client at `127.0.0.1:1`, a port nothing can be listening on (privileged, so
 * nothing binds it unprivileged, and this is loopback either way), and the call comes back as a
 * connection failure in about a second. An explicit `baseUrl` in the `llm` block beats both
 * `OLLAMA_HOST` and the local default, so a developer running a real Ollama daemon gets the same
 * refusal as a CI runner with none. The assertions read the exit code and gaunt-sloth's own
 * `Failed to run review with agent.` line rather than the socket error's text, which is spelled
 * differently per platform.
 *
 * Requires the build — these cells spawn `packages/app/cli.js` and `packages/review/cli.js`, so
 * `pnpm test` (which builds) is the entry point; a bare `pnpm run unit` tests the previous `dist`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appCli = resolve(here, '../cli.js'); // packages/app/cli.js — `gth`
const reviewBin = resolve(here, '../../review/cli.js'); // packages/review/cli.js — `gaunt-sloth-review`

/** A provider that cannot answer: the daemon client aimed at a port that refuses the connection. */
const UNREACHABLE_PROVIDER = {
  type: 'ollama',
  model: 'gth-rel24-no-such-model',
  baseUrl: 'http://127.0.0.1:1',
};

/** The line `review()`'s runner catch prints; the failure this suite is about, in our own words. */
const AGENT_FAILED = 'Failed to run review with agent.';

const FAKE_VERDICT = 'FAKE-REVIEW-VERDICT-REL-24';

describe('a review that fails inside the agent exits non-zero (e2e)', () => {
  let dir: string;
  let home: string;

  const reportPath = (): string => resolve(dir, 'review.md');

  /**
   * Write the project config both entry points discover from the temp cwd.
   *
   * Rating is off unless a cell says otherwise, and that is the configuration under test rather
   * than a convenience: with rating on, a failed run already exits 1 through the missing-artifact
   * branch of `handleRatingResult`. A user who turned rating off had nothing left to notice the
   * failure by.
   */
  const writeConfig = (extra: Record<string, unknown> = {}): void => {
    writeFileSync(
      resolve(dir, '.gsloth.config.json'),
      JSON.stringify({
        llm: UNREACHABLE_PROVIDER,
        contentSource: 'file',
        writeOutputToFile: './review.md',
        streamOutput: false,
        commands: {
          pr: { contentSource: 'file', rating: { enabled: false } },
          review: { contentSource: 'file', rating: { enabled: false } },
        },
        ...extra,
      })
    );
  };

  /** Run a built entry point in the temp project dir. */
  const run = (entry: string, args: string[]): { status: number | null; output: string } => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    // The CLI's cwd is `INIT_CWD` when set (systemUtils.getCurrentWorkDir), and pnpm sets it to
    // wherever `pnpm test` was invoked — the repo root. Inherited, it would aim this run's
    // project-relative paths at the repository instead of the temp dir under test.
    delete env.INIT_CWD;
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      cwd: dir,
      env,
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-rel24-'));
    home = mkdtempSync(resolve(tmpdir(), 'gsloth-rel24-home-'));
    writeFileSync(resolve(dir, 'change.diff'), 'diff --git a/a.txt b/a.txt\n+new\n');
    writeConfig();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // Entry point 1 of 2 — the `gth` CLI, with rating off, which is the uncovered configuration.
  it('gth review reports the provider failure and exits 1', () => {
    const { status, output } = run(appCli, [
      '--nopipe',
      'review',
      'change.diff',
      '--content-source',
      'file',
    ]);

    expect(output, 'the run did not fail inside the agent').toContain(AGENT_FAILED);
    expect(status, `review failed but the process said it succeeded; CLI said:\n${output}`).toBe(1);
    // REL-20's guarantee holds at the same time: the report is still written, and it names the
    // failure. A non-zero exit that cost the caller the report would be a trade, not a fix.
    expect(existsSync(reportPath())).toBe(true);
    expect(readFileSync(reportPath(), 'utf8')).toContain(AGENT_FAILED);
  });

  // Entry point 2 of 2 — the standalone bin `review.yml` actually runs. It reaches its
  // exit code by DRAINING `process.exitCode`, not through its phase-2 catch: `review()` handles
  // the agent failure itself and returns normally, so that catch never fires for this case.
  it('gaunt-sloth-review reports the provider failure and exits 1', () => {
    const { status, output } = run(reviewBin, ['change.diff']);

    expect(output, 'the run did not fail inside the agent').toContain(AGENT_FAILED);
    expect(status, `review failed but the process said it succeeded; CLI said:\n${output}`).toBe(1);
    expect(existsSync(reportPath())).toBe(true);
  });

  /**
   * The `errorOnReviewFail` decision, pinned: it governs a VERDICT, not a malfunction. A user who
   * set it to `false` asked not to have the build failed by a low score; a review that never
   * produced a score has no opinion to suppress.
   *
   * Green before the fix as well as after — with rating enabled the missing-artifact branch was
   * already setting the code — and it is here for exactly that reason: it is the assertion that
   * would go red if the flag were ever extended to cover a run that could not happen.
   */
  it('a run that failed exits 1 even with errorOnReviewFail false', () => {
    writeConfig({
      commands: {
        review: {
          contentSource: 'file',
          rating: { enabled: true, errorOnReviewFail: false },
        },
      },
    });

    const { status, output } = run(appCli, [
      '--nopipe',
      'review',
      'change.diff',
      '--content-source',
      'file',
    ]);

    expect(output, 'the run did not fail inside the agent').toContain(AGENT_FAILED);
    expect(status).toBe(1);
  });

  // The control: a review that reaches the agent and finishes still exits 0. A fix that failed
  // every review would satisfy the cells above and nothing else.
  it('a successful review still exits 0', () => {
    writeConfig({ llm: { type: 'fake', responses: [FAKE_VERDICT] } });

    const { status, output } = run(appCli, [
      '--nopipe',
      'review',
      'change.diff',
      '--content-source',
      'file',
    ]);

    expect(output).not.toContain(AGENT_FAILED);
    expect(status, `a successful review exited non-zero; CLI said:\n${output}`).toBe(0);
    expect(readFileSync(reportPath(), 'utf8')).toContain(FAKE_VERDICT);
  });
});
