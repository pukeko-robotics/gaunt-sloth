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

The agent reads the relevant files, edits them in place, and asks for approval before each shell
command it wants to run (answer the prompt, or run `/auto-approve` to stop being asked for the rest
of the session). Follow up in the same conversation — "now add a CHANGELOG entry" — context carries
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

- `/clear` — wipe the transcript
- `/status` — mode, model, and turn count
- `/model` — show the current model / provider
- `/verbose` — expand or collapse tool-call detail (Ctrl+T does the same mid-response)
- `/reasoning` — reprint a turn's thinking (`/reasoning 2` for turn 2)
- `/auto-approve` — auto-approve shell commands for this session (`/auto-approve off` to revert)
- `/debug-dump` — write a diagnostic archive for a bug report (see [debug-dump](../debug-dump.md))
- `/exit` (or `/quit`) — leave the session

A pasted filesystem path such as `/usr/local/bin` is not swallowed as a command — only a line with
no further `/` after the leading one is parsed as one.

## TUI or plain readline (`--tui` / `--no-tui`)

Sessions have two surfaces. On a real interactive terminal, `gth` renders the Ink TUI — the full
terminal UI with the slash-command menu, collapsible tool-call panels, and a docked debug view.
Anywhere it can't — stdin/stdout is not a TTY, `TERM=dumb`, `CI` is set, `GTH_NO_TUI` is set, or
the optional `ink` dependency didn't install — it falls back to a plain readline prompt with the
same slash commands. Two global flags force the choice:

```bash
gth --no-tui        # force the plain readline session
gth --tui code      # force the TUI (e.g. an interactive shell that happens to set CI)
```

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
