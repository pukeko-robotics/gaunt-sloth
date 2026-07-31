import { applyTuiColour } from '#src/tui/colour.js';

/**
 * OPS-33 — pin the colour environment for the unit suite, so no spec depends on ambient terminal
 * capability.
 *
 * **The problem.** Specs that render Ink compare frames to un-escaped strings — e.g.
 * `expect([...lines[0]].slice(21).join('')).toBe('┏┓         ┏┓┓   ┓')` in `spec/tui/LaunchBanner`.
 * Slicing by code-point index only lines up while the frame is plain text; once chalk emits SGR
 * the escapes shift every column and six such tests across `spec/tui/{App,LaunchBanner,PromptInput}`
 * fail.
 *
 * **What actually triggers it — measured, because it was twice mis-filed as a "colour terminal"
 * bug.** Vitest runs specs in worker processes whose stdout is a pipe, and chalk's vendored
 * `supports-color` returns early on `haveStream && !streamIsTTY && forceColor === undefined`. So
 * chalk sits at level 0 however capable the parent terminal is: a real PTY (Konsole, IntelliJ)
 * with no `FORCE_COLOR` is 69/69 green. An exported `FORCE_COLOR` is the only thing that
 * overrides that check — the same PTY with `FORCE_COLOR=3` is 6 failed / 63 passed. The terminal
 * is irrelevant; the variable is the whole trigger. TUI-C35 has just made `FORCE_COLOR` a
 * documented, first-class knob, so a developer exporting it is now a blessed configuration whose
 * first effect would be turning this suite red.
 *
 * **Why this is safe everywhere it is not needed.** Under vitest chalk is *already* at level 0, so
 * clamping to 0 is an identity operation in every environment that passes today; it can only
 * change behaviour in the environment that is currently broken.
 *
 * **Why the clamp and not `FORCE_COLOR=0` in `test.env`.** They are not equivalent, and the
 * difference is not stylistic. `FORCE_COLOR=0` is a *meaningful* value on CFG-30's ladder — rung 1,
 * "colour explicitly off" — not a neutral one. Setting it globally would feed a decision into the
 * production ladder under test in every spec that does not clear it first, quietly preempting the
 * NO_COLOR / config / TTY rungs that `spec/colourPrecedence` and friends exist to exercise. Going
 * through the shipped hook touches `chalk.level` only and never `process.env`, so the ladder specs
 * are untouched. (The node listed the env pin as an acceptable alternative; measuring the two
 * showed it is not, and this comment is here so it does not get "simplified" back.)
 *
 * **Why `applyTuiColour(false)` rather than assigning `chalk.level = 0` directly.** It is the same
 * end state reached through the production mechanism, so the pin cannot drift from what the app
 * means by "colour off", and it changes what no test asserts.
 *
 * **Why this file sits beside `package.json` rather than under `spec/`.** The root vitest config
 * collects every `.ts` and `.tsx` file under any package's `spec/` directory as a test file, so a
 * helper placed there would be collected too and fail with "No test suite found in file". Living
 * inside `packages/app` is also what lets `#src/…` resolve: the workspace resolver is
 * importer-aware and maps this file to the `app` package.
 *
 * Top level rather than a global `beforeEach`, because `spec/colourCrossSurface.e2e.spec.ts` drives
 * `chalk.level` itself and restores it — a per-test hook would race that.
 */
applyTuiColour(false);
