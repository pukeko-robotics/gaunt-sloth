/**
 * @module tools/shell/hardline
 *
 * Unbypassable hardline blocklist for the shell tool. These are catastrophic,
 * non-recoverable commands (wipe the root filesystem, format a disk, overwrite a
 * raw block device, fork-bomb, take the host down). They are refused inside
 * `executeCommand` itself — BEFORE spawn — so the refusal fires regardless of
 * yolo (`shellYolo`), any allow-list, or the confirmation path. yolo deliberately
 * bypasses the *confirmation*; it does NOT bypass this floor.
 *
 * Recoverable-but-costly operations (e.g. `git reset --hard`, `rm -rf ./build`,
 * `chmod -R 777 ./dir`, `curl | sh`) are intentionally NOT here — those are what
 * the confirmation dialog / yolo are for.
 *
 * Patterns match the NORMALIZED command (`@gaunt-sloth/core` `core/shell/normalize`) so
 * obfuscation (ANSI/fullwidth/backslash splits/whitespace padding) cannot bypass them.
 * The normalized form PRESERVES line breaks (EXT-55) — they are command separators, not
 * padding — so a pattern must terminate on one just as it does on `;`/`&`/`|`. Both the
 * command-position prefix ({@link CMD_POS}) and the pattern tail ({@link CMD_END}) are built
 * from the one shared `COMMAND_SEPARATOR_CLASS` in core so they cannot disagree.
 *
 * This floor is deliberately INDEPENDENT of the allow-list classifier above it: it must block
 * a catastrophic command even if every layer above wrongly decided the command was safe.
 *
 * Patterned after hermes-agent `tools/approval.py` HARDLINE_PATTERNS.
 */
import {
  COMMAND_SEPARATOR_CLASS,
  normalizeCommand,
} from '@gaunt-sloth/core/core/shell/normalize.js';

// Matches a position where the shell would begin parsing a NEW command: start of
// string, after a separator (; & | newline), after `$(` or backtick, optionally
// consuming leading wrappers (sudo/env VAR=VAL/exec/nohup/setsid/time). Used by
// the shutdown-family patterns so they don't false-positive on `echo reboot`.
const CMD_POS =
  `(?:^|[${COMMAND_SEPARATOR_CLASS}\`]|\\$\\()` +
  '\\s*' +
  '(?:sudo\\s+(?:-[^\\s]+\\s+)*)?' +
  '(?:env\\s+(?:\\w+=\\S*\\s+)*)?' +
  '(?:(?:exec|nohup|setsid|time)\\s+)*' +
  '\\s*';

/**
 * EXT-55 — the tail of a hardline pattern: the command ends here, either at end of input or at a
 * separator that starts a NEW command.
 *
 * This used to be the literal `(?:$|[;&|])`, which omitted the newline that {@link CMD_POS}
 * already listed. The two halves of this module therefore disagreed about what a separator is,
 * and `checkHardline('ls\nrm -rf /\nls -la')` returned null while `checkHardline('rm -rf /')`
 * blocked. Both halves are now built from the ONE shared
 * {@link COMMAND_SEPARATOR_CLASS} so they cannot drift apart again.
 *
 * (JS `$` without the `m` flag matches only true end-of-input, so the explicit line break in the
 * class is genuinely required; the `m` flag is NOT an alternative — it would also change `^` in
 * {@link CMD_POS}.)
 */
const CMD_END = `(?:$|[${COMMAND_SEPARATOR_CLASS}])`;

/**
 * Hardline patterns: [regex, human description]. Matched case-insensitively
 * against the normalized command.
 */
export const HARDLINE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // rm -rf targeting the root filesystem (`/`, `/*`).
  // EXT-55: built with `new RegExp` so the tail comes from the shared CMD_END, not a literal.
  [
    new RegExp('\\brm\\s+(?:-[^\\s]*\\s+)*/\\s*\\*?\\s*' + CMD_END),
    'recursive delete of root filesystem',
  ],
  // rm -rf targeting protected system directories (with optional /* suffix).
  [
    new RegExp(
      '\\brm\\s+(?:-[^\\s]*\\s+)*' +
        '(?:/(?:home|root|etc|usr|var|bin|sbin|boot|lib|lib64|opt|sys|proc))(?:/\\*)?\\s*' +
        CMD_END
    ),
    'recursive delete of system directory',
  ],
  // rm -rf targeting the home directory (~ or $HOME).
  // Note: patterns match the LOWERCASED normalized command, so $HOME → $home.
  [
    new RegExp('\\brm\\s+(?:-[^\\s]*\\s+)*(?:~|\\$home)(?:/\\*)?\\s*' + CMD_END),
    'recursive delete of home directory',
  ],
  // Filesystem format.
  [/\bmkfs(?:\.[a-z0-9]+)?\b/, 'format filesystem (mkfs)'],
  // dd writing to a raw block device.
  [/\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*/, 'dd to raw block device'],
  // Shell redirection to a raw block device (`> /dev/sda`).
  [/>\s*\/dev\/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b/, 'redirect to raw block device'],
  // Classic fork bomb `:(){ :|:& };:`.
  [/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  // chmod -R 777 / (recursive world-writable on root).
  [
    /\bchmod\s+(?:-[^\s]*\s+)*(?:-r|--recursive)\s+(?:-[^\s]*\s+)*777\s+\//,
    'recursive chmod 777 of root',
  ],
  // Kill every process on the system (`kill -1`, `kill -9 -1`).
  [/\bkill\s+(?:-[^\s]+\s+)*-1\b/, 'kill all processes'],
  // System shutdown / reboot — anchored to a command position so `echo reboot`
  // and `grep shutdown log` don't trip it.
  [new RegExp(CMD_POS + '(?:shutdown|reboot|halt|poweroff)\\b'), 'system shutdown/reboot'],
  [new RegExp(CMD_POS + 'init\\s+[06]\\b'), 'init 0/6 (shutdown/reboot)'],
  [
    new RegExp(CMD_POS + 'systemctl\\s+(?:poweroff|reboot|halt|kexec)\\b'),
    'systemctl poweroff/reboot',
  ],
  [new RegExp(CMD_POS + 'telinit\\s+[06]\\b'), 'telinit 0/6 (shutdown/reboot)'],
];

export interface HardlineMatch {
  /** Human-readable reason the command was refused. */
  description: string;
}

/**
 * Check a raw command against the hardline blocklist. Normalizes first so
 * obfuscated variants are caught. Returns the match (with a description) when the
 * command is catastrophic, or `null` when it is allowed to proceed.
 */
export function checkHardline(command: string): HardlineMatch | null {
  const normalized = normalizeCommand(command).toLowerCase();
  for (const [pattern, description] of HARDLINE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { description };
    }
  }
  return null;
}
