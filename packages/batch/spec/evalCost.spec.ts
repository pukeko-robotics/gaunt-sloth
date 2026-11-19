import { describe, expect, it } from 'vitest';
import { renderReportedCost, repeatedCaseCost, sumReportedCosts } from '#src/evalCost.js';
import { foldRepeatedRuns } from '#src/evalRepeat.js';
import type { EvalCaseResult } from '#src/evalTypes.js';

// BATCH-65 — summing and printing the cost an agent reports for its own runs.

function result(id: string, costUsd?: number, extra: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    id,
    verdict: 'PASS',
    passThreshold: 6,
    sutOk: true,
    durationMs: 1,
    reasons: [],
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...extra,
  };
}

describe('sumReportedCosts', () => {
  it('adds without the floating-point digits no agent reported', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumReportedCosts([0.1, 0.2])).toBe(0.3);
    expect(sumReportedCosts([0.2107308, 0.2107308, 0.2107308])).toBe(0.6321924);
  });

  it('never drops a digit an input carried', () => {
    expect(sumReportedCosts([0.0000001, 1])).toBe(1.0000001);
    expect(sumReportedCosts([1, 2])).toBe(3);
    expect(sumReportedCosts([0])).toBe(0);
  });
});

describe('repeatedCaseCost', () => {
  it('is the sum over the runs when every run reported a cost', () => {
    expect(repeatedCaseCost([result('a', 0.1), result('a', 0.2)])).toBe(0.3);
  });

  it('is absent when any one run reported none, so the case never understates silently', () => {
    expect(repeatedCaseCost([result('a', 0.1), result('a'), result('a', 0.2)])).toBeUndefined();
  });
});

describe('foldRepeatedRuns — cost', () => {
  it("puts the runs' summed cost on the case and keeps each run's own", () => {
    const folded = foldRepeatedRuns([result('a', 0.1), result('a', 0.2)], 1);
    expect(folded.costUsd).toBe(0.3);
    expect(folded.runs!.map((run) => run.costUsd)).toEqual([0.1, 0.2]);
  });

  it('leaves the case without a cost when one run reported none', () => {
    const folded = foldRepeatedRuns([result('a', 0.1), result('a')], 1);
    expect('costUsd' in folded).toBe(false);
  });

  it('adds no cost key to a case whose runs reported none', () => {
    const folded = foldRepeatedRuns([result('a'), result('a')], 1);
    expect(Object.keys(folded)).not.toContain('costUsd');
  });
});

describe('renderReportedCost', () => {
  it("prints the total, labelled as the agent's figure, with how many cases it covers", () => {
    expect(renderReportedCost([result('a', 0.1), result('b'), result('c', 0.2)])).toBe(
      'COST (reported by agent): 0.3 USD for 2 of 3 case(s)'
    );
  });

  it('prints the amount with its own decimals, not rounded to cents and not as an exponent', () => {
    expect(renderReportedCost([result('a', 0.0000001)])).toBe(
      'COST (reported by agent): 0.0000001 USD for 1 of 1 case(s)'
    );
    expect(renderReportedCost([result('a', 0)])).toBe(
      'COST (reported by agent): 0 USD for 1 of 1 case(s)'
    );
  });

  it('prints nothing when no case reported a cost', () => {
    expect(renderReportedCost([result('a'), result('b')])).toBeUndefined();
    expect(renderReportedCost([])).toBeUndefined();
  });

  it('names its scope for the run-level total', () => {
    expect(renderReportedCost([result('a', 1.5)], { scope: 'TOTAL' })).toBe(
      'COST TOTAL (reported by agent): 1.5 USD for 1 of 1 case(s)'
    );
  });

  it('counts cells for an identity matrix, as EVAL RESULT does', () => {
    expect(renderReportedCost([result('a', 1, { identity: 'admin' })])).toBe(
      'COST (reported by agent): 1 USD for 1 of 1 cell(s)'
    );
  });
});
