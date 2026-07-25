# Shell tool & approvals

In `gth code`, the agent can run shell commands so it can test its own work — run your suite, check
`git status`, install a package — instead of only reading and writing files. An **AI rater** reviews
each command it composes: clearly-safe ones run, risky ones stop and ask you.

## The main use case: let the agent run your tests, on your terms

Goal: while you work in `gth code`, the agent runs your test suite as it goes, and you decide which
of its other commands are allowed to run.

The general-purpose shell tool (`run_shell_command`) is **on by default in `code` mode**, so you
already have it — just start a session:

```bash
gth code "add a retry to fetchOrders and make the tests pass"
```

Interactive `code` and `chat` sessions default to **`approvals.mode: "auto"`**: the AI rater rates
every command before it runs. A command it rates `safe` (running your tests, `git status`) executes
with no prompt. Anything it rates `danger` or worse stops and asks you:

```
The agent wants to run a shell command via run_shell_command
    rm -rf node_modules
⚠ AI rater (danger): deletes a directory tree irreversibly
Approve?  [o]nce   [s]ession   [a]lways   [y] switch to auto-approve (AI rater)   [N]o
```

- **once** — run this one command, then keep asking.
- **session** — run it and auto-approve the same operation (e.g. any `npm test …`) for the rest of
  this session, without re-prompting.
- **always** — same as session, but also remembered across future sessions (persisted to
  `.gsloth/.gsloth-settings/shell-allowlist.json`).
- **switch to auto-approve (AI rater)** — hand the remaining commands to the rater, and approve this
  one. Shown only when a rater is available; it is not offered in a session that cannot rate.
- **No** (the default — just press Enter) — reject it; the agent gets the rejection and routes
  around it.

The rater is only as good as the model behind it. On a small or local model, prefer `"mode": "ask"`
(below) or point the rater at a stronger model with `approvals.rater.profile`.

To have the agent run tests *without* any of this, give it the fixed `run_tests` dev-command tool:
you set the exact command, and because there is nothing for the model to choose, it runs with **no
rating and no prompt**. Put this in `.gsloth.config.json` at your project root:

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

Now `run_tests` runs `npm test` on demand, while any *other* command the agent composes (a `git`
commit, `npm install`, a one-off script) goes through the rater. The `timeout` bump gives a slow
command up to 300000 ms (5 minutes) before it is killed; the default is 120000 ms.

A per-command `builtInTools` object **replaces** the default set entirely, which is why
`gth_checklist` and `gth_grep` (the two defaults) are listed explicitly — drop them and they are
gone.

## Choose how approvals work: `approvals.mode`

The whole gate lives in one top-level `approvals` block:

```json
{
  "approvals": {
    "mode": "auto",
    "rater": {
      "profile": "safety-rater",
      "strictness": "standard",
      "escalate": "danger"
    },
    "allowlist": true,
    "persistAllowlist": true
  }
}
```

| Mode | What happens |
|---|---|
| `auto` | The rater rates every command. `safe` runs; below the `escalate` tier the rejection reason goes back to the agent so it can adjust; at/above it you are asked; `critical` is always refused. |
| `ask` | You confirm every command yourself. A configured rater only annotates the prompt. |
| `bypass` | No gate: commands run without asking **and without the rater**. |

Set it for the current session instead with `/approvals auto|ask|bypass` (see
[Interactive sessions](interactive-sessions.md#slash-commands)).

### Tuning the rater

- **`profile`** — an identity profile whose model does the rating, instead of the session model.
  This is the fix for a weak main model: point it at a stronger one. A name that does not resolve is
  a config error, never a silent fallback.
- **`strictness`** — `lenient` / `standard` / `strict`. Adjusts what the rater *calls* `safe`; it
  never changes what happens to a given tier.
- **`escalate`** — `caution` / `danger` (default) / `never`. The only knob deciding model-vs-human:
  `caution` asks you about anything not clearly safe, `never` never interrupts you and returns every
  rejection to the agent instead. `critical` is deliberately not a valid value — a catastrophic
  command is always refused, with no setting that lets it through to a prompt.

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

Or confirm every command yourself, with no auto-approval of flag-variants of an already-approved
operation:

```json
{
  "approvals": { "mode": "ask", "allowlist": false }
}
```

Whatever you configure, a hardcoded blocklist of catastrophic commands (`rm -rf /`, `mkfs`, `dd` to
a block device, fork bombs, `shutdown`/`reboot`, …) is refused **before** it runs — even under
`"mode": "bypass"`.

## Skip approvals entirely (dangerous)

`"mode": "bypass"` runs every `run_shell_command` immediately: no prompt and no rater. Only do this
in a sandbox or throwaway environment — the agent's commands execute with your shell's privileges:

```json
{
  "approvals": { "mode": "bypass" }
}
```

## Examples

Outside an interactive session there is nobody to approve a command, so a gated one is refused —
which is why the one-shot `exec` example below sets `bypass` alongside `enabled`.

```json
// Enable the shell tool in exec mode too (it is code-mode-only by default), ungated
{
  "approvals": { "mode": "bypass" },
  "commands": { "exec": { "builtInTools": { "run_shell_command": { "enabled": true } } } }
}

// Rate with a stronger model than the session's, and ask about anything not clearly safe
{ "approvals": { "mode": "auto", "rater": { "profile": "safety-rater", "escalate": "caution" } } }

// Fully unattended: never interrupt, bounce every rejection back to the agent
{ "approvals": { "mode": "auto", "rater": { "escalate": "never" } } }

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
- The `/approvals` slash commands: [Interactive sessions](interactive-sessions.md#slash-commands).
- Migrating a pre-2.0 `yolo` / `judge` config: [Migration](../MIGRATION.md#i-approvals-and-the-ai-rater-hard).
- The `code` / `exec` commands and their flags: [Commands](../COMMANDS.md#code).
- Give the agent project rules while it codes: [Code with your rules](code-with-your-rules.md).
