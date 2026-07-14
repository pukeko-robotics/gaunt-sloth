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

## `/auto-approve` — session shell auto-approval (DL-4 transparency, EXT-12)

`/auto-approve` controls, for the current session only, whether gated `run_shell_command` calls
auto-approve without the per-command prompt. `/auto-approve on` and `/auto-approve off` set it
explicitly; a bare `/auto-approve` **toggles**. `/yolo` remains a **back-compat alias** that
toggles. The runtime flag lives at the approval-decision layer (`GthAgentRunner.setSessionYolo()` /
`toggleSessionYolo()` / `isSessionYolo()`), so the tool stays gated and the flag is consulted at the
top of `decideToolApproval`.

- **Config seeds it, but it stays toggleable (DL-4).** In interactive `code` mode the shell tool
  stays gated even when `devTools.shellYolo` pre-enables auto-approval: `GthAgentRunner.init` seeds
  the session flag ON from `shellYolo`, so the user sees no prompt by default **but can still restore
  it** with `/auto-approve off`. (Only a non-interactive `exec` / `ask --write` yolo run keeps the
  tool ungated, since its single-shot path never drains interrupts.)
- **State-aware copy.** Like `/tools` and `/debug`, the App owns the runner flag, so it applies the
  requested action and commits the notice for the **resulting** state via the shared
  `autoApproveNotice(on)` builder (`Auto-approve ON — shell commands run without asking` /
  `Auto-approve OFF — approvals required`). The command's pure `run()` only returns
  `{ autoApprove: 'on' | 'off' | 'toggle' }`.
- **Tone = `warn` when ON.** Turning the approval gate off is a caution-worthy action, so the ON
  notice is yellow; OFF returns to `info`.
- **Persistent status indicator (DL-4).** While auto-approve is ON the status bar carries an
  unmissable yellow **`⚡ auto-approve ON`** badge (both while running and idle), so the user can
  never lose track of the fact that shell commands run unprompted. Seeded from
  `initialAutoApprove` so a config-enabled session shows it from the first frame.
- **Tell the truth about the floor (DL-4).** The ON notice states that the **hardline safety floor
  still blocks catastrophic commands** — auto-approve only skips the approval *prompt*, it never
  disables the unbypassable exec-time floor enforced in `GthDevToolkit.executeCommand`.
- **Invokable during inference (DL-9).** The prompt stays mounted while a turn streams, so
  `/auto-approve` (and the other read-only / toggle commands marked `availableDuringRun`) can be run
  mid-turn; idle-only commands (`/clear`, `/exit`) are refused with a friendly notice. At the
  approval prompt itself, **`y`** turns auto-approve ON and approves the pending command in one
  keystroke — the fastest "stop asking me" path.
- **Session-scoped, reversible, never persisted** — nothing is written to config; toggling again
  restores approvals. The readline interactive session mirrors the same `/auto-approve` (and `/yolo`)
  commands via `displayWarning`/`displayInfo` (no `CommandNotice` there).

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
- **Expand on demand:** `/tools` toggles detail (it is `availableDuringRun`, so it works idle **and**
  mid-turn); **`Ctrl+T`** is the mid-turn keyboard shortcut for the same toggle. Expanded panels show
  the streamed `args` and the result body.
- **Honest limitation — committed turns are frozen.** Toggling tool detail only affects the **live
  and future turns**. Committed turns live in Ink's `<Static>` and never re-fold, so an already-
  rendered turn won't retro-expand. The notice copy says exactly this ("Applies to new turns").
  Don't pretend otherwise; document it, don't paper over it.
- **The checklist tool renders as a live plan panel.** A `gth_checklist` tool call is NOT shown as a
  generic collapsible panel: it renders a dedicated, always-expanded `📋 Checklist (done/total)` list
  with per-item checkboxes (`[x]` green completed, `[~]` yellow in-progress, `[ ]` dim pending). The
  plan is the point of the tool, so it stays visible (DL-2 discloses the *plan* directly; DL-8 colour).

## Status lines in the TUI (DL-2, DL-10)

The agent emits `statusUpdate` chatter at several levels. In the TUI, **`INFO` and `DEBUG` system
lines are suppressed** (`tui/components/App.tsx`): the agent's per-turn `INFO` output — `Requested
tools`, `Loaded tools`, `Loaded middleware`, `Workdir`, `Model`, `Thinking…` — duplicates what the
TUI already renders (live tool-call cards, the checklist panel, the status-bar spinner), so echoing it
into the transcript is redundant noise (DL-2 progressive disclosure, DL-10 budget). **`WARNING` and
`ERROR` still surface** — e.g. the experimental deepagents-backend warning — because those are signal,
not chatter (DL-1 no important action is silent). Plain (non-TUI) CLI keeps all levels via
`defaultStatusCallback`, which does its own level filtering; the suppression is TUI-only.

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
  progress (that belongs to the live turn) so it never flickers. When session auto-approve is ON it
  additionally carries the yellow **`⚡ auto-approve ON`** badge in both states (see `/auto-approve`).

## Persistent startup advisories (DL-1 nothing important is silent, TUI-C19)

Non-fatal startup advisories must not scroll out of sight the moment Ink takes over the screen. A
genuine config *error* is unmissable (`displayError` + `exit(1)` before the TUI ever renders), but a
config *warning* (an unknown top-level key, a deprecated name) is emitted once via `displayWarning`
and would otherwise vanish under the first frame. That is a DL-1 violation: the user is left unaware
their config has a problem.

- **Capture, don't let it scroll away.** The session module opens a warning-capture window
  (`beginWarningCapture` / `endWarningCapture` in `consoleUtils`) around `initConfig`, so the
  load-time validation warnings are collected as data and threaded into the TUI as the generic
  `advisories` prop. Validation itself is untouched (GS2-1 owns it); this only re-surfaces what it
  already produced. Keep the plumbing generic (a plain string list) so other non-fatal startup
  advisories can post here later without a schema change.
- **A standing line in the live chrome, OUTSIDE `<Static>`.** When there is at least one advisory,
  `NoticeBar` renders a single yellow line by the status bar: `⚠ Your config has problems · type
  /config to see details`. It lives in the live (non-`<Static>`) frame (like the status bar and the
  `⚡ auto-approve ON` badge), so it stays pinned and survives transcript growth rather than
  flushing away with the write-once scrollback. A clean config renders nothing (no advisories, no
  line), so the chrome is unchanged when there is nothing to say.
- **The pointer resolves to the detail (DL-2 progressive disclosure).** The standing line is a
  compact pointer, not the full text; `/config` renders the actual validation warnings above the
  resolved summary (and flips to `warn` tone while warnings are present), so the user gets the
  orienting line in the chrome and the specifics on demand. This mirrors how `/reasoning` and the
  debug panel keep depth one keystroke away.
- **Colour (DL-8).** Yellow + `⚠` for the standing line and `warn` tone for the `/config` block,
  matching the caution register the rest of the chrome already uses for warnings.

## Keyboard model (DL-9 keyboard-first)

- **`Esc`** — abort the in-flight turn (only while running).
- **`Ctrl+C`** — exit the app. (The bare `exit` keyword and `/exit` also quit.)
- **`Ctrl+T`** — toggle tool-call detail mid-turn (mirrors `/tools`).
- **`o` / `s` / `a` / `y` / anything-else** at a pending shell approval — approve once / session /
  always / turn on auto-approve-all (then approve this one) / reject (fail-closed).
- **slash commands mid-turn** — the prompt stays mounted while a turn streams, so run-safe commands
  (`/auto-approve`, `/tools`, `/debug`, `/help`, `/model`, …) work during inference; a plain message
  or an idle-only command is refused with a hint until the turn finishes.
- **`Tab`** — focus the docked debug panel when visible/idle; once focused, `Tab` cycles its views
  (`Shift+Tab` reverses), `↑`/`↓` scroll one line and `PageUp`/`PageDown` page-step (arrows are the
  documented scroll keys since Mac/compact keyboards lack dedicated `PageUp`/`PageDown` — DL-9, DL-5,
  DL-7), `m` maximises, `Esc` unfocuses.
- **`/` in the focused debug pane** — a `less`-style incremental search over the current tab (see
  *Debug pane search* below). `/` here means "search this pane", **not** the app slash line — that
  is safe because the prompt is unmounted while the pane is focused, so the two `/` meanings never
  contend (DL-9 keyboard-first, DL-4 inspectability).
- **arrows / Enter** — select / submit in the prompt.

Defaults are beginner-safe (DL-9): tool detail collapsed, debug panel hidden — the expert opts into
depth.

## Debug panel tabs (DL-4 inspectability, DL-2 progressive disclosure)

The docked `/debug` panel (`tui/components/DebugPanel.tsx`) is the inspectability surface (DL-4):
each tab exposes one slice of what actually shaped the turn, one keystroke deep (DL-2). The tab set,
in cycle order, is **Subagents · System prompt · Tools · MCP · Chat history · Raw response**.

- **Each tab opens with a short, plain-language description that scrolls WITH its content** (not a
  fixed header, so it costs no permanent estate; the `withDescription` idiom in `debugRender.ts`).
  A tab that overviews something another tab details **must name that other tab** so the two don't
  read as duplicates.
- **MCP tab (TUI-C20).** The MCP-server *overview*: per connected server, its discovery
  `instructions` and the tools it contributes, shown by their server-prefixed names
  (`mcp__<server>__<tool>`) with a one-line description. It renders the **same** captured
  instructions the system prompt was composed with (EXT-32's `getMcpServerInstructions()`: capture
  once, consume in both places, never a second query), so the panel can't drift from what the model
  saw (DL-4). It is deliberately **not** the tool schemas; its intro points at the **Tools** tab
  for the full description + parameter schema (DL-2: overview here, detail one tab over). A server
  that supplied no instructions shows a neutral line, and a session with no MCP servers shows a
  neutral empty state rather than a blank or a crash (DL-7 graceful degradation).

## Debug pane search (DL-4 inspectability, DL-2 progressive disclosure, DL-9 keyboard-first, TUI-C21)

The `/debug` captures (full raw response, whole chat history, full tool descriptors) are long, so
linear scroll can't find a specific string. A **`less`-style incremental search** sits over the
**shared `debugPanelLines()` line model** (`tui/debugSearch.ts`), so **every tab gets it once** — one
search over whatever the active tab rendered, never a per-tab reimplementation, and it reuses the
TUI-C11 viewport offset to jump to a match rather than re-inventing scrolling.

- **Scoped to pane focus (the seam).** `/` opens the search **only while the debug pane is focused**.
  It does not hijack the global `/` slash line: while the pane is focused the prompt is unmounted, so
  the keystroke can only reach the pane. When the pane is not focused, `/` is the app slash line as
  ever (DL-9 — one key, unambiguous by context).
- **The loop.** `/` opens a query input (case-insensitive by default); typing filters incrementally
  and highlights every match in view, jumping the viewport to the first. `Enter` confirms (keeps the
  highlights, leaves typing mode); `n` / `N` step to the next / previous match with **wrap-around**;
  `Esc` clears the search (a second `Esc`, with no active search, unfocuses the pane).
- **Always answer "where am I?" (DL-1).** A search line shows the typed query and a **match indicator
  `3/12`** (current / total), or a friendly **`no matches`** when the query has no hits — never a
  silent empty result. Matches are highlighted (yellow), the current match distinctly (cyan), so the
  eye lands on where the viewport jumped (DL-8 meaningful colour).

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
- **Recall, don't retro-mutate (`/reasoning`, TUI-C18).** Because a committed turn's thinking is
  frozen collapsed and can never re-expand in place, `/reasoning [n]` **reprints** a past turn's
  thinking as a *fresh* committed block instead of mutating the old one. No number recalls the most
  recent turn that recorded thinking; `<n>` recalls that 1-based turn (out-of-range / no-thinking
  give a friendly notice). The reprint reuses the same `ReasoningPanel` (💭 + cyan `│` gutter, DL-8)
  so a recalled block looks identical to the original, tagged `Thinking · turn <n> (recalled)`. It is
  `availableDuringRun` (read-only recall, DL-9). This is the sanctioned pattern for surfacing frozen
  `<Static>` content: emit anew, never reach back in.

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
