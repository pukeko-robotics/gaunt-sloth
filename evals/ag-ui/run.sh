#!/usr/bin/env bash
#
# BATCH-17 — run the live AG-UI eval bed (gaunt-sloth's own `gth api ag-ui` server).
#
#   ./run.sh              # the passing suite (agui.suite.yaml)
#   ./run.sh --broken     # the discrimination proof; exits 1, and must
#
# The lifecycle — build, start the server under setsid, wait for /health, grade under a `timeout`,
# tear the process group down, propagate the eval's own exit code — is evals/harness/run-bed.sh.
# What is specific to this bed is in bed.conf. Env knobs and what this bed proves are in README.md.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../harness" && pwd)/run-bed.sh" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" "$@"
