#!/usr/bin/env bash
#
# BATCH-13 — run the live multi-identity MCP authorization eval bed.
#
#   ./run.sh                          # the passing matrix (authz.suite.yaml)
#   ./run.sh --broken                 # the discrimination proof; exits 1, and must
#   ./run.sh multiturn-smoke.suite.yaml   # any other suite in workdir/
#
# The lifecycle — build, start the MCP server, wait for it, grade, tear down, propagate the eval's
# own exit code — is evals/harness/run-bed.sh. What is specific to this bed is in bed.conf. Env
# knobs and what this suite proves are in README.md.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../harness" && pwd)/run-bed.sh" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" "$@"
