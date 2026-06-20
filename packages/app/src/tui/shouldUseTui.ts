/**
 * Pure activation decision for the Ink TUI, factored out of the chat/code dispatcher so it
 * is unit-testable without spawning a terminal. The dispatcher gathers the live values
 * (TTY state, flags, env, whether `ink`+`react` actually resolve) and passes them in; this
 * function holds only the policy.
 *
 * Default is AUTO: a TUI is used when attached to a real interactive terminal with the
 * optional deps installed, and we fall back to the readline session otherwise. Any failure
 * to opt in degrades to readline — never a crash — which is also what keeps the existing
 * non-TTY integration tests on the unchanged readline path.
 */
export interface TuiDecisionInput {
  /** `process.stdout.isTTY` */
  stdoutIsTTY: boolean;
  /** `process.stdin.isTTY` */
  stdinIsTTY: boolean;
  /** `--no-tui` flag present (force off). */
  noTuiFlag: boolean;
  /** `--tui` flag present (force on where the environment can support it). */
  tuiFlag: boolean;
  /** `process.env.TERM` */
  term?: string;
  /** Truthy when `process.env.CI` is set. */
  ci: boolean;
  /** Truthy when `process.env.GTH_NO_TUI` is set (escape hatch). */
  gthNoTui: boolean;
  /** Whether `ink` + `react` resolved as optional deps. */
  inkAvailable: boolean;
}

export function shouldUseTui(input: TuiDecisionInput): boolean {
  // Hard requirements — Ink needs a real TTY on both ends and the optional deps present.
  if (!input.inkAvailable) return false;
  if (!input.stdoutIsTTY || !input.stdinIsTTY) return false;
  if ((input.term ?? '').toLowerCase() === 'dumb') return false;

  // Explicit opt-out always wins.
  if (input.noTuiFlag || input.gthNoTui) return false;

  // CI is treated as non-interactive by default; `--tui` is the deliberate override for the
  // case where a user really is on an interactive shell that happens to set CI.
  if (input.ci && !input.tuiFlag) return false;

  return true;
}
