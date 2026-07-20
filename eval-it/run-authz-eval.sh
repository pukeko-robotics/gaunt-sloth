#!/usr/bin/env bash
#
# BATCH-13 — run the live multi-identity MCP authorization eval suite.
#
#   ./run-authz-eval.sh [suite.yaml]        # default: authz.suite.yaml
#
# What it does:
#   1. Builds this worktree's CLI (so eval runs the freshly-built app, NOT the global `gth`).
#      Skip with SKIP_BUILD=1 (e.g. when you just built and want to run both suites).
#   2. Starts the real HTTP MCP server (eval-it/src/authz-mcp-server.ts) in the background and
#      polls /health until it is ready. A `trap` on EXIT kills it — no zombie on the port.
#   3. Runs `gth eval <suite>` from the profiles workdir with a HERMETIC HOME so no machine-global
#      ~/.gsloth config can merge under the per-identity profiles (the run is reproducible on any box).
#   4. Prints the eval's own exit code and propagates it as the script's exit code.
#
# Env:
#   AUTHZ_MCP_PORT   server port (default 39405; MUST match the URL pinned in the profile configs)
#   CONCURRENCY      `gth eval -j` value (default 3)
#   SKIP_BUILD=1     skip `pnpm build`
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKDIR="$SCRIPT_DIR/workdir"
CLI="$ROOT_DIR/packages/app/cli.js"
SUITE="${1:-authz.suite.yaml}"
PORT="${AUTHZ_MCP_PORT:-39405}"
CONCURRENCY="${CONCURRENCY:-3}"

# Hermetic home for the eval process only (keeps pnpm/build on the real HOME). Guarantees an empty
# global ~/.gsloth so no stray global mcpServers/llm merges under our profiles. ANTHROPIC_API_KEY is
# an env var and is preserved.
HERMETIC_HOME="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$HERMETIC_HOME" 2>/dev/null || true
}
trap cleanup EXIT

# Node-based health probe (no curl dependency). Exit 0 iff GET /health returns ok.
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

echo "==> starting MCP server on 127.0.0.1:${PORT} ..."
AUTHZ_MCP_PORT="$PORT" node "$SCRIPT_DIR/src/authz-mcp-server.ts" &
SERVER_PID=$!

echo "==> waiting for server readiness ..."
ready=""
for _ in $(seq 1 50); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: MCP server exited during startup (port ${PORT} taken?)." >&2
    exit 3
  fi
  if health_ok; then ready=1; break; fi
  sleep 0.2
done
if [[ "$ready" != "1" ]]; then
  echo "ERROR: MCP server did not become ready on port ${PORT}." >&2
  exit 3
fi
echo "==> server ready."

echo "==> running: gth eval ${SUITE} (cwd=${WORKDIR}, -j ${CONCURRENCY})"
# Run from the profiles workdir so config discovery resolves the per-identity profiles here (and the
# suite path + `-o out` are workdir-relative), not a config higher up the tree.
cd "$WORKDIR"
set +e
HOME="$HERMETIC_HOME" node "$CLI" eval "$SUITE" -j "$CONCURRENCY" -o out
EVAL_EXIT=$?
set -e

echo "AUTHZ EVAL EXIT CODE: ${EVAL_EXIT}"
exit "$EVAL_EXIT"
