/**
 * BATCH-60 — repeating an eval case N times and passing it at a set rate.
 *
 * Behaviour under a prompt is probabilistic, so one green run proves little. A case with
 * `repeat: N` runs N independent times and passes when enough of those runs pass:
 *
 *     round(100 × passes / N) ≥ round(100 × pass_rate)
 *
 * ## Why the rate is compared in whole percents
 *
 * The comparison is made on the number the report prints, never on the raw fraction. An author
 * reads `2/3, 67%` and writes `pass_rate: 0.67`; a float comparison would then FAIL the case,
 * because 2/3 = 0.666… < 0.67, while the report beside it says 67% against a required 67%. A
 * verdict that contradicts its own printed numbers is worse than either rounding choice, so both
 * sides are rounded to whole percents (half up) and compared as integers. `pass_rate: 0.68` with 2
 * of 3 still fails: 67 < 68.
 *
 * ## Why a harness error in any one run makes the whole case a harness error
 *
 * A run that did not finish is not evidence about the agent. Computing the rate over the runs that
 * happened to finish would quietly turn an infrastructure failure into a pass rate (two of two
 * "finished" runs passing reads as 100%), so the case is reported as a harness error instead:
 * `sutOk: false`, exactly like a single run whose SUT could not run. The other runs' detail is
 * still reported, in the case's `runs`.
 */

import { repeatedCaseCost } from '#src/evalCost.js';
import type { EvalCaseResult, EvalRepeatSummary } from '#src/evalTypes.js';

/**
 * The largest `repeat` a suite may declare. Every run is a full agent run plus its judge calls, so
 * a typo such as `repeat: 1000` would multiply a suite's cost a thousandfold before anyone noticed.
 * A hundred runs already resolves a pass rate to the whole percent the report prints.
 *
 * **The cap also carries the meaning of two rules.** For every n up to it, (n−1)/n must round
 * BELOW 100% and 1/n must round ABOVE 0%. That is what makes `pass_rate: 1` mean "every run passed"
 * and a BROKE rate in `--compare-to` mean "no run passed". (n−1)/n rounds to 100% from n = 200,
 * and 1/n to 0% from n = 201, so a cap of 200 or more would let one failing run pass a `pass_rate: 1` case and
 * call a case that still passes once BROKE. `evalRepeat.spec.ts` checks both for every n up to the
 * cap; raise the cap only with a rule that keeps them true.
 */
export const MAX_EVAL_REPEAT = 100;

/**
 * A fraction as a whole percent, rounded half up.
 *
 * The product is first cut to nine decimal places so binary floating point cannot move a value
 * across a half: `0.145 * 100` is `14.499999999999998` in IEEE doubles, and an author who wrote
 * `0.145` means 14.5%, which rounds to 15.
 */
export function toWholePercent(fraction: number): number {
  return Math.round(Number((fraction * 100).toFixed(9)));
}

/** The whole percent of `runs` that passed, as the report prints it. */
export function passRatePercent(passed: number, runs: number): number {
  return toWholePercent(passed / runs);
}

/**
 * Does a case with `passed` of `runs` passing meet `passRate`? Both sides are compared in whole
 * percents — see the module comment for why a raw float comparison is the wrong one.
 */
export function meetsPassRate(passed: number, runs: number, passRate: number): boolean {
  return passRatePercent(passed, runs) >= toWholePercent(passRate);
}

/**
 * Fold the graded runs of one repeated (case × identity) cell into the single result the cell
 * reports. Each run was graded on its own (its own checks, its own judge call); this decides the
 * case from them.
 *
 * - A harness error in ANY run (`sutOk: false`) makes the case a harness error, `sutOk: false` and
 *   FAIL, with no rate verdict. See the module comment for why the finished runs are not rated on
 *   their own. The exit code then follows the existing rule (`classifyEvalExit`): 2 when every
 *   case of the suite is a harness error, else 1.
 * - Otherwise the case passes iff {@link meetsPassRate}.
 *
 * The first reason is the headline a one-line reader (a JUnit `message`) shows: the rate against
 * the requirement, or which runs did not finish. Every failing run's own reasons follow, prefixed
 * `run <k>: `. A passing case has no reasons, as for a single run; its failing runs are still in
 * `runs`.
 */
export function foldRepeatedRuns(graded: EvalCaseResult[], passRate: number): EvalCaseResult {
  const first = graded[0];
  const runs: EvalCaseResult[] = graded.map(({ id, identity, ...rest }, index) => ({
    id,
    ...(identity !== undefined ? { identity } : {}),
    run: index + 1,
    ...rest,
  }));
  const passed = runs.filter((run) => run.verdict === 'PASS').length;
  const repeat: EvalRepeatSummary = {
    runs: runs.length,
    passed,
    ratePercent: passRatePercent(passed, runs.length),
    passRate,
    requiredPercent: toWholePercent(passRate),
  };

  const unfinished = runs.filter((run) => !run.sutOk);
  const sutOk = unfinished.length === 0;
  const verdict: 'PASS' | 'FAIL' =
    sutOk && meetsPassRate(passed, runs.length, passRate) ? 'PASS' : 'FAIL';

  const reasons: string[] = [];
  if (!sutOk) {
    reasons.push(
      `${unfinished.length} of ${runs.length} runs did not finish ` +
        `(${unfinished.map((run) => `run ${run.run}`).join(', ')}), so no pass rate was computed: ` +
        'a run that did not finish is not evidence about the agent.'
    );
  } else if (verdict === 'FAIL') {
    reasons.push(
      `pass rate ${passed}/${runs.length} (${repeat.ratePercent}%) is below the required ` +
        `${repeat.requiredPercent}%`
    );
  }
  if (verdict === 'FAIL') {
    for (const run of runs) {
      if (run.verdict === 'PASS') continue;
      for (const reason of run.reasons) reasons.push(`run ${run.run}: ${reason}`);
    }
  }

  // BATCH-65 — unlike the other single-run fields, cost is summed onto the case, because it is
  // additive and a reader wants the case's spend. Present only when every run reported one.
  const costUsd = repeatedCaseCost(runs);
  return {
    id: first.id,
    ...(first.identity !== undefined ? { identity: first.identity } : {}),
    passThreshold: first.passThreshold,
    durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    ...(costUsd !== undefined ? { costUsd } : {}),
    verdict,
    sutOk,
    reasons,
    ...(first.tags !== undefined ? { tags: first.tags } : {}),
    repeat,
    runs,
  };
}
