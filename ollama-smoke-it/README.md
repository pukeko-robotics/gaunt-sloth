# ollama-smoke-it — real-LLM CLI smoke against a local ollama model (QA-7)

A **local, on-demand** functional gate that drives the **real `gth` CLI** against a **local ollama
model** (`gemma4:12b` by default) and asserts each main verb actually runs, calls a tool, and
synthesizes a non-empty answer from the tool result.

Run it before merging a change that touches the agent runtime, the provider layer, or the CLI verbs.

## What it proves

Each case forces a tool call — "read `marker.txt` and report the exact secret marker string inside
it" — where the marker exists **nowhere but that file**. The gate then asserts, per case:

- process **exit 0**, and
- stdout contains `Requested tools:` (a tool actually ran), and
- stdout contains that case's **unique planted marker** (the model synthesized an answer from the
  tool result).

The marker only reaches stdout via the model's **final answer** — the tool-call echo prints just the
filename (`read_file(path: marker.txt)`), never the file's contents. So "stdout contains the marker"
is a genuine **synthesis** check, not merely a "a tool ran" check. That is precisely the **GS2-59**
class of regression it guards: gemma-over-ollama returned **empty content** on the post-tool
synthesis turn while every unit test stayed green. A whole-agent, real-LLM smoke is the only thing
that catches it.

Cases (3 direct-drive verbs + 1 structured `eval` phase):

| Phase | Verb | Drives |
|-------|------|--------|
| 1 | `gth ask`            | single-shot, read-only FS toolset |
| 1 | `gth exec -m`        | single-shot, full toolset |
| 1 | `gth code --no-tui`  | plain readline session, full toolset (`+ run_shell_command`) |
| 2 | `gth eval`           | the eval verb itself + a structured pass/fail table |

## What it is NOT

- **Not the QA-1 packaged-artifact visual gate.** No Docker, no vision — this is a source-tree
  functional smoke.
- **Not a CI gate.** It needs a running ollama daemon, a local model, and a GPU, so it can **never**
  run in GitHub CI. It is a **local pre-merge** gate, mirroring `eval-it/run-authz-eval.sh`. It is
  deliberately **not** wired into `.github/`, `pnpm run it`, or the root `pnpm build`.
- **Not a substitute** for a cloud/CI functional gate — it catches the whole-agent integration
  regressions the unit suite cannot, on the hardware where a real local model is available.

## Local-GPU-only, with a graceful skip

Because it drives a real local model, it is **local-GPU-only**. It preflights the ollama daemon and
the model **before building**: if the daemon is unreachable or the model tag is absent, it prints
`SKIPPED: …` and **exits 0** (a skip is not a failure). That means you can run it on any box — CI,
a laptop with no GPU — and it no-ops cleanly where it can't run. Non-zero exit is reserved for an
**actual assertion failure**.

## Run it

```bash
ollama-smoke-it/run-ollama-smoke.sh          # builds the CLI, runs all cases   -> exit 0 if all pass
pnpm run smoke:ollama                         # same thing, via the root script

SKIP_BUILD=1 ollama-smoke-it/run-ollama-smoke.sh    # fast iteration (skip the build)
```

The script:
1. **preflights** ollama (daemon reachable + model present) — SKIP + exit 0 if not;
2. **builds** this worktree's CLI (`pnpm build`) so the smoke runs the **freshly-built** app, not a
   global `gth` (skip with `SKIP_BUILD=1`);
3. runs each case in its **own hermetic subdir** (unique marker file per case) under a per-run
   `mktemp` workspace with a **hermetic `HOME`**, so no machine-global `~/.gsloth` config merges in;
4. prints a per-case `PASS`/`FAIL` line + a `N/M passed` summary, and **exits non-zero if any case
   failed**.

### Env knobs

| Var | Default | Effect |
|-----|---------|--------|
| `SMOKE_MODEL`      | `gemma4:12b`             | **Repoint the model in one line** — the ollama tag to drive. |
| `OLLAMA_HOST`      | `http://127.0.0.1:11434` | ollama daemon URL (same var the ollama CLI + the provider use). |
| `SKIP_BUILD`       | *(unset)*                | `1` = skip `pnpm build` and run the already-built app. |
| `CASE_TIMEOUT`     | `180`                    | per-case wall-clock cap in seconds (a hung turn fails the case, not the gate). |
| `SMOKE_FORCE_FAIL` | *(unset)*                | `1` = discrimination proof (below). |

Repoint the model: `SMOKE_MODEL=gemma4:31b ollama-smoke-it/run-ollama-smoke.sh`.

## Discrimination proof (why a green run is meaningful)

A gate that cannot fail proves nothing. `SMOKE_FORCE_FAIL=1` plants a **decoy** string in the `ask`
case's `marker.txt`, so `read_file` **succeeds** (exit 0, `Requested tools:` present) but the asserted
marker is absent from the synthesis — **reproducing the exact GS2-59 signature** (a successful tool
call followed by wrong/empty synthesis). The run reports `FAIL` and **exits 1**, for the right reason:
the **synthesis / marker** check, firing independently of exit code. (Analogous to `eval-it`'s
`authz-broken.suite.yaml`.)

```bash
SMOKE_FORCE_FAIL=1 SKIP_BUILD=1 ollama-smoke-it/run-ollama-smoke.sh   # -> FAIL, exit 1
```

## Layout

```
ollama-smoke-it/
├── run-ollama-smoke.sh         # the gate: preflight -> build -> per-case hermetic runs -> summary
├── workdir/
│   ├── smoke.suite.yaml        # the Phase-2 `gth eval` suite (one tool-forcing case)
│   ├── marker-eval.txt         # the file that suite's case reads
│   └── .gsloth/.gsloth-settings/.gsloth.config.json   # ollama config for a manual `gth eval` run
└── README.md
```

`workdir/` is the committed source for the Phase-2 eval suite. The script copies the suite + marker
into a hermetic per-run workspace (resolving the ollama config with `SMOKE_MODEL` there), so a run
never writes into the committed tree. To run the eval phase by hand against the committed config:
`cd ollama-smoke-it/workdir && HOME=$(mktemp -d) gth eval smoke.suite.yaml -o out` (repoint its
model by editing `llm.model` in that config).

This directory has **no npm dependencies** and is **not** a workspace package (not in
`pnpm-workspace.yaml`) — it is a plain script directory like an on-demand test harness.

## Parked follow-up: real-model Ink TUI

A real-LLM pass through the **Ink TUI** (`gth code --tui`) is intentionally **out of scope** here.
The GS2-59 provider-layer bug this gate guards (empty content on the post-tool synthesis turn) is
already caught by the `code --no-tui` and single-shot cases; the Ink *rendering* is covered by the
fixture-based `packages/app/tui-e2e/` (which uses `GTH_TUI_E2E_FIXTURE`, no real model). Combining a
non-deterministic local LLM with tui-test timing/render assertions is the slowest, flakiest,
lowest-value piece. A possible future follow-up: a real-model `@microsoft/tui-test` scenario that
omits the fixture env var — but it is not part of this gate.
