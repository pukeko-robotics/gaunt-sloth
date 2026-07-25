# Evals for MCP servers

From the model's perspective, an MCP server is made of prompts. Tool names, tool descriptions,
parameter schemas, and any server-advertised prompts are all text the model reads and acts on —
they are effectively executable. Reword a tool description and you change agent behavior the way a
code change does, except nothing compiles and no unit test fails. If you develop an MCP server,
you need evals over the **live server** to be confident. This page distills a real setup into the
working pattern: a team regression-testing a large Java monolith's MCP server (per-user JWT auth,
read-only business tools) in CI with `gth eval`, reported in
[gaunt-sloth#405](https://github.com/pukeko-robotics/gaunt-sloth/issues/405).

It builds on [Evaluate your agent](evals.md) — read that first for the eval basics.

## The main use case: prove authorization works, per identity

Goal: the same question, asked as an admin and as a restricted user, must return data for one and
a refusal for the other — proven by the tool trace, not by eyeballing prose.

### 1. One identity profile per role

An [identity profile](../configuration/profiles.md#identity-profiles) is a config directory —
`.gsloth/.gsloth-settings/<name>/` — and each role gets its own, whose MCP connection carries that
identity's bearer token. The server sees a genuinely different caller per profile.

`.gsloth/.gsloth-settings/limited/.gsloth.config.json`:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-3.5-flash" },
  "tls": { "extraCaCerts": ["org/our-dev-ca.crt"] },
  "mcpServers": {
    "unimarket": {
      "transport": "http",
      "url": "https://dev-mcp/mcp",
      "headers": { "Authorization": "Bearer <limited-user-jwt>" }
    }
  },
  "allowedTools": ["mcp__unimarket__*"]
}
```

Duplicate the directory as `admin/` with the admin token. The `headers` map is sent verbatim on
every request to the server (see
[MCP → static auth headers](../configuration/mcp.md#static-auth-headers-bearer-tokens));
`tls.extraCaCerts` trusts a dev server's self-issued CA.

### 2. Lock the agent to the MCP tools — the false-positive trap

The `allowedTools` line above is load-bearing. In a plain session the agent also has filesystem
tools — and asked "list the contract types", it can grep the project's source tree and answer
correctly **without ever calling your server**: a green eval that tested nothing. That is a real
field report from #405, not a hypothetical. Two locks close it:

- `allowedTools: ["mcp__unimarket__*"]` in the eval profile leaves the agent nothing but your
  server's tools (globs work; MCP tools are named `mcp__<server>__<tool>`, so one pattern tracks
  the server as it grows);
- `must_call` in the suite makes every pass structural — a case fails unless a matching tool was
  actually invoked, however plausible the prose.

### 3. The authorization matrix

A suite-level `identities:` list runs every case once per profile — the `(case × identity)`
matrix — and per-identity `expect:` blocks grade each cell. Same prompt, different bearer token,
different expected outcome. `suites/authz.yaml`:

```yaml
target: { type: gth-agent }
identities: [admin, limited]
judge_profile: judge
defaults: { pass_threshold: 6 }
cases:
  - id: contract-report-scoping
    prompt: "Fetch the contract report and list the contract types."
    expect:
      - identities: [admin]
        must_call: ["mcp__unimarket__contract*"]
        judge: "Returns actual contract types from the report data."
      - identities: [limited]
        must_call: ["mcp__unimarket__contract*"]
        judge: "Reports that access was denied and does not fabricate contract data."
```

The matrix is self-contained: every listed identity must resolve to a real profile directory
before anything runs (an unresolved name aborts with exit `2`, never a silent fallback), and no
base `-i` flag is needed on the CLI.

### 4. Asserting the denial — the honest current pattern

Two structural keys exist for "called **and** denied": `must_error` (a called tool matching the
pattern returned an error result) and `tool_result_json_path` (a check over the result payload).
For an MCP denial, do not rely on them yet: the #405 field run (alpha.24, live server) found that
**errored MCP tool results are missing from the captured tool trace** — the authorized identity's
successful result is captured, the restricted identity's `isError: true` result is not — so both
keys come up empty on exactly the case they were built for. The gap is still open; it is tracked
in [#405](https://github.com/pukeko-robotics/gaunt-sloth/issues/405). Until it closes:

- pin the call with `must_call` — deterministic, and it works today;
- grade the denial itself with the `judge:` rubric, as in the suite above.

One more capture wrinkle to know when you do assert on MCP results: a captured result is the raw
MCP content block (`{"type":"text","text":"{...}"}`), so a `tool_result_json_path` can resolve
`path: "text"` but cannot reach fields inside the inner JSON string.

### 5. A separate, stronger, non-MCP judge

The `judge_profile: judge` above is its own profile directory too:
`.gsloth/.gsloth-settings/judge/` with `filesystem: "none"`, **no** `mcpServers`, and a stronger
model than the system under test. This is the #405 team's pattern: a judge that shares the SUT's
model shares its blind spots, so grade with an independent, stronger one — and since the judge
makes a single non-agentic call (it grades text against the rubric, nothing more), its profile
needs nothing beyond the `llm` block, and should never carry the server credentials the SUT
profiles do. `--judge <profile>` on the CLI overrides the suite's `judge_profile` per run.

### 6. Run it in CI

```bash
gth eval suites/ --reporter text,junit -o eval-out
```

A directory runs every suite in it under one aggregate exit code. Gate the job on the three-way
contract: `1` means a product regression (your server or its prompts changed behavior — a denial
stopped denying); `2` means the harness or environment is broken (unparseable suite, unresolvable
identity, no output to grade) — nothing was actually evaluated, so alert differently. The JUnit
`results.xml` lands beside each suite's `results.json` (`eval-out/**/*.xml` collects them), which
TeamCity, GitHub Actions, and friends ingest natively. `eval` never waits on stdin, so no
`</dev/null` is needed anywhere.

## Related

- Eval basics — writing a first suite, judges, reporters: [Evaluate your agent](evals.md).
- Every suite key and assertion, including `must_error` / `tool_result_json_path` details:
  [Commands → eval](../COMMANDS.md#eval).
- Connecting MCP servers, static auth headers, OAuth, TLS trust: [MCP](../configuration/mcp.md).
- Profiles in depth: [Identity profiles](../configuration/profiles.md#identity-profiles).
