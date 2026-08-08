# What approvals protect you from

Approvals decide which shell commands Gaunt Sloth runs on its own and which stop to ask you — and,
at the strictest modes, which file edits and tool calls do too. This page is about what that buys
you: the kind of failure the ladder catches, the kind it cannot catch
at any setting, and what has to sit outside Gaunt Sloth to cover the difference. Configuring it is
a different page — [Shell tool & approvals](shell-tool-and-approvals.md).

## The main use case: leaving `gth code` to work unattended

Goal: you want to start a coding session on a ticket and go and do something else for an hour.

Three steps, in this order, because the last one is the smallest of the three.

**1. Decide where the run happens.** A container, a VM, or an OS account that owns nothing you care
about. This is the only item on the list that puts a boundary around what the run can reach, and
Gaunt Sloth does not provide it — see [What actually contains an
agent](#what-actually-contains-an-agent) for why it cannot.

**2. Make sure anything you would hate to lose is not only on this disk.** Push the branch, check
the remote's default branch is protected, and know when your last backup ran. What comes back after
a bad hour is whatever a remote or a backup still holds.

**3. Then pick the mode, and deny the handful of things you could not undo.** Auto is the mode named
for an unattended run, and it is the one where a risky command is put back to the agent — with the
rater's reason — instead of straight to you. That buys fewer stops, not none: the agent gets a few
rounds to narrow or justify what it asked for, and both the run of rounds and the total since you
were last involved are capped, so the argument ends at a person rather than going round. Each mode's
own description — the one `/approvals` prints, and the one
[the ladder](shell-tool-and-approvals.md#the-ladder-approvals) lists — is the current word on what
it does. So plan to come back to prompts either way: anything the rater will not clear is brought to
a person — at once when it cannot be undone, and once those rounds are spent when it can — while a
command whose structure is hostile ends the run outright. Whether that is a wait or a failure is
decided by the surface rather than the mode —
a session you walked away from holds the prompt until you come back, while a run with nobody to ask
at all (CI, a one-shot `gth exec`) exits non-zero rather than hanging. The one thing that makes a
*particular* command stop asking is naming it in `approvals.allow`. The mode is one line in the same
`approvals` object; the denials are the part worth writing out. In `.gsloth.config.json` at your
project root:

```json
{
  "approvals": {
    "mode": "auto",
    "deny": [
      { "type": "shell", "matcher": "glob", "pattern": "npm publish*" },
      { "type": "shell", "matcher": "glob", "pattern": "git push --force*" },
      { "type": "shell", "matcher": "glob", "pattern": "terraform destroy*" }
    ]
  }
}
```

Then start the session and leave:

```bash
gth code "make the failing orders tests pass"
```

A `deny` entry naming a **command**, as all three above do, is checked before your allow list and
before the rater, and it is the one check you write that survives every mode — so it is the
strongest thing you can say about which commands may run, short of not granting the shell at all. An
entry naming a *tool* instead is compared only where the mode gates that tool, which at Assisted,
Auto and Bypass is nothing at all: see
[Which entries a mode consults](shell-tool-and-approvals.md#which-entries-a-mode-consults). A deny
list stops the mistake. It does not stop a way around it — which is the rest of this page.

## The ladder reads text, so it catches accidents and not intent

Every check inside Gaunt Sloth — your allow and deny lists, the checks that run before any model is
asked, and the auto-rater itself — works by reading the **text of the command being proposed**. They
differ in whether a pattern or a model does the reading.

Any check of that kind is walked around by one indirection, because an agent that can write a file
and run a command can do anything the machine can do in two steps instead of one:

```
write_file  build.js   → a file write, and nothing else
npm run build          → a build command, and nothing else
```

Neither call's text is a lie, so no improvement to the reading catches it. This is measured, not
argued — with a shell script standing in for the build script above: the same payload proposed
directly was caught by a deny rule and stopped before it reached the shell; written to a file and
then run, it matched nothing, tripped nothing, and executed. The auto-rater's entire view of the
second version is the string `bash payload.sh` — the payload is not in its input, so no model,
however capable, could have judged it.

**So the ladder protects you against accidents, and not against intent.** An accident is the agent
doing the wrong thing while trying to do the right thing: the destructive cleanup, the command whose
consequences it did not think through, the flag it got wrong. Intent — a prompt injection that
lands, or a model steered to act against you — steps around command-text analysis in one move.

That is not an argument for turning the gate off, because accidents are the common case and the gate
does stop them. Measured over a corpus of commands that should not run unattended, the checks that
need no model at all stop 17 more of them at Assisted and Auto than at Bypass — before the rater has
been asked anything.

## The two things that are not text checks

Two controls inside Gaunt Sloth remove a capability instead of reading a string:

- The **file tools refuse a path outside the folder Gaunt Sloth is running in**, at every mode,
  Bypass included — unless you widen the sandbox yourself, which `gth exec --allow-dir <path>` does.
- The **LLM and cloud provider keys Gaunt Sloth holds are stripped from the environment** of any
  command it runs, so the environment is not a route to them — but a key you have written into a
  config file or a `.env` is a file on disk like any other, and an approved command can read it.
  A `GITHUB_TOKEN` is deliberately left in place, because Gaunt Sloth's own review workflows shell
  out to `gh`.

Each of those closes one route. Neither of them bounds the agent, and the difference is the whole
point. Take one path outside that folder, and write to it two ways:

```
write_file  /tmp/notes.txt   → refused, at every mode
touch       /tmp/notes.txt   → the same path, written
```

Wherever a shell command can run without your seeing it — Assisted, Auto and Bypass — the agent can
write anywhere your user account can, and reach anything your user account can reach. A shell
command is arbitrary code running as you; no version of this product can change that while the shell
exists, which is why step 1 of the use case above is a step and not a footnote.

## Why one layer interrupts you and another does not

The layers are deliberately conservative about opposite things.

- A **deterministic check** comes to you only when it is sure a command is too bad. Anything short of
  that, it hands to the model.
- The **auto-rater** approves only when it is sure a command is safe. Anything short of that, it
  comes to you — at Auto, at once when what it asked for cannot be undone, and otherwise once the
  agent has spent its rounds answering the rater.

A pattern is trustworthy about the form of a command and knows nothing about its meaning, so its
uncertainty is not evidence and must not spend your attention. The model is the only layer that
reads meaning, so its uncertainty *is* evidence, and it is exactly the thing worth interrupting you
for. An approval prompt that carries a rater's explanation is therefore a report of a model's doubt
about this command, not a rule that fired.

## A rater that stops you a lot is not broken

It is the chain working: nothing deterministic was certainly bad, the model was not sure it was
good, so it asked you. On a small or local model this happens more often, and it is a cost problem
rather than a safety one. A very small rater does not save you prompts at all — it asks about
almost everything and charges you a model call each time it does. In our own measurements a 1B
local model rated essentially every command unsafe, and a 12B one still escalated roughly 40% of a
set of ordinary commands that hosted models passed without comment.

The fix is a better rater, not a quieter one: point `approvals.rater` at a stronger model than the
one driving the session. Suppressing those escalations would only make a number look better.

## Manual and Write are for a few commands, not a long run

They are the modes where every shell command is a question to you, along with every MCP call and
every custom tool. At Manual, so is every file edit inside the working folder — creating, editing
and deleting a file each stop and ask. Write is that same posture with those file edits granted, and
that is what makes it a modifier on Manual rather than a further step along the ladder. That is a
real control, and it is not the strong one over a long run.

A rater judges the two-thousandth command exactly as well as the third. A person does not. Ask
someone three questions and you get three precise answers; ask them ten and you get three answers.
And the decline is silent, because a tired reviewer approves rather than complains — there is no
point at which the prompts start telling you that you have stopped reading them.

So Manual and Write are the right choice for **a few commands, in an area you do not trust the model
with and genuinely want to read**. Pointed at a two-hour unattended run they are a category error:
they turn into a rubber stamp exactly when the number of decisions is highest.

## What actually contains an agent

Real containment is a property of what the agent runs inside, not of what it is asked before it
acts:

- a container or a VM;
- a separate OS account — and check it really is separate, because membership of a group like
  `docker` is root-equivalent and hands back everything the separation was for;
- network egress control, so a command that does run cannot reach anywhere it likes;
- backups you have restored from at least once;
- a pushed remote with branch protection on the default branch.

**Gaunt Sloth provides none of these, and cannot.** Every one of them lives outside the process it
runs in — which is also why they are the ones that still hold when everything on this page has been
walked around. They are your part of the arrangement, and the ladder is only worth what it is worth
on top of them.

## Related

- Setting the mode, the allow/deny/escalate lists, and what the rater can say:
  [Shell tool & approvals](shell-tool-and-approvals.md).
- Running the agent with no arbitrary shell at all, using fixed dev commands:
  [Tools configuration](../configuration/tools.md).
