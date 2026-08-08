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
 * - **{@link AttackHaltError}** (§4.2) — an `attack` outcome *halts the run*. "A halt ends the
 *   agent loop. It is not a rejection the model can respond to, and no rung except `bypass` can
 *   turn it into anything else."
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
 * Base class for the two run-ending approvals outcomes, so a caller that wants to present them as
 * an ending rather than a crash can catch both with one `instanceof`. Nothing does that today —
 * every surface currently shows the message as-is, which is already the whole explanation — and
 * [[TUI-C26]] is the node that will catch it to render the §6.1 banner.
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
 * §4.2 — an `attack` outcome: the command's own **structure** evidenced compromise (§4.1.1 —
 * credential targeting, privilege escalation, persistence, deception, obfuscation). Ends the agent
 * loop; the model is told nothing and offered nothing.
 *
 * [[TUI-C26]] will present this interactively as the §6.1 red banner — any key stops, typing
 * `run anyway` runs this one command — BEFORE the throw; until then the run simply ends with this
 * message, which is what a non-interactive session gets either way (§6.2).
 *
 * The recovery this message names is deliberately the **allow-list**, not `bypass`. §4.2 makes
 * `approvals.allow` the supported way to run such a command unattended (it is consulted before the
 * rater, so it never reaches a halt at all); `bypass` also works and is far blunter — it turns off
 * the rater, the escalation and the halt together, for every command, for the whole run. It is a
 * last resort, not the answer, and the wording says so in that order.
 */
export class AttackHaltError extends ApprovalStopError {
  /** The rater's explanation of what the command's structure showed. */
  readonly reason: string;

  constructor(command: string, reason: string) {
    super(
      `Run halted: the auto-rater rated this command as an attack, which ends the run.\n` +
        `  Command: ${command}\n` +
        `  Reason: ${reason}\n` +
        `This is not negotiable. If this command is legitimate and you need it to run, declare ` +
        `it in approvals.allow — that list is consulted before the auto-rater, so it never ` +
        `reaches a halt. Dropping to approvals "bypass" also works, but it turns off the rater, ` +
        `the prompts and the halt for every command in the run.`,
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
  /**
   * EXT-71 §3.2 — the declared `approvals.escalate` entry that sent this call to a human, when one
   * did. It changes the recovery the message names: pointing someone at `approvals.allow` when they
   * themselves wrote an escalate entry sends them to a list that cannot win, since a match on
   * `escalate` outranks a match on `allow`.
   */
  readonly escalatedBy: string | undefined;

  /**
   * [[EXT-29]] §6 — the §5 negotiation that preceded this escalation, rendered, when there was one.
   *
   * §6.2's message is the ONLY thing a person sees on this path — there is no prompt to attach a
   * transcript to — so an unattended run that ended after three rejections would otherwise report
   * the last command and give no hint that the agent had already been told twice what to fix.
   */
  readonly negotiation: string | undefined;

  constructor(
    command: string,
    outcome?: string,
    reason?: string,
    escalatedBy?: string,
    negotiation?: string
  ) {
    super(
      `Approval required, but this session has no one to ask.\n` +
        `  Command: ${command}\n` +
        (outcome ? `  Rating: ${outcome}\n` : '') +
        (reason ? `  Reason: ${reason}\n` : '') +
        (negotiation ? `${negotiation}\n` : '') +
        (escalatedBy
          ? `  Matched approvals.escalate: ${escalatedBy}\n` +
            `An escalate entry always asks a human, whatever the rung would have done, so no ` +
            `entry in approvals.allow can answer it. Remove the escalate entry if this command ` +
            `should run unattended.`
          : `Declare the commands this run is allowed to execute in approvals.allow — write each ` +
            `one as an explicit entry, for example { "type": "shell", "matcher": "exact", ` +
            `"pattern": "npm test" }. That list is consulted before the auto-rater and never ` +
            `escalates.`),
      command
    );
    this.outcome = outcome;
    this.reason = reason;
    this.escalatedBy = escalatedBy;
    this.negotiation = negotiation;
  }
}
