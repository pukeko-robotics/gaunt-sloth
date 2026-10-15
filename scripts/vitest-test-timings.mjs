/**
 * Vitest reporter that writes one row per test — file, full name, state, duration and the timeout
 * that test actually ran under — to a JSON file. OPS-122 / OPS-153.
 *
 * It exists to measure headroom: how far each test sits below its own per-test ceiling on a CI
 * runner. The default console reporter prints only tests slower than `slowTestThreshold`, and the
 * summary's `Duration` line is a suite total (and in vitest 5, a set of percentages), so neither
 * yields a per-test distribution. `options.timeout` is recorded per test because the Ink render
 * specs do not share one ceiling: some set their own, and a headroom factor is the ratio of a
 * test's duration to ITS ceiling, not to the repo default.
 *
 * It ADDS to the configured reporters; it never replaces the console reporter, and it cannot change
 * the run's exit code: vitest turns an exception thrown from any reporter hook into an "Unhandled
 * Reporter Error" and a failed run, so every hook catches its own. A fault — a vitest API shape
 * that moved, an unwritable output file — is reported once on stderr and the run goes on, because
 * an instrument that can fail the gate it measures is a second gate nobody chose.
 *
 * Wired in `vitest.config.ts` only when `GTH_TEST_TIMINGS_FILE` names the output file, so a local
 * `pnpm test` is unchanged. `unit-tests.yml` sets it on the `test-platforms` cells and uploads the
 * file as an artifact.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';

export default class TestTimingsReporter {
  /** @param {{ outputFile: string }} options */
  constructor(options) {
    this.outputFile = options.outputFile;
    /** @type {Array<Record<string, unknown>>} */
    this.rows = [];
    this.root = process.cwd();
    this.defaultTimeout = undefined;
    this.faulted = false;
  }

  /** Report the first fault on stderr and swallow every one: see the docblock. */
  fault(hook, error) {
    if (this.faulted) return;
    this.faulted = true;
    process.stderr.write(
      `test timings: ${hook} failed, timings are incomplete: ${String(error)}\n`
    );
  }

  onInit(vitest) {
    try {
      this.root = vitest.config.root;
      this.defaultTimeout = vitest.config.testTimeout;
    } catch (error) {
      this.fault('onInit', error);
    }
  }

  onTestCaseResult(testCase) {
    try {
      const result = testCase.result();
      const diagnostic = testCase.diagnostic();
      this.rows.push({
        file: relative(this.root, testCase.module.moduleId).split(sep).join('/'),
        name: testCase.fullName,
        state: result.state,
        durationMs: diagnostic ? Math.round(diagnostic.duration) : null,
        // Wall-clock start, so an outlier can be lined up against what else was running then.
        startTime: diagnostic ? Math.round(diagnostic.startTime) : null,
        // A test's own, else its project's (the Ink render specs have one), else the root's.
        timeoutMs:
          testCase.options.timeout ??
          testCase.project?.config?.testTimeout ??
          this.defaultTimeout ??
          null,
        retryCount: diagnostic ? diagnostic.retryCount : 0,
      });
    } catch (error) {
      this.fault('onTestCaseResult', error);
    }
  }

  onTestRunEnd() {
    try {
      mkdirSync(dirname(this.outputFile), { recursive: true });
      writeFileSync(
        this.outputFile,
        JSON.stringify(
          { version: 1, platform: process.platform, node: process.version, tests: this.rows },
          null,
          1
        )
      );
    } catch (error) {
      process.stderr.write(`test timings: could not write ${this.outputFile}: ${String(error)}\n`);
    }
  }
}
