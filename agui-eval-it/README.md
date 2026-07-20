# agui-eval-it — live AG-UI eval bed for `gth eval` (BATCH-17)

A **standalone, on-demand** bed that stands up gaunt-sloth's **own AG-UI server** (`gth api ag-ui`)
and grades it end-to-end through `gth eval`'s **`ag-ui` target** (BATCH-15). It is the *live*
validation of that target against a genuine running AG-UI server — not a fake. Sibling of the
`eval-it/` (BATCH-13) and `adk-eval-it/` (BATCH-16) beds; same shape, different SUT.

It is **not published**, **not in the root `pnpm build`**, and **not wired into `pnpm run it`** — run
it by hand.

## What it proves

- `gth`'s `ag-ui` target can drive a real AG-UI server's `POST {url}/agents/{agentId}/run` endpoint
  over HTTP/SSE, decode the streamed answer, and grade it with the SAME assertion surface
  (`must_contain`/`must_not_contain`/`judge`) used for the `gth-agent` target;
- the AG-UI wire streams **`TOOL_CALL_START`**, so the runner CAPTURES the tool trace and
  **`must_call`/`must_not_call` grade live** — the key difference from the `adk-agent` target, where
  the tool trace is invisible. The `ops-status-tool-call` case asserts `must_call: [get_ops_status]`
  and the captured trace is `tools: ["get_ops_status"]`;
- the AG-UI **`threadId`** (plus the replayed history) is threaded across turns, so a multi-turn
  conversation keeps memory against the live server (the `cross-turn-memory` case);
- a green that can actually fail: the discrimination suite asserts a marker the tool never emits and
  exits **1**.

The proof the tool actually ran is doubled: `must_call: [get_ops_status]` (the streamed call) **plus**
`must_contain: [OPS-STATUS-7Q9Z]` — a **verbatim, paraphrase-proof marker** the tool alone emits and
the model cannot invent.

## The SUT

`gth api ag-ui` serves a **Haiku** agent (`agent/.gsloth.config.json`) with ONE custom tool,
`get_ops_status`, that echoes the marker `OPS-STATUS-7Q9Z`. The config sets `filesystem: none` and
`builtInTools: []`, so `get_ops_status` is the **only** tool the agent has — which makes
`must_call`/`must_not_call` maximally deterministic. The tool takes **no parameters**, deliberately:
a zero-arg custom tool skips `GthCustomToolkit`'s parameter validation, so a bad param can never trip
the interactive `y/N` override prompt (which would block on stdin in a headless server and hang the
run — see the robustness note below).

Haiku (Anthropic) is used for the SUT because it is highly reliable at "you MUST call this tool",
which is the whole point of the `must_call` proof; it also exercises the just-merged GS2-64 Anthropic
double-`SystemMessage` fix over the AG-UI path. The judge is decoupled: it grades via the local gth
config (`gemini-flash-lite-latest`), unrelated to the served SUT model.

## Run it

```bash
# builds the CLI, starts the server, runs the suite, tears the server down
agui-eval-it/run-agui-eval.sh                          # the passing suite (agui.suite.yaml)   -> exit 0
agui-eval-it/run-agui-eval.sh agui-broken.suite.yaml   # the discrimination proof              -> exit 1

# faster iteration (skip the build if already done):
SKIP_BUILD=1 agui-eval-it/run-agui-eval.sh
```

The script:
1. builds this worktree's CLI (`pnpm build`) so eval runs the **freshly-built** ag-ui target, not the
   global `gth` (skip with `SKIP_BUILD=1`);
2. starts `gth api ag-ui --port <PORT>` in its own **process group** (`setsid`), pointed at the SUT
   config via the global `-c/--config` flag (which **must precede** the `api ag-ui` subcommand), and
   `trap`s EXIT to kill the whole group (no server left on the port);
3. polls `GET /health` until `{status:'ok'}`;
4. runs `gth eval <suite>` from `workdir/` with a **hermetic `HOME`** so no machine-global `~/.gsloth`
   merges under the judge profile (reproducible on any box), wrapped in `timeout` so a hung SSE stream
   surfaces as a nonzero exit rather than wedging the run;
5. prints and propagates the eval's real exit code (`AGUI EVAL EXIT CODE: <n>`).

Env: `AGUI_PORT` (default `41757`), `CONCURRENCY` (default `2`), `EVAL_TIMEOUT` seconds (default
`300`), `SKIP_BUILD=1`.

Requires **`ANTHROPIC_API_KEY`** (the served Haiku SUT) **and** **`GOOGLE_API_KEY`** (the
gemini-flash-lite judge) in the environment. Neither is written to any committed file.

The `url` in both suites (`http://127.0.0.1:41757`) must match `AGUI_PORT`. `agent_id: default` is the
`{agentId}` path segment of `POST {url}/agents/{agentId}/run` — the server accepts any id.

## Layout

```
agui-eval-it/
├── agent/.gsloth.config.json     # the SERVED SUT: Haiku + the one custom tool `get_ops_status`
├── run-agui-eval.sh              # server lifecycle (setsid+trap) + hermetic, timeout-wrapped gth eval
├── workdir/
│   ├── agui.suite.yaml           # the passing suite (must_call + marker must_contain + judge + multi-turn)
│   ├── agui-broken.suite.yaml    # the discrimination proof (asserts a false marker -> exit 1)
│   └── .gsloth/.gsloth-settings/.gsloth.config.json   # the JUDGE model (gemini-flash-lite-latest)
└── package.json / .gitignore
```

## The judge

The AG-UI SUT runs out-of-process with its own model; gth's local config is used only for the
**judge** (`workdir/.gsloth/.gsloth-settings/.gsloth.config.json`, `gemini-flash-lite-latest`).
Repoint the judge model by editing `llm.model` there.

## Note on the BATCH-15 live-path robustness gaps

BATCH-15's review flagged four Minor gaps in the ag-ui runner that only bite the LIVE path. This bed
is exactly where they would surface. In the runs recorded for BATCH-17 **none of them bit**: a healthy
`gth api ag-ui` always emits the terminal `RUN_FINISHED`, returns 200, sends a single assistant text
run, and frames events with the reference `\n\n` (CRLF-tolerant) delimiter. Gap #1 (no fetch/stream
timeout → an indefinite hang if a stream opens but never finishes) is the one to watch: the eval run
is wrapped in `timeout` so it would surface as a reportable nonzero exit rather than wedging the run.
These gaps are NOT patched from this bed (the bed adapts to the merged target) — they remain a
coordinator follow-up.
