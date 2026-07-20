# adk-eval-it — live ADK-agent eval bed for `gth eval` (BATCH-16)

A **standalone, on-demand** bed that stands up a **real Python `google-adk` agent** over the A2A
protocol and grades it end-to-end through `gth eval`'s **`adk-agent` target** (BATCH-14). It is the
*live* validation of that target against a genuine running ADK agent — not a fake. Sibling of the
`eval-it/` BATCH-13 bed; same shape, different SUT.

It is **not published**, **not in the root `pnpm build`**, and **not wired into `pnpm run it`** — run
it by hand.

## What it proves

- `gth`'s `adk-agent` target (which drives `@a2a-js/sdk`'s `A2AClient`) can resolve a real
  google-adk agent card and reach its JSON-RPC endpoint, and grade the answer with the SAME
  assertion surface (`must_contain`/`must_not_contain`/`judge`) used for the `gth-agent` target;
- the A2A **`contextId`** is threaded across turns, so a multi-turn conversation keeps memory
  against the live agent (the `cross-turn-memory` case);
- a green that can actually fail: the discrimination suite asserts a marker the agent never emits and
  exits **1**.

Because A2A exposes **no tool trace**, `must_call`/`must_not_call` are a **parse-time error** for this
target. The proof that the tool actually ran is instead a **verbatim, paraphrase-proof marker** the
tool alone emits (`SHIP-DELIVERED-7Q`, `SHIP-INTRANSIT-3B`), asserted with `must_contain`.

## THE load-bearing detail — the A2A card-schema alignment

`gth`'s adk-agent target bundles **`@a2a-js/sdk` 0.3.14**, whose deprecated `new A2AClient(url)`
resolves the card at `<url>/.well-known/agent-card.json` and reads the **top-level `url`** field as
the JSON-RPC service endpoint.

google-adk 2.5.0 *by default* pulls **a2a-sdk 1.1.x**, which serves the **new** A2A card schema —
`supportedInterfaces: [{url, protocolBinding, protocolVersion: "1.0"}]`, with **no top-level `url`**.
Against that card the 0.3.14 client hard-fails at resolution:

```
Fetched Agent Card does not contain a valid 'url' for the service endpoint.
```

The fix is a **one-line pin** (`requirements.txt`): `a2a-sdk==0.3.26`. google-adk 2.5.0 allows
`a2a-sdk>=0.3.4,<2`, so it runs unchanged on the 0.3 generation, which emits the **classic 0.3.0
card** the JS client speaks:

```json
{ "url": "http://127.0.0.1:41539", "preferredTransport": "JSONRPC", "protocolVersion": "0.3.0", ... }
```

Same protocol generation on both ends → the whole exchange (card + `message/send` + `Task` shape) is
honestly compatible. The bed adapts to the target; the target and `@a2a-js/sdk` are untouched.

The `url` in both suites must match the port the agent is served on (`ADK_A2A_PORT`, default `41539`).

## Run it

```bash
# builds the CLI, provisions the venv (first run), starts the agent, runs the suite, tears down
adk-eval-it/run-adk-eval.sh                        # the passing suite (adk.suite.yaml)   -> exit 0
adk-eval-it/run-adk-eval.sh adk-broken.suite.yaml  # the discrimination proof             -> exit 1

# faster iteration (skip the build and/or the venv provisioning if already done):
SKIP_BUILD=1 SKIP_VENV=1 adk-eval-it/run-adk-eval.sh
```

The script:
1. builds this worktree's CLI (`pnpm build`) so eval runs the **freshly-built** adk-agent target, not
   the global `gth` (skip with `SKIP_BUILD=1`);
2. creates `.venv` + installs `requirements.txt` on first run (skip with `SKIP_VENV=1`);
3. starts the ADK agent under uvicorn in its own **process group** (`setsid`), polls the A2A card
   (`/.well-known/agent-card.json`) until `200`, and `trap`s EXIT to kill the whole group (no zombie
   uvicorn child on the port);
4. runs `gth eval <suite>` from `workdir/` with a **hermetic `HOME`** so no machine-global `~/.gsloth`
   merges under the judge profile (reproducible on any box);
5. prints and propagates the eval's real exit code (`ADK EVAL EXIT CODE: <n>`).

Env: `ADK_A2A_PORT` (default `41539`), `ADK_A2A_MODEL` (default `gemini-flash-lite-latest`),
`CONCURRENCY` (default `2`), `SKIP_BUILD=1`, `SKIP_VENV=1`.

Requires **`GOOGLE_API_KEY`** in the environment — used by BOTH the ADK SUT (routed to AI Studio via
`GOOGLE_GENAI_USE_VERTEXAI=FALSE`) and the gth judge (gth's `google-genai` provider). It is **never**
written to any committed file.

## Layout

```
adk-eval-it/
├── src/adk_agent.py          # the minimal google-adk LlmAgent + `lookup_shipment` tool, served via to_a2a()
├── requirements.txt          # google-adk 2.5.0 + the LOAD-BEARING a2a-sdk==0.3.26 pin (+ uvicorn)
├── run-adk-eval.sh           # agent lifecycle (setsid+trap) + hermetic gth eval run + exit-code propagation
├── workdir/
│   ├── adk.suite.yaml        # the passing suite (marker must_contain + judge + multi-turn contextId)
│   ├── adk-broken.suite.yaml # the discrimination proof (asserts a false marker -> exit 1)
│   └── .gsloth/.gsloth-settings/.gsloth.config.json   # the JUDGE model (gemini-flash-lite-latest)
├── .venv/                    # gitignored; created by the script
└── package.json / .gitignore
```

## The judge

The `adk-agent` SUT runs out-of-process with its own model; gth's local config is used only for the
**judge** (`workdir/.gsloth/.gsloth-settings/.gsloth.config.json`, `gemini-flash-lite-latest`).
Repoint the judge model by editing `llm.model` there.

## Note on `json_path`

The bed leans on deterministic `must_contain` markers plus one `judge` case. `json_path` assertions
(`JSON.parse(answer)`) are supported for this target too, but an LLM SUT does not reliably emit
fence-free JSON, which would make a green flaky — so the passing suite grades the marker text
instead. Add a strict-JSON case only if you shape the agent instruction to emit bare JSON.
