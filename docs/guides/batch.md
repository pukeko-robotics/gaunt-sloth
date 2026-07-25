# Fan out one prompt over inputs and models

`gth batch` runs one markdown prompt-executable across a whole matrix of inputs and/or models —
"xargs for prompts", the way `exec` runs a single one. The division of labor is deliberate:
**`batch` produces answers at scale; [`eval`](evals.md) grades them.** `batch` exits `0` as long
as the cells *ran* — a poor-quality answer is not a harness failure, and only a harness-level
error (a malformed input file, a missing script) sets a non-zero exit.

## The main use case: triage a CSV of tickets

Goal: run every row of a support-ticket export through the same triage prompt, in parallel, and
get one structured result per ticket.

Write the prompt as `prompts/triage.md`, with `{{field}}` placeholders for the CSV columns:

```markdown
Classify this support ticket as `bug`, `billing`, or `how-to`, and suggest a one-line reply.

Ticket {{id}} from {{customer}}:

{{description}}
```

With `data/tickets.csv` having `id,customer,description` columns, run eight cells at a time:

```bash
gth batch prompts/triage.md --over data/tickets.csv -j 8
```

Each row becomes one cell — an isolated single-shot run with the row's values spliced into the
prompt. (A placeholder that matches no column is left as-is; a script with no matching
placeholders at all gets the row appended as a context block instead.) The run ends with
`Batch complete: <passed>/<total> cell(s) passed` — plus, if cells failed, a warning pointing at
`results.json`; the per-cell files hold each answer.

## The model axis

`--models` fans out over models instead of (or as well as) rows — the matrix is the cross-product
of both axes. Comparing three models on one prompt is a one-liner:

```bash
gth batch prompts/classify.md --models claude-sonnet-4-5,gpt-4o,gemini-2.5-pro
```

Omit `--models` and cells run under your configured model, no fan-out.

## Retries and output

- `--retry <n>` re-runs a failed cell up to `n` times — for transient provider errors and
  timeouts, so one flaky call doesn't cost you the run (default `0`).
- `-o <dir>` picks the output directory (default: a timestamped `gth_<date>_BATCH` directory
  alongside other gth reports). It receives one structured JSON file per cell — the answer, token
  counts, and the tools called — plus a `results.json` summary.

`--over` accepts CSV or JSONL; each JSONL record's fields bind the same way as CSV columns.

## Grading what batch produced

When "good" is checkable — must mention X, must have called tool Y, passes a rubric — write the
checks as an eval suite and gate on `gth eval`'s exit code: see [Evaluate your agent](evals.md).
And when the shape is not "same prompt × many rows" but "call, decide, call again", reach for
[a workflow](workflows.md) rather than scripting around `batch`.

## Examples

```bash
# Fan out over models AND rows, retry failed cells, write to a named dir
gth batch prompts/triage.md --over data/tickets.jsonl \
  --models claude-sonnet-4-5,gpt-4o --retry 2 -o out/triage

# Run a prompt-executable over CSV rows with all defaults
gth batch prompts/summarize.md --over data/feedback.csv
```

## Related

- Every `batch` flag: [Commands → batch](../COMMANDS.md#batch).
- Prompt-executables and one-shot runs: [Scripting & CI](scripting-and-ci.md).
- Grading answers with assertions and judges: [Evaluate your agent](evals.md).
