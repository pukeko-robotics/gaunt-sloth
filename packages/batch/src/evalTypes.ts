/**
 * @packageDocumentation
 * BATCH-2 — the shapes for `gth eval`: a parsed suite/case, deterministic-check results, the
 * judge's verdict, and per-case/suite outcomes. Deliberately separate from {@link ../types.js}
 * (BATCH-1's cell/outcome shapes), which documents itself as scoped to "cells and outcomes" only
 * — eval's shapes layer on top of (not into) that file.
 */
import type { ApprovalRung } from '@gaunt-sloth/core/config/shell-policy.js';
import type { ToolResultRecord } from '#src/types.js';
import type {
  EvalCaseClassification,
  EvalClassificationReport,
  EvalClassificationSpec,
  EvalMetricSpec,
} from '#src/classificationTypes.js';

/** The 0-10 judge scale's default pass threshold, matching `review`'s own (unexported)
 * `DEFAULT_PASS_THRESHOLD` in `packages/review/src/middleware/reviewRateMiddleware.ts` — same
 * scale, same default, so a user who knows `review`'s threshold semantics already knows eval's.
 * Kept as our own constant (not imported) since review's is private to that module and coupled to
 * middleware/tool-call/artifact-store plumbing that doesn't fit a plain structured-output call. */
export const DEFAULT_EVAL_PASS_THRESHOLD = 6;

/**
 * BATCH-25 Half B — the stable marker a `rater` rationale carries when the §8 hardline floor refuses
 * the command: the one gradeable form of "this never reaches a shell, whatever the rater said".
 *
 * It is a RATIONALE marker rather than a label or an action on purpose. The floor is not a rung
 * decision: it fires at execution time inside the shell tool, under every rung, after the approvals
 * gate has already returned. It therefore has no representation in the rater's label/action
 * vocabulary, and inventing one here would be this package forming an opinion about a mechanism it
 * does not own. Instead it lands in the text, where a `forced_by: hardline-floor` case (or a plain
 * `must_contain`) grades it.
 *
 * It lives in this module rather than beside its producer so the SUITE PARSER can desugar
 * `forced_by:` without importing `raterTarget.js` — which would pull `@gaunt-sloth/agent` and core's
 * rater into the module graph of every suite parse.
 */
export const HARDLINE_REFUSAL_MARKER = 'hardline floor: refused';

/**
 * BATCH-25 Half B — the deterministic mechanisms of the approvals gate that a case can assert fired,
 * spelled EXACTLY as the approvals corpus spells them in its own `forced_by` / `floor_refuses`
 * fields, so transcribing a corpus case is a copy rather than a translation.
 *
 * ## Why this exists (the I1 finding)
 *
 * A model-free case cannot be graded on its `action`. With no verdict, core's decision mapping
 * substitutes its fail-closed one and returns the SAME action for every command at a rated rung —
 * `ls -la`, `rm -rf /` and `rm -rf $(echo /)` are indistinguishable. `expect_action: escalate` on a
 * deterministic case therefore passes for a directory listing, and would still pass with the floor
 * and both preflights deleted: a constant, not a regression gate.
 *
 * What DOES discriminate is **which deterministic mechanism fired**, which the target reports in the
 * rationale, and which is exactly what the corpus records. So a deterministic case asserts that.
 */
export const FORCED_BY_MECHANISMS = [
  'hardline-floor',
  'ambiguity-preflight',
  'script-env-leak-preflight',
] as const;

/** One of {@link FORCED_BY_MECHANISMS}. */
export type ForcedByMechanism = (typeof FORCED_BY_MECHANISMS)[number];

/** The prefix a rationale carries for a decision a preflight forced, followed by the mechanism. */
export const FORCED_BY_MARKER = 'forced by';

/**
 * The exact substring a `forced_by: <mechanism>` assertion looks for in the rationale. The floor's
 * is {@link HARDLINE_REFUSAL_MARKER} — the marker it already emits — so there is one marker per
 * mechanism and no second spelling of the same claim.
 */
export const FORCED_BY_ASSERTIONS: Record<ForcedByMechanism, string> = {
  'hardline-floor': HARDLINE_REFUSAL_MARKER,
  'ambiguity-preflight': `${FORCED_BY_MARKER}: ambiguity-preflight`,
  'script-env-leak-preflight': `${FORCED_BY_MARKER}: script-env-leak-preflight`,
};

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

/**
 * BATCH-25 Half B — gth's OWN approvals rater, evaluated as a CLASSIFIER rather than as an agent.
 *
 * Every case is a shell command; the target rates it with the same rating prompt production uses
 * (`rateShellCommand`) and maps the verdict to an action with the same decision mapping
 * (`mapVerdictToAction`), at the rung declared here. What comes back is a label + an action per
 * round, which is exactly what the classifier layer grades — so "did repointing `approvals.rater`
 * at a cheaper model raise the false-approve rate" becomes a number instead of a hunch.
 *
 * It is the ONLY target that can honour `model_free` (see {@link EvalCase.modelFree}): the
 * deterministic layer of the gate — the rung, the ambiguity and script-env-leak preflights, and the
 * §8 hardline floor — decides some commands outright, with no model in the loop.
 *
 * Unlike the agent targets this one is NOT driven by a `RunCellFn`: it supplies the
 * {@link RunClassifyFn} seam instead (`buildRaterClassifier` in {@link ../raterTarget.js}), which
 * the command passes to `runEvalSuite` as `options.classify`.
 */
export interface RaterTarget {
  type: 'rater';
  /**
   * The rung the corpus is rated at, as declared by the suite — REQUIRED, so a suite says out loud
   * which posture its numbers describe (the same label produces a different ACTION per rung).
   *
   * It is the suite's declaration, not the last word: a run whose config declares `approvals`
   * overrides it, which is what makes the `rung × model` sweep work through the existing `config:`
   * axis (a sweep cell cannot reach a `target` field). The override is announced, never silent —
   * see {@link ../raterTarget.js}.
   */
  rung: ApprovalRung;
}

/** One suite's target — the in-process gth agent (default), an external ADK agent over A2A
 * (BATCH-14), an external AG-UI agent over HTTP/SSE (BATCH-15), or the in-process approvals rater
 * graded as a classifier (BATCH-25 Half B). Discriminated by `type`; the runner is target-agnostic
 * (it consumes an injected `RunCellFn`/`RunConversationFn`, or a `RunClassifyFn` for a classifier
 * target), so the target only changes which runner the command builds. */
export type EvalTarget = GthAgentTarget | AdkAgentTarget | AgUiAgentTarget | RaterTarget;

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
 * One `tool_result_json_path` assertion (BATCH-21): select tool results by name `tool` (exact or
 * glob, the same matcher `must_call` uses), parse each matching result's payload as JSON, and
 * resolve `path` against it (the same minimal dot/`[index]` path `json_path` uses). At most one of
 * `equals`/`contains` may be set (enforced in {@link ../evalSuite.js}'s parse):
 * - neither — pure existence check: the path must resolve in a matching result's payload;
 * - `equals` — the resolved value must deep-equal this (any JSON value, incl. `null`);
 * - `contains` — the resolved value must be a string containing this substring.
 * The assertion passes when AT LEAST ONE matching tool result satisfies it; a non-JSON payload is a
 * deterministic FAIL for that result, never a throw. Requires the `gth-agent` target (rejected at
 * parse time otherwise — only the in-process agent surfaces tool results).
 */
export interface ToolResultJsonPathCheck {
  /** Tool-name pattern (exact or glob) selecting which tool's result(s) to check. */
  tool: string;
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
  /** BATCH-21 tool-RESULT assertion: for each tool-name pattern (exact/glob, `must_call`'s
   * matcher), at least one called tool matching it returned an ERROR (`isError: true`). Grades the
   * captured tool results, so it requires the `gth-agent` target (parse-rejected otherwise). */
  mustError: string[];
  /** BATCH-21 minimal JSON-path assertions over a matching tool result's payload — see
   * {@link ToolResultJsonPathCheck}. `gth-agent` target only (parse-rejected otherwise). */
  toolResultJsonPath: ToolResultJsonPathCheck[];
  /** The judge rubric, when present and non-blank. `undefined` = no judge for this block. */
  judgeRubric?: string;
  /**
   * BATCH-25 — the expected CLASSIFICATION label for this block, over the suite's declared
   * `classification.labels` enum. `undefined` = this block asserts no label.
   *
   * It lives on the EXPECTATION (not the case) deliberately: an expectation block is the atom that
   * is both identity-scoped AND per-turn, and a multi-round negotiation case needs a different
   * expected value per round (the corpus plan's N1 is reject · reject · escalate). A case-level
   * field could not express that.
   */
  expectLabel?: string;
  /**
   * BATCH-25 — the expected ACTION for this block, over the suite's declared
   * `classification.actions` enum.
   *
   * Separate from {@link expectLabel} because the two answer different questions and diverge by
   * design: the label is what the model returned (diagnostic), the action is what the gate did
   * (what a user experiences), and a deterministic preflight can rewrite the second without
   * touching the first.
   */
  expectAction?: string;
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
  /** BATCH-21 — this turn's per-tool-call result records (parallel to {@link tools}; a per-turn
   * delta like everything else here). Only the in-process `gth-agent` runner populates it. */
  toolResults?: ToolResultRecord[];
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
 * BATCH-25 — what an injected CLASSIFIER target is asked to decide. One request per (case × cell).
 *
 * ## The Half-B seam, now filled
 *
 * Half A shipped this shape, the runner plumbing and the tests (against an injected fake); Half B
 * supplies the one function — `buildRaterClassifier` in {@link ../raterTarget.js}, the
 * {@link RaterTarget}'s implementation, which drives the approvals rating prompt + decision mapping
 * at a declared rung. The shape did not have to move to fit it.
 *
 * The shape is what it is because the rater's unit is not an agent turn: it is
 * `(command, rung, [user messages], [negotiation so far]) → outcome → action`. So a request carries
 * the case's ordered inputs (the negotiation rounds, one entry for a single-round case) rather than
 * a single prompt, and the outcome carries BOTH dimensions plus its own cost.
 */
export interface ClassifyRequest {
  /** The case id, for the target's own diagnostics. */
  caseId: string;
  /** The case's turn inputs in order — the command, then each negotiation round. Length 1 for a
   * single-round case. */
  inputs: string[];
  /** The case's family tags. */
  tags: string[];
  /** The case declared `model_free: true` — the target is expected to decide with no model call,
   * and the runner FAILS the case if the returned `modelCalls` is not 0. A target that honours it
   * SHORT-CIRCUITS its model call for this case and answers from its deterministic layer alone;
   * production is unchanged (the gate still rates at a rated rung — the short-circuit is target
   * behaviour, not a claim about the gate). */
  modelFree: boolean;
}

/**
 * BATCH-25 — one classification outcome. `modelCalls` is mandatory and is what makes
 * {@link EvalCase.modelFree} enforceable rather than aspirational: a target that quietly rings the
 * model on a case declared free would otherwise be invisible.
 *
 * NOTE it lives here and NOT on BATCH-1's `CellRunOutcome` (`#src/types.js`), which documents itself
 * as scoped to cells/outcomes and is shared with the non-eval `gth batch` path.
 */
export interface ClassifyOutcome {
  /** `false` = the target could not produce a classification (the case is excluded from every
   * metric denominator and reported as excluded — never silently counted as a miss). */
  ok: boolean;
  /**
   * The label the target produced, over the suite's declared enum.
   *
   * ABSENT when the target reached its decision without a judgement — the `rater` target reports no
   * label on a zero-model-call decision, because the label IS the rater's judgement and it never
   * asked. A deterministic case therefore grades on the mechanism that decided it
   * ({@link FORCED_BY_MECHANISMS}), not on a label.
   *
   * **An absent label is not out of scope for a metric by itself.** The cell is still SCORED, so it
   * enters a label metric's denominator, where `actual.label == expected.label` counts two absent
   * values as EQUAL — i.e. as a free HIT, inflating any label-accuracy metric by exactly the number
   * of model-free cases. (The confusion matrix puts them in a visible `(none)`/`(none)` bucket, and
   * `computeMetric`'s absent-field warning names them.) A suite whose corpus mixes rated and
   * model-free cases must narrow the denominator itself: `over: ["expected.label != none"]`.
   */
  label?: string;
  /** The action the target's decision mapping produced. */
  action?: string;
  /** The target's own explanation, carried into the per-cell JSON for diagnosis. */
  rationale?: string;
  /** Model calls this classification cost. `0` for a deterministic decision. */
  modelCalls: number;
  /** Set when `ok` is `false`. */
  error?: string;
}

/**
 * BATCH-25 — the injectable "classify one case" seam, the classifier analogue of BATCH-1's
 * `RunCellFn`. Provided by a classification TARGET ({@link RaterTarget}, via
 * `buildRaterClassifier`); when absent, a classifier
 * suite reads its label/action out of the ordinary agent answer via the suite's declared
 * extractors, which is what makes Half A usable on its own.
 *
 * Returns ONE outcome PER ROUND, in order — the same shape {@link RunConversationFn} returns, and
 * for the same reason: a negotiation case asserts a different expected action on each round
 * (reject · reject · escalate), so a single collapsed outcome could not be graded against it. A
 * single-round case returns a one-element array.
 */
export type RunClassifyFn = (request: ClassifyRequest) => Promise<ClassifyOutcome[]>;

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
  /**
   * BATCH-25 — the case's family tags, as authored (`tags: [injection, rce]`). `[]` when the case
   * declares none. Every metric and the confusion matrix report per tag as well as overall, because
   * an aggregate hides adversarial collapse.
   */
  tags: string[];
  /**
   * BATCH-25 — this case must be decided with **zero model calls**. The hardline-floor and
   * ambiguity families of the approvals corpus assert an action deterministically, which makes a
   * meaningful slice of the corpus free to run and is the EXT-55 regression gate (a floor that had
   * silently stopped firing, invisible to build, lint and unit).
   *
   * A target that cannot honour it rejects the case at parse time rather than quietly billing a
   * model call: `model_free` requires an injected classifier ({@link RunClassifyFn}) that reports
   * its own `modelCalls`. The runner FAILS the case when a model-free case reports `modelCalls > 0`.
   */
  modelFree: boolean;
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
  /**
   * BATCH-25 — the suite's classification declaration: the label/action enum that gives the
   * confusion matrix its axes, and how a value is read out of the SUT's answer. Absent = an
   * ordinary pass/fail suite (every #405-era suite), and the whole classifier layer is inert.
   */
  classification?: EvalClassificationSpec;
  /**
   * BATCH-25 — suite-declared aggregate metrics over the corpus, each optionally gating the exit
   * code. `[]` when the suite declares none. Requires {@link classification} (a metric with no
   * label enum has nothing to read).
   */
  metrics: EvalMetricSpec[];
  /**
   * BATCH-25 — the config sweep: named cells the WHOLE suite is run once per, so one corpus
   * produces one comparison table instead of N unrelated runs. Absent = a single run.
   *
   * Consumed by the CLI, not by {@link ../evalRunner.js runEvalSuite}: a sweep is a run-level
   * concept (same suite, different config) exactly like BATCH-19's multi-suite loop, so the runner
   * stays about grading and #405's identity matrix is untouched.
   */
  sweep?: EvalSweep;
  cases: EvalCase[];
}

/**
 * BATCH-25 — one sweep axis value: a named bundle of config overrides applied to the run.
 *
 * The two fields are separate because they reach the config by different, differently-safe routes:
 * - `model` goes through `initConfig({ …, model })` — BATCH-1's supported seam, which re-runs the
 *   provider's `processJsonConfig()` so the cell gets a genuinely fresh `.llm` instance rather than
 *   a structural clone of an already-instantiated LangChain model.
 * - `config` is a deep merge of plain JSON data onto the resolved `GthConfig`. `llm` is rejected in
 *   it at parse time: it holds a constructed model instance, not data, and merging into it would
 *   produce a half-built object. Use `model` for the model axis.
 */
export interface EvalSweepValue {
  /** The cell's name on this axis — a path-safe token; it becomes an output-dir component. */
  name: string;
  /** `llm.model` for this cell, via the supported fresh-construction seam. */
  model?: string;
  /** Plain-data config overrides deep-merged onto the resolved config (never `llm`). */
  config?: Record<string, unknown>;
}

/**
 * BATCH-25 — the sweep: named axes whose CARTESIAN PRODUCT is the set of runs. The approvals
 * sweep's axes are `rung × model`; a one-axis sweep is just a list of settings.
 */
export interface EvalSweep {
  /** Axis name → its ordered values. At least one axis, each with at least one value. */
  axes: { name: string; values: EvalSweepValue[] }[];
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
  /** BATCH-21 — this turn's per-tool-call result records (mirrors {@link TurnRunOutcome.toolResults}). */
  toolResults?: ToolResultRecord[];
  /** Whether this turn's SUT invocation ran (mirrors {@link TurnRunOutcome.ok}); `false` = the turn
   * produced no answer (transport/agent error, or the conversation aborted before reaching it). */
  ok: boolean;
  verdict: 'PASS' | 'FAIL';
  checks?: DeterministicCheckResult;
  judge?: JudgeOutcome;
  /** Every reason this turn FAILed; empty when `verdict` is `PASS`. */
  reasons: string[];
  /** BATCH-25 — this ROUND's classification. A negotiation case asserts a different expected action
   * per round (reject · reject · escalate), so the per-round values are the ones that diagnose it.
   * Omitted for a non-classifier suite. */
  classification?: EvalCaseClassification;
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
  /** BATCH-21 — the cell's per-tool-call result records (parallel to {@link tools}; omitted when
   * the runner produced none, so a pre-BATCH-21 `<id>.json` stays byte-for-byte identical). For a
   * multi-turn cell this stays unset like `tools` — read {@link turns} instead. */
  toolResults?: ToolResultRecord[];
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
  /**
   * BATCH-25 — this cell's classification (expected vs actual label/action). Omitted entirely for a
   * suite that declares no `classification:` block, so a pre-BATCH-25 `<id>.json` is byte-for-byte
   * unchanged. For a multi-turn cell this carries the LAST turn's classification (the round the
   * corpus's expected outcome is asserted on); per-round values are in {@link turns}.
   */
  classification?: EvalCaseClassification;
  /** BATCH-25 — the case's family tags, echoed here so a single `<id>.json` is self-describing and
   * a per-tag re-aggregation needs nothing else. Omitted when the case declares none. */
  tags?: string[];
}

/**
 * The suite-level aggregate written to `results.json`. `gth eval` exits 0 iff `failed === 0` AND no
 * `gate: fail` metric threshold was breached (see `classifyEvalExit`) — a metric gate is a product
 * signal exactly like a failed assertion, and a corpus can be entirely within per-case tolerance
 * while its false-approve rate is unacceptable.
 */
export interface EvalSuiteSummary {
  total: number;
  passed: number;
  failed: number;
  cases: EvalCaseResult[];
  /** BATCH-25 — the confusion matrices + declared metrics. Omitted entirely for a suite with no
   * `classification:` block, so a pre-BATCH-25 `results.json` is byte-for-byte unchanged. */
  classification?: EvalClassificationReport;
}
