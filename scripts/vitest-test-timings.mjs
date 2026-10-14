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
 * It ADDS to the configured reporters; it never replaces the console reporter, prints nothing, and
 * cannot change the run's exit code — a write failure is reported on stderr and swallowed, because
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
  }

  onInit(vitest) {
    this.root = vitest.config.root;
    this.defaultTimeout = vitest.config.testTimeout;
  }

  onTestCaseResult(testCase) {
    const result = testCase.result();
    const diagnostic = testCase.diagnostic();
    this.rows.push({
      file: relative(this.root, testCase.module.moduleId).split(sep).join('/'),
      name: testCase.fullName,
      state: result.state,
      durationMs: diagnostic ? Math.round(diagnostic.duration) : null,
      // Wall-clock start, so an outlier can be lined up against what else was running at the time.
      startTime: diagnostic ? Math.round(diagnostic.startTime) : null,
      timeoutMs: testCase.options.timeout ?? this.defaultTimeout ?? null,
      retryCount: diagnostic ? diagnostic.retryCount : 0,
    });
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
