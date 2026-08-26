#!/usr/bin/env bash
#
# The shared lifecycle for every live eval bed under `evals/`.
#
#   evals/harness/run-bed.sh <bed-dir> [suite.yaml | --broken]
#
# A bed is a system under test plus a workdir of `gth eval` suites. Standing one up is the same
# five steps every time — build the CLI, start the SUT, wait for it to answer, grade it, tear the
# SUT down — so those steps live here once and each bed contributes only what differs, in its own
# `bed.conf`. Run a bed through its own `run.sh`, which is a two-line call into this script.
#
# WHAT THIS SCRIPT GUARANTEES
#
#   * The graded run is HERMETIC. `HOME` is a fresh empty directory for the `gth eval` process only,
#     so no machine-global `~/.gsloth` can merge under the bed's own profiles and the result is the
#     same on any box. `pnpm build` still runs under the real HOME.
#   * The SUT is TORN DOWN on every exit path, via a `trap` — including the failure paths and a
#     Ctrl-C. A bed whose SUT forks (uvicorn, express) declares BED_SUT_PROCESS_GROUP=1 and starts
#     it under `setsid`, so the trap kills the whole group rather than leaving a child on the port.
#   * The eval's OWN exit code is what this script exits with. That is the entire point: a bed's
#     discrimination suite proves itself by exiting 1, and anything that swallowed or remapped that
#     code would turn a real guard into a decoration.
#   * A bed that has not declared its discrimination suite CANNOT RUN. See the next paragraph.
#
# THE DISCRIMINATION SUITE IS NOT OPTIONAL. Every bed declares BED_REAL_SUITE and BED_BROKEN_SUITE,
# and this script refuses to run — exit 3, before anything is built or started — if either is
# missing from `bed.conf` or names a file that is not in the workdir. It refuses on EVERY run, not
# only on a `--broken` run, because the failure being guarded against is a bed that quietly has no
# way to fail: a green from a suite that cannot go red proves nothing, and a harness that treated an
# undeclared broken suite as "this bed has no discrimination check" would manufacture exactly that.
#
# Env:
#   SKIP_BUILD=1    skip `pnpm build` (use when you just built and are running both suites)
#   CONCURRENCY     `gth eval -j` value; each bed sets its own default
#   plus whatever the bed's own `bed.conf` documents (its port, its model, its timeout)
#
# Exit codes: 3 for a harness fault (bad config, occupied port, unbuilt CLI, SUT that never became
# ready) — never confusable with the eval's own 0 or 1.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: evals/harness/run-bed.sh <bed-dir> [suite.yaml | --broken]" >&2
  exit 3
fi

BED_DIR="$(cd "$1" && pwd)"
shift
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HARNESS_DIR/../.." && pwd)"
CLI="$ROOT_DIR/packages/app/cli.js"

# ---------------------------------------------------------------------------------------------
# The bed's own configuration.
# ---------------------------------------------------------------------------------------------

BED_CONF="$BED_DIR/bed.conf"
if [[ ! -f "$BED_CONF" ]]; then
  echo "ERROR: no bed.conf in $BED_DIR — every bed declares its own configuration there." >&2
  exit 3
fi

# Defaults for the settings a bed may leave out. A bed that needs none of these says nothing.
BED_NAME=""
BED_REAL_SUITE=""
BED_BROKEN_SUITE=""
BED_WORKDIR="workdir"
BED_PORT_VAR=""
BED_PORT_DEFAULT=""
BED_READY_PATH="/health"
BED_READY_NOUN="GET /health"
BED_READY_ATTEMPTS=50
BED_READY_INTERVAL=0.2
BED_CONCURRENCY_DEFAULT=2
BED_EVAL_TIMEOUT_DEFAULT=""
BED_SUT_PROCESS_GROUP=0
BED_SUT_LOG=""
BED_TIMEOUT_HINT=""
BED_REQUIRED_ENV=()

bed_provision() { :; }

# shellcheck source=/dev/null
source "$BED_CONF"

fail_config() {
  echo "ERROR: $BED_CONF — $1" >&2
  exit 3
}

[[ -n "$BED_NAME" ]] || fail_config "BED_NAME is not set."
[[ -n "$BED_PORT_VAR" ]] || fail_config "BED_PORT_VAR is not set."
[[ -n "$BED_PORT_DEFAULT" ]] || fail_config "BED_PORT_DEFAULT is not set."
declare -F bed_start_sut >/dev/null || fail_config \
  "no bed_start_sut function. A bed defines one, and it must exec its SUT so that the process this
       script waits on and kills is the SUT itself rather than a wrapper subshell around it."

WORKDIR="$BED_DIR/$BED_WORKDIR"
[[ -d "$WORKDIR" ]] || fail_config "BED_WORKDIR names $WORKDIR, which is not a directory."

# The two suites, checked together and by the same rule, so neither can be the one that quietly
# went missing. A run may still name any other suite in the workdir as its argument.
[[ -n "$BED_REAL_SUITE" ]] || fail_config "BED_REAL_SUITE is not set."
[[ -n "$BED_BROKEN_SUITE" ]] || fail_config \
  "BED_BROKEN_SUITE is not set. Every bed must declare the suite that proves it can FAIL; a bed
       with no discrimination suite cannot show that its green means anything."
[[ -f "$WORKDIR/$BED_REAL_SUITE" ]] || fail_config \
  "BED_REAL_SUITE names $BED_REAL_SUITE, which is not in $WORKDIR."
[[ -f "$WORKDIR/$BED_BROKEN_SUITE" ]] || fail_config \
  "BED_BROKEN_SUITE names $BED_BROKEN_SUITE, which is not in $WORKDIR."

# ---------------------------------------------------------------------------------------------
# What this invocation is going to run.
# ---------------------------------------------------------------------------------------------

case "${1:-}" in
  "") SUITE="$BED_REAL_SUITE" ;;
  --broken) SUITE="$BED_BROKEN_SUITE" ;;
  *) SUITE="$1" ;;
esac

PORT="${!BED_PORT_VAR:-$BED_PORT_DEFAULT}"
CONCURRENCY="${CONCURRENCY:-$BED_CONCURRENCY_DEFAULT}"
EVAL_TIMEOUT="${EVAL_TIMEOUT:-$BED_EVAL_TIMEOUT_DEFAULT}"

for requirement in ${BED_REQUIRED_ENV[@]+"${BED_REQUIRED_ENV[@]}"}; do
  name="${requirement%%:*}"
  reason="${requirement#*:}"
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: $name is not set — $reason" >&2
    exit 3
  fi
done

# ---------------------------------------------------------------------------------------------
# Lifecycle.
# ---------------------------------------------------------------------------------------------

# Hermetic home for the graded run only, so the bed's own profiles are the whole configuration.
HERMETIC_HOME="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    if [[ "$BED_SUT_PROCESS_GROUP" == "1" ]]; then
      # setsid made this PID a process-group leader, so the negative PID reaches its children too
      # — without that, a forking SUT leaves a child holding the port.
      kill -TERM "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
    else
      kill "$SERVER_PID" 2>/dev/null || true
    fi
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$HERMETIC_HOME" 2>/dev/null || true
}
trap cleanup EXIT

# Readiness probe. Node rather than curl, so a bed needs nothing installed that the repository does
# not already require. Exit 0 iff the URL answers with an ok status.
ready_ok() {
  node -e "fetch('http://127.0.0.1:${PORT}${BED_READY_PATH}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

sut_log_tail() {
  if [[ -n "$BED_SUT_LOG" ]]; then
    tail -20 "$BED_DIR/$BED_SUT_LOG" >&2 || true
  fi
}

# A port that already answers is another instance, not ours. Starting beside it would grade the
# wrong process, so stop rather than guess.
if ready_ok; then
  echo "ERROR: port ${PORT} already answering ${BED_READY_NOUN} — another instance is running. Free it first." >&2
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

bed_provision

echo "==> starting ${BED_NAME} SUT on 127.0.0.1:${PORT} ..."
bed_start_sut &
SERVER_PID=$!

echo "==> waiting for ${BED_READY_NOUN} ..."
ready=""
for _ in $(seq 1 "$BED_READY_ATTEMPTS"); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: ${BED_NAME} SUT exited during startup (port ${PORT} taken?)." >&2
    sut_log_tail
    exit 3
  fi
  if ready_ok; then ready=1; break; fi
  sleep "$BED_READY_INTERVAL"
done
if [[ "$ready" != "1" ]]; then
  echo "ERROR: ${BED_NAME} SUT did not answer ${BED_READY_NOUN} on port ${PORT}." >&2
  sut_log_tail
  exit 3
fi
echo "==> SUT ready."

# Run from the workdir so config discovery resolves the bed's own profiles here, and so the suite
# path and `-o out` are workdir-relative.
echo "==> running: gth eval ${SUITE} (cwd=${WORKDIR}, -j ${CONCURRENCY}${EVAL_TIMEOUT:+, timeout ${EVAL_TIMEOUT}s})"
cd "$WORKDIR"

EVAL_CMD=()
if [[ -n "$EVAL_TIMEOUT" ]]; then
  EVAL_CMD+=(timeout "$EVAL_TIMEOUT")
fi
EVAL_CMD+=(node "$CLI" eval "$SUITE" -j "$CONCURRENCY" -o out)

set +e
HOME="$HERMETIC_HOME" "${EVAL_CMD[@]}"
EVAL_EXIT=$?
set -e

if [[ -n "$EVAL_TIMEOUT" && "$EVAL_EXIT" == "124" ]]; then
  echo "ERROR: eval TIMED OUT after ${EVAL_TIMEOUT}s. Report this; do NOT mask it with a longer wait." >&2
  if [[ -n "$BED_TIMEOUT_HINT" ]]; then
    echo "       ${BED_TIMEOUT_HINT}" >&2
  fi
fi

echo "${BED_NAME} EVAL EXIT CODE: ${EVAL_EXIT}"
exit "$EVAL_EXIT"
