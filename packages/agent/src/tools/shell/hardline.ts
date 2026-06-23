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
 * Patterns match the NORMALIZED command ({@link ./normalize.js}) so obfuscation
 * (ANSI/fullwidth/backslash splits/whitespace padding) cannot bypass them.
 *
 * Patterned after hermes-agent `tools/approval.py` HARDLINE_PATTERNS.
 */
import { normalizeCommand } from '#src/tools/shell/normalize.js';

// Matches a position where the shell would begin parsing a NEW command: start of
// string, after a separator (; & | newline), after `$(` or backtick, optionally
// consuming leading wrappers (sudo/env VAR=VAL/exec/nohup/setsid/time). Used by
// the shutdown-family patterns so they don't false-positive on `echo reboot`.
const CMD_POS =
  '(?:^|[;&|\\n`]|\\$\\()' +
  '\\s*' +
  '(?:sudo\\s+(?:-[^\\s]+\\s+)*)?' +
  '(?:env\\s+(?:\\w+=\\S*\\s+)*)?' +
  '(?:(?:exec|nohup|setsid|time)\\s+)*' +
  '\\s*';

/**
 * Hardline patterns: [regex, human description]. Matched case-insensitively
 * against the normalized command.
 */
export const HARDLINE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // rm -rf targeting the root filesystem (`/`, `/*`).
  [/\brm\s+(?:-[^\s]*\s+)*\/\s*\*?\s*(?:$|[;&|])/, 'recursive delete of root filesystem'],
  // rm -rf targeting protected system directories (with optional /* suffix).
  [
    /\brm\s+(?:-[^\s]*\s+)*(?:\/(?:home|root|etc|usr|var|bin|sbin|boot|lib|lib64|opt|sys|proc))(?:\/\*)?\s*(?:$|[;&|])/,
    'recursive delete of system directory',
  ],
  // rm -rf targeting the home directory (~ or $HOME).
  // Note: patterns match the LOWERCASED normalized command, so $HOME → $home.
  [
    /\brm\s+(?:-[^\s]*\s+)*(?:~|\$home)(?:\/\*)?\s*(?:$|[;&|])/,
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
