# @gaunt-sloth/batch

The batch / eval / workflow runtime for Gaunt Sloth. It ships **no binary of its own** — you reach
it through three commands the `gaunt-sloth` app registers (`gth batch`, `gth eval`, `gth workflow`),
or by importing the package to embed the runtime. Install `gaunt-sloth` to use the commands; depend
on `@gaunt-sloth/batch` to embed them in your own code.

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
