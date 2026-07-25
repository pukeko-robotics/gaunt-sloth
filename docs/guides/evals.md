# Evaluate your agent

What you ship is not a model — it is an agent: a system prompt, tools, maybe MCP servers, wired
around a model. `gth eval` tests that **whole running agent**. A suite of YAML cases sends real
prompts through the real agent — tool calls included — grades every answer with deterministic
assertions and/or an LLM judge, and exits with a code a CI step can gate on.

## The main use case: a regression gate on the agent's behavior

Goal: fail the build when the agent stops answering support questions from the product docs and
starts making things up — without a human reading transcripts.

Create `eval/support-smoke.yaml`:

```yaml
target: { type: gth-agent }
defaults: { pass_threshold: 6 }
cases:
  - id: quotes-refund-policy
    prompt: "What is our refund window, per the docs?"
    must_contain: ["30 days"]
    judge: "States the 30-day refund window and cites where the policy is documented."
  - id: declines-to-invent
    prompt: "What is our policy on quantum refunds?"
    must_not_contain: ["quantum refund policy is"]
    judge: "Admits no such policy exists rather than fabricating one."
```

`target: { type: gth-agent }` runs each case through the in-process agent under your project's own
configuration — the same model, tools, and prompts a real run gets. Assertions can also be
structural, over the tool trace rather than the answer text: `must_call` fails a case unless the
agent actually invoked a matching tool. That pin is at its best when the profile is locked to the
tools under test — the pattern [Evals for MCP servers](evals-for-mcp-servers.md) is built on.

Run it:

```bash
gth eval eval/support-smoke.yaml
```

Each case prints one `PASS`/`FAIL` line (with the failing reason), followed by a closing
`EVAL RESULT: <passed>/<total> case(s) passed`. Structured output — one JSON file per case plus a
`results.json` summary — is always written (to a timestamped directory, or wherever `-o` points).

The exit code is three-way, and CI should treat the values differently:

- `0` — every case passed;
- `1` — the suite ran but at least one case failed: a **product** regression;
- `2` — a harness/environment error (unparseable suite, unresolved profile, no output to grade):
  nothing was meaningfully evaluated, so don't read it as a product verdict.

## Choose a separate judge

A `judge:` rubric is scored 0–10 by an LLM, and by default that is the SUT's own model — which
means the judge shares the very blind spots you are testing for. Point the judge at its own
[identity profile](../configuration/profiles.md#identity-profiles) with a stronger (or at least
different) model — per suite with `judge_profile: strict-judge`, or per run with the flag (the
flag wins):

```bash
gth eval eval/support-smoke.yaml --judge strict-judge
```

The judge makes a single, non-agentic call — it grades text against the rubric, nothing more — so
its profile only needs an `llm` block. Keep it minimal (`filesystem: "none"`, no `mcpServers`) so
the grading identity never doubles as an agent with access.

## Wire it into CI

Point `eval` at a whole directory to run every suite in it under one aggregate exit code, and add
the JUnit reporter so your CI renders per-case results natively:

```bash
gth eval eval/ --reporter text,junit -o eval-out
```

`--reporter text,junit` keeps the console summary and adds the JUnit reporter (see
[Commands → eval](../COMMANDS.md#eval) for the flag's full semantics). The JUnit `results.xml`
lands beside `results.json` — per suite subdirectory in a multi-suite run, so a glob like
`eval-out/**/*.xml` collects them all.

## Examples

```bash
# Two suites in one run, one aggregate exit code
gth eval eval/support-smoke.yaml eval/authz-matrix.yaml

# 8 cases in parallel, structured results to a named directory
gth eval eval/support-smoke.yaml -j 8 -o eval-out/smoke

# Gate a CI step and tell regression (1) from broken harness (2)
gth eval eval/ || echo "eval failed (exit $?)"
```

## Related

- Every suite key, assertion, and flag — including the full assertion table, identity matrices,
  and multi-turn cases: [Commands → eval](../COMMANDS.md#eval).
- The deep worked example — authorization testing against a live MCP server:
  [Evals for MCP servers](evals-for-mcp-servers.md).
- Producing answers at scale before grading them: [Batch](batch.md).
- Plain one-shot `ask`/`exec` in scripts: [Scripting & CI](scripting-and-ci.md).
