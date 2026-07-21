#!/usr/bin/env bash
#
# QA-7 — real-LLM CLI smoke: drive the REAL `gth` CLI against a LOCAL ollama model.
#
#   ./run-ollama-smoke.sh
#
# What it proves (and why the unit suite can't):
#   A whole-agent, real-LLM functional gate over the CLI's main verbs. Each case forces a tool
#   call (read a planted file whose UNIQUE marker exists nowhere else) and then asserts the marker
#   reaches stdout — which only happens if the model SYNTHESIZED an answer from the tool result.
#   That is exactly the GS2-59 class of regression (gemma-over-ollama returned EMPTY content on the
#   post-tool synthesis turn while every unit test stayed green). The marker never appears in the
#   tool-call echo (that line shows only the filename), so "stdout contains the marker" is a genuine
#   synthesis check, not a tool-ran check.
#
# What it is NOT:
#   * NOT the QA-1 packaged-artifact visual gate (no Docker, no vision) — this is a source-tree
#     functional smoke.
#   * NOT a CI gate. It needs a running ollama daemon + a local model + a GPU, so it can never run
#     in GitHub CI. It is an on-demand LOCAL pre-merge gate, mirroring eval-it/run-authz-eval.sh.
#     Absent ollama, it SKIPs and exits 0 so it can be run everywhere and no-op where it can't run.
#
# Cases (3 direct-drive verbs + 1 `gth eval` phase). Each asserts: exit 0 AND stdout contains
# `Requested tools:` (a tool ran) AND stdout contains that case's unique planted marker (synthesis).
#   1. ask            2. exec -m            3. code --no-tui            4. gth eval (structured)
#
# Env knobs:
#   SKIP_BUILD=1        skip `pnpm build` (use the already-built app; for fast iteration)
#   SMOKE_MODEL         ollama model tag to drive (default: gemma4:12b)
#   OLLAMA_HOST         ollama daemon URL (default: http://127.0.0.1:11434)
#   CASE_TIMEOUT        per-case wall-clock cap in seconds (default: 180)
#   CASE_ATTEMPTS       attempts per case, pass-if-any (default: 2). temp:0 passes on attempt 1; the
#                       retry only absorbs residual nondeterminism and cannot mask a real regression
#                       (which fails every attempt). Set to 1 to disable the backstop.
#   SMOKE_FORCE_FAIL=1  discrimination proof: plant a DECOY string in the `ask` case's marker.txt so
#                       read_file SUCCEEDS (exit 0, `Requested tools:` present) but the asserted
#                       marker is absent from the synthesis — reproducing the exact GS2-59 signature
#                       (successful tool call, wrong/empty synthesis). The run must report FAIL +
#                       exit 1. Analogous to eval-it's authz-broken.suite.yaml.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$ROOT_DIR/packages/app/cli.js"

SMOKE_MODEL="${SMOKE_MODEL:-gemma4:12b}"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
export OLLAMA_HOST   # the ollama provider reads OLLAMA_HOST too — probe and SUT hit the same daemon
CASE_TIMEOUT="${CASE_TIMEOUT:-180}"

# ---------------------------------------------------------------------------------------------------
# Ollama preflight FIRST (before build), so a box without a GPU/daemon/model skips instantly instead
# of paying for a build it can't use. Node-based probe (no curl dependency), matching the health-probe
# style in eval-it/run-authz-eval.sh. Exit 0 iff daemon reachable AND the model tag is present;
# exit 2 iff reachable-but-model-absent; exit 1 iff unreachable.
# ---------------------------------------------------------------------------------------------------
ollama_ready() {
  OLLAMA_PROBE_HOST="$OLLAMA_HOST" OLLAMA_PROBE_MODEL="$SMOKE_MODEL" node -e '
    const host = (process.env.OLLAMA_PROBE_HOST || "").replace(/\/+$/, "");
    const model = process.env.OLLAMA_PROBE_MODEL;
    fetch(host + "/api/tags")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("status " + r.status))))
      .then((j) => {
        const names = (j.models || []).map((m) => m.name);
        process.exit(names.includes(model) ? 0 : 2);
      })
      .catch(() => process.exit(1));
  ' >/dev/null 2>&1
}

set +e
ollama_ready
PROBE_RC=$?
set -e
if [[ $PROBE_RC -ne 0 ]]; then
  if [[ $PROBE_RC -eq 2 ]]; then
    echo "SKIPPED: model '${SMOKE_MODEL}' not present in ollama at ${OLLAMA_HOST} — this is a local-GPU-only gate. (\`ollama pull ${SMOKE_MODEL}\` to enable.)"
  else
    echo "SKIPPED: ollama daemon not reachable at ${OLLAMA_HOST} — this is a local-GPU-only gate."
  fi
  exit 0
fi
echo "==> ollama OK: daemon ${OLLAMA_HOST}, model ${SMOKE_MODEL}"

# ---------------------------------------------------------------------------------------------------
# Build the freshly-built app (so the smoke runs THIS worktree's CLI, not a global `gth`).
# ---------------------------------------------------------------------------------------------------
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> building CLI (pnpm build) ..."
  (cd "$ROOT_DIR" && pnpm build >/dev/null)
fi
if [[ ! -f "$CLI" ]]; then
  echo "ERROR: built CLI not found at $CLI (run without SKIP_BUILD=1 first)." >&2
  exit 3
fi

# ---------------------------------------------------------------------------------------------------
# Per-run hermetic workspace. One shared ollama config at the workdir root (resolved up-tree by every
# case), a HERMETIC HOME so no machine-global ~/.gsloth merges under it, and one SUBDIR PER CASE so a
# case's `list_directory(.)` can only see that case's own marker file (never another case's).
# ---------------------------------------------------------------------------------------------------
WORK="$(mktemp -d)"
EVAL_WORK="$(mktemp -d)"   # separate root so the eval phase's ONLY .gsloth is its own (see Phase 2)
HERMETIC_HOME="$(mktemp -d)"
cleanup() { cd / 2>/dev/null || true; rm -rf "$WORK" "$EVAL_WORK" "$HERMETIC_HOME" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$WORK/.gsloth/.gsloth-settings" "$WORK/logs"
# temperature:0 — a per-change gate must be REPRODUCIBLE. At the model's default temperature gemma
# wanders (picks list_directory over read_file, or hallucinates a glob path like `.** (searcher…)`),
# so the composite gate flaps (measured ~1/3 green). Greedy decoding (temp 0) makes each verb
# deterministic — the same tool sequence every run — which is what turns this from a coin flip into a
# gate. It does NOT weaken the GS2-59 synthesis check: a genuinely broken post-tool synthesis stays
# broken at temp 0.
cat > "$WORK/.gsloth/.gsloth-settings/.gsloth.config.json" <<EOF
{"llm":{"type":"ollama","model":"${SMOKE_MODEL}","numCtx":16384,"temperature":0}}
EOF

PROMPT='Read the file marker.txt using your tools and report the exact secret marker string it contains.'
PASS=0
FAIL=0

# run_case <label> <verb-desc> <marker> <casedir> <cmd...>
# Runs the command in <casedir> with hermetic HOME, a stdin-from-/dev/null (so single-turn verbs hit
# EOF and exit), and a timeout. `set +e` around the run so a failing case is REPORTED, not aborted
# (set -e would kill the whole gate on the first failing assertion).
#
# Retry backstop (CASE_ATTEMPTS, default 2): temperature:0 already makes each verb deterministic, so
# the happy path passes on attempt 1 (no extra latency). The retry only fires when an attempt fails,
# and exists purely to absorb RESIDUAL nondeterminism (e.g. GPU float ordering flipping one token at a
# decision boundary) — it must NOT be able to mask a real regression: a genuine GS2-59 break is
# deterministic and fails EVERY attempt, so pass-if-any still catches it (the discrimination proof
# below fails all attempts and reports FAIL). It only rescues a one-off "model did something dumb once".
run_case() {
  local label="$1" verb="$2" marker="$3" dir="$4"
  shift 4
  local attempts="${CASE_ATTEMPTS:-2}"
  echo ""
  echo "--- CASE ${label} (${verb}) — marker ${marker} ---"
  local attempt ok=0 lat=0 why="" log=""
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    log="$WORK/logs/${label}.attempt${attempt}.log"
    local start end rc
    start=$(date +%s)
    set +e
    ( cd "$dir" && HOME="$HERMETIC_HOME" timeout "$CASE_TIMEOUT" "$@" ) </dev/null >"$log" 2>&1
    rc=$?
    set -e
    end=$(date +%s)
    lat=$((end - start))

    local aok=1
    why=""
    if [[ $rc -ne 0 ]]; then aok=0; why="exit=$rc (expected 0)"; fi
    if ! grep -qF "Requested tools:" "$log"; then aok=0; why="${why:+$why; }no 'Requested tools:' (no tool call)"; fi
    if ! grep -qF "$marker" "$log"; then aok=0; why="${why:+$why; }marker '$marker' absent (no tool-derived synthesis)"; fi

    if [[ $aok -eq 1 ]]; then ok=1; break; fi
    if [[ $attempt -lt $attempts ]]; then
      echo "  attempt ${attempt}/${attempts} failed (${lat}s): ${why} — retrying"
    fi
  done

  if [[ $ok -eq 1 ]]; then
    echo "PASS  ${label} (${verb})  ${lat}s  attempt ${attempt}/${attempts}  tool-call ✓  marker ✓"
    PASS=$((PASS + 1))
  else
    echo "FAIL  ${label} (${verb})  ${lat}s  — ${why} (after ${attempts} attempts)"
    echo "----- captured output tail (${label}, last attempt) -----"
    tail -n 25 "$log" | sed 's/^/    /'
    echo "-------------------------------------------"
    FAIL=$((FAIL + 1))
  fi
}

# Unique marker per case (distinct prefix guarantees no cross-case collision; random suffix guards
# against any stale-output false-pass).
MARK_ASK="MARKER-ASK-$(printf '%04X' "$RANDOM")"
MARK_EXEC="MARKER-EXEC-$(printf '%04X' "$RANDOM")"
MARK_CODE="MARKER-CODE-$(printf '%04X' "$RANDOM")"

mkdir -p "$WORK/case-ask" "$WORK/case-exec" "$WORK/case-code"
printf 'The secret marker string is %s. Do not lose it.\n' "$MARK_EXEC" > "$WORK/case-exec/marker.txt"
printf 'The secret marker string is %s. Do not lose it.\n' "$MARK_CODE" > "$WORK/case-code/marker.txt"

ASK_PROMPT="$PROMPT"
if [[ "${SMOKE_FORCE_FAIL:-}" == "1" ]]; then
  # Discrimination proof that REPRODUCES THE GS2-59 SIGNATURE: a SUCCESSFUL tool call + a clean exit,
  # but the model's synthesis does not contain the asserted marker. The planted marker.txt holds a
  # DECOY string, so read_file succeeds (exit 0, `Requested tools:` present) yet MARK_ASK is absent —
  # exactly the empty/incorrect post-tool synthesis this gate exists to catch. The marker/synthesis
  # assertion must fire on its own, independent of exit code.
  echo "==> SMOKE_FORCE_FAIL=1: 'ask' marker.txt holds a decoy string, not the asserted marker (discrimination proof)."
  printf 'The secret marker string is DECOY-NOT-THE-ASSERTED-MARKER. Do not lose it.\n' > "$WORK/case-ask/marker.txt"
else
  printf 'The secret marker string is %s. Do not lose it.\n' "$MARK_ASK" > "$WORK/case-ask/marker.txt"
fi

echo ""
echo "=== PHASE 1: direct-drive CLI verbs ==="
run_case "ask"  "ask"           "$MARK_ASK"  "$WORK/case-ask"  node "$CLI" ask "$ASK_PROMPT"
run_case "exec" "exec -m"       "$MARK_EXEC" "$WORK/case-exec" node "$CLI" exec -m "$PROMPT"
run_case "code" "code --no-tui" "$MARK_CODE" "$WORK/case-code" node "$CLI" code --no-tui "$PROMPT"

# ---------------------------------------------------------------------------------------------------
# PHASE 2: `gth eval` over ollama — also smoke-tests the `eval` verb itself and yields a structured
# pass/fail table. `gth eval <suite>` resolves the suite path relative to the PROJECT ROOT (the dir
# holding `.gsloth`), so the eval phase gets its OWN self-contained root (config + suite + marker
# together, exactly like eval-it/workdir/), honoring SMOKE_MODEL. Its exit code propagates into the
# composite result. The Phase-1 direct-drive cases are the real gate and stand on their own.
# ---------------------------------------------------------------------------------------------------
echo ""
echo "=== PHASE 2: gth eval (structured, exercises the eval verb over ollama) ==="
mkdir -p "$EVAL_WORK/.gsloth/.gsloth-settings"
cat > "$EVAL_WORK/.gsloth/.gsloth-settings/.gsloth.config.json" <<EOF
{"llm":{"type":"ollama","model":"${SMOKE_MODEL}","numCtx":16384,"temperature":0}}
EOF
cp "$SCRIPT_DIR/workdir/smoke.suite.yaml" "$EVAL_WORK/smoke.suite.yaml"
cp "$SCRIPT_DIR/workdir/marker-eval.txt" "$EVAL_WORK/marker-eval.txt"
# Same retry backstop as run_case: temp:0 passes on attempt 1; a retry only fires on a failed attempt
# and cannot mask a real regression (which fails every attempt).
EVAL_ATTEMPTS="${CASE_ATTEMPTS:-2}"
EVAL_RC=1
for (( eattempt = 1; eattempt <= EVAL_ATTEMPTS; eattempt++ )); do
  EVAL_LOG="$WORK/logs/eval.attempt${eattempt}.log"
  set +e
  ( cd "$EVAL_WORK" && HOME="$HERMETIC_HOME" timeout "$CASE_TIMEOUT" \
      node "$CLI" eval smoke.suite.yaml -o out ) </dev/null >"$EVAL_LOG" 2>&1
  EVAL_RC=$?
  set -e
  [[ $EVAL_RC -eq 0 ]] && break
  if [[ $eattempt -lt $EVAL_ATTEMPTS ]]; then
    echo "  eval attempt ${eattempt}/${EVAL_ATTEMPTS} failed (exit=${EVAL_RC}) — retrying"
  fi
done
if [[ $EVAL_RC -eq 0 ]]; then
  echo "PASS  eval (gth eval smoke.suite.yaml)  exit=0  attempt ${eattempt}/${EVAL_ATTEMPTS}"
  PASS=$((PASS + 1))
else
  echo "FAIL  eval (gth eval smoke.suite.yaml)  exit=${EVAL_RC} (after ${EVAL_ATTEMPTS} attempts)"
  echo "----- captured output tail (eval, last attempt) -----"
  tail -n 30 "$EVAL_LOG" | sed 's/^/    /'
  echo "---------------------------------------"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((PASS + FAIL))
echo ""
echo "==> SUMMARY: ${PASS}/${TOTAL} passed (model ${SMOKE_MODEL})"
if [[ $FAIL -gt 0 ]]; then
  echo "==> RESULT: FAIL"
  exit 1
fi
echo "==> RESULT: PASS"
exit 0
