/**
 * @module core/shell/raterHealth
 *
 * [[EXT-82]] — **a rater that answers nothing is indistinguishable from a very cautious one.**
 *
 * {@link import('./rater.js').failClosedVerdict} makes ONE failed rating explicable: the verdict
 * now carries the provider's own account of why the call never reached the model. That is enough to
 * understand an occurrence and not enough to understand a session. Pointed at a model whose
 * provider refuses the shape the rater must send, every call fails, every verdict is `destructive`,
 * every explanation is identical, and the user concludes the gate is broken or unbearably noisy and
 * turns it off. The one conclusion the output does not support is the true one — that their model
 * choice cannot answer the question at all.
 *
 * This module owns the second half: **the rate**, reported once.
 *
 * ## Three properties, and each of them is a decision
 *
 * 1. **It measures consecutive failures, not a total.** A rater that fails on one command and
 *    answers on the next is a different situation — a flaky call, not a broken configuration — and
 *    a signal that latched on the first failure would report the broken case and the flaky one with
 *    the same sentence. Any real verdict resets the run to zero.
 * 2. **It fires at most once per session.** The signal is about a standing condition; repeating it
 *    per call is how a warning becomes furniture. What licenses the low threshold is exactly this
 *    cap: over-warning costs one line for the life of the session, so there is no reason to make
 *    the user wait.
 * 3. **It says only what the counter proves.** The counter knows that the last N calls failed. It
 *    does not know that every call this session failed, and the message must not claim it.
 *
 * ## Nothing here may leak
 *
 * The signal is text a user pastes into an issue. It names the rater MODEL (an id and a provider
 * type, from `raterModelLabel` — never the instance, never a key) and the failure clause built by
 * {@link import('./rater.js').renderRaterCallFailure}, which is sanitised where it is constructed.
 * It never names the rated command, and there is deliberately no parameter through which it could:
 * {@link RaterHealth.record} is not given one.
 */

import type { FailClosedCause, RaterCallFailure } from '#src/core/shell/rater.js';
import { renderRaterCallFailure } from '#src/core/shell/rater.js';

/**
 * How many CONSECUTIVE failed rating calls raise the session-level signal.
 *
 * **Three, and the number is an error-cost argument in both directions.**
 *
 * - *Warning too late costs the whole session.* The measured incident failed all 27 calls; a
 *   threshold a user's session never reaches is a diagnostic nobody ever receives, and this node
 *   exists because the user's reasonable conclusion — "the gate is broken, turn it off" — is
 *   reached within a handful of commands.
 * - *Warning too early costs one line, once.* One failure is a blip and two consecutive can still
 *   be one bad minute on a network; three consecutive with no interleaved success is a standing
 *   condition rather than weather. Because the signal is capped at one per session, a wrong fire
 *   costs a single sentence and never becomes noise — which is what makes the low number safe, and
 *   the reason a higher one buys nothing.
 *
 * Exported so the tests drive the threshold rather than restating it, and so a session that wants
 * to reason about the number has one place to read it.
 */
export const RATER_FAILURE_SIGNAL_THRESHOLD = 3;

/** One rating call, as the tracker needs to see it. */
export interface RaterCallReport {
  /**
   * The cause the gate recorded, or `undefined` when the model actually answered.
   *
   * **Read from the call's own capture, never from the verdict's text.** `isFailClosed` keys on a
   * reason prefix the rater is itself instructed to produce ("say in your explanation that you
   * could not assess it"), so a model that follows that instruction would be counted as a gate
   * failure. The capture records what the gate DID.
   */
  failClosed?: FailClosedCause;
  /** [[EXT-82]] — the provider's account, when the failure was a rejected call. */
  failure?: RaterCallFailure;
  /** The rater model's label, for naming it in the signal. */
  model?: string;
  /**
   * Whether a FAILURE on this call counts toward the rate. Defaults to true.
   *
   * §3.2's tripwire path passes false: on an `approvals.allow` match the rating is advisory and the
   * command runs on the human's standing grant either way, so a failed tripwire rating did not make
   * any verdict default — and the signal's claim that they are would be false. A SUCCESS always
   * resets regardless of the path, because a rater that answered is a rater that works and the
   * asymmetry can only ever make this signal fire less.
   */
  countsTowardRate?: boolean;
}

/**
 * The consecutive-failure tracker for ONE session.
 *
 * **An instance, never module state.** The ACP surface serves several sessions from one process,
 * each with its own runner; a shared counter would let one session's broken rater raise the signal
 * in another's, and the reset half would be meaningless because a healthy session would keep
 * clearing a broken one's run.
 */
export class RaterHealth {
  private consecutiveFailures = 0;
  private signalled = false;

  /**
   * Record one rating call.
   *
   * @returns the session-level signal the single time the rate is first met, and `undefined` every
   *   other time — including every subsequent failure once it has fired.
   */
  record(report: RaterCallReport): string | undefined {
    if (report.failClosed === undefined) {
      this.consecutiveFailures = 0;
      return undefined;
    }
    if (report.countsTowardRate === false) return undefined;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < RATER_FAILURE_SIGNAL_THRESHOLD || this.signalled) {
      return undefined;
    }
    this.signalled = true;
    return buildRaterFailureSignal(this.consecutiveFailures, report);
  }
}

/** The failure clause, one spelling per cause, for the session-level signal. */
function causeClause(report: RaterCallReport): string {
  switch (report.failClosed) {
    case 'threw':
      return report.failure ? renderRaterCallFailure(report.failure) : 'the calls failed';
    case 'timeout':
      return 'the rater did not answer within its timeout';
    case 'unparseable':
      return 'the rater returned output that did not match the verdict schema';
    case 'no-model':
      return 'no usable rater model is configured';
    default:
      return 'the calls failed';
  }
}

/**
 * The signal's wording.
 *
 * Two sentences are load-bearing rather than decorative. *"The model was never asked"* is the one
 * statement the old output could not support and the whole reason this node exists. The
 * `approvals.rater` pointer is what makes the notice actionable: a model that cannot return the
 * rater's structured output fails every call, and the fix is a different rater — not a different
 * command, which is what the user would otherwise go looking for.
 */
function buildRaterFailureSignal(failures: number, report: RaterCallReport): string {
  const model = report.model ? ` to ${report.model}` : '';
  return (
    `The command safety rater is not answering: the last ${failures} rating calls${model} all failed ` +
    `— ${causeClause(report)}. The model was never asked, so those verdicts are the gate defaulting ` +
    `to "could not assess" rather than a judgement about the commands. Check approvals.rater and ` +
    `the model behind it; a model that cannot return the rater's structured output fails every ` +
    `call. This notice appears once per session.`
  );
}
