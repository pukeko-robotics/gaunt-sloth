/**
 * @packageDocumentation
 * GS2-106 — **the one parser for a conversation id a person typed**, and the reference it returns.
 *
 * A conversation has two names. `conversations.id` is the integer `gth history list` has always
 * printed; `conversations.run_id` is a UUID minted when the row is created. Every surface that takes
 * an id — `--resume`, `/resume`, `gth history resume`, `gth history show` — parses it here and nowhere
 * else, so the two forms mean the same thing on every surface and a malformed token is refused the
 * same way on every one of them.
 *
 * Parsing is deliberately separate from resolving. Resolving needs the store, and the store's path
 * comes from the config, which `--resume` is parsed before; the reference carries the typed form
 * across that gap, and `HistoryStore.resolveConversationRef` turns it into a row by exact match.
 */

/**
 * A parsed conversation id: the integer row id, or the run id minted with the row.
 *
 * The integer form is kept for every row, including the ones written before run ids existed. The
 * run id is the form that survives a deleted and recreated database: integers restart there, so a
 * stale integer can name a different conversation, while a run id from another database names none.
 */
export type ConversationRef = { kind: 'id'; id: number } | { kind: 'run'; runId: string };

/**
 * The canonical 8-4-4-4-12 hex spelling. Any version nibble is accepted: the store only ever holds
 * what `randomUUID()` minted, and a well-formed UUID that is not in it is refused by the lookup as
 * unknown, which is the truthful answer for it.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse what a person typed as a conversation id, or `null` when it is neither form.
 *
 * - A positive whole number in decimal, optionally written `#12` the way the listing prints it.
 * - A canonical UUID, normalised to lower case, because SQLite compares TEXT case-sensitively and
 *   `randomUUID()` mints lower case — so a UUID pasted in upper case still names its row.
 *
 * Anything else is `null`, including `12abc` and `1.5`: a token that is only partly an id is a typo
 * worth naming, never a lookup worth making on the part that parsed.
 */
export function parseConversationRef(raw: string | undefined): ConversationRef | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (CANONICAL_UUID.test(trimmed)) return { kind: 'run', runId: trimmed.toLowerCase() };
  const digits = trimmed.replace(/^#/, '');
  if (!/^\d+$/.test(digits)) return null;
  const id = Number.parseInt(digits, 10);
  return Number.isSafeInteger(id) && id > 0 ? { kind: 'id', id } : null;
}

/**
 * Accept either a reference or a bare integer id — what callers and specs written before run ids
 * existed pass — and return a reference.
 */
export function toConversationRef(ref: ConversationRef | number): ConversationRef {
  return typeof ref === 'number' ? { kind: 'id', id: ref } : ref;
}

/** The reference as a person would recognise it: `#12`, or the run id itself. */
export function formatConversationRef(ref: ConversationRef | number): string {
  const r = toConversationRef(ref);
  return r.kind === 'id' ? `#${r.id}` : r.runId;
}
