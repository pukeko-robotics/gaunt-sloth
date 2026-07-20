/**
 * @packageDocumentation
 * BATCH-2 — the shapes for `gth eval`: a parsed suite/case, deterministic-check results, the
 * judge's verdict, and per-case/suite outcomes. Deliberately separate from {@link ../types.js}
 * (BATCH-1's cell/outcome shapes), which documents itself as scoped to "cells and outcomes" only
 * — eval's shapes layer on top of (not into) that file.
 */

/** The 0-10 judge scale's default pass threshold, matching `review`'s own (unexported)
 * `DEFAULT_PASS_THRESHOLD` in `packages/review/src/middleware/reviewRateMiddleware.ts` — same
 * scale, same default, so a user who knows `review`'s threshold semantics already knows eval's.
 * Kept as our own constant (not imported) since review's is private to that module and coupled to
 * middleware/tool-call/artifact-store plumbing that doesn't fit a plain structured-output call. */
export const DEFAULT_EVAL_PASS_THRESHOLD = 6;

/** One case's target — this task only supports `gth-agent` against the run's own resolved config
 * (no `--identities`, no pluggable CLI/HTTP targets — see the BATCH-2 Task 2 brief). */
export interface EvalTarget {
  type: 'gth-agent';
  /** Suite-level profile hint. Only `undefined`/`'default'` is accepted this task (see
   * {@link ../evalSuite.js}'s `parseEvalSuite`) — per-case/per-identity profile switching is
   * `--identities` scope, not this task's. */
  profile?: string;
}

/** One `json_path` assertion (BATCH-10): resolve `path` against the answer-parsed-as-JSON and check
 * it. Exactly one of `equals`/`contains` is set (enforced in {@link ../evalSuite.js}'s parse):
 * - `equals` — the resolved value must deep-equal this (any JSON value, incl. `null`).
 * - `contains` — the resolved value must be a string containing this substring. */
export interface JsonPathCheck {
  path: string;
  equals?: unknown;
  contains?: string;
}

/** One case parsed and normalized from suite YAML — snake_case YAML keys become camelCase here,
 * arrays default to `[]` (not `undefined`) so callers never need an existence check, and
 * `passThreshold` is pre-resolved (case override ?? suite `defaults.pass_threshold` ??
 * {@link DEFAULT_EVAL_PASS_THRESHOLD}). */
export interface EvalCase {
  id: string;
  prompt: string;
  mustContain: string[];
  mustNotContain: string[];
  shouldContainAny: string[];
  /** BATCH-10 tool-trace assertions, matched against the case's captured tool names with
   * glob support (see `@gaunt-sloth/core/utils/toolMatching.js`, shared with `allowedTools`). */
  mustCall: string[];
  mustNotCall: string[];
  /** BATCH-10 regex assertions over the raw answer — compiled at parse time (bad patterns are a
   * suite error, never a run-time crash) and stored so the compiled `RegExp` is reused, not
   * rebuilt. No implicit case-folding: authors control flags in the pattern themselves. */
  mustMatch: RegExp[];
  mustNotMatch: RegExp[];
  /** BATCH-10 minimal JSON-path assertions over the answer parsed as JSON — see {@link JsonPathCheck}. */
  jsonPath: JsonPathCheck[];
  /** The judge rubric, when present and non-blank. `undefined` = no judge for this case. */
  judgeRubric?: string;
  passThreshold: number;
}

/** A fully parsed and validated suite — see {@link ../evalSuite.js}'s `parseEvalSuite`. */
export interface EvalSuite {
  target: EvalTarget;
  cases: EvalCase[];
}

/** The result of running one case's answer through its deterministic checks. */
export interface DeterministicCheckResult {
  passed: boolean;
  /** Human-readable failure reasons, e.g. `missing "foo"` / `forbidden "baz"` /
   * `none of [x | y]` — the exact message shapes from the field user's proven harness
   * (`docs/batch-eval-user-requirements.md` Appendix A's `deterministic()`). Empty when passed. */
  failures: string[];
}

/** The judge's structured verdict on one case's answer — matches `review`'s `RateSchema` shape
 * (0-10 `rate` + a reason string) for UX consistency, see {@link ../judge.js}. */
export interface JudgeVerdict {
  rate: number;
  reason: string;
}

/** The outcome of attempting to grade one case's answer with the judge. */
export interface JudgeOutcome {
  /** `true` once a judge call was actually made (vs. skipped because no judge was configured). */
  attempted: boolean;
  /** `true` when the judge produced a usable {@link JudgeVerdict}. `false` on any error, timeout,
   * or unparseable output — per the BATCH-2 brief, a judge that can't produce a verdict FAILS the
   * case (there is no human to escalate to here, unlike EXT-10's shell-safety judge). */
  ok: boolean;
  verdict?: JudgeVerdict;
  /** Set when `ok` is `false`: why the judge didn't produce a verdict. */
  error?: string;
}

/** Injectable "grade one answer against one rubric" function — the seam that lets
 * {@link ../evalRunner.js}'s `runEvalSuite` be fully unit tested without any real LLM call, mirror
 * of BATCH-1's `RunCellFn`. The production wiring (`evalCommand.ts`) adapts `judgeEvalCase` to
 * this shape; tests inject a fake that resolves/fails as needed. */
export type JudgeFn = (answer: string, rubric: string) => Promise<JudgeOutcome>;

/** One case's full graded outcome, as written to `<id>.json` and summarized in `results.json`. */
export interface EvalCaseResult {
  id: string;
  verdict: 'PASS' | 'FAIL';
  passThreshold: number;
  /** Whether the SUT run itself completed without error (mirrors `CellRunOutcome.ok`). `false`
   * means the case FAILs outright — there is no answer text to check or grade. */
  sutOk: boolean;
  answer?: string;
  tokensInput?: number;
  tokensOutput?: number;
  tools?: string[];
  durationMs: number;
  checks?: DeterministicCheckResult;
  judge?: JudgeOutcome;
  /** Every reason the case FAILed (deterministic check failures, judge-below-threshold, judge
   * error, SUT failure). Empty when `verdict` is `PASS`. */
  reasons: string[];
}

/** The suite-level aggregate written to `results.json` — `gth eval` exits 0 iff `failed === 0`. */
export interface EvalSuiteSummary {
  total: number;
  passed: number;
  failed: number;
  cases: EvalCaseResult[];
}
