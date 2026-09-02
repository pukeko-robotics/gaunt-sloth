// QA-13 — read @microsoft/tui-test's report and make a *flaky* outcome escape the log.
//
// tui-test already distinguishes flaky from failed: a test that fails and then passes on a retry
// is reported as `N flaky`, and `process.exit()` counts only genuinely-failed tests, so a flake
// exits 0. That part is right and this module does not change it. What is missing is reach: a
// flake produces a green check with one yellow line buried in a log nobody opens, so an
// intermittent bug decays into invisible noise. These helpers turn that line into a GitHub
// annotation and a job-summary entry, which survive a green run.
//
// Parsing stdout is not the shape anyone would choose. tui-test hardcodes `new ListReporter()`
// (lib/runner/runner.js) with no way to register another, and its per-test outcome reaches the
// terminal only as an ANSI colour, so there is no structured channel to read instead. The
// mitigation is that this module is pure and unit-tested against captured real output
// (packages/app/spec/fixtures/tui-e2e-output/), and that it fails LOUD rather than quiet when the
// format stops matching — a checker that has gone blind must never report "no flakes".

/**
 * Strip CSI escape sequences. Only CSI is needed: chalk emits SGR (`ESC [ … m`) and the list
 * reporter emits cursor moves (lib/reporter/utils.js `ansi`), both of which are CSI. Stripping is
 * required even when our stdout is a pipe, because chalk enables colour whenever it detects a CI
 * vendor regardless of TTY — so CI output is coloured and a local piped run is not.
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * The reporter's final tally, e.g. `  tests: 1 failed, 1 flaky, 34 did not run, 1 passed, 37 total`.
 * Tokens are emitted only when non-zero (lib/reporter/base.js `_printSummary`), and the whole line
 * is skipped when no tests were discovered at all — which is the case the caller must not mistake
 * for success.
 */
const SUMMARY_RE = /^\s*tests: (?<tokens>.+?), (?<total>\d+) total\s*$/m;

const TOKEN_RE = /(\d+) (failed|flaky|did not run|skipped|passed)/g;

/**
 * One numbered header per reported test, e.g.
 *   `  2) mouse.tui.test.ts:11:9 › an ordinary escape sequence is not mangled into the prompt`
 * Only the first attempt gets a numbered header; later attempts get a dim `Retry #N` instead
 * (lib/reporter/base.js `_printFailures`, guarded on `resultIdx === 0`), so headers are
 * one-per-test. Under a TTY the line is padded to 96 columns with `─`; when stdout is a pipe
 * `process.stdout.columns` is undefined and the padding is skipped, so tolerate both.
 */
const HEADER_RE = /^ {2}(\d+)\) (.+?):(\d+):(\d+) › (.*?)[\s─]*$/gm;

/**
 * Parse a completed run's combined output.
 *
 * Identity of a flaky test comes from ordering, not from any label: the reporter prints
 * `failuresToPrint = [...unexpected, ...flaky]` (lib/reporter/base.js `_generateSummary`), so the
 * first `failed` headers are the genuine failures and the remainder are the flakes. That couples
 * this parser to two internals — the concatenation order and the summary wording — which is why
 * a mismatch between the counts and the headers is reported as a problem rather than guessed at.
 *
 * @param {string} raw combined stdout+stderr of one tui-test run
 * @returns {{summary: null | {failed:number, flaky:number, didNotRun:number, skipped:number, passed:number, total:number}, failed: object[], flaky: object[], problem: string | null}}
 */
export function analyseRun(raw) {
  const text = stripAnsi(raw);
  const summaryMatch = text.match(SUMMARY_RE);

  const entries = [...text.matchAll(HEADER_RE)].map((m) => ({
    index: Number(m[1]),
    file: m[2],
    row: Number(m[3]),
    column: Number(m[4]),
    title: m[5],
  }));

  if (!summaryMatch) {
    return {
      summary: null,
      failed: [],
      flaky: [],
      problem:
        'tui-test printed no "tests: … total" line. It skips that line only when it discovered ' +
        'no tests at all, so either testMatch matched nothing (a silent all-green run over an ' +
        'empty suite) or the reporter format changed.',
    };
  }

  const counts = { failed: 0, flaky: 0, didNotRun: 0, skipped: 0, passed: 0 };
  const key = {
    failed: 'failed',
    flaky: 'flaky',
    'did not run': 'didNotRun',
    skipped: 'skipped',
    passed: 'passed',
  };
  for (const [, n, label] of summaryMatch.groups.tokens.matchAll(TOKEN_RE)) {
    counts[key[label]] = Number(n);
  }
  const summary = { ...counts, total: Number(summaryMatch.groups.total) };

  const expectedHeaders = summary.failed + summary.flaky;
  if (entries.length !== expectedHeaders) {
    return {
      summary,
      failed: [],
      flaky: [],
      problem:
        `the summary reports ${summary.failed} failed + ${summary.flaky} flaky = ` +
        `${expectedHeaders} reported test(s), but ${entries.length} numbered header(s) were ` +
        'found. The flake check cannot tell which test was which, so it is refusing to claim ' +
        'there were no flakes.',
    };
  }

  return {
    summary,
    failed: entries.slice(0, summary.failed),
    flaky: entries.slice(summary.failed),
    problem: null,
  };
}

/**
 * GS2-20 — read the report `fixtures/tmpHome.mjs` writes, and turn it into a failure message.
 * `null` means the run was clean.
 *
 * A file rather than a stream because a stream does not arrive: these hooks run in a workerpool
 * child whose captured output the reporter prints only for a test it is already reporting, and
 * never at all for `afterAllWorker`. Measured, not assumed.
 *
 * Why this is a hard failure and not a warning: a `gth` session holds `<HOME>/.gsloth/history.db`
 * open for its whole life, and this suite is the only place that would notice a handle never being
 * released — the removal succeeds on POSIX regardless, so win32 is the sole detector.
 *
 * **The report carries two independent findings, and the message must not merge them**, because
 * they have different causes and different fixes:
 *
 * - `still-running` — a session did not exit within the wait after being killed. The removal that
 *   follows was racing a live process, and no amount of retrying the removal is the fix.
 * - `unremovable` — a directory would not delete. Since every session is settled before any of
 *   these hooks run, a live session of ours is excluded by construction, which leaves a handle
 *   that outlived the process holding it.
 *
 * @param {string} raw contents of the report file (empty when nothing failed)
 * @param {Record<string, string>} [outcomes] per-directory result of re-attempting the removal
 *   once the whole run has exited, keyed by directory. A directory that deletes cleanly then was
 *   locked only transiently; one that still will not delete is holding.
 * @returns {string | null}
 */
/**
 * The directories the report says would not delete, so the caller can try them again once the whole
 * run has exited. Separated from {@link describeLeakReport} so the retry lives in the parent
 * process — where no worker, and therefore no session, can still be running.
 *
 * @param {string} raw contents of the report file
 * @returns {string[]}
 */
export function leakedDirs(raw) {
  const dirs = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record.kind === 'unremovable' && typeof record.dir === 'string') dirs.push(record.dir);
    } catch {
      // Handled, and reported, by describeLeakReport.
    }
  }
  return dirs;
}

export function describeLeakReport(raw, outcomes = {}) {
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // A row we cannot parse is still evidence that a hook reported something, so it must not be
      // silently dropped — that would turn a garbled report into a green run.
      records.push({ kind: 'unparseable', raw: trimmed });
    }
  }
  if (records.length === 0) return null;

  const stillRunning = records.filter((r) => r.kind === 'still-running');
  const unremovable = records.filter((r) => r.kind === 'unremovable');
  const unparseable = records.filter((r) => r.kind === 'unparseable');
  const parts = [];

  if (stillRunning.length > 0) {
    const waits = stillRunning.map((r) => `${r.waitedMs}ms`).join(', ');
    parts.push(
      `${stillRunning.length} session(s) were STILL RUNNING after the harness killed them and the ` +
        `suite waited for them to exit (waited: ${waits}).\n` +
        `  The kill is a bare process.kill(pid, 9) that does not wait, so anything the session had ` +
        `open was still open. Whatever else this run reports, that is the first thing to fix: a ` +
        `removal cannot be made reliable while it races a live process.`
    );
  }

  if (unremovable.length > 0) {
    const detail = unremovable
      .map((r) => {
        const outcome = outcomes[r.dir];
        return `    ${r.dir} — ${r.reason}${outcome ? ` [${outcome}]` : ''}`;
      })
      .join('\n');
    const context =
      stillRunning.length > 0
        ? `  At least one session outlived its kill in this run, so these may simply be that race.`
        : `  Every session in this run was confirmed exited before its directory was removed, so a ` +
          `live session of ours is not what is holding these. What is left is a handle that ` +
          `outlived the process that opened it, or a scanner on the host holding the file briefly.`;
    parts.push(
      `${unremovable.length} throwaway HOME director${unremovable.length === 1 ? 'y' : 'ies'} ` +
        `could not be removed:\n${detail}\n${context}`
    );
  }

  if (unparseable.length > 0) {
    parts.push(
      `${unparseable.length} report row(s) could not be read, which means a hook reported ` +
        `something this cannot describe:\n` +
        unparseable.map((r) => `    ${r.raw}`).join('\n')
    );
  }

  return parts.join('\n');
}

/** Repo-relative path for an entry. Headers are relative to the tui-e2e dir the runner ran in. */
export function repoPath(entry, testDir = 'packages/app/tui-e2e') {
  return `${testDir}/${entry.file}`;
}

/**
 * GitHub Actions workflow commands. A `::warning` attaches to the file and line in the run's
 * Files view and appears on the run summary, so it is visible without opening the job log —
 * which is the whole point, given the job itself is green.
 */
export function githubAnnotations(flaky) {
  return flaky.map(
    (entry) =>
      `::warning file=${repoPath(entry)},line=${entry.row},col=${entry.column},title=Flaky TUI e2e::` +
      `${entry.title} — passed only on a retry. Record it in docs/known-flakes.md (takahe) ` +
      `before this scrolls away.`
  );
}

/** Markdown for $GITHUB_STEP_SUMMARY — rendered on the run page itself. */
export function stepSummaryMarkdown(flaky, { os = process.platform } = {}) {
  const rows = flaky
    .map((entry) => `| \`${repoPath(entry)}:${entry.row}\` | ${entry.title} |`)
    .join('\n');
  return [
    `### ⚠️ ${flaky.length} flaky TUI e2e test${flaky.length === 1 ? '' : 's'} on ${os}`,
    '',
    'These passed only after a retry. The job is green, but an intermittent failure is a real',
    'defect that will cost somebody an unrelated investigation later.',
    '',
    '| Test | Title |',
    '| --- | --- |',
    rows,
    '',
    'Record it in `docs/known-flakes.md` in the takahe repo so the next person mid-merge can',
    'recognise it in seconds.',
    '',
  ].join('\n');
}
