# Work interactively

Bare `gth` — no subcommand — opens an interactive coding session in the current directory: the
agent can read and edit your project's files and run shell commands you approve, and you steer it
turn by turn. On an unconfigured machine it runs the first-time setup dialog first, then drops you
straight into the session.

## The main use case: open a session and get a change made

Goal: rename a config option across a small project without making the edits yourself.

From the project root:

```bash
gth
```

Type the task at the prompt:

```
Rename the `timeoutMs` option to `requestTimeoutMs` everywhere, including the README.
```

The agent reads the relevant files, edits them in place, and runs shell commands through the
approvals gate — by default the auto-rater lets clearly-safe ones through and asks you about the
rest (`/approvals write` to confirm each one — and every other tool call — yourself, while its
built-in file tools keep working inside your working folder). Follow up in the same conversation —
"now add a CHANGELOG entry" — context carries across turns. Type `exit`, or press Ctrl+C with
nothing typed and no turn running, to leave.

## `gth` vs `gth code` vs `gth chat`

Bare `gth` *is* `gth code` — the no-subcommand default is the code session. The difference between
the two session modes is what the agent may touch:

| Command | Filesystem access | Intent |
|---|---|---|
| `gth code` (or bare `gth`) | read + write, plus dev/shell tools | make changes in your project |
| `gth chat` | read-only | discuss and explore without modifying anything |

To open a session with a first message already in it, pass it to the subcommand (the bare form
takes no arguments):

```bash
gth code "Help me refactor the authentication module"
gth chat "Let's discuss the architecture of this project"
```

## Slash commands

Inside a session, a line starting with `/` is a command, not a prompt. Run `/help` to list all of
them — in the TUI it also lists the key bindings, grouped by where each one works. Typing `/` alone
there opens a searchable command menu. A few worth knowing:

- `/clear` — wipe the transcript and the model's memory of it (it is gone, not scrolled away)
- `/compact` — fold the older part of the conversation into a summary the model reads in its
  place, keeping the last few messages word for word, so a session that has grown long can keep
  going without starting over. Free text after it (`/compact the migration plan`) says what the
  summary should concentrate on. The transcript on screen stays as it is — only the model's
  context shrinks — and the change is written into the conversation's saved state, so a resumed
  session stays compacted
- `/status` — mode, model, and turn count
- `/model` — show the current model / provider
- `/verbose` — expand or collapse tool-call detail (Ctrl+T does the same, at any time)
- `/reasoning` — reprint a turn's thinking (`/reasoning 2` for turn 2)
- `/approvals` — show the current mode, the rater, the allow/deny counts, what you have approved so
  far, what is refused and which MCP annotation hints you believe. In the TUI it also opens a
  picker: the four modes as rows, arrow keys to move, Enter to choose, Esc to keep the one you are
  on. `write` has no row — it is a variant of `manual` rather than a further step — but
  `/approvals manual|write|assisted|auto|bypass` sets any of the five directly, for this session
- `/approvals undeny <number>` — lift one of the refusals `/approvals` lists, by the number beside
  it. Each line says where its refusal came from: a line in your config's `approvals.deny`, a
  **deny always** you saved to this project, or one held for this session only. The first is
  removed by editing your config; the other two this command lifts
- `/approvals trust <server> <hint…>` — believe one MCP server's tool annotations, named by the key
  you gave it under `mcpServers`; `/approvals untrust` stops believing them. Each hint
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) is believed separately, so
  `/approvals trust jira readOnlyHint` leaves that server's `openWorldHint` disbelieved. Session
  only. Untrusting makes those tools read as more dangerous than when you approved them, so your
  saved approvals for that server are withdrawn at their next call — the command tells you so
- `/mouse` — turn mouse reporting on or off (`/mouse off` to get text selection back)
- `/debug-dump` — write a diagnostic archive for a bug report (see [debug-dump](../debug-dump.md))
- `/exit` (or `/quit`) — leave the session

A pasted filesystem path such as `/usr/local/bin` is not swallowed as a command — only a line with
no further `/` after the leading one is parsed as one.

### When the session compacts without being asked

`/compact` is the deliberate version of something the session also does on its own. If a provider
rejects a turn because the conversation no longer fits, the session folds the older messages into a
summary and sends the turn again, rather than ending with an error. It says so in one line and then
carries on:

```
The context overflowed, so 9 earlier messages were folded into a summary (13→5 messages). Retrying.
```

On **Ollama** it happens *before* the request instead. Ollama does not reject an oversized
conversation — the daemon quietly drops the oldest tokens to fit `num_ctx` and answers from what is
left, so the reply looks normal while the model has forgotten the start of the session. There is
nothing to detect afterwards, so the session estimates the size first and compacts if the turn would
not fit:

```
Context is nearly full (about 3212 tokens of a 4096-token window, with 1024 reserved for the answer),
so 9 earlier messages were folded into a summary before this call. 6 kept verbatim.
```

The window is the `num_ctx` your config sends (`llm.numCtx`, 16384 by default), capped by the
model's own maximum when the daemon reports one. Some of that is held back for the reply, because
`num_ctx` covers the question and the answer together.

A turn is retried once. If the conversation still does not fit after being compacted, the turn ends
and says why — folding it again would only eat the recent messages it just kept, so the next move is
yours: `/clear` and start fresh, or ask for something narrower.

### Running a command with a message half-written

Typing `/` only opens the menu on an empty line, so with `please refactor the fo` already in the
prompt there is nothing to type it into. In the TUI, press **Ctrl+G** (**Ctrl+/** works too, on
terminals that send it — macOS sends nothing for it) and the menu opens *above* your message
instead. Type to filter, `↑`/`↓` to move, `Tab` to complete the highlighted name, Enter to run it,
`Esc` to close. What you type goes into the menu, not into the message: the message stays on screen
untouched, and it comes back with the cursor where you left it once the command has run — including
after `/approvals`, which takes over the screen with its own picker while it runs.

It works mid-turn as well, with the same rule as a typed command — the ones that are safe while the
agent is working (`/approvals`, `/verbose`, `/debug`, `/model`, `/status`, …) run, and `/clear`,
`/compact`, `/help`, `/exit` and `/quit` ask you to wait for the turn to finish. One thing to know before you
open it there: while a reply is arriving, `Escape` stops the reply, and it does that as well as
closing the menu. To leave the menu without stopping the turn, run one of the commands — or wait
for the turn to end and then press `Esc`.

## Writing a longer message

*In the TUI. The plain readline surface (`--no-tui`) keeps readline's own line editing and puts its
own history on the arrow keys, so none of this applies there — a message is one line, and `↑`
recalls the previous one.*

Enter sends the message. To keep writing instead, press **Ctrl+J**, or end the line with a backslash
and press Enter: the message carries onto a second line, marked `…`, and Enter sends the whole thing
once you are done. Pasting several lines at once does the same without either key. `Ctrl+J` inserts
a newline wherever the cursor is, and it has no effect on the text around it — the backslash form
always consumes the backslash, so a message written that way cannot end in one.

Fixing something you have already written works the way it does at a shell prompt:

| | |
|---|---|
| **←** / **→** | a character |
| **Alt**+**←** / **Alt**+**→** (**Ctrl**+**←** / **Ctrl**+**→** in some terminals) | a word |
| **Ctrl+A** / **Ctrl+E**, or **Home** / **End** | the start / the end of the line you are on |
| **↑** / **↓** | between the lines of a multi-line message — or through the slash-command menu, while that is open |
| **Backspace** | delete the character before the cursor |
| **Delete**, or **Ctrl+D** | delete the character after the cursor |
| **Alt**+**Backspace**, or **Ctrl+W** | delete the word before the cursor |
| **Alt**+**Delete**, or **Ctrl+Delete** | delete the word after the cursor |
| **Ctrl+U** / **Ctrl+K** | delete back to the start / on to the end of the line you are on |
| **Ctrl+C** | scrap the whole message — with nothing typed it stops the turn, or leaves |
| **Ctrl+Y** | put back what the last of those deletions removed |

Both spellings of the word jump are always live, so whichever one your terminal sends for
**Option**/**Alt** + arrow will work. `Ctrl+A`/`Ctrl+E`, `Home`/`End`, `Ctrl+U` and `Ctrl+K` all work
on the line the cursor is on, not on the whole message — so `Ctrl+E` then `Ctrl+U` is how you clear
one line of several.

`Ctrl+Y` holds one deletion, the most recent of the word and line ones or of a `Ctrl+C` that scrapped
the message; `Backspace` and `Delete` do not change it, so it stays predictable while you type.
`Ctrl+D` deletes forward here and never ends the session — use `/exit`, `/quit`, or `Ctrl+C` with
nothing typed and no turn running, for that.

## TUI or plain readline (`--tui` / `--no-tui`, `tui`)

Sessions have two surfaces. On a real interactive terminal, `gth` renders the Ink TUI — the full
terminal UI with the slash-command menu, collapsible tool-call panels, and a docked debug view.
Anywhere it can't — stdin/stdout is not a TTY, `TERM=dumb`, `CI` is set, `GTH_NO_TUI` is set, or
the optional `ink` dependency didn't install — it falls back to a plain readline prompt with the
same slash commands. Two global flags force the choice for one run:

```bash
gth --no-tui        # force the plain readline session
gth --tui code      # force the TUI (e.g. an interactive shell that happens to set CI)
```

If your terminal and the TUI don't get along, make the choice permanent with the `tui` key instead
of typing a flag every time. Put it in your project config to settle it for one repo, or in the
global `~/.gsloth/.gsloth.config.json` to settle it everywhere:

```json
{ "tui": false }
```

Five things decide which surface starts, **highest first**:

| | Condition | Result |
|---|---|---|
| 1 | stdin/stdout is not a terminal, `TERM=dumb`, or `ink` is not installed | plain readline |
| 2 | `--tui` or `--no-tui` was passed | that surface |
| 3 | `GTH_NO_TUI` is set to any non-empty value | plain readline |
| 4 | `tui` is set in your config (project layer over global) | that surface |
| 5 | otherwise | the TUI, unless `CI` is set |

Row 1 asks what the terminal can do rather than what you want, which is why it sits above your
preferences: `"tui": true` in a piped or `TERM=dumb` run quietly gives you readline instead of
failing. Row 3 is the escape hatch for a machine you can't edit a config file on, so it outranks
row 4 — and row 4 outranks the `CI` heuristic in row 5, which is how you get the TUI in an
interactive shell that happens to export `CI`.

## Mouse and text selection

The TUI turns on terminal mouse reporting at launch, so clickable parts of the interface respond and
the wheel scrolls the conversation (see [Reading back over the conversation](#reading-back-over-the-conversation)).
While it is on, your terminal gives the button press to Gaunt Sloth rather than using it to start a
selection, so **hold Shift (Option in some macOS terminals) while dragging** to select and copy as
usual. Shift+drag is the answer whenever dragging stops selecting — the selection itself behaves
exactly as your terminal's normally does.

Only what is on screen can be selected: the session takes the whole terminal, so text you have
scrolled past is not there to drag over. Scroll it back into view first.

Click the sloth in the launch banner and it does something — a blink, a nod, a look around, or an
eye-roll, picked at random. It only ever animates on a click, never on its own, and it goes away
once the first exchange starts.

If you would rather have unmodified selection back, turn reporting off mid-session — it takes effect
immediately and the session carries on:

```
/mouse off
```

`/mouse on` re-enables it and `/mouse` alone toggles. To make the choice permanent, set
`useMouse` to `false` in your config; to fix a terminal that mishandles reporting before a session
even starts, run `GTH_NO_MOUSE=1 gth chat`. See
[output configuration](../configuration/output.md#mouse-usemouse-gth_no_mouse) for the full
precedence order.

The plain readline surface (`--no-tui`) has no mouse layer at all, so nothing changes there and
`/mouse` reports itself unavailable.

## Reading back over the conversation

The session takes the whole terminal, so the conversation lives in the app rather than in your
terminal's scrollback — your terminal's own scroll keys will not reach it. Scroll it with:

| | |
|---|---|
| mouse wheel | three lines a notch |
| **Shift** + wheel | one screen, in terminals that forward Shift with the wheel — some (Konsole among them) never do, and there a shifted notch scrolls three lines like any other |
| **PageUp** / **PageDown** | one screen (**Fn**+**↑**/**↓** on a keyboard without those keys) |
| **Ctrl+Home** / **Ctrl+End** | the beginning / the end of the session |

While you are reading back, new output does not drag you away from it — a reply that arrives keeps
growing below and the lines you are reading stay where they are. Start typing, or press
**Ctrl+End**, to jump back to the newest output; both work whether or not a reply is still arriving,
and the character you typed still reaches the prompt. **Escape** jumps back too, but only once
nothing is running: while a reply is arriving the first **Escape** stops it (see
[Interrupting a response](#interrupting-a-response)), and it takes a second one to jump back.

With mouse reporting off (`/mouse off`, `useMouse: false`, `GTH_NO_MOUSE=1`) the wheel does nothing
and the keys above are the whole story; nothing becomes unreachable. The plain readline surface
(`--no-tui`) has no viewport of its own — there you scroll your terminal, as ever.

## Watching a response arrive

While a model is thinking, the TUI shows a `💭 Thinking` line with the newest couple of lines of
that thinking underneath it — enough to tell what it is working on without the thinking crowding out
the answer. Tool calls appear as one summary line each, with the first few lines of their output
below them.

Press **Ctrl+T** (or run `/verbose`) to open all of that out into full detail: the raw arguments and
the complete output of every tool call, and the whole of the thinking. It applies to the entire
conversation on screen, not just the turn in flight, so it works just as well on a turn you have
scrolled back to. The same key folds it away again.

## Interrupting a response

Press **Escape** while the agent is working to stop the current response; the session stays open
and keeps its context. In the TUI, **Ctrl+C** stops it too when there is nothing typed at the
prompt — the two keys are the same interrupt there, so the reflex either hand reaches for works.
With a message half-written, Ctrl+C scraps that message first and leaves the turn running (press it
again to stop the turn), and with nothing typed and nothing running it ends the session, as `/exit`,
`/quit` and typing `exit` always do.

The plain readline surface (`--no-tui`) keeps its own convention: `Q` interrupts (a hint box above
the response says so), a Ctrl+C during a response requests the interrupt first, and a second Ctrl+C
force-exits — the escape hatch when a stuck tool call has wedged the run.

## Saving a transcript

Sessions write nothing to disk by default. Pass the global `-w` flag to save the conversation as it
runs:

```bash
gth -w true code       # .gsloth/gth_<timestamp>_CODE.md (project root if no .gsloth dir)
gth -w true chat       # gth_<timestamp>_CHAT.md
gth -w pairing.md code # a filename of your choosing
```

## Related

- Every `chat` / `code` flag: [Commands](../COMMANDS.md#code).
- One-shot, scriptable runs instead of a session: [Scripting & CI](scripting-and-ci.md).
- What the agent may touch — filesystem levels, the shell tool, approvals, the tool allow-list:
  [Tools](../configuration/tools.md) and [Shell tool & approvals](shell-tool-and-approvals.md).
