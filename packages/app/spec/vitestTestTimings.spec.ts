import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDefaults } from 'vitest/config';

/**
 * OPS-122 — the per-test timing instrument (`scripts/vitest-test-timings.mjs`).
 *
 * It is how the Ink render specs' headroom on the Windows unit cell is measured, so the two things
 * worth pinning are that it records each test against the timeout THAT test ran under, and that it
 * cannot change the run it measures: it adds to vitest's reporters rather than replacing them, and
 * a failure to write its file is reported and swallowed rather than thrown.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** The slice of vitest's TestCase the reporter reads. */
function testCase(
  file: string,
  fullName: string,
  options: { duration: number; startTime: number; timeout?: number; state?: string }
) {
  return {
    module: { moduleId: join(ROOT, file) },
    fullName,
    options: { timeout: options.timeout },
    result: () => ({ state: options.state ?? 'passed' }),
    diagnostic: () => ({
      duration: options.duration,
      startTime: options.startTime,
      retryCount: 0,
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
        retryCount: 0,
      },
    ]);
  });

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
    expect(platforms).toContain('if-no-files-found: warn');
  });
});
