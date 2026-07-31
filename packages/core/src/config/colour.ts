/**
 * CFG-30 — the single place that decides whether Gaunt Sloth emits ANSI colour.
 *
 * Everything this decision depends on arrives as an argument: no `process.env`, no `stdout`, no
 * config merge. That keeps the ladder unit-testable rung by rung without touching process globals,
 * and keeps the one mutation site ({@link setUseColour}, called from `mergeConfig`) unchanged.
 */

/** Everything the colour decision depends on. See {@link resolveUseColour}. */
export interface UseColourInput {
  /**
   * Raw `FORCE_COLOR` environment value; `undefined` when the variable is not set at all.
   * The empty string is a SET value (`FORCE_COLOR=` on the command line) and means colour on.
   */
  forceColor?: string;
  /** Raw `NO_COLOR` environment value; `undefined` when the variable is not set at all. */
  noColor?: string;
  /**
   * `useColour` as the user actually wrote it — read from the RAW config, BEFORE `DEFAULT_CONFIG`
   * is merged in. `undefined` means the user set nothing, which is what rung 3 tests for; after the
   * default merge an explicit `true` is indistinguishable from the default `true`, so this value
   * must be captured pre-merge or the rung collapses.
   */
  explicitUseColour?: boolean;
  /** Whether stdout is a terminal. Rung 4's auto-detection; stdout, not stdin. */
  stdoutIsTTY: boolean;
}

/**
 * Resolve the effective colour setting from the four-rung precedence ladder, highest wins:
 *
 *   1. `FORCE_COLOR` is set — `"0"` or `"false"` turn colour OFF, ANY other value (including the
 *      empty string) turns it ON. This rung outranks everything below it, `NO_COLOR` included.
 *   2. `NO_COLOR` is set and non-empty — colour OFF (the no-color.org convention: the variable's
 *      presence is the signal, its value is not, but an empty value does not count as set).
 *   3. `useColour` was set explicitly in config — use it verbatim.
 *   4. Otherwise auto-detect — colour ON when stdout is a terminal, OFF when it is piped or
 *      redirected, so captured output stays clean without any configuration.
 */
export function resolveUseColour(input: UseColourInput): boolean {
  // Rung 1 — FORCE_COLOR, the deliberate "I know what I am doing" override. Checked first so a
  // user can force colour through a NO_COLOR inherited from their shell profile or a CI image.
  if (input.forceColor !== undefined) {
    return !(input.forceColor === '0' || input.forceColor === 'false');
  }

  // Rung 2 — NO_COLOR (no-color.org), honoured by chalk, ripgrep, fd and delta.
  if (input.noColor !== undefined && input.noColor !== '') {
    return false;
  }

  // Rung 3 — the user's own config. Only reachable with an explicit value, never the default.
  if (input.explicitUseColour !== undefined) {
    return input.explicitUseColour;
  }

  // Rung 4 — auto-detect.
  return input.stdoutIsTTY;
}
