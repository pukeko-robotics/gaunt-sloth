#!/usr/bin/env bash
#
# BATCH-17 — run the LIVE AG-UI eval bed: stand up gaunt-sloth's OWN AG-UI server (`gth api ag-ui`)
# and grade it through `gth eval`'s `ag-ui` target (which drives the server's HTTP/SSE run endpoint,
# capturing the streamed answer AND tool calls).
#
#   ./run-agui-eval.sh [suite.yaml]              # default: agui.suite.yaml (the passing suite)
#   ./run-agui-eval.sh agui-broken.suite.yaml    # the discrimination proof (exits 1)
#
# What it does:
#   1. Builds this worktree's CLI (so eval runs the freshly-built app + its ag-ui target, NOT the
#      global `gth`). Skip with SKIP_BUILD=1 (e.g. to run both suites back-to-back).
#   2. Starts `gth api ag-ui` on a fixed port, pointed at the bed's SUT config
#      (agui-eval-it/agent/.gsloth.config.json — a cheap model + one custom tool `get_ops_status`),
#      in its own process GROUP (setsid). A `trap` on EXIT kills the whole group so no server is left
#      holding the port. The global `-c/--config` flag MUST precede the `api ag-ui` subcommand.
#   3. Polls GET /health until the server answers (the server exposes `{status:'ok'}` there).
#   4. Runs `gth eval <suite>` from workdir/ with a HERMETIC HOME so no machine-global ~/.gsloth
#      config merges under the judge profile (reproducible on any box). The judge model is gth's own
#      gemini-flash-lite-latest (workdir/.gsloth/.gsloth-settings/.gsloth.config.json) — decoupled
#      from the served SUT model. The eval run is wrapped in `timeout` so a hung SSE stream (BATCH-15
#      gap #1: no fetch/stream timeout) surfaces as a reportable nonzero, never a wedged session.
#   5. Prints the eval's own exit code and propagates it as the script's exit code.
#
# Env:
#   AGUI_PORT      server port (default 41757; the suites pin the matching url)
#   CONCURRENCY    `gth eval -j` value (default 2)
#   EVAL_TIMEOUT   seconds before the eval run is force-killed (default 300)
#   SKIP_BUILD=1   skip `pnpm build`
#
# Requires ANTHROPIC_API_KEY (the served SUT agent, Haiku) AND GOOGLE_API_KEY (the gth judge,
# gemini-flash-lite). Neither is written to any committed file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKDIR="$SCRIPT_DIR/workdir"
AGENT_CONFIG="$SCRIPT_DIR/agent/.gsloth.config.json"
CLI="$ROOT_DIR/packages/app/cli.js"
SUITE="${1:-agui.suite.yaml}"
PORT="${AGUI_PORT:-41757}"
CONCURRENCY="${CONCURRENCY:-2}"
EVAL_TIMEOUT="${EVAL_TIMEOUT:-300}"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ERROR: ANTHROPIC_API_KEY is not set — the served AG-UI SUT agent (Haiku) needs it." >&2
  exit 3
fi
if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
  echo "ERROR: GOOGLE_API_KEY is not set — the gth judge (gemini-flash-lite) needs it." >&2
  exit 3
fi

HERMETIC_HOME="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  # Kill the whole process group (setsid leader == SERVER_PID) so the express server child dies too.
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$HERMETIC_HOME" 2>/dev/null || true
}
trap cleanup EXIT

# Health probe: the AG-UI server exposes GET /health -> {status:'ok'} once it is listening.
health_ok() {
  node -e "fetch('http://127.0.0.1:${PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

if health_ok; then
  echo "ERROR: port ${PORT} already answering /health — another server is running. Free it first." >&2
  exit 3
fi

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> building CLI (pnpm build) ..."
  (cd "$ROOT_DIR" && pnpm build >/dev/null)
fi
if [[ ! -f "$CLI" ]]; then
  echo "ERROR: built CLI not found at $CLI (run without SKIP_BUILD=1 first)." >&2
  exit 3
fi

echo "==> starting gth api ag-ui on 127.0.0.1:${PORT} (SUT config: agent/.gsloth.config.json) ..."
# setsid → new process group led by this PID, so the trap can kill the express server child too.
# `--config` (global) MUST precede the `api ag-ui` subcommand. </dev/null so the CLI never blocks
# on stdin. The SUT agent reads ANTHROPIC_API_KEY from the environment.
setsid node "$CLI" --config "$AGENT_CONFIG" api ag-ui --port "$PORT" \
  </dev/null >"$SCRIPT_DIR/agui-server.log" 2>&1 &
SERVER_PID=$!

echo "==> waiting for GET /health ..."
ready=""
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: AG-UI server exited during startup — see $SCRIPT_DIR/agui-server.log" >&2
    tail -20 "$SCRIPT_DIR/agui-server.log" >&2 || true
    exit 3
  fi
  if health_ok; then ready=1; break; fi
  sleep 0.3
done
if [[ "$ready" != "1" ]]; then
  echo "ERROR: AG-UI server did not answer /health on port ${PORT} — see $SCRIPT_DIR/agui-server.log" >&2
  tail -20 "$SCRIPT_DIR/agui-server.log" >&2 || true
  exit 3
fi
echo "==> server ready (/health ok)."

echo "==> running: gth eval ${SUITE} (cwd=${WORKDIR}, -j ${CONCURRENCY}, timeout ${EVAL_TIMEOUT}s)"
cd "$WORKDIR"
set +e
HOME="$HERMETIC_HOME" timeout "$EVAL_TIMEOUT" node "$CLI" eval "$SUITE" -j "$CONCURRENCY" -o out
EVAL_EXIT=$?
set -e

if [[ "$EVAL_EXIT" == "124" ]]; then
  echo "ERROR: eval TIMED OUT after ${EVAL_TIMEOUT}s — a hung SSE stream (BATCH-15 gap #1: no" >&2
  echo "       fetch/stream timeout in the ag-ui runner). Report this; do NOT mask with a longer wait." >&2
fi

echo "AGUI EVAL EXIT CODE: ${EVAL_EXIT}"
exit "$EVAL_EXIT"
