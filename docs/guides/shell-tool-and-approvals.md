# Shell tool & approvals

In `gth code`, the agent can run shell commands so it can test its own work — run your suite, check
`git status`, install a package — instead of only reading and writing files. **Approvals** decide
which of those commands run on their own and which stop to ask you. There is one setting, and it is
a ladder of five rungs.

## The main use case: let the agent run your tests, on your terms

Goal: while you work in `gth code`, the agent runs your test suite as it goes, and you decide which
of its other commands are allowed to run.

The general-purpose shell tool (`run_shell_command`) is **on by default in `code` mode**, so you
already have it — just start a session:

```bash
gth code "add a retry to fetchOrders and make the tests pass"
```

Every session starts at **`auto-safe`**, the default rung: the auto-rater rates each command before
it runs. A command it rates safe (running your tests, `git status`) executes with no prompt.
Anything else stops and asks you:

```
The agent wants to run a shell command via run_shell_command
    rm -rf node_modules
⚠ Auto-rater (destructive): deletes a directory tree without confirmation
Approve?  [o]nce   [s]ession   [a]lways   [N]o
```

- **once** — run this one command, then keep asking.
- **session** — run it and auto-approve the same operation (e.g. any `npm test …`) for the rest of
  this session, without re-prompting.
- **always** — same as session, but also remembered across future sessions (persisted to
  `.gsloth/.gsloth-settings/shell-allowlist.json`).
- **No** (the default — just press Enter) — reject it. The agent is told what it can do next: run
  the same command with a justification, run a different one, or ask you — so it changes course
  instead of retrying the same thing or giving up.

### What the rater can say

The word in brackets after `⚠ Auto-rater` is one of four outcomes:

- **safe** — runs with no prompt.
- **destructive** — harmful, but you could undo it from inside the session: `rm -rf node_modules`,
  `git reset --hard`. Asks you, with all four choices above.
- **catastrophic** — cannot be undone from inside the session: `mkfs`, `DROP DATABASE`,
  `terraform destroy -auto-approve`, `kubectl delete namespace production`. Asks you *every* time —
  **session** and **always** do not stick for this outcome, so approving one `terraform destroy`
  never approves the next one.
- **attack** — the command's own structure shows something hostile: it goes after a credential for
  its own sake, escalates privilege, installs persistence, impersonates a hostname, or hides what it
  really runs. This one **ends the run** instead of asking. If the command is legitimate and you
  need it, put it in `approvals.allow` (below) — that list is checked before the rater.

Anything the rater cannot assess lands on **destructive** and says so; it never falls back to safe.
Pushing and publishing to somewhere your project already configures — `git push`, `npm publish`,
`docker push` — is ordinary work: the rater may well ask about it, but it never ends the run.

The rater is only as good as the model behind it. On a small or local model, prefer the `write` rung
(below) or point the rater at a stronger model with `approvals.rater`.

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

## The ladder: `approvals`

There is one approvals setting, and it takes the rung name:

```json
{ "approvals": "auto-safe" }
```

| Rung | What it grants | Rater |
|---|---|---|
| `read-only` | Gaunt Sloth may automatically read and list files in the current working folder. It asks for approval for anything else, until you tell it to always allow a command. | no |
| `write` | Gaunt Sloth may automatically read, edit, create and delete files in the current working folder. It asks for approval for anything else, until you tell it to always allow a command. | no |
| `auto-safe` | Same as write, plus the auto-rater rates everything else and automatically approves what it rates as safe; anything questionable comes to you. Gaunt Sloth can still rewrite and delete files in your working folder without asking — "safe" means each action is checked for reaching outside that folder or harming your system, not that nothing changes. | yes |
| `full-auto` | The auto-rater steers Gaunt Sloth: it decides for itself and does not stop to ask you. This is safer than bypass — the auto-rater still stops the run on a command that reads your keys or passwords, weakens permissions, installs itself to run again later, or hides what it does; it brings anything it cannot undo to you rather than deciding alone; and your deny list still applies — but it is **not** safe. Gaunt Sloth will change and delete things. Use it where the consequences are recoverable, and put real gates (deployment approvals, two-factor, branch protection) on anything that is not. | yes |
| `bypass` | No gate. Gaunt Sloth runs whatever it decides to run, without asking and without rating. Only the refusals configured in the deny list in your config still apply. | no |

`read-only`, `write` and `bypass` consult no model at all, so they are reproducible and cost
nothing. `auto-safe` spends one rating call per gated command.

`bypass` is **not** a higher-autonomy rung than `full-auto` — both let the agent act without asking;
`bypass` is the same autonomy with the checks removed.

Switch rung for the current session with `/approvals read-only|write|auto-safe|full-auto|bypass`
(see [Interactive sessions](interactive-sessions.md#slash-commands)).

## The agent knows which of its tools cost you a prompt

The cheapest approval is the one that never happens, so the agent is told the posture up front: at
every rung except `bypass`, the description of each tool that needs approval gains a sentence
saying so, and the tools that run freely say nothing. The shell is the only gated tool today, so it
is the only description that changes — at `read-only` and `write` it says the call *will* require
your approval, at `auto-safe` that it *may*, and at `full-auto` that the auto-rater may refuse it.
Each sentence also tells the agent to reach for the shell only when the other tools cannot do the
job.

The auto-rater backs that up at `auto-safe` and `full-auto`. When it does not rate a command safe
and one of the tools the agent already has would do the same job, it names that tool in its
explanation, so the tool shows up on the rater line of the approval prompt:

```
⚠ Auto-rater (destructive): rewrites a file in place; edit_file does this without a shell
```

If you then decline, the agent is told that `edit_file` needs no approval and will not interrupt
you — which is what makes it take the other route rather than re-arguing this one.

A named alternative is a suggestion, never an approval: it does not run the command, and the
suggested tool is gated on its own terms when the agent calls it. If nothing the agent already has
can do the job — a path outside your working folder, an install, a call to a service — the rater
names nothing.

## The extras: rater, allow, deny

When you need more than the rung, write the object form instead. The scalar above is exactly sugar
for `{ "mode": <value> }`:

```json
{
  "approvals": {
    "mode": "auto-safe",
    "rater": "safety-rater",
    "allow": ["npm test", "git status"],
    "deny": ["git push --force", "npm publish"]
  },
  "commands": {
    "pr": "read-only"
  }
}
```

- **`rater`** — the name of an identity profile whose model does the rating, instead of the session
  model. This is the fix for a weak main model: point it at a stronger one. A name that does not
  resolve is a config error, never a silent fallback. It is only consulted at `auto-safe` and
  `full-auto`.
- **`allow`** — command prefixes you trust. Checked **before** the rater at every rung except
  `bypass`, so an allow-listed command never costs a rating call and never prompts. This is the
  supported way to make a non-interactive pipeline pass.
- **`deny`** — command prefixes never to run. Checked **before** `allow` and before the rater, and
  it is the one check `bypass` keeps: choosing `bypass` means *"stop asking me"*, not *"forget what
  I told you never to do"*.

Both lists are read-only input: Gaunt Sloth merges them with what you approve or reject at the
prompt, and never writes back to your config file.

A per-command value **replaces** the root one wholesale — `"commands": { "pr": "read-only" }` above
says the `pr` command has no business writing files, whatever the root setting is.

## Non-interactive runs

Where there is nobody to ask — CI, a one-shot `gth exec`, a server — an escalation is not a prompt:
the run **exits non-zero**, printing the command, its rating and the reason. It never waits, and it
never times out into an approval. Declare what the pipeline is allowed to run:

```json
{
  "approvals": {
    "mode": "auto-safe",
    "allow": ["npm test", "npm run build", "git status"]
  },
  "commands": { "exec": { "builtInTools": { "run_shell_command": { "enabled": true } } } }
}
```

## Examples

```json
// Confirm every shell command yourself, while the agent still edits files freely
{ "approvals": "write" }

// Rate with a stronger model than the session's
{ "approvals": { "mode": "auto-safe", "rater": "safety-rater" } }

// Let the agent work unattended, but never let it publish
{ "approvals": { "mode": "full-auto", "deny": ["npm publish", "git push --force"] } }

// Fixed dev commands, no arbitrary shell at all
{ "commands": { "code": { "builtInTools": {
  "gth_checklist": true, "gth_grep": true,
  "run_tests":  { "command": "npm test" },
  "run_lint":   { "command": "npm run lint" },
  "run_build":  { "command": "npm run build" },
  "run_shell_command": false
} } } }

// Cap the output the shell tool feeds back to the model (default 100000 bytes)
{ "commands": { "code": { "builtInTools": {
  "run_shell_command": { "maxOutputBytes": 200000 }
} } } }
```

## Related

- Every `builtInTools` key and its defaults: [Tools configuration](../configuration/tools.md).
- The `/approvals` slash command: [Interactive sessions](interactive-sessions.md#slash-commands).
- Migrating a pre-2.0 `yolo` / `judge` config, or a CFG-26 `mode`/`strictness`/`escalate` one:
  [Migration](../MIGRATION.md#i-approvals-and-the-ai-rater-hard).
- The `code` / `exec` commands and their flags: [Commands](../COMMANDS.md#code).
- Give the agent project rules while it codes: [Code with your rules](code-with-your-rules.md).
