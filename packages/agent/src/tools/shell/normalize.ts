/**
 * @module tools/shell/normalize
 *
 * Command-string normalization shared by the shell hardening layer. The hardline
 * blocklist ({@link ../shell/hardline.js}) matches against the *normalized* form so
 * trivial obfuscation (ANSI escapes, fullwidth glyphs, backslash splits, padded
 * whitespace) cannot smuggle a catastrophic command past the guard. Kept in its own
 * importable module because EXT-9 Tier-2 (allow-list classification) will reuse it.
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

/**
 * Normalize a command string before dangerous-pattern matching.
 *
 * Steps (each closes an obfuscation bypass):
 * - strip ANSI escape sequences (CSI / OSC / lone-escape),
 * - drop null bytes,
 * - Unicode NFKC fold (fullwidth `ｒｍ` → `rm`, etc.),
 * - collapse shell backslash-escapes (`r\m` → `rm`, `\-rf` → `-rf`),
 * - drop empty-string literals that split tokens (`r''m` / `r""m` → `rm`),
 * - fold runs of whitespace (incl. tabs/newlines) to single spaces and trim.
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
  // Collapse backslash-escapes: `\x` → `x` (prevents `r\m -rf /` bypass).
  // Applied before empty-string stripping so `r\m` and `r''m` both fold.
  c = c.replace(/\\([^\n])/g, '$1');
  // Drop empty-string literals used to split a token: `r''m` / `r""m` → `rm`.
  c = c.replace(/''|""/g, '');
  // Fold all whitespace runs (spaces, tabs, newlines) to a single space, trim.
  c = c.replace(/\s+/g, ' ').trim();
  return c;
}
