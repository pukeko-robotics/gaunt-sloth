import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { configDefaults } from 'vitest/config';

/**
 * OPS-122 — the per-test timing instrument (`scripts/vitest-test-timings.mjs`).
 *
 * It is how the Ink render specs' headroom on the Windows unit cell is measured, so the two things
 * worth pinning are that it records each test against the timeout THAT test ran under, and that it
 * cannot change the run it measures: it adds to vitest's reporters rather than replacing them, a
 * fault in any of its hooks is reported and swallowed rather than thrown, and its artifact upload
 * cannot fail the cell. The reporter-list case discriminates on CI, where `GITHUB_ACTIONS` puts
 * `github-actions` among the defaults; in a plain shell the defaults are `['default']` alone.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** The slice of vitest's TestCase the reporter reads. */
function testCase(
  file: string,
  fullName: string,
  options: {
    duration: number;
    startTime: number;
    timeout?: number;
    state?: string;
    retryCount?: number;
    projectTimeout?: number;
    noResult?: boolean;
  }
) {
  return {
    module: { moduleId: join(ROOT, file) },
    fullName,
    options: { timeout: options.timeout },
    ...(options.projectTimeout === undefined
      ? {}
      : { project: { config: { testTimeout: options.projectTimeout } } }),
    result: () => (options.noResult ? undefined : { state: options.state ?? 'passed' }),
    diagnostic: () => ({
      duration: options.duration,
      startTime: options.startTime,
      retryCount: options.retryCount ?? 0,
    }),
  };
}

describe('OPS-122 the per-test timings reporter', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.restoreAllMocks();
  });

  it('writes one row per test, with the timeout that test ran under', async () => {
    const { default: TestTimingsReporter } =
      await import('../../../scripts/vitest-test-timings.mjs');
    dir = mkdtempSync(join(tmpdir(), 'gth-timings-'));
    const outputFile = join(dir, 'nested', 'timings.json');
    const reporter = new TestTimingsReporter({ outputFile });
    reporter.onInit({ config: { root: ROOT, testTimeout: 10_000 } });

    reporter.onTestCaseResult(
      testCase('packages/app/spec/tui/A.spec.tsx', 'suite > own ceiling', {
        duration: 1234.4,
        startTime: 1000.6,
        timeout: 40_000,
      })
    );
    reporter.onTestCaseResult(
      testCase('packages/app/spec/tui/B.spec.tsx', 'suite > default ceiling', {
        duration: 56,
        startTime: 2000,
        state: 'failed',
        retryCount: 2,
      })
    );
    reporter.onTestCaseResult(
      testCase('packages/app/spec/tui/C.spec.tsx', 'suite > project ceiling', {
        duration: 78,
        startTime: 3000,
        projectTimeout: 20_000,
      })
    );
    reporter.onTestRunEnd();

    const written = JSON.parse(readFileSync(outputFile, 'utf8'));
    expect(written.version).toBe(1);
    expect(written.tests).toEqual([
      {
        file: 'packages/app/spec/tui/A.spec.tsx',
        name: 'suite > own ceiling',
        state: 'passed',
        durationMs: 1234,
        startTime: 1001,
        timeoutMs: 40_000,
        retryCount: 0,
      },
      {
        file: 'packages/app/spec/tui/B.spec.tsx',
        name: 'suite > default ceiling',
        state: 'failed',
        durationMs: 56,
        startTime: 2000,
        timeoutMs: 10_000,
        retryCount: 2,
      },
      {
        file: 'packages/app/spec/tui/C.spec.tsx',
        name: 'suite > project ceiling',
        state: 'passed',
        durationMs: 78,
        startTime: 3000,
        timeoutMs: 20_000,
        retryCount: 0,
      },
    ]);
  });

  it("names each file relative to vitest's root, not to the working directory", async () => {
    const { default: TestTimingsReporter } =
      await import('../../../scripts/vitest-test-timings.mjs');
    dir = mkdtempSync(join(tmpdir(), 'gth-timings-'));
    const outputFile = join(dir, 'timings.json');
    const reporter = new TestTimingsReporter({ outputFile });
    // A root that is not the cwd this spec runs in.
    reporter.onInit({ config: { root: join(ROOT, 'packages'), testTimeout: 10_000 } });
    reporter.onTestCaseResult(
      testCase('packages/app/spec/tui/A.spec.tsx', 'suite > case', { duration: 1, startTime: 1 })
    );
    reporter.onTestRunEnd();

    const written = JSON.parse(readFileSync(outputFile, 'utf8'));
    expect(written.tests.map((row: { file: string }) => row.file)).toEqual([
      'app/spec/tui/A.spec.tsx',
    ]);
  });

  it('still writes the row of an aborted test that has no result', async () => {
    const { default: TestTimingsReporter } =
      await import('../../../scripts/vitest-test-timings.mjs');
    dir = mkdtempSync(join(tmpdir(), 'gth-timings-'));
    const outputFile = join(dir, 'timings.json');
    const reporter = new TestTimingsReporter({ outputFile });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    reporter.onInit({ config: { root: ROOT, testTimeout: 10_000 } });
    reporter.onTestCaseResult(
      testCase('packages/app/spec/tui/A.spec.tsx', 'suite > aborted', {
        duration: 5,
        startTime: 7,
        noResult: true,
      })
    );
    reporter.onTestRunEnd();

    const written = JSON.parse(readFileSync(outputFile, 'utf8'));
    expect(written.tests).toEqual([
      {
        file: 'packages/app/spec/tui/A.spec.tsx',
        name: 'suite > aborted',
        state: null,
        durationMs: 5,
        startTime: 7,
        timeoutMs: 10_000,
        retryCount: 0,
      },
    ]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('swallows a fault in onInit and onTestCaseResult, saying so once on stderr', async () => {
    const { default: TestTimingsReporter } =
      await import('../../../scripts/vitest-test-timings.mjs');
    const reporter = new TestTimingsReporter({ outputFile: join(tmpdir(), 'unused.json') });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Inputs whose shape moved: no `config`, and a test case with none of its methods.
    expect(() => reporter.onInit({})).not.toThrow();
    expect(() => reporter.onTestCaseResult({})).not.toThrow();
    expect(() => reporter.onTestCaseResult({})).not.toThrow();

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('test timings: onInit failed'));

    // The second guard on its own: a sound onInit, so the one report is onTestCaseResult's.
    stderr.mockClear();
    const second = new TestTimingsReporter({ outputFile: join(tmpdir(), 'unused.json') });
    second.onInit({ config: { root: ROOT, testTimeout: 10_000 } });
    expect(() => second.onTestCaseResult({})).not.toThrow();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('test timings: onTestCaseResult failed')
    );
  });

  it('leaves a real run that passes exiting 0 when both of those hooks fault', () => {
    // The fixture subclasses the reporter and feeds both hooks a moved shape; see its config.
    const fixture = join(ROOT, 'packages', 'app', 'spec', 'fixtures', 'timingsReporterFault');
    dir = mkdtempSync(join(tmpdir(), 'gth-timings-'));
    const run = spawnSync(
      process.execPath,
      [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.config.mjs'],
      {
        cwd: fixture,
        encoding: 'utf8',
        env: {
          ...process.env,
          GTH_TEST_TIMINGS_FILE: join(dir, 'timings.json'),
          GTH_FIXTURE_CACHE_DIR: join(dir, 'cache'),
        },
        timeout: 60_000,
      }
    );
    // Uncoloured, because a CI runner forces colour on and the counts are then split by escapes.
    const output = stripVTControlCharacters(`${run.stdout}\n${run.stderr}`);
    // Proves the fixture ran its test and the onInit guard reported. The onTestCaseResult fault is
    // not named here, since a reporter reports once; that it was swallowed is what the exit code
    // and the missing 'Unhandled Reporter Error' show, and the test above names it directly.
    expect(output).toMatch(/Tests\s+1 passed/);
    expect(output).toContain('test timings: onInit failed');
    expect(output).not.toContain('Unhandled Reporter Error');
    expect(run.status).toBe(0);
    // Its cache went to the temp dir, not into the repo.
    expect(existsSync(join(fixture, 'node_modules'))).toBe(false);
  }, 60_000);

  it('reports a write failure on stderr and does not throw it into the run', async () => {
    const { default: TestTimingsReporter } =
      await import('../../../scripts/vitest-test-timings.mjs');
    dir = mkdtempSync(join(tmpdir(), 'gth-timings-'));
    // A regular file where the output's parent directory must go: mkdir fails on every platform.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '');
    const reporter = new TestTimingsReporter({ outputFile: join(blocker, 'timings.json') });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => reporter.onTestRunEnd()).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('test timings: could not write'));
  });
});

describe('OPS-122 the timings reporter is wired beside vitest’s own reporters', () => {
  const saved = process.env.GTH_TEST_TIMINGS_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GTH_TEST_TIMINGS_FILE;
    else process.env.GTH_TEST_TIMINGS_FILE = saved;
  });

  it('keeps every default reporter, the CI annotations included, and adds itself last', async () => {
    // The config reads the variable when it loads, so each reading is a fresh import of it.
    process.env.GTH_TEST_TIMINGS_FILE = join(tmpdir(), 'unused-timings.json');
    const on = (await import('../../../vitest.config.ts?timings=on')).default as any;
    const { default: TestTimingsReporter } =
      await import('../../../scripts/vitest-test-timings.mjs');
    const reporters = on.test.reporters as unknown[];
    expect(reporters.slice(0, -1)).toEqual(configDefaults.reporters);
    expect(reporters.at(-1)).toBeInstanceOf(TestTimingsReporter);
  });

  it('leaves the reporters unset when the variable is absent', async () => {
    delete process.env.GTH_TEST_TIMINGS_FILE;
    const off = (await import('../../../vitest.config.ts?timings=off')).default as any;
    expect(off.test).not.toHaveProperty('reporters');
  });

  it('is switched on for the platform cells of unit-tests.yml, with an upload that cannot fail the cell', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'unit-tests.yml'), 'utf8');
    const platforms = workflow.slice(workflow.indexOf('  test-platforms:'));
    expect(platforms).toContain('GTH_TEST_TIMINGS_FILE: ${{ runner.temp }}/test-timings.json');
    expect(platforms).toContain('path: ${{ runner.temp }}/test-timings.json');
    const upload = platforms.slice(platforms.indexOf('- name: Upload per-test timings'));
    expect(upload).toContain('if-no-files-found: warn');
    // Uploaded from a red cell too, and an artifact-service error is the step's failure, not the
    // cell's — this workflow is also the release gate.
    expect(upload).toContain('if: ${{ !cancelled() }}');
    expect(upload).toContain('continue-on-error: true');
  });
});
