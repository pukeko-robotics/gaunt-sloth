import chalk, { type ChalkInstance, type ColorSupportLevel } from 'chalk';

/**
 * TUI-C35 — teach the Ink TUI the colour decision `core` already made.
 *
 * The plain readline surface asks `resolveUseColour` (the CFG-30 four-rung ladder:
 * `FORCE_COLOR` > `NO_COLOR` > explicit config > stdout auto-detect). The TUI never asked
 * anybody: it renders through Ink and through {@link import('#src/tui/markdown.js')}, both of
 * which call `chalk`, and chalk decides for itself from its vendored `supports-color`. That
 * module reads `FORCE_COLOR` and the `--no-color` CLI flag and nothing else — it has never
 * implemented `NO_COLOR`, in 5.6.2 or in 6.0.0 (measured by grepping the published package).
 * So `NO_COLOR=1` blanked the plain surface and left the TUI fully coloured.
 *
 * This module is the whole fix, and it is deliberately NOT a second colour policy — a second
 * policy is how the two surfaces came to disagree in the first place. It contains no ladder, no
 * `process.env` read and no TTY probe. It takes the answer someone else resolved and pushes it
 * into the one knob that reaches every renderer: `chalk.level` on the shared instance.
 *
 * **Why one knob is enough.** Ink imports the same `chalk` default export we do (`colorize.js`
 * and `render-border.js` both `import chalk from 'chalk'`), and under the scoped `ink>chalk` /
 * `ink-text-input>chalk` overrides in `pnpm-workspace.yaml` that resolves to the very same
 * physical module as the app's. Mutating it therefore clamps every `<Text color>` Ink paints as
 * well as our markdown styling. Break the single-module property and this hook silently covers
 * only half the screen, which is why the overrides carry a comment saying so.
 *
 * chalk is an `optionalDependency`, so the static `import chalk` above confines this module to
 * the lazily-imported TUI subtree. Nothing on the readline path may import it.
 */

/**
 * The level the clamp leaves chalk at, given what chalk's own detection produced.
 *
 * **Clamps DOWN only.** Colour off means level 0, full stop. Colour on does NOT mean "turn
 * everything up": chalk's detection already knows what the terminal can render, and overriding
 * that upward would promote a basic-16 terminal to truecolor and emit escapes it cannot show.
 * The single exception is a floor at 1, for the case where the ladder says colour is wanted but
 * detection found none — `FORCE_COLOR` into a pipe, which is the entire reason that variable
 * exists. Levels 2 and 3 are returned only when detection had already reached them.
 */
export function clampedChalkLevel(
  detected: ColorSupportLevel,
  useColour: boolean
): ColorSupportLevel {
  if (!useColour) return 0;
  return detected === 0 ? 1 : detected;
}

/**
 * The TUI's startup colour hook. Call once, before anything renders, with the resolved
 * `useColour` — `config.useColour` on the configured path, or `resolveUseColour(...)` where no
 * config has been loaded. Never re-derives the decision itself.
 *
 * Writes only when the level actually changes, so the common "colour on, terminal already
 * detected" case leaves chalk exactly as it was. chalk 6 made `level` a validating accessor that
 * THROWS on anything but an integer 0–3, so {@link clampedChalkLevel} is typed to that union and
 * every value it can return is legal.
 */
export function applyTuiColour(useColour: boolean, instance: ChalkInstance = chalk): void {
  const target = clampedChalkLevel(instance.level, useColour);
  if (target !== instance.level) instance.level = target;
}
