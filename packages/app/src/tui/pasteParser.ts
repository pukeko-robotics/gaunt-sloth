/**
 * TUI-C24 — pure, React-free helper for pasted text.
 *
 * A terminal in **bracketed paste mode** (`\x1b[?2004h`) wraps pasted content between `\x1b[200~`
 * and `\x1b[201~`, so a multi-line paste is distinguishable from typed keystrokes (its embedded
 * newlines are NOT Enter presses and must not submit the prompt). Ink 7.1.0 already tokenizes that
 * protocol internally and delivers the payload via its `usePaste` hook, which is what the TUI wires
 * up in production (see `PromptInput.tsx`) — so the live tokenizing is Ink's job, not ours.
 *
 * What remains ours is normalizing the payload's line breaks, which is genuinely on the runtime
 * path: the `usePaste` handler runs every pasted payload through {@link normalizePastedText} before
 * inserting it into the buffer. Kept free of any Ink/React dependency so it stays unit-testable by
 * feeding strings and asserting the result.
 */

/**
 * Collapse `\r\n` (CRLF) and standalone `\r` (CR) to `\n` so pasted line breaks match how the rest
 * of the buffer stores them. Terminals variously deliver pasted newlines as `\r`, `\r\n`, or `\n`;
 * normalizing to `\n` is what stops a multi-line paste from either jamming onto one line or
 * splitting inconsistently. Idempotent and safe on single-line text (returns it unchanged).
 */
export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
