# TUI — deferred improvements

Running notes for the Ink TUI, captured during TUI-C1 (status bar, separators,
slash-command registry) and its dock-layout follow-up. These are polish items
intentionally left out of C1 to keep it shippable and low-risk; pick them up under
the relevant TUI cluster node (TUI-C2/C3) or as a new node where flagged.

## Full-width rules — done (TUI-C6)
`components/Rule.tsx` now spans the live terminal width instead of a fixed 40 chars.
It reads the width from `useTerminalSize()` — the frame's single shared stdout `'resize'`
subscription, published by `<App>` through context, because a rule is mounted per separator
and per notice and one subscription each would make Node's listener count a function of how
much conversation is on screen. It falls back to 80
columns when the width is unknown (non-TTY/tests), clamped to a minimum of 1. The width
math is the pure, exported `ruleWidth(columns)` helper (unit-tested in
`spec/tui/ruleWidth.spec.ts`); the component stays single-sourced and is still used both
between turns in the transcript viewport and to bracket the input dock in `App`.

## Other small ideas
- Status bar could surface more context once available: provider/key source,
  context-token usage, elapsed time per turn.
- Slash-command UX: inline autocomplete / a `/` menu as you type (currently you
  must know the command or run `/help`). Pairs with EXT-5 (slash-command catalog).
- `SlashCommandResult` is synchronous by design; commands needing async side
  effects (e.g. `/save`) will need an effect-callback extension to the result type.
