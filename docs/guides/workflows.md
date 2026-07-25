# Orchestrate agent calls from a script

`gth workflow` runs a local JavaScript file that drives the agent programmatically: call, look at
the result, decide, call again, fan out and join — control flow that a shell pipeline of `gth`
invocations can't express cleanly. When the shape is "same prompt × many rows", use
[`batch`](batch.md) instead; when it's "grade the output", use [`eval`](evals.md). A workflow is
for the logic in between.

> **Runs with full Node privileges.** The script is arbitrary local ESM — it can read files and
> spawn processes. Run only scripts you trust, as you would any local script.

## The main use case: classify in parallel, then summarize

Goal: classify a handful of user-feedback lines concurrently with schema-validated output, then
have the agent write a summary of the results — one script, one command.

`workflows/feedback.mjs`:

```js
export default async (ctx) => {
  const lines = ctx.args?.lines ?? [
    'App crashes when I upload a photo',
    'Love the new dark mode',
    'Password reset email never arrives',
  ];

  // Build schemas with ctx.z (the host's own zod instance) — a zod imported by the
  // script itself is a different copy and breaks structured output.
  const Classification = ctx.z.object({
    category: ctx.z.enum(['bug', 'praise', 'question']),
    urgent: ctx.z.boolean(),
  });

  const results = await ctx.parallel(
    lines.map(
      (line) => () => ctx.agent(`Classify this user feedback: ${line}`, { schema: Classification })
    )
  );
  ctx.log(`Classified ${results.filter(Boolean).length}/${lines.length} lines`);

  const summary = await ctx.agent(
    `Summarize this feedback classification in two sentences: ${JSON.stringify(results)}`,
    { system: 'You are a concise release manager.' }
  );

  return { results, summary };
};
```

Run it:

```bash
gth workflow workflows/feedback.mjs
```

The script's return value is the command's output: a string prints as-is, anything else as
pretty-printed JSON. A malformed `--args` value or an error thrown by the script fails the run
with a clean message and a non-zero exit code.

## The `ctx` surface

The default export must be `async (ctx) => result`. `ctx` provides:

- **`ctx.agent(prompt, opts?)`** — one LLM call through your resolved gth config. With
  `opts.schema` (a zod schema built from `ctx.z`) it makes a plain, tool-free model call and
  returns a schema-validated object; without one it returns the answer text from a full agent run
  (tools included). Other options:
  `system` (system-message text), `model` (per-call model override, e.g.
  `'google-genai:gemini-3.1-flash-lite'`), and `command` (the agent mode for text calls, default
  `'ask'`). Throws on failure — wrap in try/catch where one bad call shouldn't end the workflow.
- **`ctx.parallel(thunks)`** — runs an array of `() => Promise` thunks concurrently, **four at a
  time**, returning results in input order; a thunk that throws yields `null` in its slot instead
  of rejecting the whole batch (hence the `filter(Boolean)` above). This cap is the workflow host's
  own and is deliberately separate from `batch`/`eval`'s serial `-j` default — workflow thunks are
  usually cheap orchestration steps rather than N full model calls.
- **`ctx.args`** — the parsed `--args <json>` value, or `undefined`.
- **`ctx.log(message)`** — emit a progress line through gth's console (respects its levels).
- **`ctx.z`** — the host's zod module. Always build `schema` values with it.

Workflows respect your project config and global flags — `-i <profile>` selects the identity the
calls run under, and per-call `model` overrides resolve through the same config machinery as
`batch --models`.

## Examples

```bash
# Feed the script data as ctx.args
gth workflow workflows/feedback.mjs --args '{"lines":["Export to PDF is broken"]}'

# Run the script's agent calls under a named identity profile
gth -i cheap workflow workflows/feedback.mjs
```

## Related

- The `workflow` command reference: [Commands → workflow](../COMMANDS.md#workflow).
- Same prompt over many rows/models, no logic in between: [Batch](batch.md).
- Grading outputs with assertions and judges: [Evaluate your agent](evals.md).
- One-shot calls from shell scripts: [Scripting & CI](scripting-and-ci.md).
