#!/usr/bin/env bash
#
# BATCH-16 — run the LIVE ADK-agent eval bed: stand up a real Python google-adk agent over A2A and
# grade it through `gth eval`'s `adk-agent` target (which drives it via `@a2a-js/sdk`).
#
#   ./run-adk-eval.sh [suite.yaml]        # default: adk.suite.yaml (the passing suite)
#   ./run-adk-eval.sh adk-broken.suite.yaml   # the discrimination proof (exits 1)
#
# What it does:
#   1. Builds this worktree's CLI (so eval runs the freshly-built app + its adk-agent target, NOT the
#      global `gth`). Skip with SKIP_BUILD=1 (e.g. to run both suites back-to-back).
#   2. Creates the venv + installs requirements.txt (google-adk + the LOAD-BEARING a2a-sdk==0.3.26
#      pin) on first run; reuses it after. See requirements.txt for why the pin matters.
#   3. Starts the Python ADK agent under uvicorn on a fixed port with A2A enabled, in its own process
#      GROUP (setsid), and polls the A2A agent card (/.well-known/agent-card.json) until 200 — which
#      also confirms the Starlette lifespan attached the A2A routes. A `trap` on EXIT kills the whole
#      group so no uvicorn child is left holding the port.
#   4. Runs `gth eval <suite>` from workdir/ with a HERMETIC HOME so no machine-global ~/.gsloth
#      config merges under the judge profile (reproducible on any box). The judge model is gth's own
#      gemini-flash-lite-latest (workdir/.gsloth/.gsloth-settings/.gsloth.config.json).
#   5. Prints the eval's own exit code and propagates it as the script's exit code.
#
# Env:
#   ADK_A2A_PORT   agent port (default 41539; the suites pin the matching url)
#   ADK_A2A_MODEL  SUT model (default gemini-flash-lite-latest)
#   CONCURRENCY    `gth eval -j` value (default 2)
#   SKIP_BUILD=1   skip `pnpm build`
#   SKIP_VENV=1    skip the venv create/install (reuse an already-provisioned .venv)
#
# Requires GOOGLE_API_KEY in the environment (used by BOTH the ADK SUT and the gth judge). It is
# never written to any committed file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKDIR="$SCRIPT_DIR/workdir"
VENV="$SCRIPT_DIR/.venv"
CLI="$ROOT_DIR/packages/app/cli.js"
SUITE="${1:-adk.suite.yaml}"
PORT="${ADK_A2A_PORT:-41539}"
MODEL="${ADK_A2A_MODEL:-gemini-flash-lite-latest}"
CONCURRENCY="${CONCURRENCY:-2}"

if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
  echo "ERROR: GOOGLE_API_KEY is not set — the ADK SUT and the gth judge both need it." >&2
  exit 3
fi

HERMETIC_HOME="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  # Kill the whole process group (setsid leader == SERVER_PID) so uvicorn's server child dies too.
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$HERMETIC_HOME" 2>/dev/null || true
}
trap cleanup EXIT

# Health probe: the ADK Starlette app has no /health route, and its A2A routes (incl. the card) are
# attached in the lifespan — so a 200 on the well-known card both means "ready" and "startup ran".
card_ok() {
  node -e "fetch('http://127.0.0.1:${PORT}/.well-known/agent-card.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

if card_ok; then
  echo "ERROR: port ${PORT} already serving an agent card — another agent is running. Free it first." >&2
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

if [[ "${SKIP_VENV:-}" != "1" ]]; then
  if [[ ! -x "$VENV/bin/python" ]]; then
    echo "==> creating venv + installing requirements (first run) ..."
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --upgrade pip >/dev/null
    "$VENV/bin/pip" install -r "$SCRIPT_DIR/requirements.txt" >/dev/null
  fi
fi
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "ERROR: venv python not found at $VENV/bin/python (run without SKIP_VENV=1 first)." >&2
  exit 3
fi

echo "==> starting ADK agent (uvicorn) on 127.0.0.1:${PORT} (model=${MODEL}) ..."
# setsid → new process group led by this PID, so the trap can kill the uvicorn server child too.
# GOOGLE_GENAI_USE_VERTEXAI=FALSE routes the SUT model to AI Studio (GOOGLE_API_KEY), not Vertex.
ADK_A2A_PORT="$PORT" ADK_A2A_MODEL="$MODEL" GOOGLE_GENAI_USE_VERTEXAI=FALSE \
  setsid "$VENV/bin/python" -m uvicorn adk_agent:app \
  --host 127.0.0.1 --port "$PORT" --app-dir "$SCRIPT_DIR/src" >"$SCRIPT_DIR/adk-agent.log" 2>&1 &
SERVER_PID=$!

echo "==> waiting for the agent card ..."
ready=""
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: ADK agent exited during startup — see $SCRIPT_DIR/adk-agent.log" >&2
    tail -20 "$SCRIPT_DIR/adk-agent.log" >&2 || true
    exit 3
  fi
  if card_ok; then ready=1; break; fi
  sleep 0.3
done
if [[ "$ready" != "1" ]]; then
  echo "ERROR: ADK agent did not serve its card on port ${PORT} — see $SCRIPT_DIR/adk-agent.log" >&2
  tail -20 "$SCRIPT_DIR/adk-agent.log" >&2 || true
  exit 3
fi
echo "==> agent ready (card resolved)."

echo "==> running: gth eval ${SUITE} (cwd=${WORKDIR}, -j ${CONCURRENCY})"
cd "$WORKDIR"
set +e
HOME="$HERMETIC_HOME" node "$CLI" eval "$SUITE" -j "$CONCURRENCY" -o out
EVAL_EXIT=$?
set -e

echo "ADK EVAL EXIT CODE: ${EVAL_EXIT}"
exit "$EVAL_EXIT"
