# @gaunt-sloth/batch

The batch / eval / workflow runtime for Gaunt Sloth. You reach it three ways: through the commands
the `gaunt-sloth` app registers (`gth batch`, `gth eval`, `gth workflow`), through this package's own
`gth-batch` binary — a thin standalone matrix runner for shell pipelines (see [below](#pipeline-runner-gth-batch)) —
or by importing the package to embed the runtime. Install `gaunt-sloth` for the full command set;
install `@gaunt-sloth/batch` for the standalone binary, or depend on it to embed the runtime.

## Grade a suite of prompts (`gth eval`)

You want to check that your agent still passes a set of graded cases before you ship a prompt or
config change. Write a suite YAML, install the CLI, then run `gth eval` — it exits `0` iff every
case passes ("pytest for prompts"). The commands run on `@gaunt-sloth/batch`, but they ship in the
`gaunt-sloth` app, so that is what you install:

```bash
npm install -g gaunt-sloth@alpha
```

Write `prompts.eval.yaml`:

```yaml
target: { type: gth-agent }
cases:
  - id: greets-and-signs-off
    prompt: "Greet the user, then say goodbye."
    must_contain: ["hello", "goodbye"]
  - id: summarizes-as-json
    prompt: "Summarize the last release as a JSON object with a title field."
    must_not_contain: ["Sorry"]
    judge: "Returns a single JSON object with a non-empty title field."
    pass_threshold: 7
```

Run it:

```bash
gth eval prompts.eval.yaml
```

A case passes when its deterministic checks hold (`must_contain` / `must_not_contain` /
`should_contain_any`) and, if a `judge` rubric is set, the LLM judge rates the answer at or above
`pass_threshold` (0–10 scale, suite default `6`). `gth eval` prints a `PASS`/`FAIL` line per case
plus a suite total, writes structured per-case JSON and a `results.json` summary to a timestamped
output dir (override with `-o <dir>`), and exits non-zero if any case failed. Add `-j <n>` to cap
in-flight cases.

### Examples

```bash
# Run one prompt-executable over a matrix of two models × the rows of a CSV.
gth batch summarize.md --over inputs.csv --models gemini-2.5-pro,gemini-3.5-flash -j 4

# Run a local orchestration script, passing it JSON as ctx.args.
gth workflow rank-models.mjs --args '{"topic":"robotics"}'
```

`gth batch <script.md>` runs a markdown prompt-executable over a matrix of models (`--models a,b,c`,
comma-separated; omit to use the configured model) and/or content-bound input rows (`--over
<file.csv|file.jsonl>` — one cell per row, with `{{field}}` placeholders bound from the row). It
writes the same structured per-cell output as `eval` but — unlike `eval` — exits `0` as long as the
cells *ran*: a poor answer is not a harness failure. `-j <n>` caps concurrency, `--retry <n>` retries
a failed cell (default `0`), `-o <dir>` sets the output dir.

`gth workflow <script.mjs>` runs a local ESM script whose default export is `async (ctx) => result`;
the return value is printed (a string as-is, anything else as pretty JSON), and `--args <json>` is
handed to the script as `ctx.args`. The script is arbitrary local ESM run with full Node privileges
(it can read files and spawn processes) — run only scripts you trust, as you would any local script.

## Pipeline runner (`gth-batch`)

`gth batch` above is the full command, wired into the `gaunt-sloth` app. When you want the matrix
runtime on its own — inside a shell pipeline, without installing the whole CLI — this package ships a
thin binary, `gth-batch`, that runs the same matrix and emits the **same per-cell records** `gth batch`
produces, one JSON object per line (JSONL) on stdout:

```bash
# Fan a prompt-executable over rows piped in as JSON (or YAML), across two models.
echo '[{"topic":"gears"},{"topic":"levers"}]' \
  | gth-batch explain.md --models gemini-2.5-flash,gemini-2.5-pro -j 4 \
  | jq -c 'select(.ok) | {id, model, answer}'
```

It takes the script path as its argument and the input axis as **inline `--over` data** (a JSON/YAML
array of row objects) **or on stdin** — a pipeline already has the shell to produce the data, so
unlike `gth batch` there is no CSV/JSONL file path. `--models a,b,c`, `-j <n>` (concurrency) and
`--retry <n>` behave as in `gth batch`.

Each stdout line is the full `CellResult` (`id`, `model`, `inputIndex`, `inputRow`, `ok`, `answer`,
`tokensInput`/`tokensOutput`, `tools`, `durationMs`, `retries`) — stdout is kept a clean data channel
(all progress/errors go to stderr), so it pipes straight into `jq`, `grep`, or a file. Following the
`gth batch` exit-code contract, `gth-batch` exits `0` as long as the cells *ran* — a poor or failed
cell is recorded as `"ok": false` in its line, not reflected in the exit code; only a harness error
(bad arguments, an unreadable script, malformed `--over`, or a config failure) exits non-zero.

It resolves your model from the same `.gsloth.config.*` as the rest of Gaunt Sloth (discovered from
the working directory), so configure a provider there first.

## Programmatic use

Depend on `@gaunt-sloth/batch` to drive the same engine from your own code. Every module is exported
via the `./*.js` subpath map, matching the other `@gaunt-sloth/*` packages:

```js
import { runEvalSuite } from '@gaunt-sloth/batch/evalRunner.js';
```

The public API (see the package's `index.ts`) groups by command:

- **Matrix** (`gth batch`): `buildMatrix`, `bindCellContent`, `parseOverFile`, `runBatchMatrix`,
  `buildBatchSummary`, `writeBatchOutput`, `DEFAULT_CONCURRENCY`.
- **Eval** (`gth eval`): `parseEvalSuite`, `runDeterministicChecks`, `judgeEvalCase`, `runEvalSuite`,
  `writeEvalOutput`, `EvalVerdictSchema`, `DEFAULT_EVAL_PASS_THRESHOLD`.
- **Workflow** (`gth workflow`): `runWorkflow`.

The corresponding TypeScript types (`MatrixCell`, `BatchSummary`, `CellResult`, `EvalSuite`,
`EvalCaseResult`, `WorkflowContext`, …) are exported alongside them.

## Dependencies

- `@gaunt-sloth/core` — config, provider factory, the lean single-shot runtime, `askStructured`
- `@gaunt-sloth/agent` — the resolvers and lean agent factory the batch/eval/workflow cell path runs on
- `@langchain/core`, `yaml`, `zod`

## Related packages

- [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) — Core utilities, config,
  and agent infrastructure
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/core))
- [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent) — Agent runtime: built-in
  tools, filesystem toolkit, middleware registry, API server, AG-UI, MCP, and A2A integration
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/agent))
- [`@gaunt-sloth/review`](https://www.npmjs.com/package/@gaunt-sloth/review) — Review and Q&A modules
  with standalone CLI
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/review))
- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — Batch / eval / workflow
  runtime (this package)
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
