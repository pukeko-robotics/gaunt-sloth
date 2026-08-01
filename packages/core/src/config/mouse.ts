/**
 * TUI-C37 — the single place that decides whether the Ink TUI turns on terminal mouse reporting.
 *
 * Shaped exactly like the colour decision in `colour.ts`: everything the answer depends on arrives
 * as an argument, so the ladder is testable rung by rung without touching process globals.
 *
 * Mouse reporting is ON by default, which is what makes the TUI's clickable affordances
 * discoverable at all. The cost is real and is why the off-ramps below exist: while tracking is on
 * the terminal hands drag events to the application, so its own text selection needs a modifier
 * (Shift, or Option on macOS terminals). {@link MOUSE_SELECTION_HINT} is the one wording for that,
 * so `/help` and the `/mouse` feedback cannot drift apart.
 */

/** Everything the mouse decision depends on. See {@link resolveUseMouse}. */
export interface UseMouseInput {
  /**
   * Raw `GTH_NO_MOUSE` environment value; `undefined` when the variable is not set at all. Set and
   * non-empty means mouse OFF. This rung outranks config because it is the escape hatch that works
   * WITHOUT editing a config file — the state someone is in when their terminal mishandles tracking
   * and the session is already unpleasant to use.
   */
  noMouse?: string;
  /**
   * `useMouse` as the user actually wrote it — read from the RAW config, BEFORE `DEFAULT_CONFIG` is
   * merged in. `undefined` means the user set nothing. After the default merge an explicit `true` is
   * indistinguishable from the default `true`, so this must be captured pre-merge or the rung
   * collapses (the same trap `explicitUseColour` documents).
   */
  explicitUseMouse?: boolean;
  /** Raw `TERM`; `dumb`, empty or unset describes a terminal that cannot be expected to track. */
  term?: string;
  /** Whether stdout is a terminal. */
  stdoutIsTTY: boolean;
  /** Whether stdin is a terminal — mouse REPORTS arrive on stdin, so both ends must be a TTY. */
  stdinIsTTY: boolean;
}

/**
 * The user-facing sentence explaining how to select text while tracking is on. Terminals disagree
 * about which modifier restores native selection, so this names both rather than promising one.
 */
export const MOUSE_SELECTION_HINT =
  'To select text while the mouse is on, hold Shift (Option in some macOS terminals) while dragging.';

/**
 * Resolve mouse reporting from the four-rung precedence ladder, highest wins:
 *
 *   1. `GTH_NO_MOUSE` is set and non-empty — mouse OFF, no config file needed.
 *   2. `useMouse` was set explicitly in config — use it verbatim.
 *   3. `TERM` is unset, empty or `dumb` — mouse OFF; nothing useful can be reported.
 *   4. Otherwise — ON when BOTH stdout and stdin are terminals. A piped, redirected or captured run
 *      never enables tracking, so its bytes are identical to a run with mouse compiled out.
 */
export function resolveUseMouse(input: UseMouseInput): boolean {
  // Rung 1 — the no-config escape hatch.
  if (input.noMouse !== undefined && input.noMouse !== '') {
    return false;
  }

  // Rung 2 — the user's own config. Only reachable with an explicit value, never the default.
  if (input.explicitUseMouse !== undefined) {
    return input.explicitUseMouse;
  }

  // Rung 3 — a terminal that cannot track. Checked below config so someone on an unusual TERM that
  // does support tracking can still force it on.
  if (input.term === undefined || input.term === '' || input.term === 'dumb') {
    return false;
  }

  // Rung 4 — default on, but only for a genuine interactive terminal at both ends.
  return input.stdoutIsTTY && input.stdinIsTTY;
}
