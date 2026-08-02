/**
 * @module utils/untrustedText
 *
 * **The structural delimiters gsloth wraps untrusted text in, and the one function that neutralizes
 * a forged one.**
 *
 * Text that arrived from outside this process — an MCP server's discovery `instructions`, a command
 * string the model composed from an issue body or a fetched page — is quoted into the model's
 * context in several places. Wherever it is, the same two things have to be true:
 *
 * 1. the quoted text is visibly fenced, so the model can tell data from first-party instruction; and
 * 2. **the quoted text cannot forge the fence** and escape it.
 *
 * (2) is the load-bearing half, and it is why the delimiters and the defang live together in one
 * module rather than beside each consumer. A second defang written for a second consumer is how one
 * of them comes to know about a delimiter the other emits: a forged `[END …]` token that the
 * emitting site happens not to defang closes its fence early and the attacker's lines land OUTSIDE
 * the boundary, reading as first-party text. {@link defangUntrustedDelimiters} knows **every**
 * delimiter we emit, so every consumer is protected by every arm.
 *
 * **Defang BEFORE wrapping, always.** That ordering is the whole mechanism; wrapping first and
 * sanitizing after would sanitize a string that already contains the real delimiters.
 */

/** The MCP discovery-instructions fence (EXT-32), emitted by `utils/systemPromptNotes.ts`. */
export const MCP_FENCE_BEGIN = '[BEGIN MCP SERVER-PROVIDED CONTEXT]';
export const MCP_FENCE_END = '[END MCP SERVER-PROVIDED CONTEXT]';

/**
 * EXT-65 — the fence a refused command is quoted back inside, emitted by
 * `core/shell/abstention.ts`. A command the gate could not parse is frequently a command the model
 * assembled out of text it read somewhere, so quoting it back for the model to rewrite is quoting
 * untrusted bytes into the model's context.
 */
export const QUOTED_COMMAND_FENCE_BEGIN = '[BEGIN QUOTED COMMAND TEXT]';
export const QUOTED_COMMAND_FENCE_END = '[END QUOTED COMMAND TEXT]';

/** How much of a refused command is quoted back. Generous; a realistic command is far shorter. */
export const QUOTED_COMMAND_MAX_CHARS = 2000;

/** Appended when {@link QUOTED_COMMAND_MAX_CHARS} actually clipped the quoted command. */
export const QUOTED_COMMAND_TRUNCATION_MARKER = '… [truncated]';

/**
 * Neutralize every structural delimiter this codebase emits, inside UNTRUSTED text.
 *
 * The text is fully attacker-influenceable, so it may forge:
 *   - either fence's tokens (`[BEGIN|END MCP SERVER-PROVIDED CONTEXT]`,
 *     `[BEGIN|END QUOTED COMMAND TEXT]`) — the bracket run is collapsed so they can no longer be
 *     read as the real delimiter, while staying legible to a reader who wants to see what was
 *     attempted; and
 *   - a per-server label line `--- Server: …` (EXT-32) — the leading `---` run is broken so it
 *     cannot masquerade as one of ours.
 *
 * After this, the ONLY real delimiters in a composed block are the ones the caller emits. Names we
 * put in our OWN labels come from trusted config keys and are not sanitized — only the untrusted
 * CONTENT is.
 *
 * Whitespace-tolerant (`\s+`, optional bracket padding, `-{3,}`) so trivial spacing variants cannot
 * slip a delimiter through, and case-insensitive so neither can a lowercase one.
 */
export function defangUntrustedDelimiters(text: string): string {
  return text
    .replace(
      /\[\s*(BEGIN|END)\s+MCP\s+SERVER-PROVIDED\s+CONTEXT\s*\]/gi,
      (_m, kw: string) => `(server text: ${kw.toUpperCase()} MCP SERVER-PROVIDED CONTEXT)`
    )
    .replace(
      /\[\s*(BEGIN|END)\s+QUOTED\s+COMMAND\s+TEXT\s*\]/gi,
      (_m, kw: string) => `(quoted text: ${kw.toUpperCase()} QUOTED COMMAND TEXT)`
    )
    .replace(/-{3,}(\s*Server\s*:)/gi, '- - -$1');
}

/**
 * Truncate untrusted text at `maxChars`, SURROGATE-SAFE, appending `marker` only when text was
 * actually clipped.
 *
 * A naive `slice(0, N)` can split a surrogate pair (e.g. an emoji) at the boundary and emit a lone
 * half-code-unit. If the cut would land between a high and a low surrogate, back off one code unit
 * so the pair is kept whole (dropped entirely rather than split).
 */
export function capUntrustedText(text: string, maxChars: number, marker: string): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // don't split a surrogate pair
  return `${text.slice(0, end).trimEnd()}\n${marker}`;
}
