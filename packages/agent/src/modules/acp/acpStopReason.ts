/**
 * @packageDocumentation
 * [[EXT-159]] — the one place ACP's stop reasons are derived from our termination taxonomy.
 *
 * ACP maintains its own `StopReason` vocabulary, and an editor speaking ACP is a fourth consumer of
 * the same classification the retry posture, the 400-never/429-is-different ruling and the
 * nudge-or-back-off decision read. **So it is mapped onto, never forked.** A second vocabulary
 * grown beside the taxonomy is how two answers to "why did this end" come to disagree, and the
 * editor's is the one the user sees.
 *
 * **The map is exhaustive by type, not by care.** It is a `Record` over every category, so a 23rd
 * member of the taxonomy is a build failure here rather than a run that silently reports the new
 * cause as `end_turn`.
 *
 * **`null` is a real answer and the most important one.** v1's union is CLOSED — five members, no
 * extension point — and several of our categories have no true member in it: a rate limit is not a
 * refusal and it is certainly not the model finishing. Rather than pick the nearest wrong word,
 * those map to `null`, which tells the caller "the closed vocabulary cannot state this" and routes
 * it to the dialect's own way of saying so: a JSON-RPC error on v1, an underscore-prefixed custom
 * reason on v2. The full classification then rides alongside as structured data — `_meta` on the
 * response, `data` on the error — so nothing is lost by the narrowing.
 */

import type {
  GthTerminationCategory,
  GthTerminationReason,
} from '@gaunt-sloth/core/core/terminationReason.js';

/**
 * The stop reasons ACP defines, spelled here rather than imported.
 *
 * v1 and v2 export a `StopReason` each and they are not the same type: v1's is closed and v2's is
 * widened with `string` for custom, underscore-prefixed reasons. A map written against either would
 * be wrong for the other — against v2's it would type-check while emitting values v1 rejects — so
 * the shared half is named once, and each dialect's own extension stays in that dialect's module.
 */
export type AcpClosedStopReason =
  'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/**
 * The custom v2 stop reason for an ending the closed vocabulary cannot state.
 *
 * v2 reserves custom reasons to names beginning with an underscore. Deliberately ONE name rather
 * than one per category: a client cannot be expected to learn our taxonomy from its stop reason
 * field, and the classification it should actually read is the structured value beside it.
 */
export const ACP_ERROR_STOP_REASON = '_error';

/**
 * Every category, mapped to the ACP reason that is TRUE of it, or `null` when none is.
 *
 * The three `max_turn_requests` entries are the mapping's one judgement call, and it is deliberate:
 * the closed vocabulary has exactly one member for *the agent's own in-turn bound ended this*, and
 * the tool-error budget, the tool-loop guard and the graph's recursion limit are three such bounds.
 * Reporting them as `end_turn` would say the model finished, which is the false-completion defect
 * this taxonomy exists to remove; reporting them as errors would say something failed, which is
 * also untrue — each is a guard doing its job. Which bound it was is in the `site` travelling
 * beside this value.
 */
const ACP_STOP_REASON: Readonly<Record<GthTerminationCategory, AcpClosedStopReason | null>> = {
  completed: 'end_turn',
  // The model handed back having said nothing. Nothing failed and nobody refused, so this is an
  // ordinary end of turn — the emptiness is the part the classification beside it carries.
  empty_response: 'end_turn',
  content_refusal: 'refusal',
  output_truncated: 'max_tokens',
  // NOT `max_tokens`, which states the OUTPUT cap: this is the input window, a different bound with
  // a different remedy, and the two are exactly the pair a client would act on differently.
  context_overflow: null,
  rate_limited: null,
  auth_failed: null,
  invalid_request: null,
  provider_error: null,
  network_error: null,
  timeout: null,
  cancelled: 'cancelled',
  // The gate declined to continue, which is what ACP's `refusal` says. An approvals stop is not a
  // failure — nothing broke — so routing it to an error would show the user a crash for a decision.
  approval_stop: 'refusal',
  tool_error_budget: 'max_turn_requests',
  tool_loop_guard: 'max_turn_requests',
  interrupt_drain_guard: 'max_turn_requests',
  tool_error: null,
  // The graph is parked and the client is being handed control back; the turn itself is over.
  suspended: 'end_turn',
  recursion_limit: 'max_turn_requests',
  // The consumer stopped listening. From the client's side that is indistinguishable from having
  // cancelled, and it is the one closed member that does not claim the model did anything.
  abandoned: 'cancelled',
  unknown: null,
};

/**
 * The ACP stop reason for a termination reason, or `null` when the closed vocabulary cannot state
 * it — including when nothing classified the ending at all.
 *
 * A `null` REASON and a `null` result are deliberately the same answer here. An unclassified ending
 * is a site we missed, and the honest report of it is the dialect's own "stopped, and none of the
 * defined reasons is what happened" — never a guessed `end_turn`, which would claim the model
 * finished on precisely the turns where nobody knows what happened.
 */
export function acpStopReasonFor(
  reason: GthTerminationReason | null | undefined
): AcpClosedStopReason | null {
  if (!reason) return null;
  return ACP_STOP_REASON[reason.category] ?? null;
}

/**
 * The classification as structured metadata, for the `_meta` of an ACP response or the `data` of an
 * ACP error.
 *
 * Namespaced, because `_meta` is a shared bag whose keys are reserved by convention rather than by
 * the protocol. Returns `undefined` for an unclassified ending rather than a placeholder object: a
 * client must be able to tell "we did not classify this" from "we classified it as nothing".
 */
export function acpTerminationMeta(
  reason: GthTerminationReason | null | undefined
): Record<string, unknown> | undefined {
  if (!reason) return undefined;
  return { 'gauntSloth/terminationReason': { ...reason } };
}
