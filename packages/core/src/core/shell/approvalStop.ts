/**
 * @module core/shell/approvalStop
 *
 * CFG-27 — the two ways the approvals gate **ends a run** rather than answering a tool call.
 * Both are thrown from `GthAgentRunner.decideToolApproval`, both carry the command and the reason
 * a person needs to see, and both are re-thrown UNCHANGED by `processMessages` (which otherwise
 * wraps failures as `Agent processing failed: …`) so the explanation reaches the user intact.
 *
 * They are errors rather than {@link ../types.js ToolApprovalDecision}s on purpose. A decision is
 * something the model observes as a `ToolMessage` and can respond to; these two are precisely the
 * cases where the spec says the model gets no move at all:
 *
 * - **{@link ExfiltrationHaltError}** (§4.2) — an `exfiltration` outcome *halts the run*. "A halt
 *   ends the agent loop. It is not a rejection the model can respond to, and no rung except
 *   `bypass` can turn it into anything else."
 * - **{@link NonInteractiveEscalationError}** (§6.2) — where no human can answer, *every*
 *   escalation is an immediate non-zero exit carrying the command, the rating and its reason.
 *   There is no prompt, no waiting, and never a timeout into approval. Teams that need specific
 *   commands to run unattended declare them in `approvals.allow` (§3), which is consulted before
 *   the rater and therefore never escalates.
 *
 * Exit code: neither class sets one. The single-shot runtime (`runSingleShot`) already reports a
 * thrown run as `ok: false`, and each command entry point turns that into `setExitCode(1)` — so
 * "immediate non-zero exit carrying the explanation" is what a caller already gets, without a new
 * exit path that could diverge from the existing one.
 */

/**
 * Base class for the two run-ending approvals outcomes, so a caller can catch both with one
 * `instanceof` (the TUI does this to render them as an ending rather than a crash).
 */
export abstract class ApprovalStopError extends Error {
  /** The command that ended the run. */
  readonly command: string;

  protected constructor(message: string, command: string) {
    super(message);
    this.command = command;
    // Restore the prototype chain across the ES5 `extends Error` downlevel, so `instanceof` works.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * §4.2 — an `exfiltration` outcome. Ends the agent loop; the model is told nothing and offered
 * nothing. [[TUI-C26]] will present this interactively as the §6.1 red banner (`s` stop / `b`
 * bypass this one command) BEFORE the throw; until then the run simply ends with this message.
 */
export class ExfiltrationHaltError extends ApprovalStopError {
  /** The rater's explanation of what the command would send where. */
  readonly reason: string;

  constructor(command: string, reason: string) {
    super(
      `Run halted: the auto-rater rated this command as exfiltration, which ends the run.\n` +
        `  Command: ${command}\n` +
        `  Reason: ${reason}\n` +
        `This is not negotiable at any rung except bypass. If you genuinely need this operation, ` +
        `re-run at approvals "bypass" and accept the risk.`,
      command
    );
    this.reason = reason;
  }
}

/**
 * §6.2 — an escalation with nobody to ask (CI, one-shot runs, servers). Fails the build loudly,
 * with everything a person needs in order to see why.
 */
export class NonInteractiveEscalationError extends ApprovalStopError {
  /** The rater's outcome, when a rating existed (the unrated rungs have none). */
  readonly outcome: string | undefined;
  /** The rater's explanation, when a rating existed. */
  readonly reason: string | undefined;

  constructor(command: string, outcome?: string, reason?: string) {
    super(
      `Approval required, but this session has no one to ask.\n` +
        `  Command: ${command}\n` +
        (outcome ? `  Rating: ${outcome}\n` : '') +
        (reason ? `  Reason: ${reason}\n` : '') +
        `Declare the commands this run is allowed to execute in approvals.allow — that list is ` +
        `consulted before the auto-rater and never escalates.`,
      command
    );
    this.outcome = outcome;
    this.reason = reason;
  }
}
