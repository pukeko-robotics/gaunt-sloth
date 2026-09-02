import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  analyseRun,
  describeLeakReport,
  githubAnnotations,
  leakedDirs,
  repoPath,
  stepSummaryMarkdown,
  stripAnsi,
} from '../tui-e2e-report.mjs';

/**
 * QA-13 — the PTY e2e flake reporter.
 *
 * `tui-e2e-report.mjs` reads @microsoft/tui-test's own report so a *flaky* outcome escapes a green
 * job. It does that by parsing stdout, because tui-test hardcodes its reporter and encodes the
 * per-test outcome as an ANSI colour and nothing else. Parsing is the risk, so every fixture here
 * is REAL captured output from a run of a deliberately-flaky / deliberately-failing probe against
 * the actual pinned tui-test (0.0.4) — not prose written to match the parser.
 *
 * The one exception is `no-tests-discovered.log`, which is the real header of a zero-match run
 * with the summary line removed. That is exactly the byte sequence tui-test emits when it finds no
 * tests at all (`_printSummary` returns early when the total is 0), and it cannot be captured
 * directly without deleting the suite.
 *
 * Fixtures are resolved as URLs throughout — a `D:\…` string is not a valid URL, and re-wrapping a
 * native path is what broke [[OPS-39]]'s guard on the Windows cells.
 */
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/tui-e2e-output/${name}`, import.meta.url), 'utf8');

const FAILED_AND_FLAKY = fixture('failed-and-flaky.log');
const FLAKY_ONLY = fixture('flaky-only.log');
const ALL_PASS = fixture('all-pass.log');
const NO_TESTS = fixture('no-tests-discovered.log');

describe('QA-13 tui-e2e flake reporter', () => {
  describe('the fixtures are real reports', () => {
    // Anti-vacuity. A truncated or missing fixture would otherwise make the assertions below pass
    // by parsing nothing into "no flakes" — the exact silence this whole module exists to prevent.
    it.each([
      ['failed-and-flaky', FAILED_AND_FLAKY],
      ['flaky-only', FLAKY_ONLY],
      ['all-pass', ALL_PASS],
    ])('%s carries a real summary line', (_name, text) => {
      expect(text.length).toBeGreaterThan(100);
      expect(text).toContain('  tests: ');
      expect(text).toContain(' total');
    });

    it('no-tests-discovered has output but deliberately no summary line', () => {
      expect(NO_TESTS.length).toBeGreaterThan(0);
      expect(NO_TESTS).toContain('Running 0 test');
      expect(NO_TESTS).not.toContain('  tests: ');
    });
  });

  describe('analyseRun', () => {
    it('separates a genuine failure from a flake in the same run', () => {
      // The discriminating case: both appear as numbered headers, distinguished ONLY by the
      // summary counts and their order. If the parser lumped them together, or mapped them the
      // wrong way round, this is where it shows.
      const result = analyseRun(FAILED_AND_FLAKY);

      expect(result.problem).toBeNull();
      expect(result.summary).toEqual({
        failed: 1,
        flaky: 1,
        didNotRun: 34,
        skipped: 0,
        passed: 1,
        total: 37,
      });
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].title).toContain('genuinely failing');
      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0].title).toContain('passes on the retry');
      expect(result.flaky[0].file).toBe('zzprobe.tui.test.ts');
      expect(result.flaky[0].row).toBe(11);
    });

    it('reports a flake in an otherwise-green run', () => {
      const result = analyseRun(FLAKY_ONLY);

      expect(result.problem).toBeNull();
      expect(result.summary?.flaky).toBe(1);
      expect(result.summary?.failed).toBe(0);
      expect(result.failed).toEqual([]);
      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0].title).toContain('passes on the retry');
    });

    it('finds nothing to report in a clean run', () => {
      const result = analyseRun(ALL_PASS);

      expect(result.problem).toBeNull();
      expect(result.summary?.passed).toBe(1);
      expect(result.summary?.flaky).toBe(0);
      expect(result.flaky).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it('refuses to call a run clean when no tests were discovered', () => {
      // A suite whose testMatch stopped matching prints no summary and exits 0. Treating that as
      // "no flakes, all good" is the blind-denominator failure: a gate reporting on nothing.
      const result = analyseRun(NO_TESTS);

      expect(result.problem).toBeTruthy();
      expect(result.problem).toContain('no tests');
      expect(result.summary).toBeNull();
    });

    it('takes the failed/flaky split from the counts, not from a fixed position', () => {
      // Synthesised from the real fixture's own header lines: 2 failed + 1 flaky. Guards against
      // a parser that happens to work only because every real fixture here has exactly one of
      // each — `slice(0, 1)` and `slice(0, summary.failed)` are indistinguishable otherwise.
      const text = [
        '  1) a.tui.test.ts:10:1 › first genuine failure',
        '  2) b.tui.test.ts:20:2 › second genuine failure',
        '  3) c.tui.test.ts:30:3 › the flake',
        '',
        '  tests: 2 failed, 1 flaky, 5 passed, 8 total',
      ].join('\n');

      const result = analyseRun(text);

      expect(result.problem).toBeNull();
      expect(result.failed.map((entry) => entry.file)).toEqual(['a.tui.test.ts', 'b.tui.test.ts']);
      expect(result.flaky.map((entry) => entry.file)).toEqual(['c.tui.test.ts']);
    });
  });

  describe('it goes loud rather than quiet when the format stops matching', () => {
    it('rejects a report whose counts and headers disagree', () => {
      // Mutation of the REAL fixture: claim one more flake than there are headers. A parser that
      // silently trusted whichever side it read first would pass this.
      const mutated = FAILED_AND_FLAKY.replace('1 flaky', '2 flaky');
      expect(mutated).not.toBe(FAILED_AND_FLAKY);

      const result = analyseRun(mutated);

      expect(result.problem).toContain('numbered header');
      expect(result.flaky).toEqual([]);
    });

    it('rejects a report whose summary line has been lost', () => {
      const mutated = ALL_PASS.replace(/^\s*tests: .*$/m, '');
      expect(mutated).not.toBe(ALL_PASS);

      expect(analyseRun(mutated).problem).toBeTruthy();
    });

    it('rejects a report whose summary wording changed', () => {
      const mutated = FLAKY_ONLY.replace('1 flaky', '1 unreliable');

      const result = analyseRun(mutated);

      // The token no longer parses, so the counts say zero reported tests while one header is
      // present. Silence would be the dangerous answer here; a problem is the safe one.
      expect(result.problem).toBeTruthy();
      expect(result.flaky).toEqual([]);
    });
  });

  describe('stripAnsi', () => {
    it('is load-bearing: a coloured report parses the same as a plain one', () => {
      // Locally the runner's stdout is a pipe and chalk emits nothing, but in CI chalk keys off
      // the CI vendor and colours anyway — so the CI-shaped input is the coloured one, and it is
      // the one that has to work. Colours are injected exactly where the reporter puts them: the
      // numbered header (yellow for flaky, red for failed) and the summary tokens.
      const coloured = FAILED_AND_FLAKY.replace(
        /^ {2}(\d+)\) (.*)$/gm,
        '  \u001b[31m$1) $2\u001b[39m'
      )
        .replace('1 failed', '\u001b[31m1 failed\u001b[39m')
        .replace('1 flaky', '\u001b[33m1 flaky\u001b[39m');
      expect(coloured).toContain('\u001b[');

      expect(analyseRun(coloured)).toEqual(analyseRun(FAILED_AND_FLAKY));
    });

    it('removes CSI sequences and leaves the text', () => {
      expect(stripAnsi('\u001b[33mflaky\u001b[39m')).toBe('flaky');
      expect(stripAnsi('\u001b[2K\u001b[Gredrawn')).toBe('redrawn');
      expect(stripAnsi('plain')).toBe('plain');
    });
  });

  describe('what CI is told', () => {
    const flaky = analyseRun(FLAKY_ONLY).flaky;

    it('maps a header path to a repo-relative one', () => {
      // The header is relative to the tui-e2e dir the runner ran in; an annotation only attaches
      // to a file if the path is relative to the repo root.
      expect(repoPath(flaky[0])).toBe('packages/app/tui-e2e/zzprobe.tui.test.ts');
    });

    it('emits a GitHub warning naming the test and where to record it', () => {
      const [annotation] = githubAnnotations(flaky);

      expect(annotation).toContain('::warning file=packages/app/tui-e2e/zzprobe.tui.test.ts');
      expect(annotation).toContain('line=11');
      expect(annotation).toContain('passes on the retry');
      expect(annotation).toContain('docs/known-flakes.md');
    });

    it('writes a job summary naming the test and where to record it', () => {
      const markdown = stepSummaryMarkdown(flaky, { os: 'darwin' });

      expect(markdown).toContain('1 flaky TUI e2e test on darwin');
      expect(markdown).toContain('packages/app/tui-e2e/zzprobe.tui.test.ts:11');
      expect(markdown).toContain('passes on the retry');
      expect(markdown).toContain('docs/known-flakes.md');
    });

    it('pluralises the job summary heading', () => {
      const two = [...flaky, ...flaky];
      expect(stepSummaryMarkdown(two, { os: 'linux' })).toContain('2 flaky TUI e2e tests on linux');
    });
  });

  /**
   * GS2-20 — the leak gate. A `gth` session holds `<HOME>/.gsloth/history.db` open for its whole
   * life, and the suite's throwaway HOME cannot be removed on win32 while that handle is alive.
   * POSIX unlinks an open file regardless, so the win32 cell is the only detector there is, and a
   * hook that merely warned would be no detector at all. The report is written to a file and the
   * runner fails the run on it.
   *
   * The report cannot travel on a stream: those hooks run in a workerpool child whose captured
   * output the reporter prints only for a test it is already reporting, and never for
   * `afterAllWorker`. Measured with a filesystem control — zero hits on either stream.
   *
   * **The two findings must stay distinguishable.** A session that outlived its kill and a
   * directory that will not delete have different causes and different fixes, and a message that
   * merges them sends the reader after the wrong one. These cases pin that separation.
   */
  describe('describeLeakReport', () => {
    it('says nothing when nothing failed', () => {
      // The control, and the one that matters most: this gate runs on EVERY green run, so a
      // function that reported a leak from an empty or whitespace-only file would turn the whole
      // PTY suite red for every developer, immediately.
      expect(describeLeakReport('')).toBeNull();
      expect(describeLeakReport('\n')).toBeNull();
      expect(describeLeakReport('  \n\n  \n')).toBeNull();
    });

    it('names every directory that would not delete, with its reason', () => {
      const report = describeLeakReport(
        `${JSON.stringify({
          kind: 'unremovable',
          dir: 'C:\\Users\\runner\\AppData\\Local\\Temp\\gth-e2e-attack-home-a1',
          reason: 'EPERM: operation not permitted',
        })}\n${JSON.stringify({
          kind: 'unremovable',
          dir: 'C:\\Users\\runner\\AppData\\Local\\Temp\\gth-e2e-attack-home-b2',
          reason: 'EBUSY: resource busy',
        })}\n`
      );
      expect(report).not.toBeNull();
      expect(report).toContain('2 throwaway HOME directories');
      expect(report).toContain('gth-e2e-attack-home-a1');
      expect(report).toContain('EPERM: operation not permitted');
      expect(report).toContain('gth-e2e-attack-home-b2');
      expect(report).toContain('EBUSY: resource busy');
      // With no still-running row the message reports WHAT WAS OBSERVED — that the pty signalled an
      // exit — and keeps the diagnosis conditional on that signal being faithful.
      expect(report).toContain('The pty reported an exit for every session');
      expect(report).toContain('If that signal is faithful');
      // It must NOT claim the process was alive. That was the first message's unearned conclusion.
      expect(report).not.toContain('still holding a file open well after the process was killed');
      // Nor may it claim the sessions were CONFIRMED dead, which was the second one: on win32 that
      // signal is the pty's output socket closing, which is not an observation of process death.
      expect(report).not.toContain('confirmed exited');
      expect(report).toContain('evidence and not proof');
    });

    it('prints how long the exits took, which is what indicts or exonerates the exit signal', () => {
      const withTimings = describeLeakReport(
        `${JSON.stringify({
          kind: 'unremovable',
          dir: '/tmp/gth-e2e-menu-x',
          reason: 'EPERM',
          exitWaits: { n: 12, minMs: 0, maxMs: 3 },
        })}\n`
      );
      expect(withTimings).toContain('reported in 0-3ms across 12 session(s)');
      // And it must not fabricate the sentence when the worker recorded no timings at all.
      const without = describeLeakReport(
        `${JSON.stringify({ kind: 'unremovable', dir: '/tmp/gth-e2e-menu-x', reason: 'EPERM' })}\n`
      );
      expect(without).not.toContain('Those exits were reported in');
    });

    it('reports a session that outlived its kill as its own finding, not as a leak', () => {
      const report = describeLeakReport(
        `${JSON.stringify({ kind: 'still-running', waitedMs: 5000 })}\n`
      );
      expect(report).not.toBeNull();
      expect(report).toContain('1 session(s) were STILL RUNNING');
      expect(report).toContain('5000ms');
      expect(report).toContain('does not wait');
      // No directory failed here, so it must not invent one.
      expect(report).not.toContain('throwaway HOME director');
    });

    it('stops claiming the sessions were settled once one of them was not', () => {
      const both = describeLeakReport(
        `${JSON.stringify({ kind: 'still-running', waitedMs: 5000 })}\n` +
          `${JSON.stringify({ kind: 'unremovable', dir: '/tmp/gth-e2e-menu-x', reason: 'EPERM' })}\n`
      );
      expect(both).toContain('STILL RUNNING');
      expect(both).toContain('/tmp/gth-e2e-menu-x');
      // The discriminating assertion: with a live session in the run, the removal failure may be
      // nothing but that race, and the message must not assert the stronger diagnosis. Pinned on a
      // string the OTHER branch really does emit — asserting the absence of wording that appears in
      // neither branch would be an assertion that cannot fail.
      expect(both).not.toContain('The pty reported an exit for every session');
      expect(both).toContain('may simply be that race');
    });

    it('carries the run-end re-check through, which is what separates a race from a leak', () => {
      const raw = `${JSON.stringify({
        kind: 'unremovable',
        dir: '/tmp/gth-e2e-menu-x',
        reason: 'EPERM',
      })}\n`;
      expect(
        describeLeakReport(raw, { '/tmp/gth-e2e-menu-x': 'removable once the run had exited' })
      ).toContain('[removable once the run had exited]');
      expect(describeLeakReport(raw)).toContain('1 throwaway HOME directory');
    });

    it('never goes quiet on a row it cannot read', () => {
      // A garbled report is evidence that a hook reported SOMETHING. Dropping it would turn a
      // broken instrument into a green run, which is the failure mode this whole gate exists to
      // avoid.
      const report = describeLeakReport('{not json at all\n');
      expect(report).not.toBeNull();
      expect(report).toContain('could not be read');
      expect(report).toContain('{not json at all');
    });
  });

  describe('leakedDirs', () => {
    it('returns only the directories, so the run-end re-check has something to retry', () => {
      const raw =
        `${JSON.stringify({ kind: 'still-running', waitedMs: 5000 })}\n` +
        `${JSON.stringify({ kind: 'unremovable', dir: '/tmp/a', reason: 'EPERM' })}\n` +
        `${JSON.stringify({ kind: 'unremovable', dir: '/tmp/b', reason: 'EBUSY' })}\n`;
      expect(leakedDirs(raw)).toEqual(['/tmp/a', '/tmp/b']);
    });

    it('is empty for a clean run and survives an unreadable row', () => {
      expect(leakedDirs('')).toEqual([]);
      expect(leakedDirs('{broken\n')).toEqual([]);
    });
  });
});
