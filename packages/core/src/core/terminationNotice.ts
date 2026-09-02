/**
 * @packageDocumentation
 * [[EXT-159]] — getting the typed termination reason to the person looking at the screen.
 *
 * `core/terminationReason.ts` decides *what* ended a run. This module decides *how that fact is
 * said*, once, for every surface — the Ink TUI, the readline session, the non-interactive verbs,
 * ACP and AG-UI — so a run states why it ended in the same vocabulary wherever it is being watched.
 *
 * **Recording it better is not the deliverable.** Most people never make a debug dump; the ones
 * most likely to hit a silent stop have already quit, taking the live session state with them; and
 * reading a dump is a skill that fails even for a maintainer holding one. So the reason has to
 * reach the SESSION, at the moment it happens, on the surface in front of the user.
 *
 * **The prose is never the carrier.** Every surface commits the {@link GthTerminationReason} value
 * itself and derives the words from it here, so a test — and a consumer — reads the classification
 * structurally instead of matching a sentence. That is also why {@link terminationCode} exists: a
 * user quoting one short token in a bug report hands a maintainer the fact that makes the report
 * tractable, which is precisely what "the agent just stopped" could not.
 *
 * **An ABSENT reason is a signal, not a blank to fill.** The taxonomy's contract is that a turn
 * with no reason is a site nobody classified, which is why an ordinary completion is recorded
 * rather than left empty. Nothing here invents a category, a placeholder or a default for `null`:
 * {@link terminationLogLine} states the absence as an absence, and
 * {@link displayTermination} says nothing to the user, because "we did not classify this" is a
 * defect report aimed at us and not an explanation aimed at them.
 */

import type {
  GthTerminationCategory,
  GthTerminationReason,
  GthTerminationRemedy,
} from '#src/core/terminationReason.js';
import { displayNotice } from '#src/utils/consoleUtils.js';
import { debugLog } from '#src/utils/debugUtils.js';

/**
 * What each category is called in a sentence a user reads.
 *
 * An exhaustive `Record` rather than a `switch` with a default: a 23rd category is then a build
 * failure here instead of a run that silently reports the new cause in the old words.
 */
const CATEGORY_LABEL: Readonly<Record<GthTerminationCategory, string>> = {
  completed: 'the model finished',
  empty_response: 'the model returned nothing',
  content_refusal: 'the model declined to answer',
  output_truncated: 'the answer hit the output limit',
  context_overflow: 'the conversation outgrew the model input window',
  rate_limited: 'the provider rate-limited the request',
  auth_failed: 'the provider rejected the credentials',
  invalid_request: 'the provider rejected the request',
  provider_error: 'the provider failed',
  network_error: 'the connection failed',
  timeout: 'a deadline elapsed',
  cancelled: 'it was cancelled',
  approval_stop: 'the approvals gate stopped it',
  tool_error_budget: 'the tool-error budget ended the run',
  tool_loop_guard: 'the tool-loop guard ended a repeating call',
  interrupt_drain_guard: 'too many tool approvals in one turn',
  tool_error: 'a tool failed',
  suspended: 'it is waiting to be resumed',
  recursion_limit: 'it hit the graph step limit',
  abandoned: 'the client stopped listening',
  unknown: 'the cause was not recognised',
};

/**
 * What each remedy asks the user to actually do.
 *
 * Exhaustive for the same reason {@link CATEGORY_LABEL} is: the posture table names a remedy, and a
 * remedy nobody worded is a retry hint the user never gets.
 */
const REMEDY_LABEL: Readonly<Record<GthTerminationRemedy, string>> = {
  'reduce-context': 'Send less — clear or compact the conversation, then try again.',
  'back-off': 'Wait a moment, then send the same request again.',
  'change-request': 'Try a different or narrower request.',
  'change-model': 'Try a different model.',
  'fix-credentials': 'Check the API credentials or configuration, then try again.',
  resume: 'Nothing is wrong — the run is parked and can be continued where it stopped.',
};

/**
 * The opening of every termination notice title.
 *
 * Exported because two surfaces put the notice into a channel that also carries other messages —
 * ACP's `agent_message`, where the agent speaks about the session — so something has to be able to
 * tell one from the other without transcribing the wording. A consumer keying on this constant
 * moves with the copy; one keying on a copy of the string does not, and finds out when the two have
 * silently disagreed for a while.
 */
export const TERMINATION_NOTICE_TITLE_PREFIX = 'Run ended: ';

/** A termination reason, rendered for a surface that shows a title and body lines. */
export interface GthTerminationNotice {
  /**
   * **The carrier.** The classification travels as this value; the strings below are derived from
   * it and are never the only place it exists.
   */
  reason: GthTerminationReason;
  /** The one line that says what happened. */
  title: string;
  /** The supporting lines: the quotable code, what was seen, and what may help. */
  lines: string[];
}

/**
 * The short token a user can quote and a maintainer can act on: the category and the site that
 * classified it.
 *
 * Both halves, always. Several sites share a category and several categories reach one site, so
 * either alone loses the fact that separates two failures which look identical on screen — the
 * standing example being an `empty_response` whose as-is retry has already been spent at
 * `runner.empty-after-fallback` and one where it has not been spent at all.
 */
export function terminationCode(reason: GthTerminationReason): string {
  return `${reason.category}@${reason.site}`;
}

/**
 * Is this reason worth telling the person watching?
 *
 * Two categories are not. `completed` is the ordinary end of a turn, and announcing it would put a
 * line under every successful answer. `suspended` is a run that has PAUSED rather than ended — the
 * graph is parked on a tool-approval interrupt and about to continue — so announcing it would
 * report the middle of a working turn as its end.
 *
 * Everything else is announced, deliberately including the ones that look self-explanatory.
 * `cancelled` is announced because a turn cancelled by a stray escape sequence is exactly the shape
 * that gets misattributed to the provider for months ([[TUI-C62]]), and a user who did not knowingly
 * press anything is owed the fact that a cancellation is what happened. `approval_stop` is announced
 * because the gate's own prose explains the DECISION while this states the CLASSIFICATION, which is
 * the half a bug report needs.
 *
 * Announcing is a separate decision from recording: everything is recorded, including the
 * categories this returns `false` for.
 */
export function shouldAnnounceTermination(reason: GthTerminationReason): boolean {
  return reason.category !== 'completed' && reason.category !== 'suspended';
}

/**
 * Render a reason for a surface that shows a title and body lines.
 *
 * **The `??` on the label lookup is a runtime floor, and it takes nothing away from the build-time
 * one.** That a 23rd category fails the build comes from the category-label table being a `Record`
 * over the whole union, which this expression cannot weaken. What it covers is the case the type
 * system never saw: a reason that arrived from outside it — read back off an ACP `_meta`, handed
 * over by an embedder, or revived from a dump — whose category is a string the table has no entry
 * for. Without the fallback that renders as the literal word `undefined` in the one line the user
 * is being shown, which is a worse answer than "the cause was not recognised" and is exactly the
 * kind of second failure this module refuses to add to a first one.
 */
export function terminationNotice(reason: GthTerminationReason): GthTerminationNotice {
  const lines: string[] = [`Reason code: ${terminationCode(reason)}`];
  const seen: string[] = [];
  if (reason.provider) seen.push(`provider ${reason.provider}`);
  if (reason.detail) seen.push(`reported ${reason.detail}`);
  if (seen.length > 0) lines.push(`What was seen: ${seen.join(', ')}.`);
  lines.push(retryAdvice(reason));
  return {
    reason,
    title: `${TERMINATION_NOTICE_TITLE_PREFIX}${CATEGORY_LABEL[reason.category] ?? CATEGORY_LABEL.unknown}`,
    lines,
  };
}

/**
 * The retry advice for a reason, read off the posture the taxonomy already decided.
 *
 * Read from the reason's own posture fields rather than re-deriving one from the category, so this
 * cannot come to disagree with the single posture table the taxonomy exists to keep.
 */
function retryAdvice(reason: GthTerminationReason): string {
  if (reason.retryableAsIs) return 'Sending the same request again may work.';
  if (reason.retryableAfterRemedy && reason.remedy) return REMEDY_LABEL[reason.remedy];
  return 'Sending the same request again will not help.';
}

/**
 * One line for the debug log, stating either the whole classification or the absence of one.
 *
 * `null` is the case this function exists for. A turn that ended with nothing classifying it is the
 * taxonomy's own defect signal, and it has to be written down as that — never as `completed`, never
 * as `unknown`, and never omitted, because a missing line is indistinguishable from a session where
 * this was never reached.
 */
export function terminationLogLine(reason: GthTerminationReason | null): string {
  if (!reason) {
    return (
      'EXT-159 termination: UNCLASSIFIED — no site classified how this turn ended. ' +
      'An absent reason means a termination site we missed, not a turn that went well.'
    );
  }
  const parts = [
    `category=${reason.category}`,
    `site=${reason.site}`,
    `source=${reason.source}`,
    `retryableAsIs=${reason.retryableAsIs}`,
    `retryableAfterRemedy=${reason.retryableAfterRemedy}`,
  ];
  if (reason.remedy) parts.push(`remedy=${reason.remedy}`);
  if (reason.provider) parts.push(`provider=${reason.provider}`);
  if (reason.detail) parts.push(`detail=${reason.detail}`);
  return `EXT-159 termination: ${parts.join(' ')}`;
}

/**
 * Say why the run ended on a console surface (the readline session and the non-interactive verbs),
 * and write the same fact to the debug log either way.
 *
 * Returns whether anything was shown, so a caller can tell "said nothing because the turn simply
 * finished" from "said nothing because nothing classified it" without re-deriving the rule.
 *
 * Fail-soft in the strongest sense: explaining a failure must never become a second failure, so
 * every path here is wrapped and a throw is swallowed.
 *
 * **The whole notice, on one stream, at any console level.** Written through
 * {@link displayNotice}, so the title and the body cannot land on different streams and cannot be
 * filtered apart. `gate: 'always'` because {@link terminationCode} is the token a user quotes in a
 * bug report and there is nowhere else they will find it: the session log is off by default and the
 * debug log is not what anyone reads. A notice they cannot recover is not a notice worth quieting —
 * and only a run that ended abnormally reaches here at all, since
 * {@link shouldAnnounceTermination} declines the ordinary ones.
 */
export function displayTermination(reason: GthTerminationReason | null): boolean {
  try {
    debugLog(terminationLogLine(reason));
    if (!reason || !shouldAnnounceTermination(reason)) return false;
    const notice = terminationNotice(reason);
    displayNotice(notice.title, notice.lines, { tone: 'warn', gate: 'always' });
    return true;
  } catch {
    return false;
  }
}
