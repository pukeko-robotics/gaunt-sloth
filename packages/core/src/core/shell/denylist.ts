/**
 * @module core/shell/denylist
 *
 * CFG-27 (spec §3) — the **deny list**: command prefixes the user has said never to run. It is
 * consulted **before the allow-list and before the rater**, a match is refused with no prompt and
 * no rating call, and — uniquely — **it still applies under `bypass`**. Choosing `bypass` says
 * *"stop asking me"*; it does not withdraw a prohibition the user has already stated. The deny
 * list is the user's own hardline, and it is the only check `bypass` keeps besides the built-in
 * floor (§8).
 *
 * ## Why this is NOT `matchesApproval` with the sense flipped
 *
 * The allow-list matcher ({@link ./allowlist.js}) resolves a command through
 * {@link ./arity.js classifyCommand}, which returns `null` for anything that composes,
 * substitutes or redirects. For an ALLOW list that is a fail-**closed** behaviour and exactly
 * right: an unclassifiable command matches nothing and therefore gets no free pass.
 *
 * Reuse it for DENY and the identical code fails **open**: `git push --force; ls` is
 * unclassifiable, so it would match no deny entry and sail straight past a declared
 * a declared deny entry for `git push --force`. A prohibition that any trailing `; ls` defeats is not a
 * prohibition.
 *
 * So the deny matcher fails in the other direction on purpose:
 *  - it splits the normalized command into **every** segment a shell would run (`;` `&&` `||`
 *    newline, plus the bodies of `$(…)` / backtick substitutions), and
 *  - matches a declared prefix against **each** segment.
 *
 * An unclassifiable command is therefore still deny-matchable, which is the whole point.
 *
 * ## Matching rule
 *
 * A segment matches a declared prefix when, after normalization, it **is** the prefix or begins
 * with the prefix followed by whitespace — i.e. the match is token-aligned. `git push --force`
 * does not match `git push --force-with-lease`, and `npm publish` does not match
 * `npm publish-please`. Flag ORDER is significant, as it is for the allow-list: a prefix is a
 * literal command opening, not a parsed argv predicate, and pretending otherwise would mean
 * shipping a second command parser — which §4.4 rejects for exactly this reason.
 */
import { COMMAND_SEPARATOR_CLASS, normalizeCommand } from '#src/core/shell/normalize.js';

/** Splits the normalized command at every point where a shell would begin a NEW command. */
const SEGMENT_SPLIT_RE = new RegExp(`[${COMMAND_SEPARATOR_CLASS}]|\\$\\(|\\)|\``, 'g');

/**
 * Split a raw command into the segments a shell would run, normalized and **case preserved**.
 *
 * Substitution bodies are segments in their own right: `echo $(npm publish)` runs `npm publish`,
 * so a deny entry for `npm publish` must see it. Splitting on `$(`, `` ` `` and `)` yields the
 * body as its own segment (and leaves harmless empty fragments, which are dropped).
 *
 * Shared with the EXT-71 rule matcher (`core/approvals/matcher.ts`), which needs the segments with
 * their case intact because a `regexp` entry is compiled exactly as the user wrote it.
 */
export function commandSegments(command: string): string[] {
  return normalizeCommand(command)
    .split(SEGMENT_SPLIT_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** {@link commandSegments}, lower-cased — the form this module's own prefix matching compares. */
export function denyCandidateSegments(command: string): string[] {
  return commandSegments(command).map((segment) => segment.toLowerCase());
}

/**
 * Whether a single normalized, lower-cased segment starts with a declared prefix, token-aligned.
 * Exported for tests; callers use {@link matchesDenylist}.
 */
export function segmentMatchesPrefix(segment: string, prefix: string): boolean {
  if (segment === prefix) return true;
  return segment.startsWith(prefix) && /\s/.test(segment.charAt(prefix.length));
}

/**
 * Find the declared deny entry that refuses this command, or `null` when none does.
 *
 * Returns the entry AS DECLARED (not the normalized form) so the refusal message can quote the
 * user's own words back at them — a refusal the user cannot trace to the line they wrote is
 * indistinguishable from a bug.
 *
 * Empty/whitespace-only entries are ignored rather than matching everything: a stray `""` in a
 * config array must not silently disable the agent.
 */
export function matchesDenylist(command: string, deny: readonly string[]): string | null {
  if (deny.length === 0) return null;
  const segments = denyCandidateSegments(command);
  if (segments.length === 0) return null;

  for (const declared of deny) {
    const prefix = normalizeCommand(declared).toLowerCase().trim();
    if (prefix.length === 0) continue;
    for (const segment of segments) {
      if (segmentMatchesPrefix(segment, prefix)) return declared;
    }
  }
  return null;
}

/**
 * The session's deny list: the entries declared in config (§9 — **read-only input**, never
 * written back) merged with whatever the escalation menu's *always reject* choice adds at
 * runtime (§6; that writer arrives with [[TUI-C26]]'s menu).
 *
 * Per-instance rather than module-global so concurrent sessions (ACP / AG-UI multi-session)
 * cannot stomp each other, matching {@link ./allowlist.js AllowlistStore}.
 */
export class DenylistStore {
  private readonly entries: string[] = [];

  constructor(declared: readonly string[] = []) {
    this.addAll(declared);
  }

  /** Add one entry (idempotent). Blank entries are ignored. */
  add(entry: string): void {
    const trimmed = entry.trim();
    if (trimmed.length === 0) return;
    if (!this.entries.includes(trimmed)) this.entries.push(trimmed);
  }

  /** Add several entries (idempotent). */
  addAll(entries: readonly string[]): void {
    for (const entry of entries) this.add(entry);
  }

  /** Every entry, in declaration order. */
  list(): string[] {
    return [...this.entries];
  }

  /** The declared entry refusing this command, or `null`. See {@link matchesDenylist}. */
  match(command: string): string | null {
    return matchesDenylist(command, this.entries);
  }
}
