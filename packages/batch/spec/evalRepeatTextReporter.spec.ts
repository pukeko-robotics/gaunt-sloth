import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalCaseResult, EvalSuiteSummary } from '#src/evalTypes.js';

const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stdout: { columns: 100 },
}));

function run(n: number, verdict: 'PASS' | 'FAIL', sutOk = true): EvalCaseResult {
  return { id: 'c1', run: n, verdict, passThreshold: 6, sutOk, durationMs: 1, reasons: [] };
}

async function linesFor(result: EvalCaseResult): Promise<string[]> {
  const { createTextReporter } = await import('#src/reporters/textReporter.js');
  const reporter = createTextReporter();
  const ctx = { suitePath: 's.yaml', outputDir: 'out' };
  await reporter.onCellResult?.(result, ctx);
  const lines: Array<[number, string]> = [];
  for (const [channel, mock] of Object.entries(consoleUtilsMock)) {
    mock.mock.calls.forEach((call, index) =>
      lines.push([mock.mock.invocationCallOrder[index], `${channel}: ${String(call[0])}`])
    );
  }
  return lines.sort((a, b) => a[0] - b[0]).map(([, line]) => line);
}

describe('BATCH-60 — the text reporter on a repeated case', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('prints the rate on the verdict row and each run on the next', async () => {
    const lines = await linesFor({
      id: 'c1',
      verdict: 'PASS',
      passThreshold: 6,
      sutOk: true,
      durationMs: 3,
      reasons: [],
      repeat: { runs: 3, passed: 2, ratePercent: 67, passRate: 0.67, requiredPercent: 67 },
      runs: [run(1, 'PASS'), run(2, 'FAIL'), run(3, 'PASS')],
    });
    expect(lines).toEqual([
      'display: PASS  c1 (2/3 runs passed, 67%, needs 67%)',
      'display:       runs 1: PASS · 2: FAIL · 3: PASS',
    ]);
  });

  it('prints a failing case with its reasons, and a run that did not finish as ERROR', async () => {
    const lines = await linesFor({
      id: 'c1',
      verdict: 'FAIL',
      passThreshold: 6,
      sutOk: false,
      durationMs: 3,
      reasons: ['1 of 3 runs did not finish (run 2)', 'run 2: SUT run failed: down'],
      repeat: { runs: 3, passed: 2, ratePercent: 67, passRate: 0.5, requiredPercent: 50 },
      runs: [run(1, 'PASS'), run(2, 'FAIL', false), run(3, 'PASS')],
    });
    expect(lines[0]).toBe('displayWarning: FAIL  c1 (2/3 runs passed, 67%, needs 50%)');
    expect(lines.some((line) => line.includes('run 2: SUT run failed: down'))).toBe(true);
    expect(lines.at(-1)).toBe('displayWarning:       runs 1: PASS · 2: ERROR · 3: PASS');
  });

  it('leaves the suite total counting cases, not runs', async () => {
    const { createTextReporter } = await import('#src/reporters/textReporter.js');
    const summary: EvalSuiteSummary = {
      total: 1,
      passed: 1,
      failed: 0,
      cases: [],
    };
    await createTextReporter().onSuiteEnd?.(summary, { suitePath: 's.yaml', outputDir: 'out' });
    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
      'EVAL RESULT: 1/1 case(s) passed. Results written to out'
    );
  });
});
