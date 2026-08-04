/**
 * @module core/shell/rejection
 *
 * EXT-58 (spec §7) — **what the model is told when a gated tool call is refused.**
 *
 * A rejection returned to the model MUST name the moves available to it, not merely the refusal.
 * The pre-EXT-58 message was the bare string *"User rejected the shell command."*, which tells the
 * model it failed and nothing about what to do instead — so it either re-runs the identical call or
 * abandons a legitimate task silently. §7 fixes both ends: state the refusal, carry the explanation
 * when one exists, and name the three moves (re-call with a justification, call a different
 * command, ask the user).
 *
 * When the rater named an already-granted alternative (§4.4), the message MUST carry it **and** say
 * that the alternative needs no approval. That last clause is the sentence that actually redirects
 * behaviour: without it the model reads a tool name and still has no reason to believe calling it
 * is cheaper than arguing about the command it already chose.
 *
 * What this module deliberately does NOT do:
 *
 * - It does not decide anything. It renders a refusal that has already been decided elsewhere; a
 *   suggestion it carries is never an approval and changes no outcome (§4.4).
 * - It does not serve a **halt** (§4.2). A halt is not a rejection and offers the model no moves,
 *   so it is an error (`AttackHaltError`) rather than a message — see `approvalStop.ts`.
 * - It does not serve a **deny-list** refusal. A deny entry is the user's own hardline, and
 *   "re-call the same command with a justification" is not a move the model has there; that message
 *   stays as it is, in `GthAgentRunner.decideToolApproval`.
 * - It does not serve a command the gate's parser could not READ. There is no such refusal:
 *   [[EXT-81]] rates that command instead of refusing it, so every rejection this module renders is
 *   a JUDGED one and "call the same command with a justification" is always a move the model has.
 */
import type { ShellSafetyVerdict } from '#src/core/shell/rater.js';

/** Who refused the call — the opening sentence and the moves both follow from this. */
export type RejectionSource =
  /** The human answered "no" at the escalation prompt (§6). */
  | 'user'
  /** The auto-rater refused during a negotiation (§5 / [[EXT-29]]). */
  | 'rater';

/** The three moves §7 requires a JUDGED rejection to name. */
export const REJECTION_MOVES =
  'You may call the same command with a justification, call a different command, or ask the user ' +
  'if there is no way around it.';

/**
 * §7 — the clause that makes a suggestion actionable. Verbatim in substance from the spec:
 * *"`gth_edit_file` does this and is already approved at this level, so it will not interrupt the
 * user."*
 */
export function buildGrantedAlternativeClause(toolName: string): string {
  return `\`${toolName}\` does this and is already approved at this level, so it will not interrupt the user.`;
}

/** Inputs to {@link buildRejectionMessage}. */
export interface RejectionMessageOptions {
  /** Who refused. */
  source: RejectionSource;
  /** The tool that was refused; defaults to a generic phrasing when absent. */
  toolName?: string;
  /**
   * The rating that accompanied the escalation, when one exists. Carries both the explanation the
   * model is owed and — when the rater named one — the granted alternative (§4.4). Absent at the
   * unrated rungs (`read-only`, `write`), where there is no rating at all and the descriptions of
   * §4.5 are the only mechanism in play.
   */
  verdict?: ShellSafetyVerdict;
}

/**
 * Build the rejection message handed back to the model as the refused call's tool result.
 *
 * §7 shape, each part omitted when it does not apply:
 * 1. who refused what;
 * 2. the rater's explanation, when a rating exists;
 * 3. the three moves — always;
 * 4. the granted alternative plus the no-approval-needed clause, when the rater named one.
 */
export function buildRejectionMessage(options: RejectionMessageOptions): string {
  const target = options.toolName ? `your call to ${options.toolName}` : 'your command';
  const opener =
    options.source === 'rater'
      ? `The auto-rater rejected ${target}.`
      : `The user rejected ${target}.`;

  const parts: string[] = [opener];
  const reason = options.verdict?.reason?.trim();
  if (reason) {
    parts.push(`Explanation: ${reason}`);
  }
  parts.push(REJECTION_MOVES);
  const suggested = options.verdict?.suggestedTool?.trim();
  if (suggested) {
    parts.push(buildGrantedAlternativeClause(suggested));
  }
  return parts.join(' ');
}
