/**
 * @module core/shell/normalize
 *
 * Command-string normalization shared by the shell hardening layer. The hardline
 * blocklist (in `@gaunt-sloth/agent` `tools/shell/hardline`) and the EXT-9 Tier-2
 * allow-list classifier ({@link ./arity.js}) both match against the *normalized* form so
 * trivial obfuscation (ANSI escapes, fullwidth glyphs, backslash splits, padded
 * whitespace) cannot smuggle a command past the guard. Canonical home is core so both the
 * core runner (allow-list) and the agent toolkit (hardline) import a single implementation.
 *
 * Patterned after hermes-agent `tools/approval.py:_normalize_command_for_detection`.
 */

// ANSI / ECMA-48 escape sequences. ESC = \x1b, BEL = \x07, ST = ESC \.
// CSI: ESC [ params intermediates final.
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// OSC: ESC ] ... terminated by BEL or ST (ESC \).
const ANSI_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// Any remaining 2-char escape: ESC followed by a single byte.
const ANSI_LONE = /\x1b[@-Z\\-_]?/g;
// Null bytes.
const NULL_BYTES = /\x00/g;
// Any line ending — CRLF, a lone CR, or a lone LF. Canonicalized to `\n` by normalizeCommand.
const LINE_ENDINGS = /\r\n?/g;
// A run of HORIZONTAL whitespace: whitespace that is not a line break (spaces, tabs, NBSP, …).
const HORIZONTAL_WS = /[^\S\n]+/g;
// A run of line breaks together with any whitespace around it.
const LINE_BREAK_RUN = /\s*\n\s*/g;

/**
 * SECURITY / EXT-55 — the single source of truth for **where a new command begins**.
 *
 * This is a regex character-class BODY (embed it as `` `[${COMMAND_SEPARATOR_CLASS}]` ``) listing
 * every character at which the shell stops one command and starts the next: `;`, `&` (hence
 * `&&`), `|` (hence `||`), and a LINE BREAK. Both consumers of the normalized form build their
 * patterns from it — the allow-list classifier's fail-closed check
 * ({@link import('./arity.js').classifyCommand}) and the agent hardline blocklist's pattern
 * terminators (`@gaunt-sloth/agent` `tools/shell/hardline`) — so the two layers can never again
 * disagree about what a separator is.
 *
 * The layers disagreed before EXT-55: `;`/`&&`/`|` made a command ambiguous (fail-closed) but a
 * newline did not, because {@link normalizeCommand} folded it to a SPACE. `ls -la\nrm -rf /` was
 * therefore classified as the single command `ls`, and an ordinary `ls` grant auto-approved it.
 *
 * `\r` is listed defensively: {@link normalizeCommand} canonicalizes CR/CRLF to LF, so a
 * normalized string never contains one — but a pattern matched against a RAW command still fails
 * closed.
 */
export const COMMAND_SEPARATOR_CLASS = ';&|\\n\\r';

/** {@link COMMAND_SEPARATOR_CLASS} as a ready-made single-character matcher. */
export const COMMAND_SEPARATOR_RE = new RegExp(`[${COMMAND_SEPARATOR_CLASS}]`);

/**
 * Matches any line break — the separator {@link normalizeCommand} used to destroy (EXT-55).
 * Exported so a caller can ask "is this more than one command?" of a RAW string without
 * depending on someone else's normalizer having preserved the boundary.
 */
export const LINE_BREAK_RE = /[\n\r]/;

/**
 * Normalize a command string before dangerous-pattern matching.
 *
 * Steps (each closes an obfuscation bypass):
 * - strip ANSI escape sequences (CSI / OSC / lone-escape),
 * - drop null bytes,
 * - Unicode NFKC fold (fullwidth `ｒｍ` → `rm`, etc.),
 * - canonicalize every line ending (CRLF / lone CR) to a bare `\n`,
 * - collapse shell backslash-escapes (`r\m` → `rm`, `\-rf` → `-rf`),
 * - drop empty-string literals that split tokens (`r''m` / `r""m` → `rm`),
 * - fold runs of HORIZONTAL whitespace (spaces/tabs) to single spaces,
 * - collapse each run of line breaks to a single `\n` — **which survives**, because a line break
 *   is a command separator, not padding (EXT-55) — and trim the ends.
 *
 * EXT-55: the last two steps used to be one `\s+ → ' '` fold, which erased the command boundary
 * and let `ls -la\nrm -rf /` be read as the single command `ls`. A line break now reaches every
 * consumer intact, exactly like `;`. Leading/trailing breaks are still trimmed, so the very
 * common `"npm test\n"` tool argument remains ONE command and keeps matching the allow-list.
 *
 * A backslash before a line break (a shell line continuation) is deliberately NOT joined: folding
 * it away would re-open the same hole for `ls \<newline>rm -rf /`. Keeping the boundary makes such
 * a command categorically ambiguous, which costs a prompt, not a failure.
 *
 * This is intentionally lossy: the normalized form is ONLY used for detection,
 * never for execution (the original command is what runs).
 */
export function normalizeCommand(command: string): string {
  let c = command;
  c = c.replace(ANSI_CSI, '');
  c = c.replace(ANSI_OSC, '');
  c = c.replace(ANSI_LONE, '');
  c = c.replace(NULL_BYTES, '');
  // Unicode compatibility fold (fullwidth → ASCII, etc.).
  c = c.normalize('NFKC');
  // EXT-55: canonicalize line endings FIRST so CR and CRLF are the same separator as LF for every
  // step below (and for every consumer of the normalized form).
  c = c.replace(LINE_ENDINGS, '\n');
  // Collapse backslash-escapes: `\x` → `x` (prevents `r\m -rf /` bypass).
  // Applied before empty-string stripping so `r\m` and `r''m` both fold.
  // `[^\n]` keeps a backslash line-continuation intact — see the docblock.
  c = c.replace(/\\([^\n])/g, '$1');
  // Drop empty-string literals used to split a token: `r''m` / `r""m` → `rm`.
  c = c.replace(/''|""/g, '');
  // Fold runs of horizontal whitespace to a single space…
  c = c.replace(HORIZONTAL_WS, ' ');
  // …then collapse each run of line breaks (with the whitespace around it) to a single `\n`,
  // which SURVIVES normalization as the command separator it is (EXT-55).
  c = c.replace(LINE_BREAK_RUN, '\n');
  // Trim the ends — including a leading/trailing break, which separates nothing.
  return c.trim();
}
