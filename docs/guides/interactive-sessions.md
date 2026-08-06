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
rest (`/approvals write` to confirm every one yourself). Follow up in the same conversation — "now add a CHANGELOG entry" — context carries
across turns. Type `exit` or press Ctrl+C to leave.

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
them; in the TUI, typing `/` alone opens a searchable command menu. A few worth knowing:

- `/clear` — wipe the transcript and the model's memory of it (it is gone, not scrolled away)
- `/status` — mode, model, and turn count
- `/model` — show the current model / provider
- `/verbose` — expand or collapse tool-call detail (Ctrl+T does the same mid-response)
- `/reasoning` — reprint a turn's thinking (`/reasoning 2` for turn 2)
- `/approvals` — show the current rung, the rater, the allow/deny counts, what you have approved so
  far and which MCP annotation hints you believe;
  `/approvals read-only|write|auto-safe|full-auto|bypass` switches the rung for this session
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
the wheel scrolls a focused panel. While it is on, your terminal gives drag events to Gaunt Sloth
rather than using them to select text, so **hold Shift (Option in some macOS terminals) while
dragging** to select and copy as usual.

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

## Interrupting a response

Press **Escape** while the agent is working to stop the current response; the session stays open
and keeps its context. **Ctrl+C** (or typing `exit` at the prompt) ends the whole session — in the
TUI it does so immediately, even mid-response, so Esc is the interrupt there. In the plain
readline surface, `Q` also interrupts (a hint box above the response says so), a Ctrl+C during a
response requests the interrupt first, and a second Ctrl+C force-exits — the escape hatch when a
stuck tool call has wedged the run.

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
