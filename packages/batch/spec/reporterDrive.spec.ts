import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalCaseResult, EvalSuiteSummary } from '#src/evalTypes.js';
import type { EvalReporter, EvalRunContext } from '#src/reporters/reporterTypes.js';

const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const CTX: EvalRunContext = { suitePath: 'suite.yaml', outputDir: '/out' };

function makeSummary(): EvalSuiteSummary {
  const cases: EvalCaseResult[] = [
    { id: 'case-a', verdict: 'PASS', passThreshold: 6, sutOk: true, durationMs: 1, reasons: [] },
    { id: 'case-b', verdict: 'PASS', passThreshold: 6, sutOk: true, durationMs: 1, reasons: [] },
  ];
  return { total: 2, passed: 2, failed: 0, cases };
}

describe('driveReporters', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('drives hooks in lifecycle order: onSuiteStart → onCellResult per case (cases order) → onSuiteEnd', async () => {
    const { driveReporters } = await import('#src/reporters/drive.js');
    const calls: string[] = [];
    const reporter: EvalReporter = {
      onSuiteStart: () => {
        calls.push('start');
      },
      onCellResult: (result) => {
        calls.push(`cell:${result.id}`);
      },
      onSuiteEnd: () => {
        calls.push('end');
      },
    };

    await driveReporters([reporter], makeSummary(), CTX);

    expect(calls).toEqual(['start', 'cell:case-a', 'cell:case-b', 'end']);
  });

  it('awaits async hooks', async () => {
    const { driveReporters } = await import('#src/reporters/drive.js');
    const calls: string[] = [];
    const reporter: EvalReporter = {
      onSuiteStart: async () => {
        await Promise.resolve();
        calls.push('start');
      },
      onCellResult: async (result) => {
        await Promise.resolve();
        calls.push(`cell:${result.id}`);
      },
      onSuiteEnd: async () => {
        await Promise.resolve();
        calls.push('end');
      },
    };

    await driveReporters([reporter], makeSummary(), CTX);

    expect(calls).toEqual(['start', 'cell:case-a', 'cell:case-b', 'end']);
  });

  it('contains a throwing hook: completes, runs the remaining hooks, warns, does not throw', async () => {
    const { driveReporters } = await import('#src/reporters/drive.js');
    const calls: string[] = [];
    const reporter: EvalReporter = {
      onSuiteStart: () => {
        calls.push('start');
      },
      onCellResult: (result) => {
        calls.push(`cell:${result.id}`);
        throw new Error(`boom on ${result.id}`);
      },
      onSuiteEnd: () => {
        calls.push('end');
      },
    };

    // Must resolve (never reject) — a reporter can NOT abort the run.
    await expect(driveReporters([reporter], makeSummary(), CTX)).resolves.toBeUndefined();

    // Both cells were still attempted, and onSuiteEnd still ran despite each onCellResult throwing.
    expect(calls).toEqual(['start', 'cell:case-a', 'cell:case-b', 'end']);
    // Each thrown hook surfaced as a warning; the message names the failing hook.
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(2);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('onCellResult')
    );
  });

  it('skips missing hooks (a reporter need not implement all three)', async () => {
    const { driveReporters } = await import('#src/reporters/drive.js');
    const onSuiteEnd = vi.fn();
    const reporter: EvalReporter = { onSuiteEnd };

    await driveReporters([reporter], makeSummary(), CTX);

    expect(onSuiteEnd).toHaveBeenCalledTimes(1);
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });

  it('is phase-grouped across multiple reporters (all onSuiteStart, then per-case onCellResult, then all onSuiteEnd)', async () => {
    const { driveReporters } = await import('#src/reporters/drive.js');
    const calls: string[] = [];
    const mk = (name: string): EvalReporter => ({
      onSuiteStart: () => calls.push(`${name}:start`),
      onCellResult: (result) => calls.push(`${name}:cell:${result.id}`),
      onSuiteEnd: () => calls.push(`${name}:end`),
    });

    await driveReporters([mk('r1'), mk('r2')], makeSummary(), CTX);

    expect(calls).toEqual([
      'r1:start',
      'r2:start',
      'r1:cell:case-a',
      'r2:cell:case-a',
      'r1:cell:case-b',
      'r2:cell:case-b',
      'r1:end',
      'r2:end',
    ]);
  });
});
