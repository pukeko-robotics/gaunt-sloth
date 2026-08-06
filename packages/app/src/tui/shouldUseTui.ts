/**
 * Pure activation decision for the Ink TUI, factored out of the chat/code dispatcher so it
 * is unit-testable without spawning a terminal. The dispatcher gathers the live values
 * (TTY state, flags, env, config, whether `ink`+`react` actually resolve) and passes them in;
 * this function holds only the policy.
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
  /**
   * CFG-37 — the `tui` key as the layered config files set it (project over global), or
   * `undefined` when neither sets it. A boolean here is a persistent preference, NOT a capability
   * claim: it is outranked by both flags and by `GTH_NO_TUI`, and it can never defeat the hard
   * gates above it.
   */
  configuredTui?: boolean;
}

/**
 * CFG-37 — the precedence chain, strongest first. It is written as one straight-line sequence of
 * returns so the ranking is the reading order, and every rung is pinned by its own test:
 *
 *   1. hard capability gates (ink missing · no TTY · `TERM=dumb`)
 *   2. the `--tui` / `--no-tui` flags
 *   3. the `GTH_NO_TUI` escape hatch
 *   4. the `tui` config key (project layer over global, resolved by the caller)
 *   5. auto-detect (the CI heuristic, then opt in)
 *
 * The gates sit above the preferences because they answer "can this terminal run Ink?", not "what
 * would the user like?" — so `tui: true` (or `--tui`) degrades to readline on a pipe rather than
 * forcing a mount that would crash.
 */
export function shouldUseTui(input: TuiDecisionInput): boolean {
  // 1. Hard requirements — Ink needs a real TTY on both ends and the optional deps present.
  if (!input.inkAvailable) return false;
  if (!input.stdoutIsTTY || !input.stdinIsTTY) return false;
  if ((input.term ?? '').toLowerCase() === 'dumb') return false;

  // 2. The flags are the most explicit thing the user can say, so they answer outright — including
  //    over `GTH_NO_TUI`, which is the persistent escape hatch a one-off `--tui` is meant to lift.
  //    `--no-tui` is checked first so passing both still lands on the safe surface.
  if (input.noTuiFlag) return false;
  if (input.tuiFlag) return true;

  // 3. The environment escape hatch: no config file needed, so it stays above config.
  if (input.gthNoTui) return false;

  // 4. The configured preference. Tested with `!== undefined` rather than for truthiness, because
  //    `false` is a real answer here ("always give me readline") and must not read as "unset".
  if (input.configuredTui !== undefined) return input.configuredTui;

  // 5. Auto-detect. CI is treated as non-interactive; `--tui` (rung 2) and `tui: true` (rung 4) are
  //    the deliberate overrides for a user who really is on an interactive shell that sets CI.
  if (input.ci) return false;

  return true;
}
