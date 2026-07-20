# eval-it — live multi-identity MCP authorization suite for `gth eval` (BATCH-13)

A **standalone, on-demand** integration suite that exercises `gth eval`'s identity matrix against a
**real HTTP MCP server** with **per-identity bearer-token authorization**. It is the first *live*
(non-fake) exercise of the eval authorization / data-isolation path: three identities authenticate to
the same MCP server, each with its own `Authorization` bearer, and the suite passes iff each identity
is correctly scoped.

This is a **private workspace package** (`"private": true`, listed in `pnpm-workspace.yaml`). It is
**not published**, **not part of the root `pnpm build`**, and **not wired into `pnpm run it`**.

## What it proves (and what it does not)

It validates the `gth eval` **mechanism** end-to-end with a real LLM (Anthropic Claude Haiku 4.5) and a
real HTTP MCP server doing real per-identity authorization:

- per-identity `Authorization` headers reach **distinct** MCP connections (`[[CFG-4]]`: the bearer is
  never stripped),
- per-identity **tool visibility** (a tool hidden from an identity's `tools/list`) and **server-side
  denial** (a visible tool the server refuses) are both enforced and graded the correct way,
- **data isolation** (a shared tool returning only the caller's own rows) is graded from the server's
  results, not the model's goodwill.

It does **not** replace a pass against a real production MCP (e.g. a Java monolith) — this is a
synthetic target we fully control.

## Token → identity → scope map

| Bearer token   | Identity | Scope            | Sees (`tools/list`)                                              | Denied |
|----------------|----------|------------------|-----------------------------------------------------------------|--------|
| `admin-token`  | admin    | full access      | whoami, list_my_orders, search_catalog, list_inventory, list_all_orders, delete_order | — |
| `alice-token`  | alice    | procurement-read | whoami, list_my_orders, search_catalog, delete_order            | delete_order (server refuses); list_inventory + list_all_orders HIDDEN |
| `bob-token`    | bob      | inventory-read   | whoami, list_my_orders, list_inventory, delete_order            | delete_order (server refuses); search_catalog + list_all_orders HIDDEN |

Each identity profile sets `allowedTools: ["mcp__authz__*"]`, so the SUT agent is locked to **only the
authz MCP tools** — no filesystem/dev tools. This is load-bearing: without it, a hidden-tool identity
(e.g. bob asked about the catalog) will `gth_grep`/`read_file` the workdir, find a marker like
`CAT-WODGET-1` in the suite/server source, and report it — defeating `must_not_contain`. Locking the
SUT to MCP-only makes the server the sole source of truth (deterministic authz).

`list_my_orders` is visible to all three but returns **only the caller's own** order
(`ORD-ADMIN-1` / `ORD-ALICE-1` / `ORD-BOB-1`) — data isolation via results. `list_all_orders`
(admin-only) returns all three. Verbatim, paraphrase-proof markers: `ORD-*-1`, `CAT-WODGET-1`,
`INV-SKU42`, `DELETE-OK` (success) / `DELETE-DENIED` (refusal).

### The one rule that makes the assertions valid

Every deterministic assertion's truth comes from the **server**, never from the model *choosing* not
to call a visible tool. A tool is therefore either:

- **HIDDEN** for an identity → assert `must_not_call` (it cannot appear in the trace), or
- **VISIBLE-BUT-DENIED** (`delete_order`) → the agent WILL call it, so do **not** `must_not_call`;
  assert the answer (`must_not_contain` a success marker) + a judge ("explains it was refused").

## Run it

```bash
# from the repo root or eval-it/ — builds the CLI, starts the MCP server, runs the suite, tears down
eval-it/run-authz-eval.sh                       # the passing matrix (authz.suite.yaml)  -> exit 0
eval-it/run-authz-eval.sh authz-broken.suite.yaml   # the discrimination proof            -> exit 1

# faster iteration (skip the build if you just built):
SKIP_BUILD=1 eval-it/run-authz-eval.sh
```

The script:
1. builds this worktree's CLI (`pnpm build`) so eval runs the **freshly-built** app, not the global
   `gth` (skip with `SKIP_BUILD=1`);
2. starts the real MCP server, polls `/health` until ready, and `trap`s EXIT to kill it (no zombie on
   the port);
3. runs `gth eval <suite>` from `workdir/` with a **hermetic `HOME`** so no machine-global `~/.gsloth`
   config can merge under the per-identity profiles (reproducible on any box);
4. prints and propagates the eval's real exit code (`AUTHZ EVAL EXIT CODE: <n>`).

Env: `AUTHZ_MCP_PORT` (default `39405`; **must** match the URL pinned in the profile configs),
`CONCURRENCY` (default `3`), `SKIP_BUILD=1`.

Requires `ANTHROPIC_API_KEY` in the environment. **It is never written to any committed file** — the
profile configs use `{"type":"anthropic","model":"claude-haiku-4-5"}` and rely on the env var.

## Repoint the model (one line)

Edit the `llm.model` in each `workdir/.gsloth/.gsloth-settings/*/​.gsloth.config.json` (or the shared
`.gsloth.config.json` base). All four identity profiles (`admin`/`alice`/`bob`/`alice-broken`) plus the
no-identity base carry `{"type":"anthropic","model":"claude-haiku-4-5"}`; change the string to retarget.

## Discrimination proof (why a green run is meaningful)

`authz-broken.suite.yaml` runs one identity, `alice-broken`, whose profile is identical to `alice`
**except it deliberately sends the admin bearer** (a simulated authorization misconfiguration). It
asserts alice's *correct limited* expectations; because the profile actually authenticates as admin,
the cells testing alice's restrictions flip to FAIL (own-orders isolation, cross-scope read, inventory,
delete) while the one legitimately-shared cell (catalog — alice really has procurement scope) still
PASSES. Result: `1/5 passed, 4 failed`, **exit 1**. A suite that cannot fail proves nothing; this one
can, for the right reasons.

## Layout

```
eval-it/
├── src/authz-mcp-server.ts        # the real HTTP (Streamable) MCP server (@modelcontextprotocol/sdk)
├── run-authz-eval.sh              # server lifecycle + hermetic run + exit-code propagation
├── workdir/
│   ├── authz.suite.yaml           # the passing identity matrix (5 cases × 3 identities = 15 cells)
│   ├── authz-broken.suite.yaml    # the discrimination-proof (exit 1)
│   ├── step0-whoami.suite.yaml    # the STEP-0 pre-flight smoke
│   └── .gsloth/.gsloth-settings/  # base config + admin/alice/bob/alice-broken identity profiles
└── package.json / tsconfig.json
```

## Note on the core fix shipped alongside this suite

The first live run surfaced a pre-existing bug: `runSingleShot` passed the preamble as a
`SystemMessage` **and** the agent backends compose their own `systemPrompt`, producing two system
messages — which `@langchain/anthropic` rejects ("System messages are only permitted as the first
passed message"). This broke **every** single-shot run (ask/exec/batch/eval) on Anthropic on **both**
backends (Google/OpenAI silently merged them, hiding it). The fix (in
`packages/core/src/runtime/singleShot.ts`) drops the redundant preamble; the agent's composed prompt is
a superset, so it is content-preserving. Without it, this suite could not run against an Anthropic SUT
at all. See `handoff/task-1-report.md`.
