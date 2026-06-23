# TUI / CLI UX Guidelines (gaunt-sloth)

This document is the concrete, code-grounded ruleset for the terminal surface in
`packages/app/src/tui/` — the TUI and the plain no-TUI CLI. It **implements Project TAKAHĒ's
cross-surface Design Language** for the terminal; that design language defines the numbered
principles cited below as **DL-1 … DL-10** (the *why*), and the rules here are the *how* for the
terminal. This file is **referenced from `AGENTS.md`**, so any agent implementing TUI work is
expected to follow it.

Audience reminder: complete beginners on a budget **and** power-user DIYers, on cheap/old hardware,
local-first. Calm and plain by default; deep on demand; never silent.

> The cross-surface Design Language principles (DL-n), in brief — **DL-1** no action is silent;
> **DL-2** progressive disclosure; **DL-3** preserve the user's context (non-destructive);
> **DL-4** transparency & inspectability; **DL-5** respect the host platform; **DL-6**
> cross-surface consistency; **DL-7** legibility & graceful degradation; **DL-8** meaningful
> colour & tone; **DL-9** keyboard-first with beginner-safe defaults; **DL-10** budget &
> performance-conscious.

## Command feedback — the 3-line notice (DL-1)

Every slash command gives noticeable, explanatory feedback via the shared **`CommandNotice`**
component (`tui/components/CommandNotice.tsx`):

1. a dim full-width **`Rule`** that brackets the block off from the conversation,
2. a **bold, coloured title** line stating **WHAT happened**,
3. one or more **dim body lines** stating **HOW it affects the user**.

Rules:

- **Every command renders a notice — no command may read as "does nothing."** The one exception is
  `/exit`, which quits (the app closing *is* the feedback). `/clear` is a special case: its feedback
  is the live-frame `ClearBanner`, not a committed notice (see below).
- Build notices as a structured `SlashCommandNotice` (`{ title, lines, tone? }`) returned from the
  command's pure `run()` in `tui/slashCommands.ts`; the component renders it. Keep commands pure
  (no React, no I/O) so they stay unit-testable — `App.tsx` is the only place that turns a
  `SlashCommandResult` into state/effects.
- **State-aware copy for toggles.** A toggle's notice must describe the **resulting** state, not
  "toggled." Use the shared builders `toolsToggleNotice(expanded)` / `debugToggleNotice(visible)`,
  which take the post-toggle state and produce titles like `Tool details: on` / `Debug panel:
  hidden`. Single-source these so the slash command and the keyboard shortcut emit identical copy.
- **Tone.** `tone: 'info'` (cyan title, the default) for normal feedback; `tone: 'warn'` (yellow)
  for caution — e.g. the **unknown-command** notice, which never forwards the text to the model and
  points the user at `/help`.

## `/yolo` — session shell auto-approval (DL-4 transparency, EXT-12)

`/yolo` toggles, for the current session only, whether gated `run_shell_command` calls auto-approve
without the per-command prompt. It is **distinct from the static `shellYolo` config flag** (which
omits the tool from `interruptOn` at agent-build time and cannot change mid-session): the runtime
toggle lives at the approval-decision layer (`GthAgentRunner.toggleSessionYolo()` /
`isSessionYolo()`), so the tool stays gated and the flag is consulted at the top of
`decideToolApproval`.

- **State-aware copy.** Like `/tools` and `/debug`, the App owns the runner flag, so it flips it and
  commits the notice for the **resulting** state via the shared `yoloToggleNotice(yolo)` builder
  (`yolo ON — shell commands auto-approved this session` / `yolo OFF — approvals required`). The
  command's pure `run()` only returns `{ toggleYolo: true }`.
- **Tone = `warn` when ON.** Turning the approval gate off is a caution-worthy action, so the ON
  notice is yellow; OFF returns to `info`.
- **Tell the truth about the floor (DL-4).** The ON notice states that the **hardline safety floor
  still blocks catastrophic commands** — `/yolo` only skips the approval *prompt*, it never disables
  the unbypassable exec-time floor enforced in `GthDevToolkit.executeCommand`.
- **Session-scoped, reversible, never persisted** — nothing is written to config; toggling again
  restores approvals. The readline interactive session mirrors the same `/yolo` toggle via
  `displayWarning`/`displayInfo` (no `CommandNotice` there).

## `/clear` (DL-3 preserve context, DL-5 respect host)

`/clear` resets the session **without destroying history**:

- **Bump up, never wipe.** Write `viewportBumpSequence(rows)` (`tui/terminal.ts`): a screenful of
  newlines to scroll prior content up and out of the viewport, then `ESC[H` + `ESC[J` to land the
  fresh frame cleanly at the top. **Never emit `ESC[3J`** — that erases the terminal's scrollback
  and defeats the whole point. Native scroll and copy must survive a clear.
- **Feedback is the `ClearBanner`** (`tui/components/ClearBanner.tsx`, built on `CommandNotice`),
  rendered in the **live (non-`<Static>`) frame**. This is deliberate: pushing a committed notice
  right after `setTranscript([])` is swallowed because clearing `<Static>`'s items resets its
  internal index (TUI-C12). The banner is dropped the moment the next turn starts so it doesn't
  linger above a fresh conversation.
- **Clear resets BOTH the view and the model thread.** Wiping only the on-screen transcript would
  leave the LangGraph checkpointer's thread intact, so the model would still "remember" everything —
  a transparency lie (DL-4). Call `agent.resetThread?.()` so the model's context truly matches the
  now-empty screen, and **reset the turn counter to 0** so the status bar agrees.

## Bump-on-launch (DL-3, DL-5)

On interactive launch (**TTY only**), bump the screen with the same `viewportBumpSequence` so the
session opens at a clean top while preserving anything already in the user's scrollback. Do not bump
in non-TTY / piped contexts.

## Tool-call panels (DL-2 progressive disclosure)

Tool calls render as **collapsible panels** (`tui/components/LiveTurn.tsx`):

- **Collapsed by default:** one summary line — caret (`▸`/`▾`) + status glyph + tool name + status
  label. Status semantics: `⋯ running` (yellow), `✓ done` (magenta), `✗ error` (red) when the
  result text looks like an error. The transcript stays readable.
- **Expand on demand:** `/tools` toggles detail when idle; **`Ctrl+T`** toggles it mid-turn (gated
  on `running` so the prompt's text input doesn't eat the keystroke). Expanded panels show the
  streamed `args` and the result body.
- **Honest limitation — committed turns are frozen.** Toggling tool detail only affects the **live
  and future turns**. Committed turns live in Ink's `<Static>` and never re-fold, so an already-
  rendered turn won't retro-expand. The notice copy says exactly this ("Applies to new turns").
  Don't pretend otherwise; document it, don't paper over it.

## Markdown (DL-7 legibility & graceful degradation)

- **Stream plain, render on commit.** While a turn is streaming, render assistant text as **plain
  text** so the live region never reflows mid-chunk or garbles a half-arrived construct. Render
  markdown only once the segment is complete (`LiveTurn`'s `streaming` flag).
- **Never-crash plain-text fallback.** Use `tui/markdown.ts` `renderMarkdown`, which **never throws
  and never garbles**: content with no markdown-meaningful syntax passes through verbatim, and any
  internal error returns the original text unchanged. Keep the renderer dependency-light (chalk,
  already shipped by Ink) — don't pull in a heavyweight markdown lib (DL-10).
- The `--no-tui` / readline path must not import this module; plain/non-interactive output stays
  untouched.

## Layout: rules and the status bar (DL-7, DL-1)

- **Full-width, resize-aware rules.** Use the single-sourced `Rule` component; it spans the live
  terminal width via `useStdout().columns`, re-renders on the stdout `resize` event, and falls back
  to 80 cols (clamped to ≥1) when width is unknown. Rules delimit committed turns and bracket the
  input dock so the controls read as a distinct zone.
- **Single-line, stable status bar** (`tui/components/StatusBar.tsx`). One dim line carrying
  session context — **mode · model · turn counter · ready** — when idle; a spinner +
  `Thinking… (Esc to interrupt)` while a turn runs. Keep it to one line and free of streaming
  progress (that belongs to the live turn) so it never flickers.

## Keyboard model (DL-9 keyboard-first)

- **`Esc`** — abort the in-flight turn (only while running).
- **`Ctrl+C`** — exit the app. (The bare `exit` keyword and `/exit` also quit.)
- **`Ctrl+T`** — toggle tool-call detail mid-turn (mirrors `/tools`).
- **`Tab`** — focus the docked debug panel when visible/idle; once focused, `Tab` cycles its views
  (`Shift+Tab` reverses), `↑`/`↓` scroll one line and `PageUp`/`PageDown` page-step (arrows are the
  documented scroll keys since Mac/compact keyboards lack dedicated `PageUp`/`PageDown` — DL-9, DL-5,
  DL-7), `m` maximises, `Esc` unfocuses.
- **arrows / Enter** — select / submit in the prompt.

Defaults are beginner-safe (DL-9): tool detail collapsed, debug panel hidden — the expert opts into
depth.

## Colour & tone semantics (DL-8)

Colour is **meaningful, not decorative**. Use the shared palette consistently:

- **cyan** — informational (default notice title, inline code in markdown).
- **yellow** — warning/caution (warn-tone notices, the running spinner, list bullets).
- **green** — the user's own prompt line (`You ›`).
- **red** — error (failed tool calls).
- **magenta** — a completed tool call (and H1 in markdown).
- **dim** — secondary/contextual text: body lines, rules, the status bar, system lines.
- **bold** — the load-bearing line (the notice title; the *what*).

## `<Static>` (committed) vs the live region (DL-2, DL-10)

The TUI has two zones and the boundary is a hard design constraint:

- **Committed scrollback lives in Ink's `<Static>`** (`tui/components/Transcript.tsx`): each item
  is written **exactly once**, above the live region, and never re-rendered. This is what gives no
  flicker and clean native terminal scrollback (DL-10) — and it is **why committed turns are
  immutable.** You **cannot retro-update a committed turn** (the tool-detail limitation above is a
  direct consequence). State changes apply to the live / next turn only — say so in the copy.
- **The live region** (live turn, debug panel, `ClearBanner`, status bar, prompt) is the only part
  that re-renders. Anything that must update in place, or must survive a `setTranscript([])`, belongs
  here — not in `<Static>`.

## Copy voice (DL-1, beginner-first)

- **Concise, plain language, beginner-friendly. No jargon.** Prefer "The model no longer sees the
  prior conversation" over "context window flushed."
- **Always say what happened AND how it affects the user** — the title is the *what*, the body lines
  are the *how* (`History cleared` → "The model no longer sees the prior conversation" +
  "Scroll up to revisit…").
- Tell the user the next move when there is one ("Run `/tools` again to collapse…", "Run `/help` to
  see everything available").
- Match the tone of the existing notices in `slashCommands.ts`; don't introduce a louder or
  cuter register.

## Maintenance

These guidelines are the **TUI instantiation** of Project TAKAHĒ's cross-surface Design Language;
when the two disagree, the Design Language is the intent. Changes here flow through a **hybrid
review loop**: an AI UX-expert persona drafts and first-pass-reviews every UX-affecting change
against the DL principles, the coordinator curates, and a **human designer holds final approval**.
A cross-surface visual-QA harness (screenshot → judge) is the automated check that the rendered TUI
actually honours these rules. When adding or changing a TUI behaviour, cite the DL principle it
serves and update this doc (and, if the principle itself shifts, the cross-surface Design Language).
