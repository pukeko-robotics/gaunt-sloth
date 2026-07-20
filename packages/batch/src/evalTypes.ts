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

/** The in-process SUT target: an agent built from the run's own resolved config (the original and
 * default target). */
export interface GthAgentTarget {
  type: 'gth-agent';
  /** Suite-level profile hint. Only `undefined`/`'default'` is accepted (see
   * {@link ../evalSuite.js}'s `parseEvalSuite`) — per-case/per-identity profile switching is
   * `identities` scope, not this. */
  profile?: string;
}

/**
 * BATCH-14 — an EXTERNAL Google ADK agent, graded over the A2A (Agent-to-Agent) protocol. The eval
 * drives a *running* ADK agent by A2A text send and grades its answers with the same content
 * assertions as {@link GthAgentTarget}. The agent runs out-of-process (its own model/tools/auth), so
 * this target only needs the A2A connection, not a gth config.
 *
 * Honest-boundary note (BATCH-14 design point 4): A2A's wire content is only text/file/data parts
 * plus task status/artifact events — it does NOT expose the agent's intermediate tool/function calls
 * in any standardized form. So `must_call`/`must_not_call` cannot be graded against this target and
 * are rejected at parse time (never a silent pass); the `identities` matrix (per-identity gth
 * configs) is likewise meaningless for an external agent and rejected.
 */
export interface AdkAgentTarget {
  type: 'adk-agent';
  /** The ADK agent's A2A endpoint / agent-card base URL (mirrors `A2AClientConfig.agentUrl`; the
   * SDK fetches `/.well-known/agent-card.json` from it). Required — a suite without it is a parse
   * error. */
  url: string;
  /** Optional label for the agent (mirrors `A2AClientConfig.agentId`; used only for debug logging).
   * Defaults to `'adk-agent'` when the suite omits it. */
  agentId?: string;
}

/**
 * BATCH-15 — an EXTERNAL agent exposed over the AG-UI protocol, graded by driving its HTTP/SSE run
 * endpoint (`POST {url}/agents/{agentId}/run`). The eval sends the conversation as a `RunAgentInput`
 * and decodes the streamed AG-UI events, grading the assembled answer with the SAME content
 * assertions as {@link GthAgentTarget}. Like {@link AdkAgentTarget}, the agent runs out-of-process
 * (its own model/tools/auth), so this target only needs the AG-UI connection, not a gth config.
 *
 * KEY DIFFERENCE from {@link AdkAgentTarget}: the AG-UI wire DOES stream the agent's tool calls
 * (`TOOL_CALL_START` events). So — unlike A2A, where the tool trace is invisible and
 * `must_call`/`must_not_call` are rejected at parse time — the ag-ui runner captures each
 * `TOOL_CALL_START`'s tool name into the outcome's `tools`, and `must_call`/`must_not_call` grade
 * normally against this target.
 */
export interface AgUiAgentTarget {
  type: 'ag-ui';
  /** The AG-UI server's base URL — the origin of `POST {url}/agents/{agentId}/run`. Required; a
   * suite without it is a parse error. */
  url: string;
  /** The `{agentId}` path segment of `/agents/{agentId}/run` (per the AG-UI protocol). Required; a
   * suite without it is a parse error. */
  agentId: string;
}

/** One suite's target — the in-process gth agent (default), an external ADK agent over A2A
 * (BATCH-14), or an external AG-UI agent over HTTP/SSE (BATCH-15). Discriminated by `type`; the
 * runner is target-agnostic (it consumes an injected `RunCellFn`/`RunConversationFn`), so the target
 * only changes which runner the command builds. */
export type EvalTarget = GthAgentTarget | AdkAgentTarget | AgUiAgentTarget;

/** One `json_path` assertion (BATCH-10): resolve `path` against the answer-parsed-as-JSON and check
 * it. Exactly one of `equals`/`contains` is set (enforced in {@link ../evalSuite.js}'s parse):
 * - `equals` — the resolved value must deep-equal this (any JSON value, incl. `null`).
 * - `contains` — the resolved value must be a string containing this substring. */
export interface JsonPathCheck {
  path: string;
  equals?: unknown;
  contains?: string;
}

/**
 * One expectation block (BATCH-12) — the BATCH-10 assertion bundle PLUS an optional `identities`
 * scope. This is the atom the whole eval layer normalizes to: a flat case is sugar for ONE
 * unscoped expectation (applies to every identity), and a matrix case's `expect:` array is a list
 * of these. snake_case YAML keys become camelCase here; arrays default to `[]` (not `undefined`)
 * so callers never need an existence check.
 */
export interface EvalExpectation {
  /**
   * The identity profiles this block grades (BATCH-12). Absent/empty = applies to EVERY applicable
   * identity — this is what a flat case's single block carries (the sugar), and what an unscoped
   * `expect:` block carries. A block naming `[admin]` grades only the `admin` run. Every name here
   * is validated at parse time to be one the suite declares in its top-level `identities` list.
   */
  identities?: string[];
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
  /** The judge rubric, when present and non-blank. `undefined` = no judge for this block. */
  judgeRubric?: string;
}

/**
 * One conversational turn (BATCH-12): the `user` message to send, and the {@link EvalExpectation}
 * blocks that grade its answer. **Task 1 keeps every case at exactly one turn** (single-turn); the
 * general `turns[]` type exists NOW so Task 2 adds multi-turn *execution*, not a schema migration.
 */
export interface EvalTurn {
  user: string;
  expectations: EvalExpectation[];
}

/**
 * One turn's raw run outcome inside a multi-turn conversation (BATCH-12 Task 2). Structurally the
 * per-turn analogue of BATCH-1's {@link ../types.js CellRunOutcome}: the turn's answer plus the
 * tools/tokens captured FOR THAT TURN — a per-invoke GS2-16 delta (each `processMessages` call
 * resets the tally), NOT the cumulative conversation total. `ok:false` with `error` set means that
 * turn's SUT invocation failed (no answer to grade). The conversational runner returns one of these
 * per turn it attempted, in turn order (a short array = the conversation aborted mid-way).
 */
export interface TurnRunOutcome {
  ok: boolean;
  answer?: string;
  tokensInput?: number;
  tokensOutput?: number;
  tools?: string[];
  error?: string;
}

/**
 * Injectable "run one whole scripted conversation" function (BATCH-12 Task 2) — the multi-turn
 * analogue of BATCH-1's {@link ../types.js RunCellFn}, and the seam that lets
 * {@link ../evalRunner.js}'s multi-turn path be unit tested without any real LLM/MCP. Given the
 * ordered user messages of ONE (case × identity) conversation, it builds the agent + resolves tools
 * ONCE, runs each turn against the accumulated message history, and returns one {@link TurnRunOutcome}
 * per turn (per-turn answer + per-turn tool delta), cleaning up once. The production wiring
 * (`batchCommand.ts`'s `buildProductionRunConversation`) adapts core's `runConversation`; tests
 * inject a fake returning scripted per-turn answers + traces.
 */
export type RunConversationFn = (userMessages: string[]) => Promise<TurnRunOutcome[]>;

/**
 * One case parsed and normalized from suite YAML. Every case — flat or matrix — reduces to this
 * ONE shape: a list of {@link EvalTurn}s (Task 1: length exactly 1, its `user` = the case's
 * `prompt`) whose expectations carry the assertions. `passThreshold` is per-case and pre-resolved
 * (case override ?? suite `defaults.pass_threshold` ?? {@link DEFAULT_EVAL_PASS_THRESHOLD}).
 */
export interface EvalCase {
  id: string;
  turns: EvalTurn[];
  passThreshold: number;
}

/** A fully parsed and validated suite — see {@link ../evalSuite.js}'s `parseEvalSuite`. */
export interface EvalSuite {
  target: EvalTarget;
  /**
   * Suite-level identity profiles (BATCH-12 / #405 his #1): run every case once per identity, each
   * under `initConfig({ …, identityProfile })`, to test per-identity authorization / data-isolation.
   * Absent = no matrix — a single run under the invoked profile (today's behavior, unchanged). Each
   * name is a plain profile that must resolve to its own `.gsloth-settings/<name>/` config.
   */
  identities?: string[];
  /** Optional suite-level judge identity profile (BATCH-10 Task 2): the profile whose model grades
   * the cases, when the suite wants a judge distinct from the SUT. A top-level sibling of
   * `target`/`cases` — distinct from `target.profile` (which selects the SUT and is still rejected
   * unless `default`). Resolved by the CLI as `--judge <profile>` > this > none (none = judge uses
   * the SUT's `config.llm`, the pre-Task-2 behavior). Absent/blank = no separate judge. */
  judgeProfile?: string;
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

/**
 * One graded turn inside a multi-turn cell's result (BATCH-12 Task 2). Present only on a multi-turn
 * {@link EvalCaseResult} (via its `turns` array); a single-turn cell keeps its flat top-level shape
 * unchanged. Carries the turn's user message, its answer/tools/tokens, and its own verdict + reasons
 * so the output pinpoints exactly which turn failed and why.
 */
export interface EvalTurnResult {
  user: string;
  answer?: string;
  tokensInput?: number;
  tokensOutput?: number;
  tools?: string[];
  /** Whether this turn's SUT invocation ran (mirrors {@link TurnRunOutcome.ok}); `false` = the turn
   * produced no answer (transport/agent error, or the conversation aborted before reaching it). */
  ok: boolean;
  verdict: 'PASS' | 'FAIL';
  checks?: DeterministicCheckResult;
  judge?: JudgeOutcome;
  /** Every reason this turn FAILed; empty when `verdict` is `PASS`. */
  reasons: string[];
}

/** One graded cell's full outcome, as written to `<id>.json` (matrix: `<id>__<identity>.json`) and
 * summarized in `results.json`. A cell is one (case × identity) pair: without a suite `identities`
 * list there is exactly one cell per case (`identity` omitted, byte-for-byte as before BATCH-12);
 * with identities there is one cell per (case, identity). */
export interface EvalCaseResult {
  id: string;
  /** The identity profile this cell ran under (BATCH-12). Omitted entirely (not `undefined`-valued)
   * for a no-identities suite, so its `<id>.json` output stays byte-for-byte identical to before. */
  identity?: string;
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
   * error, SUT failure). Empty when `verdict` is `PASS`. For a multi-turn cell each reason is
   * prefixed with the failing turn (`turn N: …`), and the full per-turn breakdown is in {@link turns}. */
  reasons: string[];
  /**
   * BATCH-12 Task 2 — the per-turn breakdown of a MULTI-TURN cell (one entry per conversational
   * turn, in order). Present only for a multi-turn case; **omitted entirely for a single-turn
   * cell**, so an existing single-`prompt` case's `<id>.json` stays byte-for-byte identical. The
   * cell PASSES iff every turn here PASSes; the top-level `answer`/`checks`/`judge`/`tools` fields
   * are left unset for a multi-turn cell (there is no single answer) — read {@link turns} instead.
   */
  turns?: EvalTurnResult[];
}

/** The suite-level aggregate written to `results.json` — `gth eval` exits 0 iff `failed === 0`. */
export interface EvalSuiteSummary {
  total: number;
  passed: number;
  failed: number;
  cases: EvalCaseResult[];
}
