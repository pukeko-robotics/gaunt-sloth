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
  "allowedTools": ["mcp__unimarket_*"]
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

- `allowedTools: ["mcp__unimarket_*"]` in the eval profile leaves the agent nothing but your
  server's tools (globs work; MCP tools are named `mcp__<server>_<tool>`, so one pattern tracks
  the server as it grows — but it also matches the tools of any server whose name starts with
  `unimarket_`, so give servers that share a profile names that do not extend one another);
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
        must_call: ["mcp__unimarket_contract*"]
        judge: "Returns actual contract types from the report data."
      - identities: [limited]
        must_call: ["mcp__unimarket_contract*"]
        judge: "Reports that access was denied and does not fabricate contract data."
```

The matrix is self-contained: every listed identity must resolve to a real profile directory
before anything runs (an unresolved name aborts with exit `2`, never a silent fallback), and no
base `-i` flag is needed on the CLI.

### 4. Asserting the denial structurally

A server that refuses a call returns `isError: true`, and that result reaches the eval's tool trace
under the tool's own name — so the denial is assertable with `must_error` instead of a rubric.
Replace the `limited` block above with:

```yaml
      - identities: [limited]
        must_call: ["mcp__unimarket_contract*"]    # it tried the tool…
        must_error: ["mcp__unimarket_contract*"]   # …and the server refused it
```

Both keys take the same glob patterns, so one pattern covers a growing tool family. Keep a judge
when the *wording* of the refusal matters — that the agent reported the denial rather than
inventing contract data — but the authorization fact itself is graded structurally, so a restricted
identity that quietly got real data back fails the case without a model having to notice.

`tool_result_json_path` is the other result-level key, and it grades what a call returned —
including a denial. A failed MCP call reaches the trace as the server's own error text, recorded
exactly as the model saw it, so a server whose errors are JSON can have its code and reason pinned:

```yaml
      - identities: [limited]
        must_call: ["mcp__unimarket_contract*"]
        must_error: ["mcp__unimarket_contract*"]
        tool_result_json_path:
          - { tool: "mcp__unimarket_contract*", path: "code", equals: "forbidden" }
          - { tool: "mcp__unimarket_contract*", path: "reason", contains: "contracts:read" }
```

That is what an authorization suite is really after: not just that the restricted identity was
refused, but that it was refused for a scope failure rather than a rate limit or an outage dressed
up as one.

When the server sends MCP `structuredContent` with an error, the check grades that structured body
instead of the text, and `path` addresses it from its root. That holds for a server that puts its
error detail *only* in `structuredContent` too, although the model then sees a stock sentence
(*The MCP tool returned an error without text content.*) in place of the detail, so repeat in the
text anything the agent should be able to act on. A server whose error text is prose and that sends
no `structuredContent` has no path to address — assert it with `must_error` plus a judge.

For a successful call the key reads the payload the model saw, and where `path` starts depends on
what the server sent back. A lone text block arrives as the text itself, so a `path` addresses that
JSON directly — including for a tool that declares an output schema, whose `structuredContent` the
model does not see and the check does not read. Several content blocks arrive as the blocks, with
the text one hop further in at `[0].text`.

```yaml
      - identities: [admin]
        tool_result_json_path:
          - { tool: "mcp__unimarket_contract*", path: "contracts[0].type", contains: "SUPPLY" }
```

When it matters what the agent *asked* the server for — that the admin's search was scoped to
active contracts rather than everything — assert on the call's arguments with
`tool_call_json_path`. It takes the same entries, read against the arguments the model sent, and
needs `"evalToolCallArgs": true` in the project config
(`.gsloth/.gsloth-settings/.gsloth.config.json`). Put it there, not in an identity's profile: it is a
setting of the run, and the matrix reads it from the config the run starts with:

```yaml
      - identities: [admin]
        tool_call_json_path:
          - { tool: "mcp__unimarket_contract_search", path: "status", equals: "ACTIVE" }
```

When the order of the calls matters, for example that the agent searched for the contract before
fetching its report, use `tool_trajectory`. It needs no setting, because every eval run records its
calls:

```yaml
      - identities: [admin]
        tool_trajectory:
          calls: ["mcp__unimarket_contract_search", "mcp__unimarket_contract_report"]
```

Other calls may come before, between and after these two. With `strict: true` the run must make
exactly these calls and no others. See
[Tool-call order assertions](../COMMANDS.md#tool-call-order-assertions).

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
- Every suite key and assertion, including `must_error` / `tool_result_json_path` /
  `tool_call_json_path` / `tool_trajectory` details:
  [Commands → eval](../COMMANDS.md#eval).
- Connecting MCP servers, static auth headers, OAuth, TLS trust: [MCP](../configuration/mcp.md).
- Profiles in depth: [Identity profiles](../configuration/profiles.md#identity-profiles).
