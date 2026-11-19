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

/**
 * The largest `repeat` a suite may declare. Every run is a full agent run plus its judge calls, so
 * a typo such as `repeat: 1000` would multiply a suite's cost a thousandfold before anyone noticed.
 * A hundred runs already resolves a pass rate to the whole percent the report prints.
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
