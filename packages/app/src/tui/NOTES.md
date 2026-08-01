# TUI — deferred improvements

Running notes for the Ink TUI, captured during TUI-C1 (status bar, separators,
slash-command registry) and its dock-layout follow-up. These are polish items
intentionally left out of C1 to keep it shippable and low-risk; pick them up under
the relevant TUI cluster node (TUI-C2/C3) or as a new node where flagged.

## Pinned / full-screen dock (alt-screen) — biggest item
The whole UI grows top-down and the input dock floats directly under the
conversation, so on a tall terminal the bottom ~80% is empty (the dock is not
pinned to the terminal floor). This is inherent to Ink's default inline rendering.
Pinning the status bar + prompt to the bottom needs a full-screen/alt-screen
buffer (enter the alternate screen, fixed top scrollback region + fixed bottom
dock) — a structural change, not a tweak. Treat as its own node, not part of C1.
Watch out for: scrollback behaviour, resize handling, and keeping the `<Static>`
no-flicker guarantee.

## Full-width rules — done (TUI-C6)
`components/Rule.tsx` now spans the live terminal width instead of a fixed 40 chars.
It reads `useStdout().stdout.columns`, subscribes to the stdout `'resize'` event so the
rule re-renders at the new width (listener torn down on unmount), and falls back to 80
columns when the width is unknown (non-TTY/tests), clamped to a minimum of 1. The width
math is the pure, exported `ruleWidth(columns)` helper (unit-tested in
`spec/tui/Rule.spec.ts`); the component stays single-sourced and is still used both
between turns in `Transcript` and to bracket the input dock in `App`.

## Other small ideas
- Status bar could surface more context once available: provider/key source,
  context-token usage, elapsed time per turn.
- Slash-command UX: inline autocomplete / a `/` menu as you type (currently you
  must know the command or run `/help`). Pairs with EXT-5 (slash-command catalog).
- `SlashCommandResult` is synchronous by design; commands needing async side
  effects (e.g. `/save`) will need an effect-callback extension to the result type.

## Where the live frame sits on screen — a known gap in mouse hit-testing (TUI-C37/C40)

Mapping a click to a component needs the frame's first row in absolute screen coordinates, and Ink
does not report it: it paints wherever the cursor happens to be. Two states are known exactly, and
`MouseProvider`'s `anchor` prop selects between them:

- **Nothing committed yet** — the TUI-C13 viewport bump has homed the cursor, so the frame starts at
  row 0 with empty screen below. This is the launch state, and the one the clickable launch banner
  lives in.
- **Output has scrolled the screen** — the frame ends on the last row, so it starts at
  `rows - frameHeight`.

Between them there is a window the code cannot resolve: a couple of short turns on a tall terminal
leave the frame neither at row 0 nor at the bottom, and a click there can land a few rows off its
target. Getting it right needs the number of rows Ink has written into `<Static>`, which Ink keeps
to itself — a `<Static>`-aware count, or a one-shot cursor-position query (`ESC[6n`) when mouse is
enabled, are the two plausible routes. Worth doing before any affordance that lives *below* a
growing transcript becomes clickable; the banner is unaffected because it only exists before the
first exchange.
