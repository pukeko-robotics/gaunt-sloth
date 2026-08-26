#!/usr/bin/env bash
#
# BATCH-16 — run the live ADK-agent eval bed (a real Python google-adk agent over A2A).
#
#   ./run.sh              # the passing suite (adk.suite.yaml)
#   ./run.sh --broken     # the discrimination proof; exits 1, and must
#
# The lifecycle — build, provision the venv, start the agent under uvicorn, wait for its A2A card,
# grade, tear the process group down, propagate the eval's own exit code — is
# evals/harness/run-bed.sh. What is specific to this bed is in bed.conf. Env knobs, the load-bearing
# a2a-sdk pin and what this bed proves are in README.md.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../harness" && pwd)/run-bed.sh" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" "$@"
