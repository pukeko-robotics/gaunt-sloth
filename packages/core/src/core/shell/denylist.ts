/**
 * @module core/shell/denylist
 *
 * **Command segmentation** — splitting a command into every command a shell would actually run.
 *
 * This is what lets a restrictive rule (`deny`, `escalate`) see inside a compound command. The
 * asymmetry it serves lives in `core/approvals/matcher.ts`, which is the one comparison engine:
 *
 * - **No allow entry matches a command that does not statically resolve.** Composition,
 *   substitution and redirection are a non-match for every allow entry, so a grant can never be
 *   extended with a `; rm -rf /`.
 * - **A deny or escalate entry MAY match one**, and is compared against every segment as well as
 *   the whole string, because a prohibition that catches something unresolvable errs in the
 *   direction that costs nothing. Without that, `git push --force; ls` would sail straight past a
 *   declared deny entry for `git push --force` — a prohibition any trailing `; ls` defeats is not a
 *   prohibition.
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
 * Case is preserved because the matcher folds it per list and per matcher — a `regexp` entry is
 * compiled exactly as the user wrote it, and folding here would decide that for it.
 */
export function commandSegments(command: string): string[] {
  return normalizeCommand(command)
    .split(SEGMENT_SPLIT_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}
