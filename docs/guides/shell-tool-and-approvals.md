# Shell tool & approvals

In `gth code`, the agent can run shell commands so it can test its own work — run your suite, check
`git status`, install a package — instead of only reading and writing files. Every arbitrary command
it composes is gated behind a per-command approval prompt, so you stay in control of what actually
runs.

## The main use case: let the agent run your tests, on your terms

Goal: while you work in `gth code`, the agent runs your test suite as it goes, and you decide which
of its other commands are allowed to run.

The general-purpose shell tool (`run_shell_command`) is **on by default in `code` mode**, so you
already have it — just start a session:

```bash
gth code "add a retry to fetchOrders and make the tests pass"
```

When the agent decides to run something, the run suspends and asks you first:

```
The agent wants to run a shell command via run_shell_command
    npm test
Approve?  [o]nce   [s]ession   [a]lways   [y] auto-approve all   [N]o
```

- **once** — run this one command, then keep asking.
- **session** — run it and auto-approve the same operation (e.g. any `npm test …`) for the rest of
  this session, without re-prompting.
- **always** — same as session, but also remembered across future sessions (persisted to
  `.gsloth/.gsloth-settings/shell-allowlist.json`).
- **auto-approve all** — stop asking for anything for the rest of this session.
- **No** (the default — just press Enter) — reject it; the agent gets the rejection and routes
  around it.

To have the agent run tests *without* approving them each time, give it the fixed `run_tests`
dev-command tool: you set the exact command, and because there is nothing for the model to choose,
it runs with **no approval prompt**. Put this in `.gsloth.config.json` at your project root:

```json
{
  "commands": {
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "gth_checklist": true,
        "gth_grep": true,
        "run_tests": { "command": "npm test" },
        "run_shell_command": { "timeout": 300000 }
      }
    }
  }
}
```

Now `run_tests` runs `npm test` on demand, while any *other* command the agent wants (a `git`
commit, `npm install`, a one-off script) still goes through the approval prompt above. The
`timeout` bump gives a slow command up to 300000 ms (5 minutes) before it is killed; the default is
120000 ms.

A per-command `builtInTools` object **replaces** the default set entirely, which is why
`gth_checklist` and `gth_grep` (the two defaults) are listed explicitly — drop them and they are
gone.

## Restrict what the agent may run

Turn the arbitrary shell tool **off** and leave only your fixed dev commands, so the agent can run
`npm test` and nothing else it composes itself:

```json
{
  "commands": {
    "code": {
      "builtInTools": {
        "gth_checklist": true,
        "gth_grep": true,
        "run_tests": { "command": "npm test" },
        "run_shell_command": false
      }
    }
  }
}
```

Or keep the shell tool but force a **fresh approval for every single command** (never auto-approve
flag-variants of an already-approved operation) by turning the allow-list off:

```json
{
  "commands": {
    "code": {
      "builtInTools": {
        "gth_checklist": true,
        "gth_grep": true,
        "run_shell_command": { "allowlist": false }
      }
    }
  }
}
```

Whatever you configure, a hardcoded blocklist of catastrophic commands (`rm -rf /`, `mkfs`, `dd` to
a block device, fork bombs, `shutdown`/`reboot`, …) is refused **before** it runs — even when
approvals are bypassed.

## Skip approvals (dangerous)

`yolo` runs every `run_shell_command` immediately with no prompt. Only do this in a sandbox or
throwaway environment — the agent's commands execute with your shell's privileges:

```json
{
  "commands": {
    "code": {
      "builtInTools": {
        "run_shell_command": { "yolo": true }
      }
    }
  }
}
```

## Auto-approve the safe ones

The `judge` gate vets each command with a lightweight model *before* the human prompt: it
auto-approves clearly-safe commands (a fatigue reducer) and escalates the rest to the prompt above.
It is off by default because it costs one model call per command:

```json
{
  "commands": {
    "code": {
      "builtInTools": {
        "run_shell_command": {
          "judge": { "enabled": true, "blockHigh": true }
        }
      }
    }
  }
}
```

`blockHigh: true` also rejects clearly-catastrophic commands outright instead of prompting. Point
the judge at a cheaper model with `judge.model` (see
[Choose & switch models](choose-and-switch-models.md)).

## Examples

```json
// Enable the shell tool in exec mode too (it is code-mode-only by default)
{ "commands": { "exec": { "builtInTools": { "run_shell_command": true } } } }

// Fixed dev commands, no arbitrary shell
{ "commands": { "code": { "builtInTools": {
  "gth_checklist": true, "gth_grep": true,
  "run_tests":  { "command": "npm test" },
  "run_lint":   { "command": "npm run lint" },
  "run_build":  { "command": "npm run build" }
} } } }

// Cap the output the shell tool feeds back to the model (default 100000 bytes)
{ "commands": { "code": { "builtInTools": {
  "run_shell_command": { "maxOutputBytes": 200000 }
} } } }
```

## Related

- Every `builtInTools` key and its defaults: [Tools configuration](../configuration/tools.md).
- The `code` / `exec` commands and their flags: [Commands](../COMMANDS.md#code).
- Give the agent project rules while it codes: [Code with your rules](code-with-your-rules.md).
