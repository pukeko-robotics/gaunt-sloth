import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalCaseResult, EvalSuiteSummary } from '#src/evalTypes.js';

/** A case that ran once. */
function single(id: string, verdict: 'PASS' | 'FAIL', sutOk = true): EvalCaseResult {
  return { id, verdict, passThreshold: 6, sutOk, durationMs: 1, reasons: [] };
}

/** A repeated case with `passed` of `runs` passing; its verdict is irrelevant to flaky/broke. */
function repeated(id: string, passed: number, runs: number, sutOk = true): EvalCaseResult {
  const ratePercent = Math.round((100 * passed) / runs);
  return {
    id,
    verdict: ratePercent >= 67 ? 'PASS' : 'FAIL',
    passThreshold: 6,
    sutOk,
    durationMs: runs,
    reasons: [],
    repeat: { runs, passed, ratePercent, passRate: 0.67, requiredPercent: 67 },
    runs: Array.from({ length: runs }, (_, index) => ({
      ...single(id, index < passed ? 'PASS' : 'FAIL'),
      run: index + 1,
    })),
  };
}

function summary(cases: EvalCaseResult[]): EvalSuiteSummary {
  const passed = cases.filter((c) => c.verdict === 'PASS').length;
  return { total: cases.length, passed, failed: cases.length - passed, cases };
}

describe('BATCH-60 — --compare-to tells flaky from broke', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('classifies a rate that fell but stayed above zero as flaky', async () => {
    const { diffRuns, renderRunDiff } = await import('#src/evalCompare.js');
    const diff = diffRuns(summary([repeated('a', 3, 3)]), summary([repeated('a', 1, 3)]));
    expect(diff.flaky).toEqual([{ id: 'a', before: '3/3 (100%)', after: '1/3 (33%)' }]);
    expect(diff.broke).toEqual([]);
    const rendered = renderRunDiff(diff);
    expect(rendered).toContain('  FLAKY (1):');
    expect(rendered).toContain('    a: 3/3 (100%) → 1/3 (33%)');
    expect(rendered).not.toContain('  no change.');
  });

  it('prints a FLAKY-only diff (verdict PASS on both sides) without "no change."', async () => {
    const { diffRuns, renderRunDiff } = await import('#src/evalCompare.js');
    // 3/3 → 2/3 at 0.67: the case still passes, so nothing is REGRESSED. The FLAKY list is the
    // only thing that can keep "no change." off the page.
    const before = repeated('a', 3, 3);
    const after = repeated('a', 2, 3);
    expect([before.verdict, after.verdict]).toEqual(['PASS', 'PASS']);
    const diff = diffRuns(summary([before]), summary([after]));
    expect(diff.regressed).toEqual([]);
    const rendered = renderRunDiff(diff);
    expect(rendered).toContain('  FLAKY (1):');
    expect(rendered).toContain('    a: 3/3 (100%) → 2/3 (67%)');
    expect(rendered).not.toContain('  no change.');
  });

  it('lists no reclassification when a classified single run is compared with a repeated one', async () => {
    const { diffRuns } = await import('#src/evalCompare.js');
    const classified: EvalCaseResult = {
      ...single('a', 'PASS'),
      classification: { expectedLabel: 'safe', actualLabel: 'safe' },
    };
    const diff = diffRuns(summary([classified]), summary([repeated('a', 3, 3)]));
    expect(diff.reclassified).toEqual([]);
    // The control: two single runs whose labels differ ARE listed, so the empty list above is the
    // gate at work and not a fixture that could never reclassify.
    const moved: EvalCaseResult = {
      ...single('a', 'PASS'),
      classification: { expectedLabel: 'safe', actualLabel: 'risky' },
    };
    expect(diffRuns(summary([classified]), summary([moved])).reclassified).toEqual([
      { id: 'a', before: 'safe', after: 'risky' },
    ]);
  });

  it('renders a RunDiff that predates flaky and broke', async () => {
    const { diffRuns, renderRunDiff } = await import('#src/evalCompare.js');
    const diff = diffRuns(summary([single('a', 'PASS')]), summary([single('a', 'PASS')]));
    const older = { ...diff } as Partial<typeof diff>;
    delete older.flaky;
    delete older.broke;
    expect(renderRunDiff(older as typeof diff)).toContain('  no change.');
  });

  it('classifies a rate that fell to zero as broke', async () => {
    const { diffRuns, renderRunDiff } = await import('#src/evalCompare.js');
    const diff = diffRuns(summary([repeated('a', 2, 3)]), summary([repeated('a', 0, 3)]));
    expect(diff.broke).toEqual([{ id: 'a', before: '2/3 (67%)', after: '0/3 (0%)' }]);
    expect(diff.flaky).toEqual([]);
    expect(renderRunDiff(diff)).toContain('  BROKE (1):');
  });

  it('puts an unchanged rate in neither list, and reports no change', async () => {
    const { diffRuns, renderRunDiff } = await import('#src/evalCompare.js');
    const diff = diffRuns(summary([repeated('a', 2, 3)]), summary([repeated('a', 2, 3)]));
    expect(diff.flaky).toEqual([]);
    expect(diff.broke).toEqual([]);
    expect(renderRunDiff(diff)).toContain('  no change.');
  });

  it('puts an improved rate in neither list', async () => {
    const { diffRuns } = await import('#src/evalCompare.js');
    const diff = diffRuns(summary([repeated('a', 1, 3)]), summary([repeated('a', 3, 3)]));
    expect(diff.flaky).toEqual([]);
    expect(diff.broke).toEqual([]);
  });

  it('compares a repeated run with a single-run baseline, which counts as 100% or 0%', async () => {
    const { diffRuns } = await import('#src/evalCompare.js');
    const diff = diffRuns(
      summary([single('a', 'PASS'), single('b', 'PASS')]),
      summary([repeated('a', 2, 3), repeated('b', 0, 3)])
    );
    expect(diff.flaky).toEqual([{ id: 'a', before: '1/1 (100%)', after: '2/3 (67%)' }]);
    expect(diff.broke).toEqual([{ id: 'b', before: '1/1 (100%)', after: '0/3 (0%)' }]);
  });

  it('compares a single run with a repeated baseline', async () => {
    const { diffRuns } = await import('#src/evalCompare.js');
    const diff = diffRuns(summary([repeated('a', 3, 3)]), summary([single('a', 'FAIL')]));
    expect(diff.broke).toEqual([{ id: 'a', before: '3/3 (100%)', after: '0/1 (0%)' }]);
  });

  it('leaves two single runs to REGRESSED alone, so a diff without repeats is unchanged', async () => {
    const { diffRuns } = await import('#src/evalCompare.js');
    const diff = diffRuns(summary([single('a', 'PASS')]), summary([single('a', 'FAIL')]));
    expect(diff.regressed).toEqual([{ id: 'a', before: 'PASS', after: 'FAIL' }]);
    expect(diff.flaky).toEqual([]);
    expect(diff.broke).toEqual([]);
  });

  it('does not rate a harness error on either side', async () => {
    const { diffRuns } = await import('#src/evalCompare.js');
    const diff = diffRuns(summary([repeated('a', 3, 3)]), summary([repeated('a', 0, 3, false)]));
    expect(diff.flaky).toEqual([]);
    expect(diff.broke).toEqual([]);
  });

  it('reads judge drift off the weakest run of a repeated case', async () => {
    const { diffRuns } = await import('#src/evalCompare.js');
    const judged = (rate: number) => ({
      attempted: true,
      ok: true,
      verdict: { rate, reason: 'r' },
    });
    const before = repeated('a', 2, 2);
    before.runs = before.runs!.map((run) => ({ ...run, judge: judged(9) }));
    const after = repeated('a', 2, 2);
    after.runs = after.runs!.map((run, index) => ({ ...run, judge: judged(index === 0 ? 9 : 5) }));
    const diff = diffRuns(summary([before]), summary([after]));
    expect(diff.judgeDrift).toEqual([
      expect.objectContaining({ id: 'a', before: 9, after: 5, reason: 'crossed' }),
    ]);
  });
});
