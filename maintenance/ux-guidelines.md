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

## `/approvals` — the session's approvals mode (DL-4 transparency)

`/approvals` shows the mode the session is in and switches it: `/approvals
manual|write|assisted|auto|bypass`. There is no toggle — with five ordered modes a flip has no
unambiguous meaning — and there is no per-prompt "turn the gate down from here" affordance.

- **One set of words, everywhere.** The mode's own description comes from
  `APPROVAL_RUNG_DESCRIPTIONS`, its display spelling from `APPROVAL_RUNG_LABELS`, and the picker,
  the status notice, the text fallback and the tool-description suffixes all read those. A surface
  that authors its own sentence about a mode becomes the one that contradicts the rest.
- **Say what a mode is FOR, in at most two sentences, and let the first stand alone.** One-line
  forms render only `firstSentence`, so the opener carries the whole answer. The reasoning that does
  not fit goes to the docs page named by `APPROVAL_PROTECTION_DOCS_LINES`, printed beside the copy —
  label and bare URL as two separate lines, so a narrow pane never breaks the URL mid-path.
- **Never advertise safety the gate cannot deliver.** No description may read as containment: the
  gate protects against accidents, not intent, and a working-folder claim is true of the built-in
  file *tools* and false of the agent as a whole. Copy cites only protections the user can inspect
  and extend — the deny list — never the hardline floor.
- **Scope every claim to the session the user is in.** These strings render on terminal surfaces;
  the AG-UI and ACP servers never drain an approval interrupt, so a universal "Gaunt Sloth always
  asks" would be false.
- **Tone = `warn` at `bypass`.** Running with no gate is caution-worthy, so its notice is yellow and
  the status bar carries the unmissable **`⚡ Bypass`** badge; every other mode is `info`.
- **Choosing is a picker on a TTY, a list everywhere else.** `/approvals` with no argument renders
  `ApprovalsPicker` (four postures — Write is a modifier of Manual and stays settable by name);
  every non-TTY surface prints the same choices as text from the same builder, so the two cannot
  offer different modes.
- **Invokable during inference (DL-9).** The prompt stays mounted while a turn streams, so
  `/approvals` (and the other read-only / toggle commands marked `availableDuringRun`) can be run
  mid-turn to change how the run's remaining tool calls are handled; idle-only commands (`/clear`,
  `/exit`) are refused with a friendly notice.
- **Session-scoped, reversible, never persisted** — nothing is written to config, and the notice
  says so.

## Abstentions the agent resolves (DL-4 transparency, DL-1 nothing important is silent, EXT-65)

When the approvals gate cannot statically read a command — it composes, substitutes or redirects —
it hands the defect back to the **model** as a rejection and the user is not asked. That is the
point: `pwd && ls` is an ordinary shell idiom, the gate is the only party that cannot read it, and
prompting about it is approval fatigue with nothing behind it. But a prompt that no longer appears
is a decision the user never sees, so the transparency has to move somewhere rather than vanish.

- **Count it and show the aggregate (DL-4).** The read-only `/approvals` display carries the
  session's abstention count. It is the near-miss signal the gate produces most often, and before
  this it was invisible — an approval the user was spared is still an approval that happened.
- **One retry, then the user (DL-1).** A second *consecutive* abstention escalates as before.
  Silence is affordable exactly once, because the retry is a search toward a command the gate can
  read; past that the user is the only party who can settle it.
- **The count is consecutive, not per-session (DL-9 beginner-safe defaults).** A per-session count
  would make the second legitimate composed command of a long session prompt, which inverts the goal
  the feature exists to serve.
- **Never present an abstention as a rating (DL-4).** It is the checker declaring its own limit, not
  a judgement about the command, and wearing the auto-rater's name for it teaches the user to blame
  the wrong layer. The escalation prompt still does this; TUI-C26 owns the fix.

## `/clear` (DL-3 preserve context, DL-5 respect host)

`/clear` resets the session:

- **Empty the buffer, write no escapes.** The transcript is a buffer the app owns, so
  `setTranscript([])` IS the clear — the viewport re-renders with nothing in it. `/clear` must not
  write terminal escapes at all: there is no scrollback in the alternate screen to scroll content
  into, so a scroll-and-clear sequence would be motion with no meaning.
- **Say that it is a deletion.** The banner must not offer to let the user scroll up and revisit
  the conversation; that was true when the transcript was the terminal's own scrollback and is
  false now, and confirming something that did not happen is a DL-4 failure.
- **Feedback is the `ClearBanner`** (`tui/components/ClearBanner.tsx`, built on `CommandNotice`).
  It is dropped the moment the next turn starts so it doesn't linger above a fresh conversation.
- **Clear resets BOTH the view and the model thread.** Wiping only the on-screen transcript would
  leave the LangGraph checkpointer's thread intact, so the model would still "remember" everything —
  a transparency lie (DL-4). Call `agent.resetThread?.()` so the model's context truly matches the
  now-empty screen, and **reset the turn counter to 0** so the status bar agrees.

## The full-screen dock (DL-3, DL-5, TUI-C48)

The interactive TUI renders into the **alternate screen** (`render(…, { alternateScreen: true })`),
with the status bar and prompt pinned to the terminal floor and the conversation in a viewport above
them. Three rules hold it up:

- **Entering and leaving the alternate screen is Ink's job, not ours.** Ink restores the primary
  buffer and the user's original content on unmount, a thrown error, `process.exit`, an uncaught
  exception and SIGINT/SIGTERM/SIGHUP, and correctly no-ops the whole thing on a non-interactive or
  non-TTY stream. Do not write a second teardown path beside it.
- **A frame must never be taller than the terminal.** The root box is laid out to exactly the
  terminal height. A taller frame does not error — it loses its top rows off the top of the screen,
  which reads as missing content and nothing reports it.
- **Anything the user must keep is written AFTER unmount.** Ink treats alternate-screen teardown
  output as disposable, so a final summary or error written during unmount never reaches the
  restored screen.

## Mouse modes and on-screen selection (DL-5 respect the host, TUI-C37, TUI-C48)

The TUI requests exactly two mouse **tracking** modes: **`1000`** (normal button tracking) and
**`1006`** (SGR extended encoding). `1006` is a correctness requirement rather than a feature — the
legacy encoding cannot express a column past 223, so without it clicks on the right of a wide
terminal report the wrong cell. Those two are not the only DECSET modes it writes, and a reader who
takes the count literally will not find the third: `mouseReporting.ts` also turns **alternate scroll
(`1007`) off**, and restores it on every exit path. That one is installed exactly when tracking is
**off** — with tracking on the wheel arrives as an SGR event and alternate scroll never applies,
while with tracking off the terminal would otherwise translate wheel notches into bare arrow keys
indistinguishable from a real arrow press.

**`1002` (button-event tracking) is deliberately not requested, and dropping it does not buy
selection back.** Measured in **Konsole 26.04.3 on X11/xcb**, with drags synthesised through XTEST
and the selection read out of the X11 PRIMARY buffer. That is one terminal family and the behaviour
below is not known to be universal — kitty, Ghostty, VTE, iTerm2 and Windows Terminal are unmeasured,
as is whether macOS Option-drag is the override there:

- With `1000 + 1006` and **no** `1002`, a plain drag produces **no selection**. `1000` alone is
  already enough for the terminal to swallow the button press and refuse to start one.
- **Shift+drag does select**, under both mode sets and in both the primary and the alternate screen
  buffer.

So the reason to leave `1002` out is cost, not selection: nothing in the codebase consumes a drag,
and it would be a dozen decoded-and-discarded reports per gesture. And **the answer to "why can't I
select text any more" is Shift+drag** — every place that tells a user about mouse reporting says so,
because the moment someone reaches for `/mouse` is the moment they are trying to copy something. The
user-facing wording adds "Option in some macOS terminals"; that is inherited convention, not a
measurement, and it belongs in the unmeasured set above.

Two consequences worth stating rather than rediscovering:

- **Selection is on-screen only.** The alternate screen has no scrollback, so conversation the
  reader has scrolled past cannot be dragged over; it has to be scrolled back into view first.
- **Wheel-to-scroll requires tracking to stay on for the whole session.** Any future scheme that
  enabled reporting only while something clickable was on screen would take the wheel away from the
  conversation, which is now a primary navigation gesture.

## Launch banner (DL-6 cross-surface consistency, DL-7 graceful degradation, TUI-C33)

Interactive sessions (`chat`, `code`) open with an ASCII-art banner — a magenta sloth face beside the
`GAUNT SLOTH` wordmark, the version, the model/provider and the working directory — printed **above**
the ready message.

- **Interactive only, TTY only.** `chat` and `code`, and only when `stdout.isTTY`. The one-shot verbs
  (`ask`, `review`, `pr`, `get`, `eval`, `batch`, `api`, `init`) pipe their stdout into files, diffs
  and CI, where a banner is corruption. It is also **not** written to the session log: that log is a
  transcript, not a screenshot.
- **An intro, not a fixture (DL-2).** It renders under the same `showIntro` condition as the ready
  message, so it greets the user on arrival and stops occupying rows once the conversation starts.
- **One pure layout module, two thin renderers (DL-6).** All the geometry lives in
  `@gaunt-sloth/core/core/launchBanner.js`; the TUI maps its rows to `<Text>` and the plain surface
  emits its string through `displayLaunchBanner`. The two surfaces cannot drift, and the column maths
  is unit-tested without a terminal — the same split as `ruleWidth` vs `Rule`.
- **Nothing may wrap (DL-7).** A wrapped line restarts at column 0 and collides with the face, so
  every dynamic field is bounded by the width left on its own line. The model/provider and directory
  lines **truncate** with `…` (the directory from the *left*, keeping the informative leaf); the
  **version is dropped instead of truncated**, because `v2.0…` reads as a real, different version
  rather than as a clipped one, and a wrong version in a bug report costs more than an absent one.
  Below 45 columns the right-hand column is dropped and the face prints alone; an unknown width falls
  back to 80.
- **Colour is the 16-colour `magenta` slot and nothing else (DL-7, DL-8).** That slot adopts the
  user's own terminal theme violet, so the sloth looks native in light and dark schemes alike — never
  a 256-colour or 24-bit escape. The right-hand column carries no escape at all, and with colour off
  the banner is plain text with zero escape sequences. **"Colour off" means the same thing on both
  surfaces (DL-6).** One ladder decides it — the CFG-30 `config/colour.ts` (`FORCE_COLOR`, then
  `NO_COLOR`, then an explicit `useColour`, then stdout's TTY status; documented for users in
  [Output & files](../docs/configuration/output.md#colour-usecolour-no_color-force_color)) — and the
  TUI consumes that answer rather than deriving its own. It has to: chalk's own detection reads
  `FORCE_COLOR` but **not** `NO_COLOR`, in any version, so left alone the TUI stayed coloured under
  `NO_COLOR=1` while the plain surface went monochrome. TUI-C35 closed that with a single startup
  hook (`tui/colour.ts`) that clamps the shared chalk instance from the resolved config before the
  first render; agreement is pinned by `packages/app/spec/colourCrossSurface.e2e.spec.ts`.
- **A new TUI colour path must go through that hook, never around it.** Do not add a second read of
  `NO_COLOR`/`FORCE_COLOR` anywhere under `tui/`, and do not give Ink its own chalk: the hook works
  only because Ink and our markdown renderer share one physical chalk module, which the scoped
  `ink>chalk` / `ink-text-input>chalk` overrides in `pnpm-workspace.yaml` exist to guarantee. The
  clamp is **downward only** — colour off means level 0, colour on keeps whatever depth chalk
  detected (floored at basic 16-colour when it detected none), and never promotes a terminal to a
  depth it did not report.

## Tool-call panels (DL-2 progressive disclosure, DL-4 transparency)

Tool calls render as **collapsible panels** (`tui/components/LiveTurn.tsx`), with the per-tool
rendering supplied by the **surface-agnostic tool-display registry** (TUI-C30,
`@gaunt-sloth/core/core/toolDisplay.js`) that the plain surface shares (DL-6 consistency):

- **The call line carries the params inline, shortened** — `▸ ✓ 📁 read_file(path=README.md)
  [done]`: caret (`▸`/`▾`) + status glyph + registry glyph + `name(arg=val, …)`. Values are
  whitespace-collapsed, per-value truncated with `…`, the whole summary capped, and
  **secret-redacted** via the GS2-47 `redactSecrets` lineage — never a raw JSON dump (DL-4
  without noise). Status semantics: `⋯ running` (yellow), `✓ done` (magenta), `✗ error` (red),
  driven by the real `isError` signal (TUI-C7), never sniffed from text.
- **Collapsed panels preview the output inline (TUI-C30).** Up to the **canonical 10 lines** of
  the tool's output render as greyed/dim text directly below the call line, with a
  `… (+N more lines)` overflow marker — the head of the story is inspectable without expanding
  (DL-2 with a transparent default; DL-10: a hard cap keeps long outputs cheap). The 10-line cap is
  the only preview length for **tool output**, on both surfaces; it is a render-time cap, separate
  from the model-facing EXT-9/OutputBuffer caps.
- **The streaming `💭 Thinking` panel previews its newest TWO lines, and that number is its own.**
  It is deliberately not the tool-output cap above, and the two must not be harmonised: tool output
  is a discrete artefact you go and inspect, so ten lines is how much of it is worth having in
  front of you, while reasoning is ambient and continuous — it streams for as long as the model
  thinks, it is superseded by the answer, and collapsed its whole job is to say "something is
  happening, and it is about this". Ten would let thinking take over the screen the panel collapses
  to stay out of. The preview follows the stream (always the newest lines) and is **live-only**: a
  committed turn's collapsed panel is its header alone, unchanged.
- **`write_file`/`edit_file` render as a diff, not a dump.** The change is derived from the tool's
  args — added lines green with a `+` prefix, removed lines red with `-` (DL-8 colour semantics);
  the prefixes keep the diff readable on monochrome terminals (DL-7).
- **Expand on demand:** `/verbose` (GS2-8 rename of `/tools`, which is removed — no alias)
  toggles detail (it is `availableDuringRun`, so it works idle **and**
  mid-turn); **`Ctrl+T`** is the keyboard shortcut for the same toggle, and it is bound in every
  state for the same reason `/verbose` is — a reader paging back over the conversation wants an
  earlier turn's arguments and results, which is exactly when no turn is running. Expanded panels show
  the FULL body: the raw streamed `args`, the routed `🔧 Executing …` notice (expanded-only chrome,
  kept off the collapsed preview), and the uncapped output/result — **deduped** for shell-shaped
  calls whose result's `<COMMAND_OUTPUT>` body repeats the live output (the live output renders
  once, plus the closing status line).
- **Toggling tool detail applies to the whole conversation on screen.** Committed turns are
  ordinary components in a viewport the app owns, so they re-fold with the live one, and the notice
  copy says exactly that. Keep the copy matched to what the toggle actually reaches — a state-aware
  notice that overstates or understates its scope is the DL-4 failure it exists to prevent.
- **The checklist tool renders as a live plan panel.** A `gth_checklist` tool call is NOT shown as a
  generic collapsible panel: it renders a dedicated, always-expanded `📋 Checklist (done/total)` list
  with per-item checkboxes (`[x]` green completed, `[~]` yellow in-progress, `[ ]` dim pending). The
  plan is the point of the tool, so it stays visible (DL-2 discloses the *plan* directly; DL-8 colour).
- **Live tool output stays inside the managed frame (TUI-C17, DL-4 transparency).** A custom/dev
  tool's streamed child stdout/stderr (and its `🔧 Executing …` notice) is routed through the
  tool-output channel as typed `tool_output` events and folded into the call's panel — never
  written to raw `process.stdout`, which would print out of order above the agent message, corrupt
  Ink's frame, and vanish on re-render. Living in the view-model (`output`, with the notice on the
  separate `notice` field), it survives re-renders and feeds the collapsed preview live.

**The plain (no-TUI) surface gets the equivalent compact indication (TUI-C30, DL-6).** On
`--no-tui`/piped/single-shot runs, when a tool call completes,
`core/plainToolIndication.ts` prints `✓ 📁 read_file(path=README.md)` + the SAME 10-line greyed
preview (and the same args-derived diff colouring for `write_file`/`edit_file`) built from the
same registry. Stream discipline: it is emitted at **INFO level** on stdout — the same
`consoleLevel` gate and session-log treatment as the historical `📁`/`🔧` tool notices, so
scripted consumers that silence INFO chatter silence it too. Colour only on a colour-enabled
TTY; **non-TTY/piped output degrades to clean monochrome** with `+`/`-` diff prefixes intact
(DL-7). Shell-shaped results (whose live output already streamed raw via the tool-output
channel's default sink) show only the closing status line — never a repeat of output the user
just watched.

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
  already shipped by Ink) — don't pull in a heavyweight markdown lib (DL-10). It is a plain
  string→string module: it takes its width from `tui/ruleWidth.ts`, **not** by importing a
  component, so nothing drags React/Ink into a renderer that has to stay cheap and total.
- **Fenced code is primary content, not chrome.** Frame fences with dim top/bottom rules (language
  tag inlaid on the top rule when present) and a **two-space** indent on body lines. Emit body
  lines at **default foreground** — do not grey or dim the payload; that is what makes a committed
  answer look degraded the moment streaming ends. Dim is for secondary chrome only.
- **One bar for every divider.** Fence rules and a markdown `---` are the same full-width dim `─`
  bar, sized by `ruleWidth` — the same math behind the `Rule` component. A divider inside a
  committed answer must line up with the ones bracketing turns, not fall visibly short of them.
- The `--no-tui` / readline path must not import this module; plain/non-interactive output stays
  untouched.

## Layout: rules and the status bar (DL-7, DL-1)

- **Full-width rules.** Use the single-sourced `Rule` component; it spans the terminal width via
  `useStdout().columns` and falls back to 80 cols (clamped to ≥1) when width is unknown. Rules
  delimit committed turns and bracket the input dock so the controls read as a distinct zone.
  Anything else that draws a full-width bar takes its width from the same `ruleWidth` math.
- **The whole frame follows a resize.** Everything on screen is a mounted component, so a rule
  drawn between two committed turns re-renders at the new width along with the dock. `App` tracks
  the terminal height the same way `Rule` tracks the width — from the stdout `resize` event —
  because Ink relays out on `SIGWINCH` without re-rendering React, and a frame that keeps its old
  height is either short of the floor or overflowing the screen.
- **Single-line, stable status bar** (`tui/components/StatusBar.tsx`). One dim line carrying
  session context — **mode · model · turn counter · ready** — when idle; a spinner +
  `Thinking… (Esc to interrupt)` while a turn runs. Keep it to one line and free of streaming
  progress (that belongs to the live turn) so it never flickers. It names the approvals mode in its
  display spelling, and at `bypass` additionally carries the yellow **`⚡ Bypass`** badge in both
  states (see `/approvals`).

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
- **A standing line in the pinned dock.** When there is at least one advisory, `NoticeBar` renders
  a single yellow line by the status bar: `⚠ Your config has problems · type /config to see
  details`. It lives in the dock (like the status bar and the `⚡ Bypass` badge), so it
  stays on screen and survives transcript growth rather than scrolling out of the conversation
  region. A clean config renders nothing (no advisories, no line), so the chrome is unchanged when
  there is nothing to say.
- **The pointer resolves to the detail (DL-2 progressive disclosure).** The standing line is a
  compact pointer, not the full text; `/config` renders the actual validation warnings above the
  resolved summary (and flips to `warn` tone while warnings are present), so the user gets the
  orienting line in the chrome and the specifics on demand. This mirrors how `/reasoning` and the
  debug panel keep depth one keystroke away.
- **Colour (DL-8).** Yellow + `⚠` for the standing line and `warn` tone for the `/config` block,
  matching the caution register the rest of the chrome already uses for warnings.

## Keyboard model (DL-9 keyboard-first)

- **`Esc`** — one key, three meanings, resolved by what currently owns the keyboard, in this order:
  a pending shell approval answers it (rejecting, fail-closed); a turn in flight is aborted; the
  focused debug pane clears its search or unfocuses; otherwise the conversation returns to the
  newest output. The order is the specification, not an artefact of where the branches sit.
- **`Ctrl+C`** — exit the app. (The bare `exit` keyword, `/exit` and `/quit` also quit.)
- **`Ctrl+T`** — toggle tool-call detail, running or idle (mirrors `/verbose`).
- **A control chord never types its letter, and never moves the message under it.**
  `ink-text-input` claims only `Ctrl+C` and inserts the letter of every other chord, so the prompt
  keeps the whole class out of its buffer (`PromptInput.tsx`). Without that, each keybinding the app
  adds also drops a stray character into whatever the user was part-way through writing — and gating
  a binding on "a turn is running" does not avoid it, because the prompt stays mounted while a turn
  streams. **Refusing the value is only half the job**: the text input commits its cursor offset
  before it asks whether the value may change, and repairs an out-of-range offset only from an
  effect keyed on that value, so a refusal alone leaves the cursor past the end of the buffer, erases
  it from the screen and makes every later keystroke insert one place early. The prompt therefore
  remounts the input on a refused chord, which re-derives the offset from the value. The cost is
  that a cursor the user had moved into the middle of the buffer returns to the end — visible, and
  recoverable with the arrow keys; the line editor (TUI-C25) owns the cursor and settles it properly.
- **`o` / `s` / `a` / anything-else** at a pending shell approval — approve once / session / always
  / reject (fail-closed). `[s]` and `[a]` are offered only when there is something to remember.
  Changing the approvals mode is not one of the choices: the ladder has no "turn the gate down from
  here" action, so that decision is made deliberately with `/approvals`.
- **slash commands mid-turn** — the prompt stays mounted while a turn streams, so run-safe commands
  (`/approvals`, `/verbose`, `/debug`, `/help`, `/model`, …) work during inference; a plain message
  or an idle-only command is refused with a hint until the turn finishes.
- **`Tab`** — focus the docked debug panel when visible/idle; once focused, `Tab` cycles its views
  (`Shift+Tab` reverses), `↑`/`↓` scroll one line and `PageUp`/`PageDown` page-step (arrows are the
  documented scroll keys since Mac/compact keyboards lack dedicated `PageUp`/`PageDown` — DL-9, DL-5,
  DL-7), `m` maximises, `Esc` unfocuses.
- **`/` in the focused debug pane** — a `less`-style incremental search over the current tab (see
  *Debug pane search* below). `/` here means "search this pane", **not** the app slash line — that
  is safe because the prompt is unmounted while the pane is focused, so the two `/` meanings never
  contend (DL-9 keyboard-first, DL-4 inspectability).
- **Scrolling the conversation.** The full-screen surface owns its conversation region and the
  alternate screen has no scrollback of its own, so these bindings are the *only* way back to what
  has already been said (DL-3 — the user's content stays reachable):
  - **wheel** — three lines a notch. **Shift + wheel** — one page, and only where the terminal
    forwards Shift with the wheel: some (Konsole among them) emit the identical report with and
    without it, so the app receives a plain notch. The binding is correct; what must stay qualified
    is the promise (DL-5, DL-7 — same rule as naming `PageUp` to a keyboard that has none).
  - **`PageUp` / `PageDown`** — one page, meaning the region less a row of overlap so the reader
    keeps their place. The focused debug pane claims these keys for its own viewport first; they
    move the conversation only when it is not focused.
  - **`Ctrl+Home` / `Ctrl+End`** — the oldest and the newest output of the session.
  - **New output pins the view to the end unless the reader has scrolled up** (DL-1: the newest
    thing is what you are looking at). Scrolled up, the rows being read stay on the *same screen
    rows* while the conversation grows below them — a streaming turn must not crawl the page.
    **Typing a character**, **`Esc`** and **`Ctrl+End`** all return to the end; the character still
    reaches the prompt. `Esc` gets there only when nothing else claims it — while a turn is in
    flight the first `Esc` aborts the turn (the order above), so anything that advertises `Esc` as
    the way back to the newest output says so on the same line (DL-5).
  - **Bare `Up`/`Down` are the prompt's**, and stay the prompt's. `Ctrl+Shift+Up`/`Down` and
    `Cmd+Up`/`Down` are deliberately unbound: kitty binds the first to its own scroll, VTE and
    Windows Terminal reserve the namespace, and the second has no default terminal encoding at all.
  - **With mouse reporting off, nothing is unreachable** — the wheel is suppressed rather than
    delivered as arrow keys, and `PageUp`/`PageDown` and `Ctrl+Home`/`Ctrl+End` are the whole model
    (DL-9 keyboard-first).
  - **Name the keys honestly for keyboards that lack them** (DL-5, DL-7): a compact or Mac keyboard
    sends the identical codes from `Fn`+`Up`/`Down`, so any hint that mentions paging says so rather
    than naming a key the reader cannot find.
- **The keyboard is advertised where the user is already looking** (DL-1, DL-9). A binding nobody
  can discover is a binding nobody has, and the full-screen surface removed the one thing everybody
  already knew — the terminal's scrollback. So:
  - the hint row under the prompt names the scroll keys, and nothing more: it is a nudge, sized to
    one dim line;
  - **`/help` is the reference** and carries the whole set, **grouped by the context each binding is
    reachable in** — a flat dump would state four contradictory things about `Esc` alone — plus the
    detail the row has no room for (the `Fn`+`↑`/`↓` note, the wheel, terminal-dependent chords).
  - **Both are supplied by the surface, never by the shared layer.** The slash-command registry and
    the `exitMessage` hint string are shared with the readline session, which has no Ink components,
    no mouse layer and its own scrollback, so a key section baked into the shared formatter — or a
    scroll clause added to the shared literal — would advertise keys that do nothing there. The TUI
    passes its bindings in as data and composes its own hint fragment; readline passes nothing and
    its output is unchanged by construction (GS2-87).
- **arrows / Enter** — select / submit in the prompt.
- **multiline paste** — pasting text with newlines buffers it into the prompt intact; the embedded
  newlines do **not** submit — only an explicit `Enter` sends the whole buffered value (DL-9
  keyboard-first, DL-3 preserve the user's content, TUI-C24). The prompt enables the terminal's
  bracketed-paste mode while mounted (via Ink's `usePaste`) so a paste is captured as content rather
  than misread as keystrokes; newlines are normalized to `\n`. Rich multiline cursor editing /
  continuation-line rendering is a later step (TUI-C25) — a buffered multiline value may render
  imperfectly, but the submitted value is correct and intact (DL-7 graceful degradation).

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
- **magenta** — a completed tool call (and H1 in markdown; and the launch-banner sloth face).
- **dim** — secondary/contextual text: body lines, rules, the status bar, system lines.
- **bold** — the load-bearing line (the notice title; the *what*).

## The conversation viewport vs the dock (DL-2, DL-10)

The TUI has two zones, and which one a thing belongs in is a design decision, not a detail:

- **The conversation viewport** (`tui/components/TranscriptViewport.tsx`) holds the committed
  transcript, the streaming turn and the pre-first-exchange intro. It shows the **tail** of the
  conversation, pinned to its bottom edge, or an older part of it once the reader scrolls back, and
  mounts **only the items that can reach the visible region** — everything else is unmounted.
- **Where the bottom edge sits is a clip, never a calculation.** The block the edge cuts through
  sits in a fixed-height clipping box that draws its first rows and hides the rest, so no height
  estimate ever decides where a row lands on screen; estimates only decide how much to mount, and
  over-mounting merely costs a component the layout throws away. The edge is held as *an item plus
  how many of its rows are visible, counted from that item's top* — anchoring it to a row offset
  from the end would make it drift on every chunk of a streaming turn.
- **No height cache — and adding one is the thing not to do.** A width change re-wraps the whole
  conversation, so a cache of item heights would have to be discarded and rebuilt on every resize:
  seconds of frozen terminal on a long session. Heights are measured from the committed layout at
  the moment a gesture arrives, which costs nothing and cannot go stale. If a measurement has to
  reach render state, it needs a guard that only updates when the clamped value really differs —
  measure, clamp, render, measure is an endless re-render that no test sees and a hot CPU does.
- **The dock** (debug panel, checklist, approval prompt, advisories, status bar, prompt) is pinned
  to the terminal floor and never scrolls. Anything that must stay on screen regardless of how long
  the conversation gets belongs here.
- **On a terminal too short for the dock, the dock wins and loses its own bottom rows.** The frame
  is clamped to the terminal height, so what goes first is the dock's last row rather than the
  conversation. Measured at 80 columns: the prompt and the status bar survive down to a three-row
  terminal and the exit hint down to four; at five rows and below the conversation region has no
  rows at all, so scrolling cannot help there either. The readline surface keeps everything visible
  at those sizes because the terminal itself scrolls — a deliberate divergence (GS2-87), stated
  rather than discovered, and one that begins well below any terminal anybody works in.
- **DL-10 is a measured budget, not an assurance.** Windowing bought a cost that is **flat in
  transcript length** — a 2000-turn session renders the same work per frame as a 10-turn one,
  because the cost tracks the viewport rather than the history. What that budget does NOT cover is
  terminal *height*: a very tall terminal renders more of the conversation per frame and costs
  proportionally more. Any change here must keep the flatness, and the suite pins it by asserting
  the number of mounted transcript components stays bounded as the transcript grows.
- **Key the window by `item.id`, never by index.** With index keys React keeps one component per
  slot and swaps its props as the window advances, so nothing scrolling out is ever unmounted — the
  unmount guarantee above would be false while every test of it still passed.
- **Recall, don't retro-mutate (`/reasoning`, TUI-C18).** `/reasoning [n]` **reprints** a past
  turn's thinking as a *fresh* committed block. No number recalls the most recent turn that recorded
  thinking; `<n>` recalls that 1-based turn (out-of-range / no-thinking give a friendly notice). The
  reprint reuses the same `ReasoningPanel` (💭 + cyan `│` gutter, DL-8) so a recalled block looks
  identical to the original, tagged `Thinking · turn <n> (recalled)`. It is `availableDuringRun`
  (read-only recall, DL-9). Recall keeps the request and its answer next to each other at the bottom
  of the conversation, where the user is looking, instead of changing something they have scrolled
  away from.

## Copy voice (DL-1, beginner-first)

- **Concise, plain language, beginner-friendly. No jargon.** Prefer "The model no longer sees the
  prior conversation" over "context window flushed."
- **Always say what happened AND how it affects the user** — the title is the *what*, the body lines
  are the *how* (`History cleared` → "The model no longer sees the prior conversation" + "The
  earlier messages are gone from this session too").
- Tell the user the next move when there is one ("Run `/verbose` again to collapse…", "Run `/help` to
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
