/**
 * @module core/shell/provenance
 *
 * [[EXT-106]] (spec §4.6) — **the user-provenance carve-out: where the human named the host
 * themselves, we WARN rather than ASK.**
 *
 * §4.6's open-world preflight floors every command that names a host in a fetch or transfer
 * position, before any model call. That is right for a host the *agent* chose. It is wrong for the
 * one the *user* typed: the person who wrote *"fetch https://example.com/install.sh"* is then asked
 * to confirm the fetch they just requested, on a rung they chose in order not to be asked. This
 * module decides that one question — **was every host in this command named verbatim by the
 * human?** — and it decides it deterministically, with no model call.
 *
 * ## The four rules that make it safe, and none of them is optional
 *
 * 1. **It lifts the FLOOR, never the RATING.** What is carved is the claim *"this command names a
 *    host"*, never *"this command is safe"*. The rater still runs, still rates, and a
 *    `destructive` verdict on a carved command still refuses it — `curl <a host the user named> |
 *    sh` is `destructive` on its own merits and stays so.
 * 2. **EVERY host must be user-named, never the first.** {@link findOpenWorldHostLiterals} returns
 *    all matches for exactly this reason, and {@link carvedOpenWorldHosts} requires all of them, so
 *    one host the user asked for cannot carry an unmentioned second one through with it.
 * 3. **Token EQUALITY, never substring.** See {@link userNamedTokens}.
 * 4. **`auto` only** ({@link isUserProvenanceRung}), enforced HERE rather than at the call site, so
 *    a caller that forgets cannot widen the scope.
 *
 * ## The residual hole, stated once
 *
 * §4.6.1's error-cost inversion is **narrowed, not falsified**. The rater still rates the command,
 * so a clear typosquat is `attack` and halts the run, and an unclear one is `destructive` and still
 * reaches a person. The gap is precisely one case: a deception the rater rates `safe` outright — one
 * it never noticed — where the user is now **told rather than asked**. The warning the runner emits
 * on every carved approval is what covers even that case, and Andrew accepted this trade explicitly.
 * It is not relitigated here.
 *
 * **Host trust is still never a model judgement.** Tier 1 moves the decision to a human's verbatim
 * words, which is an exact match. What changes is *when the deterministic floor fires*, never *who
 * may judge a hostname*. Tier 2 — a paraphrase the model matches (*"clone the testing repo from our
 * org"*) — is deliberately out of scope and must not be added here.
 */
import type { ApprovalRung } from '#src/config.js';
import { isUserProvenanceRung } from '#src/config.js';
import { findOpenWorldHostLiterals } from '#src/core/shell/openWorld.js';

/**
 * The trailing characters stripped from a USER's token before it is compared — a small closed set,
 * because prose puts them there: *"fetch https://example.com/x."*, *"(see https://example.com/x)"*.
 *
 * Only the **trailing** end and only these characters. A wider or two-ended trim would start
 * inventing tokens the user did not type, and every character not in this set simply makes the token
 * unequal to the host literal — which floors, the fail-closed direction.
 */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', ')', ']', '"', "'"]);

/** One user token with any {@link TRAILING_PUNCTUATION} removed from its end. */
function trimTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(token[end - 1])) end -= 1;
  return token.slice(0, end);
}

/**
 * Every whitespace-delimited token the user actually typed, trailing prose punctuation removed.
 *
 * **MATCHING IS BY TOKEN EQUALITY AND NEVER BY SUBSTRING, and that is the whole security of this
 * layer.** A naive `message.includes(hostLiteral)` is exploitable in exactly the direction the
 * open-world floor exists to stop: a command naming `https://evil.com` is a *substring* of a user
 * message containing `https://evil.com.attacker.net/x`, so any unrelated pasted URL would carve a
 * host the user never named — and pasting a URL into a chat is not an unusual thing for a person to
 * do. Equality has a boundary at both ends and cannot be extended by an attacker-chosen suffix.
 *
 * Blunt beats precise here. No normalisation, no host parsing, no case folding: a host literal that
 * no longer matches simply floors, and floors are the direction this layer is allowed to fail in.
 */
function userNamedTokens(userMessages: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const message of userMessages) {
    for (const raw of message.split(/\s+/)) {
      const token = trimTrailingPunctuation(raw);
      if (token.length > 0) tokens.add(token);
    }
  }
  return tokens;
}

/**
 * [[EXT-106]] §4.6 — **the host literals §4.6's preflight found and the user had already named**, or
 * an empty array when the carve-out does not apply to this call.
 *
 * This is the ONE implementation of the carve, read by every reader of it: the floor
 * ({@link import('./rater.js').mapVerdictToAction}), negotiability
 * ({@link import('./rater.js').isNegotiableCall}), the diagnostic archive and the warning. A second
 * derivation is how a gate and a warning come to disagree about whether a command was carved.
 *
 * **The rung is enforced here, not at the call site.** A caller that forgets to check it cannot
 * widen the scope, which matters because the rung that must NOT carve is the DEFAULT one — see
 * {@link isUserProvenanceRung}.
 *
 * **`provenance` is the user's own retained messages, and it is NOT
 * {@link import('./negotiation.js').ShellNegotiationState.contextFor}'s.** That function returns
 * `userMessages: []` at round 1 by design — §5.1's *"round 1 sees the command alone"* — and round 1
 * is precisely the round this carve-out exists to act on. §5.1 bounds what the **rater** may see;
 * the floor is not the rater, and a floor reading nothing at round 1 would never fire at all. The
 * runner reads {@link import('./negotiation.js').ShellNegotiationState.retainedUserMessages}
 * instead.
 *
 * **The window is cumulative across the turns of a thread** (capped and de-duplicated by that
 * state), so a host the user named in an earlier turn still carves a command proposed in a later
 * one. That is a decision, not an accident: *"the user asked for this"* is a property of the
 * conversation rather than of one message, and an agent that gathers information for two turns
 * before running the fetch it was asked for is the ordinary case. `resetThread()` clears the window,
 * which is the right boundary for it.
 *
 * @param rung The rung in force. Anything but `auto` returns `[]`.
 * @param command The raw command string as the model proposed it — read through the same
 *   {@link findOpenWorldHostLiterals} the floor reads, so the two cannot disagree about which hosts
 *   are in play.
 * @param provenance The user's retained messages. **Empty means "no provenance", which floors
 *   exactly as before** — the default every caller outside a live session gets.
 */
export function carvedOpenWorldHosts(
  rung: ApprovalRung,
  command: string,
  provenance: readonly string[]
): readonly string[] {
  if (!isUserProvenanceRung(rung)) return [];
  if (provenance.length === 0) return [];
  const hosts = findOpenWorldHostLiterals(command);
  if (hosts.length === 0) return [];
  const named = userNamedTokens(provenance);
  // Rule 2 — EVERY host, never the first. `every` on a non-empty array, so a command naming a
  // user-requested host and one the user never mentioned is not carved at all.
  return hosts.every((host) => named.has(host)) ? hosts : [];
}

/**
 * Whether §4.6's open-world floor is lifted on this call — the boolean reading of
 * {@link carvedOpenWorldHosts}, defined in terms of it so the two can never disagree.
 */
export function isOpenWorldCarved(
  rung: ApprovalRung,
  command: string,
  provenance: readonly string[]
): boolean {
  return carvedOpenWorldHosts(rung, command, provenance).length > 0;
}
