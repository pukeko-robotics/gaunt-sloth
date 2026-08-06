# Scripting & CI (non-interactive use)

`gth ask` and `gth exec` are the non-interactive verbs: they take input from arguments, files, or
a pipe, stream the result to stdout, and set the process exit code (`0` on success, `1` on error).
That makes them safe to call from a shell script or CI step — capture the output, branch on `$?`,
and nothing waits for a human.

## Pick the right command

`ask`/`exec` are the one-shot verbs this page covers, but they are not the only non-interactive
ones — and a shell loop around them is usually the wrong tool:

- **`ask` / `exec`** — one prompt, one answer, exit `0`/`1`: the rest of this page.
- **`batch`** — the same prompt over many rows or models; don't write the fan-out loop yourself:
  [Fan out one prompt over inputs and models](batch.md).
- **`eval`** — grade the answers and gate CI on the result (three-way exit code):
  [Evaluate your agent](evals.md).
- **`workflow`** — several agent calls with logic between them, in JS; don't pipe `gth` into
  `gth` from bash: [Orchestrate agent calls from a script](workflows.md).
- **`review` / `pr`** — content-gate a diff or pull request:
  [Review code and pull requests](review-code-and-prs.md).

## Which binary name in scripts

`gth`, `gsloth`, and `gaunt-sloth` are the same binary. Interactively, type the short one — but in
CI and checked-in scripts, prefer the long `gaunt-sloth` form: it self-documents in CI logs
(nobody has to ask what `gth` is), and an AI agent later editing the script won't "auto-correct"
the unfamiliar `gth` to `gh` — a real, observed failure mode with the short name.

## The main use case: diagnose a build log from a script

Goal: a CI step pipes a failing build log into `gth`, captures the diagnosis, and stops the script
if `gth` itself errored (network/provider failure) rather than continuing with empty output.

```bash
export ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"

diagnosis=$(gth ask "Summarise the root cause of this build failure in two sentences." < build.log)
status=$?

if [ "$status" -ne 0 ]; then
  echo "gth ask failed (exit $status)" >&2
  exit "$status"
fi

echo "$diagnosis"
```

`gth ask` combines everything it is given, in order: the content of any `-f` files, then whatever
is piped on stdin, then the `[message]` argument. Here the message frames the task and `build.log`
arrives on stdin, so the model sees both. At least one of the three (file, stdin, or message) is
required — with none, `ask` errors out.

`status` is `1` when the run failed (a provider error, or the process couldn't produce an answer)
and `0` when it succeeded. That is a signal about the *run*, not a verdict on the *content* — to
fail a job when the content itself is bad (a review that doesn't pass, an eval assertion that
fails), see [Review code and pull requests](review-code-and-prs.md) and
[`eval`](../COMMANDS.md#eval).

## Deterministic runs with `exec`

When the prompt is fixed and you want the same input to give as close to the same output as the
provider allows, use `exec` instead of `ask`. `exec` runs a markdown "prompt-executable" and, unlike
`ask`, cannot be interrupted with ESC (there is no interactive user). Pass `-t 0` to pin the sampling
temperature to its most deterministic setting:

```bash
gth exec -m "List the section headings in CHANGELOG.md as a bullet list." -t 0 < CHANGELOG.md
```

The script itself resolves in precedence order: `-m/--message` inline text wins, then a `[script]`
file path, then stdin. So a checked-in prompt file is just as valid a scripted invocation:

```bash
gth exec scripts/release-notes.md -f CHANGELOG.md
```

`-m` and a positional `[script]` path are mutually exclusive — pass one or the other, not both.

## Writing the output to a file

`ask` and `exec` both honour the global `-w/--write-output-to-file`. Pass a filename to write there,
or `true` for a timestamped `gth_<timestamp>_ASK.md` / `gth_<timestamp>_EXEC.md` (under `.gsloth/`
if that directory exists, otherwise the project root):

```bash
gth -w diagnosis.md ask "Summarise the root cause of this build failure." < build.log
gth exec scripts/release-notes.md -w RELEASE_NOTES.md
```

Neither command writes a file unless you ask for one, and a `writeOutputToFile` in your config does
not switch `exec` on — its result streams to stdout so it stays pipeable by default. The report file
is a full session log, so when you want only the answer, redirect stdout instead:

```bash
gth exec scripts/release-notes.md > RELEASE_NOTES.md
```

## Stdin in CI

`ask` and `exec` read piped stdin, so on a non-TTY with an open-but-idle stdin they wait for EOF.
If a scripted `gth ask "…"` that takes its input from arguments (no pipe) appears to hang in CI,
close stdin (`gth ask "…" < /dev/null`) or pass the global `--no-pipe` flag to skip the wait.

## Examples

```bash
# Capture a one-line answer into a shell variable, branch on the exit code
answer=$(git --no-pager log -1 --stat | gth ask "Summarise this commit in one sentence.")
[ $? -eq 0 ] && echo "$answer"

# Deterministic inline prompt, result redirected to a file
gth exec -m "Rewrite README.md's intro as three bullet points." -t 0 < README.md > intro.md

# Run a checked-in prompt script with an extra context file
gth exec scripts/lint-summary.md -f eslint-report.json

# Pipe a prompt script on stdin
cat scripts/triage.md | gth exec
```

## Related

- Fail a CI job when a review or PR doesn't pass (content gating, not just run success):
  [Review code and pull requests](review-code-and-prs.md).
- Every `ask` / `exec` flag, the exit-code table, and output-file naming:
  [Commands](../COMMANDS.md#exec).
- Grade your whole agent with pass/fail assertions and a three-way exit code in CI:
  [Evaluate your agent](evals.md).
