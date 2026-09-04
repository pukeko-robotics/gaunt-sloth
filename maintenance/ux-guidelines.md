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

### On the plain surface a notice is written to ONE stream (DL-4 transparency, DL-7 graceful degradation)

The Ink TUI paints a notice as one component, so it cannot come apart. On the readline (`--no-tui`)
surface the same notice is text on two file descriptors unless something stops it, so **every line
of one — the title and every body line — goes through `displayNotice(title, lines, options)`, which
writes the whole notice to stderr.** That covers both renderers: `printNotice` for slash commands
and `displayTermination` for why a run ended. Nothing else may write a line of one.

- **The writer takes the title and the body together, so a caller cannot split them.** The ordinary
  `display*` helpers bind colour to stream — `displayWarning` is yellow AND stderr, `display` is
  plain AND stdout — so a tone-coloured title with `display`ed body lines is one notice written
  across both. Redirect one and the reader keeps a heading with no substance while the file keeps
  the substance with no heading; neither half is wrong and neither is usable. Passing the tone as an
  argument is what decouples the two, exactly as `DialogTone` does for a dialog.
- **stderr, because a notice is commentary on the run and not the run's output.** It is where
  `displayWarning` already wrote, and that is the only one of the ordinary helpers that does — even
  `displayError`, the loudest of them, is red but goes to stdout. It is not block-buffered, and it
  leaves stdout carrying what the command produced. It also keeps a notice on the same stream as the
  approval dialog it sits beside, which two streams could reorder. The cost is the dialog's cost:
  piping stdout no longer captures a notice — the terminal still shows it, `2>` still collects it,
  and an enabled session log still records it.
- **The gate is per notice, never per line.** `display` filters at `StatusLevel.DISPLAY` and
  `displayWarning` at `StatusLevel.WARNING`, so a per-line filter is how a quieted console comes to
  print a title with nothing under it. `displayNotice` decides once, before the first line. A notice
  the user asked for by typing a command is gated at its tone's level; `gate: 'always'` is for one
  whose absence the reader cannot recover — the termination notice carries the code a bug report
  quotes, and the session log that would otherwise hold it is off by default. The session log is
  written unconditionally either way, so a quieted console never costs the transcript a notice.
- **Severity survives with no colour on the plain surface.** A `warn` notice's title carries the `⚠`
  marker the rest of the CLI already uses, applied at render time and never written into the notice
  value: the marker is presentation, and a glyph baked into the value would travel to every consumer
  of it. AG-UI keeps the classification intact by other means — it ships the whole notice object
  rather than rendered text — and so does ACP, which carries it in `_meta`; what ACP joins into one
  text block is the human-readable half, not the classification.
  **The Ink TUI is not covered:** its only tone channel is colour (a yellow-vs-cyan title), so under
  `NO_COLOR` a warn notice renders identically to an info one. That is a known TUI-C14 residual and
  this rule does not close it. Colour is the first thing a surface loses; severity that exists only
  in the colour is severity a piped or monochrome reader never receives.

## `/approvals` — the session's approvals mode (DL-4 transparency)

`/approvals` shows the mode the session is in and switches it: `/approvals
manual|write|assisted|auto|bypass`. There is no toggle — with five ordered modes a flip has no
unambiguous meaning — and there is no per-prompt "turn the gate down from here" affordance.

- **One set of words, everywhere.** The mode's own description comes from
  `APPROVAL_RUNG_DESCRIPTIONS`, its display spelling from `APPROVAL_RUNG_LABELS`, and the picker,
  the status notice and the text fallback all read those. A surface that authors its own sentence
  about a mode becomes the one that contradicts the rest. The one deliberate exception is
  `RUNG_TOOL_DESCRIPTION_SUFFIXES`, which is addressed to the **model** rather than the user and so
  carries its own wording — kept in step with the descriptions by hand, and worded per *outcome*,
  never per mode, so two modes that decide identically cannot be described differently.
- **Say what a mode is FOR, in at most two sentences, and let the first stand alone.** One-line
  forms render only `firstSentence`, so the opener carries the whole answer. The reasoning that does
  not fit goes to the docs page named by `APPROVAL_PROTECTION_DOCS_LINES`, printed beside the copy —
  label and bare URL as two separate lines, so a narrow pane never breaks the URL mid-path.
- **A qualification may not live in the second sentence alone.** The picker, the text fallback and
  the usage hint print the opener and nothing else, so a caveat parked in sentence two is invisible
  at the moment a user is choosing. An opener that promises a behavioural difference is wrong wherever
  the modes decide the same way — check a wording by rendering the surface, never by reading the
  constant.
- **Never advertise safety the gate cannot deliver.** No description may read as containment: the
  gate protects against accidents, not intent, and a working-folder claim is true of the built-in
  file *tools* and false of the agent as a whole. Copy cites only protections the user can inspect
  and extend — the deny list — never the hardline floor.
- **Scope every claim to the session the user is in — ratified 2026-08-13, and it binds every
  approvals surface written from here on.** These strings render on terminal surfaces only, each of
  them a session a person is sitting in, so "in this session" describes where the sentence actually
  appears rather than hedging around a falsehood; unscoped, a universal "Gaunt Sloth always asks"
  would be false over the AG-UI server, which never drains an approval interrupt. **The
  boundary: the moment an approvals string is rendered by a server surface this ruling stops
  covering it**, and the claim has to be re-earned there rather than inherited from the terminal.
- **Tone = `warn` at `bypass`.** Running with no gate is caution-worthy, so its notice is yellow and
  the status bar carries the unmissable **`⚡ Bypass`** badge; every other mode is `info`.
- **Choosing is a picker on a TTY, a text list off it.** `/approvals` with no argument renders
  `ApprovalsPicker` (four postures — Write is a modifier of Manual and stays settable by name); the
  readline session prints the same choices as text from the same builder, so the two cannot offer
  different modes. A surface with no slash commands — the ACP and AG-UI servers — renders neither,
  so no copy from this builder reaches a server surface, and AG-UI renders no approvals string at
  all. **ACP renders its own, though** — the permission request's title, the explanation built from
  the rater's verdict, the matched `approvals.escalate` entry and the grant preview, its four option
  labels, and the confirmation a remembering answer earns — so there the boundary above **is**
  crossed, and every claim in that copy has to be re-earned rather than inherited from here. One of
  them already is: ACP's two remembering answers are labelled *Allow and remember* and *Reject and
  remember*, the pair of scopes that reach a project file — one menu item may not mean two lifetimes
  across the three surfaces that offer it. The confirmation is re-earned in the same way and says so
  in that surface's own words: an editor has no menu key to name and no `/approvals` to point at, so
  copy that names either is copy that does not belong there.
- **A confirmation states what LANDED, and waits for it if it has to (DL-4).** The two answers that
  promise a project file — *always approve* and *always reject* — ask for something the runner may
  not be able to do: a store whose file cannot be written records the answer for this session
  instead, and reports the failure at `ERROR`. A notice written from the key that was pressed is
  therefore a claim about a file nobody has tried to write yet, and where the write fails it sits on
  screen contradicting the error beside it. So the surface reads back the lifetime the runner
  recorded and writes the notice from that. The rule generalises the toggle rule above — describe the
  resulting state, never the request — and its two corollaries are what make it safe: **the answer is
  taken immediately** (the dialog is dismissed and the next queued approval surfaces on the keystroke,
  never on the write), and **the notice is committed once, when it is known** — an optimistic line
  corrected a moment later is its own DL-4 failure, because the user has already read the first
  version. The one-shot and session answers persist nothing and need no wait.
  **This binds every surface that offers a remembering answer**, terminal and editor alike, and the
  wait is not optional anywhere: the runner reports the landed lifetime only after the approval
  callback has returned, so a surface writing its confirmation where the answer is chosen is
  describing a file nobody has tried to write. Where a surface offers the remembering control
  *unconditionally* — ACP does, so that its menu stays learnable — a third case exists that the
  terminal menus cannot reach: the gate had nothing to store, so **nothing** was remembered, not even
  for the session. That copy has to say so; *this session only* would replace one false claim with
  another.
- **A decision notice earns its place by saying what the tool row cannot, and it waits for the
  turn (DL-4) — in the Ink TUI.** Unlike the bullet above, this one is scoped, and the scope is the
  rule rather than an exemption from it: it rests on two things only the Ink TUI has, a tool row
  carrying its own outcome line and a turn committed as a single item. The row plus its outcome line
  already say a call was refused and who refused it, so the bare *the command was not run* notice is
  not written at all. What is written is a **persistent policy change**: the scope an approval took
  effect at — which is not the key that was pressed, since a `catastrophic` verdict clamps
  *[s]*/*[a]* to once — and whether a sticky refusal reached the project file, with the control that
  lifts it. Those notices are committed **after the turn's own item**, not on the keystroke: the turn
  is committed when it ends, so a notice pushed the moment a key is pressed lands above the whole
  turn it was part of and reads as though the decision preceded the work.
  **The readline surface keeps its own split and its own refusal notice.** It has neither of those
  two things — it writes chronologically to stdout, so it never had the inversion this rule fixes —
  and it still prints `Command rejected.` on an ordinary refusal, which is where that surface says a
  human answered at all. That divergence is deliberate: deleting the notice there would take the
  only trace with it. Read this bullet as the TUI's, and leave the plain surface alone.
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

## Text the model wrote (DL-4 transparency, DL-7 nothing wraps into the chrome)

A command the agent proposed and an auto-rater's `reason` are **untrusted text going to a
terminal**, where a string is not inert: a carriage return returns to column 0, an escape sequence
moves the cursor or clears the screen, and a newline alone lays down a line that looks exactly like
the surface's own chrome. A screen whose chrome can be forged by the text it is showing is not a
gate.

- **Neutralise, never sanitise, and do it once at the source.** Control and format characters become
  printable escapes (`core/shell/framing`'s `neutralizeUntrustedText`), so what the model wrote is
  still on the screen and none of it can move a cursor. Values that reach a person through an
  `Error` — the run-ending approvals stops — are neutralised where the error is BUILT, because a
  thrown stop also reaches logs, `--no-tui` stderr, the approvals archive and a CI job, and only
  some of those are terminals.
- **Every line renders inside the renderer's gutter** (`FramedLines` over
  `frameUntrustedCommand` / `frameUntrustedText`), so nothing model-authored reaches column 0.
  This is the half neutralisation cannot buy: a neutralised line is still one long line, and a
  terminal wraps a long line back to column 0 with whatever bytes sit at that offset. It is a
  render-time concern, so it belongs to the surface — an `Error.message` has no width to frame
  against.
- **Never clamp untrusted text to one line to make it safe.** The command that motivates this
  surface hid its payload fifteen lines into a commit message; a clamp throws away exactly the span
  the user is being asked to rule on, and buys no immunity — newlines forge chrome with no escape
  sequence at all.
- **Every surface uses the same renderer.** The approval dialog, the attack banner and the stop
  message are painted by one module on both the Ink TUI and the readline session, so two surfaces
  cannot come to disagree about how much of a command a person was shown.

## A dialog is written to ONE stream (DL-4 transparency, DL-7 graceful degradation)

On the readline (`--no-tui`) surface, **every line of the approval dialog and the attack banner goes
through `displayDialogLine`, which writes to stderr and takes the severity as a `DialogTone`
argument.** Nothing else may write a line of one.

- **The order of a dialog's lines is load-bearing, and two streams cannot promise it.** Only writes
  to the same stream are delivered in the order they were made. The ordinary `display*` helpers bind
  colour to stream — `displayWarning` is yellow AND stderr, `displayError` is red AND stdout — so
  colouring a dialog with them writes it across both. On a terminal both land in call order; piped
  or redirected they need not, and a reader can be shown a rater's answer above the command it
  answers.
- **stderr, because a prompt is not program output**: it is the conventional home for interaction,
  it is not block-buffered, and it leaves stdout carrying what the run produced. State the cost
  where users read about the dialog — piping stdout no longer captures it.
- **The menu line is part of the dialog**, so it is written like the rest and readline is handed an
  empty prompt. `rl.question(menu)` would put the question on readline's own output (stdout), which
  is the worst line to lose from a capture or to have arrive after the answer to it. Readline
  redraws the line it is editing, so the answer is typed on the row below the menu.
- **Not level-gated.** A dialog is a question; the level filter is per line, so gating it prints the
  parts above the threshold and drops the rest — a severity heading with no command under it. Half a
  dialog is worse than none, because it still looks like a whole one.
- **The stop message is not part of this rule.** It is the third member of the family named above,
  but it is not a dialog: nothing is asked and nothing is typed, so no answer can arrive out of
  order. Its two paths each write on one stream already — stdout inside the session loop, stderr on
  the one-shot `-m` path — and that difference is a property of the two callers, not a split within
  one message.

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
  `ink>chalk` override in `pnpm-workspace.yaml` exists to guarantee. The
  clamp is **downward only** — colour off means level 0, colour on keeps whatever depth chalk
  detected (floored at basic 16-colour when it detected none), and never promotes a terminal to a
  depth it did not report.

## The run header (DL-4 transparency, DL-6 cross-surface consistency, DL-7 graceful degradation, REL-12, GS2-95)

Every command opens with the same one-line run header, in every mode:

```text
Gaunt Sloth · review · gemini-3.1-pro-preview (google-genai)
Gaunt Sloth · exec · claude-haiku-4-5 (anthropic)
```

- **The word after the product name is the COMMAND THE USER TYPED.** Not the agent mode the run
  executes under, and not a title-case label: `review`, not `Code Review`; `eval`, not `ask`. A
  command that runs its work through another verb's mode prompt (`gth eval` through `ask`,
  `gth batch` through `exec`, `gth workflow`, `gth-batch`) supplies its own name as a **display
  label** — a field distinct from the init verb. Never rename a run by moving its init verb: that
  argument selects the mode prompt, the approvals posture and the command-specific filesystem
  config, so a copy fix made there silently changes what the agent does.
- **The agent renders; the command names.** `compactHeaderStatus` (`GthAbstractAgent`) takes the
  name it was given and never derives one. A label table inside the runtime would be the agent
  naming a user-facing surface, which is a coordinator decision.
- **No markdown prefix, in any mode.** The honest condition for a `##` is not "running under GitHub
  Actions" but "this consumer renders markdown", and those differ in both directions — the Ink TUI
  renders markdown, a GHA *job log* does not while a GHA *step summary* does. The property belongs
  to the **sink**, and one run has several at once (TUI on screen, a posted PR comment, a session
  log on disk), so no single flag can be right for all of them. Formatting a header does not justify
  a per-sink capability.
- **One line and no more.** Everything above the first line of real output pushes it down. No rule,
  box, logo, timestamp, version, or restated repo/branch/PR.
- **`compact` is the default rung, and it is the header ALONE.** An unset `output.header` resolves
  to `compact` at the read site (`GthAbstractAgent#headerRung`), so an unconfigured non-TUI text run
  opens with this one line and nothing else. The Workdir/Model/Tools/Middleware preamble and the
  interrupt hint belong to `debug`, and every one of them is emitted through `headerStatus`, which
  is the gate. A new opening line therefore has to declare which rung owns it: emitted through
  `headerStatus` it is `debug`'s, and emitted any other way it lands on `compact` too, where it is a
  second line the rung does not have.
- **The header starts at column 0, on every path.** Anything printed before it closes its own line
  first — the piped path's `reading STDIN` notice is the one that has to, and `readStdin` stops its
  `ProgressIndicator` before the command parses for exactly that reason. A notice left unterminated
  renders as `reading STDIN..Gaunt Sloth · review · …`.
- **The model half is the launch banner's spelling (DL-6).** `model (provider)`, from the shared
  `modelProviderLabel` in `@gaunt-sloth/core/core/modelLabel.js` (`launchBanner.js` re-exports it) —
  never a second spelling of the same fact on a second surface. The line itself is assembled by the
  shared `runHeaderLine` (`@gaunt-sloth/core/core/runHeader.js`), which is what keeps its two
  writers from drifting.
- **Everywhere the model is named, the provider is named beside it, through that same helper
  (DL-4 transparency, DL-6 consistency).** A model id alone is ambiguous — one name is served by
  several providers, and which one is in play changes cost, rate limits, tool-call behaviour and
  where the traffic goes. So `/status`, `/model`, `/config`, the `debug` rung's `Model:` line and
  the TUI status bar all render `modelProviderLabel`'s output, and a change to the spelling lands on
  every one of them at once. Adding another site means importing the helper, not retyping the
  format: a local `${model} (${provider})` passes every rendered-string test and is exactly how one
  surface drifts to `google-genai:gemini` while its neighbour says `gemini (google-genai)`.
- **Drop rather than mislead (DL-7).** No provider — a JS config hands us an already-built model —
  prints the bare model, with no `(unknown)` and no empty parentheses. On a review, no model drops
  the label altogether and the line ends after the command: a provider name would sit exactly where
  a model name sits and be read as one. Same rule the banner applies to a version that will not fit.

### Where `review` and `pr` emit it

- **The product emits it, never the caller (DL-4).** A review is usually read where the command that
  produced it is not visible — a pull request comment under a bot avatar, a report file attached to a
  ticket — and an unlabelled AI review there is credited to whichever AI reviewer the reader already
  knows. Emitting it from `review()` means every surface carrying the output carries the attribution:
  the terminal, the `writeOutputToFile` report, and any workflow that posts that file, with nothing
  to wire up.
- **One emission, both surfaces (DL-6).** It goes out through `display` after `initSessionLogging`
  and before the agent runs, so the session-log capture puts the same line in the report file. It is
  the **first** thing written there: nothing may precede it, because *the review opens with the
  header* is the whole rule, and a line inserted above it is the failure this exists to prevent.
- **It survives the `compact` rung.** That rung strips the technical preamble
  (Workdir/Model/Tools/Middleware) so captured stdout stays diffable, and this line is not preamble:
  it is the first line of the review document, and being emitted outside the agent it is out of
  `headerStatus`'s reach by construction. It is also why `review`/`pr` are the two commands the
  agent's own `compactHeaderStatus` stays silent for — both render the same line, so a second
  emission would print the header twice on one screen.
- **`output.header: "none"` drops it, and that is intended.** A caller piping a review into their own
  template needs a byte-clean stream, and the rung is opt-in: nobody loses attribution without asking
  for it. The gate is at the emission site in `reviewModule.ts`; `reviewHeading.ts` builds the line
  and never decides whether it is shown.

## Tool-call panels (DL-2 progressive disclosure, DL-4 transparency)

Tool calls render as **collapsible panels** (`tui/components/LiveTurn.tsx`), with the per-tool
rendering supplied by the **surface-agnostic tool-display registry** (TUI-C30,
`@gaunt-sloth/core/core/toolDisplay.js`) that the plain surface shares (DL-6 consistency):

- **A turn paints in the order it happened (DL-4 transparency, DL-3 the user's context).** A turn
  that ran think → text → tool → think → text renders as those five things, in that order: each
  explanation sits with the action it is about, and each thought sits where the model had it. The
  turn view-model therefore holds an ordered **segment list** — a run of reasoning, a run of text,
  or a tool call — rather than strings beside a tool-call array. With parallel fields there is
  nowhere to record that a run arrived *between* two calls, so every completed turn can only be
  drawn as all the thinking, then every tool, then all of the text, which puts the sentence
  explaining an action dozens of rows below it and the thought that produced the last call above
  the first. **This binds on the `💭 Thinking` panel as much as on prose:** a model that thinks,
  acts, then thinks again had two thoughts, and they are two panels at two depths, never one
  hoisted to the top with the thoughts concatenated. Every text run is rendered **independently**:
  a markdown construct split across a tool call frames itself on both sides rather than being
  re-joined across an action that happened in the middle of it.
- **An approval outcome sits on the row of the call it is about, below it (DL-4, DL-2).** When a
  human answers the gate, what stays in the conversation is one line under that call's own
  summary — *approved by you* / *rejected by you* — and the detail is behind Ctrl+T, the affordance
  the row already advertises. The line carries the decision and **no lifetime**: a scope is not
  known at the keystroke (see *A confirmation states what LANDED*), so a line written from the key
  pressed would be a claim that is sometimes corrected, and the lifetimes stay in the decision
  notice. **A decision belongs to a call, not to a turn**, and that is what makes the placement
  hold: the request block used to be committed to the transcript when the question was asked, and
  the viewport draws every committed item above the in-flight turn, so it painted above every tool
  row of the turn it interrupted — worse the longer the turn ran. A line inside its own call's
  panel has no wall to sit above and cannot drift as the turn grows. The request itself is drawn
  under the live turn while the question is open, where it is the last thing that happened and
  stays so because the run is suspended, and it is never committed on the ask.
- **A text run is only ever broken by something the reader can SEE.** What a turn *records* and
  what it *draws* are separate: `displaySegments()` (`tui/viewModel.ts`) drops the segments that
  paint nothing inside the turn — today the checklist tool, which is the pinned dock panel — and
  re-joins the text runs around them with no separator, so a re-joined run is byte-for-byte what
  the model streamed and a construct it fell inside of closes normally. The justification for
  splitting a paragraph is an action visible between its halves; a call that paints nothing leaves
  a sentence broken with no cause on screen, and the lean agent makes checklist calls mid-turn
  routinely. An **unnamed** tool call (the placeholder created when a stream mentions an id before
  naming it) *does* draw, so it does break the run — and when its name arrives and turns out to be
  the checklist tool, the panel goes and the runs join. **`displaySegments()` is the single
  definition of what a turn draws, and both the renderer and the windowing estimator
  (`tui/transcriptWindow.ts`) must go through it.** The estimator decides how much conversation the
  viewport mounts, so one that resolved any of this differently would show up as content in the
  wrong place, not as an error.
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
  to stay out of. The preview follows the stream (always the newest lines) and belongs to the
  thought being **written** — the last drawn segment of a streaming turn. A turn's earlier
  thoughts are finished, and a committed turn's collapsed panel is its header alone: a finished
  thought still previewing its tail would claim the model is still on it.
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
`ERROR` still surface** — e.g. the notice that a configured `subagents` block is not dispatched —
because those are signal, not chatter (DL-1 no important action is silent). Plain (non-TUI) CLI keeps all levels via
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
- **One blank row between blocks of sense (DL-7 legibility, DL-2 progressive disclosure).** A turn
  is a stack of blocks — a text run, a tool-call panel, a `💭 Thinking` panel — and each is
  separated from its neighbour by a single empty row. The separation goes **between** blocks and at
  neither end of a turn, so the conversation still opens flush at the top of the region and still
  ends flush on its own floor. Without this the glyph column is the only structural signal a reader
  has, and a tool's indented output sits at nearly the weight of the next block's header.
- **A rule gets the blank row too — the order is blank, rule, content (DL-7).** The two rule
  boundaries are the turn-separating rule above a `You ›` item and the rule that opens the pinned
  dock, and each opens on a row of air like every other boundary. A rule drawn hard against the
  block above it reads as the top edge of the block below rather than as the thing separating the
  two. The transcript's first item is the exception at both ends: it draws neither the rule nor the
  blank, so the conversation never opens on air or on a stray line. The dock's row belongs to the
  **dock**: at the tail of the conversation region it would draw the same picture while sitting
  inside the scrolled window and inside `transcriptWindow`'s arithmetic.
- **A blank row is a sized `<Box>` (`tui/components/BlankRow.tsx`), never an empty `<Text>`.** An
  empty `<Text>` among siblings measures zero-high in Yoga and the row silently vanishes; a
  `<Text>` holding a space would hold the row open but leave trailing whitespace. Anything that
  paints a row must also be counted in `tui/transcriptWindow.ts`, whose estimates are a deliberate
  lower bound — the failure direction is a blank band above the conversation.
- **The live turn carries the same separation as the committed one.** Geometry that appears only at
  commit time makes the whole conversation jump by a row the moment a turn finishes, including a
  view the reader has deliberately parked above the edge.
- **The prompt gets a row of air above and below it**, so the line the user types into reads as its
  own block rather than as the next line of the status bar. Both rows belong to the prompt and are
  unmounted with it whenever something else owns the keyboard — an approval prompt, the attack
  banner, the approvals picker, a focused debug pane.
- **Single-line, stable status bar** (`tui/components/StatusBar.tsx`). One dim line carrying
  session context — **mode · model (provider) · turn counter · ready** — when idle; a spinner +
  `Thinking… (Esc to interrupt)` while a turn runs. Keep it to one line and free of streaming
  progress (that belongs to the live turn) so it never flickers. It names the approvals mode in its
  display spelling, and at `bypass` additionally carries the yellow **`⚡ Bypass`** badge in both
  states (see `/approvals`).
- **The bar drops the provider before it overflows (DL-6 consistency, DL-7 graceful degradation).**
  The model half is the shared `modelProviderLabel` spelling the run header and launch banner use,
  so all three say `model (provider)` and none of them invents a second one. This is the only
  surface where that costs anything — one line already carrying the mode, the turn counter, the
  approvals badge and sometimes the debug hint — so it is the only one allowed a width-conditional
  omission. When the assembled line will not fit, `statusBarSegments` drops the **provider** and
  keeps the model, and truncates neither: the model is the half the user chose, and a clipped
  `openrou…` or `claude-sonnet-4…` misleads rather than merely shortens, which is the same reason
  the banner drops a version it cannot fit. The budget counts the badge and the hint, because they
  are separate `<Text>` nodes on the row the terminal wraps as a whole. The width decision lives in
  a pure exported function taking `columns` as a parameter, not in the render — a rule that only
  exists inside a component can only be tested by driving a terminal.

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
  - **The slash menu is a known exception, in both of its modes.** The prompt closes the menu on
    `Esc`, but the abort above does not consult the menu the way the `Tab` handler consults it — so
    `Esc` pressed to dismiss the menu while a turn is streaming closes the menu **and** stops the
    turn. Anything that advertises `Esc` as the way out of that menu has to say so.
- **`Ctrl+C`** — on the TUI, one key with three meanings, resolved most-local-first: a **modal state**
  (attack banner, pending approval, approvals picker) leaves, because that is what those screens
  promise and the run is blocked on an answer nobody is at the keyboard to give; else a **typed
  message** is scrapped into the kill slot, recoverable with `Ctrl+Y`; else a **turn in flight** is
  stopped, exactly as `Esc` stops it; else the session **exits**. (The bare `exit` keyword, `/exit`
  and `/quit` exit unconditionally.) Two reflexes meet on this key — *scrap this line* and *stop what
  you are doing* — and the buffer holds a whole composed message, so an unconditional exit spends a
  session on either of them. Modal on one key is a real cost, taken because `Esc` here is already
  modal in the same way and `/help` groups it by context for that reason. **The arbitration lives in
  exactly one handler** (`App.tsx`): Ink broadcasts every keypress to every `useInput` subscriber with
  no way to stop propagation, and the prompt is unmounted in the states where rungs 2 and 3 still have
  to work — so the prompt publishes a handle for the clear and `<App>` decides. This is the TUI
  surface only; readline's `Ctrl+C` is unchanged (GS2-87).
- **`Ctrl+T`** — toggle tool-call detail, running or idle (mirrors `/verbose`).
- **`Ctrl+G`** (and `Ctrl+/`) — open the slash-command menu **over an unfinished message**, with the
  message left alone. See the slash-menu entry below.
- **A control chord must not type its letter, and must not move the message under it.** Every text
  buffer in the TUI takes its input from one shared pair of answers in `tui/keyGuards.ts` —
  `isTypedText` for "does this event carry text at all", `typedText` for "which of it may be
  inserted" — and they all use them: the prompt's editor, the chord menu's query, `App.tsx`'s
  debug-pane search, `SelectList`'s filter. Sharing them is not tidiness: **Ink broadcasts one
  keypress to every `useInput` subscriber with no way to stop propagation**, and in the same
  synchronous dispatch, so a buffer that answers "is this text?" differently from its neighbour types
  the byte its neighbour refused. Without the guard at all, each keybinding the app adds also drops a
  stray character into whatever the user was part-way through writing; and gating a binding on "a
  turn is running" does not avoid it, because the prompt stays mounted while a turn streams.
  - **The predicate refuses a control character whatever the modifiers say, and that half is the one
    a modifier test cannot do.** Ink's ctrl+letter branch is bounded at `\x1a`, so `Ctrl+/` (`0x1f`)
    and `Ctrl+\` (`0x1c`) decode with `ctrl: false` and an `input` holding the byte; the `ESC ^C`
    residual of the hold-back filter (`mouseStdin.ts`) arrives the same way. All of them look like
    typed text to a four-modifier guard, and the symptom is an invisible byte in whatever has focus.
  - **`shift` is deliberately not refused** — it is how a capital is typed, not a different key.
    `capsLock`/`numLock` sit on the same object and are lock states, not modifiers.
  - **The refusal is per CHARACTER, because one event is not one keystroke.** Ink hands a pasted
    string over as a single `input`, and a paste is what arrives on the keystroke channel whenever
    bracketed-paste mode is off — which it is in every state where the prompt, the only holder of
    `usePaste`, is not mounted. So the control characters are removed from what is inserted and the
    rest of the text lands; refusing the whole event instead would silently discard the paste, with
    no character, no error and no way to get it back. A bare control byte still reaches nothing:
    with its one character removed there is nothing left to insert.
  - **A buffer that can hold a line break says so.** `typedText` drops `\n` with the other control
    characters because a query, a filter or a phrase is one line; `<PromptEditor>`'s message is
    drawn on as many rows as it has lines, so it asks for `typedMultilineText`, which keeps `\n`
    (normalized like a bracketed paste's) and removes everything else.
  - **A key that must survive the guard needs its own branch**, because the guard cannot know it:
    `Ctrl+J` is the byte `\n` alone, which carries no text by this answer, so `PromptEditor.tsx`
    binds it explicitly rather than letting it fall through to the insert branch.
  - **The attack banner's phrase field is the one deliberate exception, and it is stricter**
    ([[TUI-C68]] §1). It refuses the whole event when a control character is in it, because the
    character in question is the `\r` of a pasted `run anyway` line and the phrase matcher trims
    before it compares — filtering would leave the exact phrase in the buffer, one Enter from an
    irreversible command nobody typed. Losing a paste costs a retype; keeping one costs the
    command. Every other buffer takes the opposite trade, and differing from the shared answer
    anywhere else is drift.
- **`o` / `s` / `a` / anything-else** at a pending shell approval — approve once / session / always
  / reject (fail-closed). `[s]` and `[a]` are offered only when there is something to remember.
  Changing the approvals mode is not one of the choices: the ladder has no "turn the gate down from
  here" action, so that decision is made deliberately with `/approvals`.
- **The slash menu has two doors, and one menu behind them (DL-9 keyboard-first, DL-3 preserve the
  user's content, TUI-C10/TUI-C51).** Typing `/` on an otherwise-empty line filters the menu on the
  prompt buffer itself, which is why it only opens on a buffer that starts with `/` and holds no
  space. **`Ctrl+G` — or `Ctrl+/` — opens the same menu with a query of its own**, so it is reachable
  with a half-written message in the prompt, where the first door cannot open at all and clearing the
  buffer to reach it would destroy what the user wrote. In that mode the editor stands down
  completely, the message is captured and put back around the dispatch (caret included), and `Esc`
  closes leaving it as it was — mid-turn, `Esc` also stops the turn (see the `Esc` entry above).
  **Only one of the two is ever on screen.**
  - **The message comes back even when the command REPLACED the prompt while it ran.** `/approvals`
    opens a picker, and the prompt is not rendered while one is up, so a draft restored into the
    prompt's own state would be restored into something about to be unmounted and lost with it —
    with no kill-slot recovery, because nothing killed it. The snapshot is handed to a slot on
    `<App>`, which is always mounted, and the next mount of the prompt takes it back. Restoring
    only for the commands that happen to leave the prompt standing is not the promise: `/approvals`
    is the command the mid-turn notice offers as its example.
  - **The leading `/` is tolerated, never required (DL-6, DL-9).** The chord menu's query filters on
    command names, which are stored without the slash, so a query typed as `/help` is normalised to
    `help` as it is stored and a bare `/` is an empty query listing everything. A user who learned
    the commands as `/help` types the name the way they know it, and the character they typed looks
    exactly like part of the name — so an empty list there has nothing on screen to explain it.
    Exactly one slash, and only as the first text to reach a freshly opened menu. Anywhere after
    that — a query with characters in it, or one backspaced empty again — a `/` is ordinary query
    text and matches nothing, which is the honest answer. A second slash is not a spelling of
    anything, and the typed door refuses `//help` outright as a path rather than a command, so a
    chord door that dispatched it would give two doors opposite answers for the same six
    characters. **The condition is "no text has reached this query yet", not "the query is
    empty"**: a swallowed slash leaves the query empty, so the emptiness reading re-arms on every
    slash and strips an unbounded number of them, and it does so only on the keystroke path — so
    the same input typed and pasted give two different screens. Keys that reach the menu without
    putting text in it, the arrows among them, leave the strip armed.
  - **A paste while the menu is open is filtered BY the menu, never spliced into the message.**
    Both arrival shapes go to the query through one normalisation, so what a `/help` does cannot
    depend on whether the terminal wrapped it in bracketed-paste markers — a distinction the user
    neither makes nor can see. This is also what keeps the draft-preservation promise above true on
    the channel a terminal actually uses.
  - **It ships on, with no config key** — an additive chord changes nothing until pressed, and a
    discovery affordance behind a flag is not one (DL-9). `--no-tui` is the opt-out, as for the TUI
    generally.
  - **`Ctrl+G` is the binding and `Ctrl+/` is a second spelling, decided on measured emission**
    rather than on how the chord reads: `Ctrl+/` sends nothing at all on macOS, in Terminal.app and
    in Zed, while Konsole sends `0x1f`. `Alt+/` is not bound because on macOS it is the printable
    `÷`, and `Ctrl+\` is not because it shares `Ctrl+/`'s defect and is conventionally `SIGQUIT`.
  - **The chord OPENS; it never toggles.** An even number of presses would then be indistinguishable
    from none, which is how a test passes on a tree where the binding does nothing.
  - **It is not gated on a turn running.** `Ctrl+T` is, because Ink broadcasts every keypress
    everywhere; here filtering IS the mechanism and there is nothing to swallow — and composing a
    message while idle is precisely the case the door exists for.
- **slash commands mid-turn** — the prompt stays mounted while a turn streams, so run-safe commands
  (`/approvals`, `/verbose`, `/debug`, `/model`, `/status`, …) work during inference; a plain message
  or an idle-only command (`/help`, `/clear`, `/exit`, `/quit` — the ones without
  `availableDuringRun`) is refused with a hint until the turn finishes. **The gate is
  `handleSubmit`'s, not the prompt's**, so it applies identically however the command was reached —
  typed, or dispatched from the `Ctrl+G` menu.
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
    its output is unchanged by construction (GS2-87). The rule cuts the other way too: **the shared
    literal carries only what is true on both surfaces and in every state of them.** A key whose
    meaning depends on the surface, or on what the session is doing, belongs in `/help` — which
    groups by context and can say so — and not in a row that is always on screen and always the
    same. That is why the row names the `exit` keyword and points at `/help`, and names no chord.
- **Editing the message is readline's keyboard, not a text field's (DL-5 respect the host, DL-9
  keyboard-first, TUI-C25).** The prompt is a real line editor over a pure model
  (`tui/lineEditor.ts`, rendered and driven by `tui/components/PromptEditor.tsx`): `←`/`→` a
  character, `Alt`+`←`/`→` **and** `Ctrl`+`←`/`→` a word, `Ctrl+A`/`Ctrl+E` and bare `Home`/`End` the
  ends of the caret's own line, `↑`/`↓` between the lines of a multiline message. The keys are the
  ones a terminal user's fingers already know, which is the whole reason they are these keys.
  - **Every spelling ships everywhere; no branch on the platform.** The three word-motion encodings
    belong to terminal families rather than to operating systems (`Meta+B`/`Meta+F` is Terminal.app
    and Ghostty for `Option`+arrow, `Ctrl`+arrow is xterm/Konsole, `Meta`+arrow is Konsole's `Alt`+
    arrow), so an `os.platform()` check could only ever be wrong on a combination nobody measured.
    A test reads both sources to keep it out.
  - **`Home`/`End` are claimed only without `Ctrl`**, because `Ctrl+Home`/`Ctrl+End` scroll the
    conversation. A binding that ignores the modifier silently takes the other one away.
  - **`↑`/`↓` mean two things and the arbitration is stated at the branch**: the slash menu owns them
    while it is open, the buffer owns them otherwise. There is no input-history recall at this
    prompt, so the buffer's no-op on a single-line message is the end of the chain, not a
    fall-through. `/help` lists both meanings on one line for the same reason (DL-4).
  - **Every deletion is a motion's span, deleted** (TUI-C79). `Backspace`/`Delete` (and `Ctrl+D`, a
    second spelling of `Delete`) take one character each way; `Alt`+`⌫` and `Ctrl+W` take what word
    motion moves back over; `Alt`+`Delete` and `Ctrl+Delete` take what it moves on over; `Ctrl+U`
    and `Ctrl+K` take what `Ctrl+A` and `Ctrl+E` move over — the caret's own logical line. Defining
    them by the motions is what stops the pair drifting: bash and zsh already disagree about both
    `Ctrl+W` and `Ctrl+U`, so "what users expect" cannot settle it and internal coherence does.
    - **`Ctrl+D` never exits, even on an empty buffer.** readline's EOF convention is declined
      because `Ctrl+C` carries the buffer-dependent exit rule and a second exit key with a different
      one is a trap. **`Ctrl`+`⌫` is not bindable at all** — Ink's `\x08` branch sits above its
      ctrl+letter branch and blanks `input` for a backspace, so the chord is indistinguishable from
      a plain one; `Ctrl+W` is what gives a keyboard without Option-as-Meta a backward word delete.
  - **The word/line deletions and `Ctrl+C`'s clear are recoverable; the one-character ones are not
    stored** (DL-3 preserve the user's content, TUI-C79). `Ctrl+U` on a composed message removes it
    in one keystroke and `Ctrl+C` removes the whole of it, and the prompt has no undo, so the killed
    text goes to a **single slot** that `Ctrl+Y` puts back at the caret. One slot, not a kill ring.
    `Backspace`/`Delete`/`Ctrl+D` deliberately do not write it — a slot every keystroke overwrites is
    one nobody can predict — and neither does a kill that removed nothing, which would otherwise
    destroy a yank the user still wanted. The slot lives beside the buffer in `PromptInput.tsx`: the
    editor is controlled and unmounts in several app states, and module scope in the pure model would
    share one slot across every render tree.
  - **Two v1 narrowings, deliberate:** `↑`/`↓` move over *logical* lines, not visual wrapped rows
    (visual motion would thread the terminal width into a pure module); and the line motions go to
    the ends of the caret's own line, not of the whole buffer.
- **A message can be more than one line (DL-3 preserve the user's content, DL-9).** A trailing `\`
  before `Enter` continues the line instead of sending it, and `Ctrl+J` inserts a newline at the
  caret directly (the same row, without the backslash's limitation that a sent line cannot end in
  one); continuation rows are drawn with a dim `  … ` prefix exactly as wide as `  > `, so every
  row's text stays in one column (DL-7 legibility). `/help` lists both spellings, because neither
  announces itself — `\` is a character a user types for other reasons, and a chord is invisible
  (DL-4 — an affordance nobody can see is one nobody has). `Shift+Enter` is not among them and
  cannot be: terminals do not distinguish it from `Enter` without the kitty keyboard protocol, which
  Terminal.app and iTerm2 do not speak.
- **multiline paste** — pasting text with newlines buffers it into the prompt intact; the embedded
  newlines do **not** submit — only an explicit `Enter` sends the whole buffered value (DL-9
  keyboard-first, DL-3 preserve the user's content, TUI-C24). The prompt enables the terminal's
  bracketed-paste mode while mounted (via Ink's `usePaste`) so a paste is captured as content rather
  than misread as keystrokes; newlines are normalized to `\n`, and the payload is inserted **at the
  caret** rather than appended.

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
