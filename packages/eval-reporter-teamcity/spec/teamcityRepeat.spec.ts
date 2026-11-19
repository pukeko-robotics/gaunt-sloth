import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalCaseResult } from '@gaunt-sloth/batch';

/** A repeated case as batch reports it, built as a plain object because this package's batch types
 * may predate the repeat fields. */
function repeatedCase(verdict: 'PASS' | 'FAIL', reasons: string[]): EvalCaseResult {
  const run = (n: number, runVerdict: 'PASS' | 'FAIL', sutOk = true) => ({
    id: 'c1',
    run: n,
    verdict: runVerdict,
    passThreshold: 6,
    sutOk,
    durationMs: 10,
    reasons: runVerdict === 'FAIL' ? ['missing "x"'] : [],
  });
  return {
    id: 'c1',
    verdict,
    passThreshold: 6,
    sutOk: true,
    durationMs: 30,
    reasons,
    repeat: { runs: 3, passed: 2, ratePercent: 67, passRate: 0.67, requiredPercent: 67 },
    runs: [run(1, 'PASS'), run(2, 'FAIL'), run(3, 'PASS')],
  } as EvalCaseResult;
}

describe('BATCH-60 — TeamCity keeps one test per repeated case', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports a passing repeated case as one test, with each run in its stdout', async () => {
    const { createTeamCityReporter } = await import('#src/teamcityReporter.js');
    const chunks: string[] = [];
    createTeamCityReporter((chunk) => chunks.push(chunk)).onCellResult?.(repeatedCase('PASS', []), {
      suitePath: 's.yaml',
      outputDir: 'out',
    });
    expect(chunks).toEqual([
      "##teamcity[testStarted name='c1']\n",
      "##teamcity[testStdOut name='c1' out='pass rate: 2/3 (67%), required 67%|nrun 1: PASS|nrun 2: FAIL — missing \"x\"|nrun 3: PASS']\n",
      "##teamcity[testFinished name='c1' duration='30']\n",
    ]);
  });

  it('leads a failing repeated case with the rate as the testFailed message', async () => {
    const { createTeamCityReporter } = await import('#src/teamcityReporter.js');
    const chunks: string[] = [];
    createTeamCityReporter((chunk) => chunks.push(chunk)).onCellResult?.(
      repeatedCase('FAIL', [
        'pass rate 2/3 (67%) is below the required 100%',
        'run 2: missing "x"',
      ]),
      { suitePath: 's.yaml', outputDir: 'out' }
    );
    const started = chunks.filter((chunk) => chunk.startsWith('##teamcity[testStarted'));
    expect(started).toHaveLength(1);
    const failed = chunks.find((chunk) => chunk.startsWith('##teamcity[testFailed'));
    expect(failed).toContain("message='pass rate 2/3 (67%) is below the required 100%'");
  });

  it('labels a run that did not finish ERROR in the test output', async () => {
    const { createTeamCityReporter } = await import('#src/teamcityReporter.js');
    const result = repeatedCase('FAIL', [
      '1 of 3 runs did not finish (run 2)',
    ]) as EvalCaseResult & {
      runs: Array<EvalCaseResult & { run: number }>;
    };
    result.sutOk = false;
    result.runs[1] = { ...result.runs[1], sutOk: false, reasons: ['SUT run failed: down'] };
    const chunks: string[] = [];
    createTeamCityReporter((chunk) => chunks.push(chunk)).onCellResult?.(result, {
      suitePath: 's.yaml',
      outputDir: 'out',
    });
    const stdout = chunks.find((chunk) => chunk.startsWith('##teamcity[testStdOut'));
    expect(stdout).toContain('|nrun 2: ERROR — SUT run failed: down|n');
  });
});
