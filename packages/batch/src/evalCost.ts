/**
 * BATCH-65 — summing and printing the cost an agent reports for its own runs.
 *
 * gaunt-sloth computes no cost for any model: there is no reliable price list, which is why core's
 * run stats carry none. A `command` target's decoder can still read the figure the agent printed
 * about its own run (Claude Code's `total_cost_usd`), and that is a fact, not a price. Everything
 * here carries it through and labels it as the agent's, so nobody reads it as gaunt-sloth's
 * estimate.
 *
 * ## Why a sum is rounded to its inputs' precision
 *
 * Binary floating point turns `0.1 + 0.2` into `0.30000000000000004`. Writing that into
 * `results.json` or printing it would invent digits the agent never reported. A sum is therefore
 * rounded to the most decimal places any one input had, which is exact for every input that was
 * itself a finite decimal and never drops a digit an input carried. Nothing is rounded to cents: a
 * single short run can cost a fraction of a cent, and the agent's own figure is what is printed.
 *
 * ## Why a total says how many cases it covers
 *
 * A case has a cost only when its agent reported one (and a repeated case only when every run did).
 * A total over 3 of 7 cases is not the suite's cost, so the line names its coverage, and it is not
 * printed at all when no case has a cost, so every suite whose agent reports nothing keeps its
 * exact output.
 *
 * @module
 */
import type { EvalCaseResult } from '#src/evalTypes.js';

/** How many digits follow the decimal point in `value`'s shortest representation. */
function decimalPlaces(value: number): number {
  const [mantissa, exponent] = String(value).split('e');
  const fraction = mantissa.split('.')[1]?.length ?? 0;
  // `toFixed` accepts at most 100 places; no reported cost comes near that.
  return Math.min(100, Math.max(0, fraction - Number(exponent ?? 0)));
}

/**
 * Sum reported costs, rounded to the most decimal places any one of them had (see the module
 * docblock). Every value must already be a finite, non-negative number; the decoder seam and the
 * runner guarantee that before a cost reaches a case.
 */
export function sumReportedCosts(values: readonly number[]): number {
  const places = values.reduce((most, value) => Math.max(most, decimalPlaces(value)), 0);
  const sum = values.reduce((total, value) => total + value, 0);
  return Number(sum.toFixed(places));
}

/**
 * The cost of a repeated case: the sum over its runs, present ONLY when every run reported one. A
 * sum over the runs that happened to report would understate the case without saying so, and the
 * case's total would then understate the suite's.
 */
export function repeatedCaseCost(runs: readonly EvalCaseResult[]): number | undefined {
  const costs: number[] = [];
  for (const run of runs) {
    if (run.costUsd === undefined) return undefined;
    costs.push(run.costUsd);
  }
  return costs.length > 0 ? sumReportedCosts(costs) : undefined;
}

/** Options for {@link renderReportedCost}. */
export interface RenderReportedCostOptions {
  /** `'TOTAL'` for the run-level line printed beside `EVAL TOTAL:`, so it is never read as one
   * suite's figure. */
  scope?: string;
}

/**
 * The one line that reports what the agent said the cases cost, or `undefined` when no case has a
 * cost, in which case nothing is printed. The amount is printed with exactly the decimal places it
 * has, never in exponent notation and never rounded to cents.
 */
export function renderReportedCost(
  cases: readonly EvalCaseResult[],
  options: RenderReportedCostOptions = {}
): string | undefined {
  const costs = cases
    .map((result) => result.costUsd)
    .filter((cost): cost is number => cost !== undefined);
  if (costs.length === 0) return undefined;
  const total = sumReportedCosts(costs);
  const headline = options.scope ? `COST ${options.scope}` : 'COST';
  // The same noun rule as `EVAL RESULT:`: an identity matrix counts cells, not cases.
  const noun = cases.some((result) => result.identity !== undefined) ? 'cell(s)' : 'case(s)';
  return (
    `${headline} (reported by agent): ${total.toFixed(decimalPlaces(total))} USD ` +
    `for ${costs.length} of ${cases.length} ${noun}`
  );
}
