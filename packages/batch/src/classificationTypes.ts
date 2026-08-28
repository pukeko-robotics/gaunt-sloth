/**
 * @packageDocumentation
 * BATCH-25 — the shapes for a CLASSIFIER eval: a suite-declared label/action enum, the extractors
 * that turn a SUT answer into a label, the confusion matrix, and declared aggregate metrics.
 *
 * Deliberately its own file rather than more weight in {@link ./evalTypes.js}: eval's per-case
 * PASS/FAIL shapes and a classifier's corpus-wide *distribution* shapes answer different questions,
 * and only the latter needs the anti-blind-metric machinery below.
 *
 * ## The lesson this file is shaped by
 *
 * The QA-5 throwaway harness declared an `over-rejection` metric whose denominator was only the
 * `safe`-labelled cases. It read a clean **0/10 at both strictness settings** while that setting was
 * simultaneously rejecting seven routine commands back to the model. A perfect score, reported for a
 * setting that had made behaviour materially worse, and then trusted.
 *
 * So, structurally, in this file:
 * - a metric's denominator is **the whole scored corpus unless the author says otherwise**
 *   ({@link EvalMetricSpec.over} is optional and its absence means "everything");
 * - every metric carries {@link EvalMetricResult.coverage}, and any shortfall — a declared subset
 *   denominator, cases excluded because the SUT failed, an empty denominator, or numerator cases
 *   sitting OUTSIDE the denominator — becomes a {@link EvalMetricResult.warnings} entry;
 * - an unrecognized label is a real, visible bucket ({@link UNRECOGNIZED_LABEL}) rather than a
 *   dropped row, so the confusion matrix always accounts for every scored cell.
 *
 * A blind metric is worse than no metric, because it is trusted.
 */

/** The bucket a classification lands in when the SUT produced output but it matched no declared
 * label/action. It is a REAL row/column of the confusion matrix, never a dropped case — an
 * unparseable verdict is a finding, and silently discarding it is how a matrix comes to read
 * "covered everything" when it didn't. Parenthesized so it can never collide with a declared enum
 * value (which must match `/^[\w.-]+$/`). */
export const UNRECOGNIZED_LABEL = '(unrecognized)';

/** The axis entry for "this case declares no expectation on this dimension" — e.g. a corpus case
 * that asserts an action but no label. Like {@link UNRECOGNIZED_LABEL} it is a visible bucket.
 * Parenthesized for the same collision-proof reason. */
export const NO_EXPECTATION = '(none)';

/**
 * How a label/action is read out of a cell's answer. Deliberately tiny and TOTAL — every extractor
 * either yields a declared enum value or {@link UNRECOGNIZED_LABEL}; none of them guesses.
 *
 * - `answer` (default) — the trimmed answer, compared case-insensitively against the declared enum.
 *   Suited to a suite whose prompt says "reply with exactly one of: …".
 * - `json_path` — resolve a minimal dot/`[index]` path (the same resolver `json_path` assertions
 *   use) against the answer parsed as JSON, then match its stringified value against the enum.
 *   Suited to a structured-output classifier.
 *
 * There is deliberately NO fuzzy/substring mode. A heuristic that finds `safe` inside "this is not
 * safe" is precisely the class of silent misreading this facility exists to eliminate.
 */
export type ClassificationExtractor = { kind: 'answer' } | { kind: 'json_path'; path: string };

/**
 * A suite's `classification:` declaration — the enum that gives the confusion matrix its axes, plus
 * how to read a value out of the SUT's answer.
 *
 * `actions` is empty when the suite classifies labels only. The two dimensions are separate because
 * the QA-5 corpus asserts two different things about the same case: **the label the model returned**
 * (diagnostic) and **the action the gate took** (what a user actually experiences). They diverge by
 * design — deterministic preflights rewrite the verdict independently of the model — so scoring
 * labels alone overstates the model and understates the gate.
 */
export interface EvalClassificationSpec {
  /** The declared label enum (≥1 value). Gives the matrix its axes and validates every
   * `expect_label` and every metric literal at parse time. */
  labels: string[];
  /** The declared action enum, or `[]` when the suite asserts labels only. */
  actions: string[];
  /** How the ACTUAL label is read from a cell's answer. */
  labelFrom: ClassificationExtractor;
  /** How the ACTUAL action is read. `undefined` = the suite declares no action dimension; an
   * `expect_action` assertion is then a parse error rather than a silently ungradeable one. */
  actionFrom?: ClassificationExtractor;
}

/**
 * One field a metric predicate can read. `expected.*` is what the CORPUS declares; `actual.*` is
 * what the SUT produced. The prose in a corpus plan says "label" for the corpus label and "action"
 * for the actual action taken, and that ambiguity is exactly what produces a silently-wrong metric —
 * so the surface forces the distinction to be written down.
 *
 * **BATCH-26 — `model.label` is the third one, and it is not a synonym for `actual.label`.** The
 * SUT's decision and the model's judgement are the same value on most cells and different on the
 * ones where a deterministic step raised the model's answer. A metric over `actual.label` measures
 * the GATE (which is what a user experiences); one over `model.label` measures the RATER. Scoring
 * the second question with the first field is what bounded the agreement figure the approvals
 * corpus exists to produce, so both are readable and the engine says which one a metric is on.
 *
 * There is deliberately **no `model.action`**: the deterministic layer overrides the label and
 * produces the action, so an "action the model chose" does not exist and a predicate on it could
 * never match. {@link ./metrics.js parseMetricPredicate} rejects it by name.
 */
export type MetricField =
  'expected.label' | 'expected.action' | 'actual.label' | 'actual.action' | 'model.label';

/** The literal `none` in a predicate — matches a cell where that field is absent. */
export const METRIC_NONE_LITERAL = 'none';

/**
 * One comparison inside a metric's predicate list. Predicates in a list are **ANDed**; there is no
 * `or`, no nesting and no parentheses.
 *
 * That is a deliberate limit, not an oversight. Every metric the approvals corpus plan declares —
 * `false_approve`, `false_halt`, `over_escalation`, `outcome_accuracy`, `exfil_recall`,
 * `floor_recall` — is a conjunction of at most two comparisons. A general expression grammar would
 * add a parser to the ONE component where a bug yields wrong numbers that look right, which is the
 * failure this whole file is built to prevent. If a corpus ever needs disjunction, that is a new
 * node, not a silent generalisation.
 */
export type MetricPredicate =
  /** `<field> == <value>` / `<field> != <value>`, where the right-hand side is a literal. */
  | { kind: 'compare'; field: MetricField; negated: boolean; value: string }
  /** `<field> == <field>` / `<field> != <field>` — how `outcome_accuracy` is written
   * (`actual.label == expected.label`). */
  | { kind: 'compareField'; field: MetricField; negated: boolean; other: MetricField }
  /** `<field> in [a, b]` / `<field> not in [a, b]`. */
  | { kind: 'in'; field: MetricField; negated: boolean; values: string[] }
  /** `has_tag(x)` / `not has_tag(x)`. */
  | { kind: 'tag'; negated: boolean; tag: string };

/**
 * A suite-declared aggregate metric over the corpus.
 *
 * `over` (the denominator) is OPTIONAL and its absence means **the whole scored corpus**. That
 * default is the load-bearing part of this type: an author who does not think about the denominator
 * gets the corpus-wide one, and an author who narrows it gets a warning saying how much of the
 * corpus their number can no longer see.
 */
export interface EvalMetricSpec {
  name: string;
  /** The numerator predicate list (ANDed). Evaluated only over cells already in the denominator. */
  where: MetricPredicate[];
  /** The denominator predicate list (ANDed). Absent = every scored cell — corpus-wide by
   * construction. */
  over?: MetricPredicate[];
  /** FRACTION gate: fail when the value is strictly GREATER than this (0..1). */
  max?: number;
  /** FRACTION gate: fail when the value is strictly LESS than this (0..1) — or when the denominator
   * is empty (a recall metric that measured nothing has not met its floor; it has measured
   * nothing). */
  min?: number;
  /**
   * COUNT gate: fail when the NUMERATOR exceeds this many cases.
   *
   * Not sugar for {@link max}. A target like "at most 2 of the 22 cases in this family" is an
   * absolute count against an honest denominator, and expressing it as a fraction has two failures
   * the fraction form cannot avoid:
   *
   * - the author must compute `2/22 = 0.0909` by hand from the current corpus size, and
   * - **it silently drifts as the corpus grows.** Add ten cases and the gate quietly tightens or
   *   loosens — no edit, no warning, the number still plausible while its meaning has moved.
   *
   * That second one is the same species as the blind denominator the rest of this file guards
   * against: a number that stays believable while what it measures changes underneath it. A count
   * gate is invariant to corpus size by construction.
   *
   * A count gate also reads more honestly wherever the target genuinely IS zero cases —
   * `max_count: 0` says "not one case may do this", where `max: 0` says it in a unit that happens
   * to coincide at zero.
   */
  maxCount?: number;
  /** COUNT gate: fail when the NUMERATOR is below this many cases. Unlike {@link min}, this needs
   * no empty-denominator special case — an empty denominator yields a numerator of 0, which is
   * simply below any positive floor. */
  minCount?: number;
  /** `fail` (default when a threshold is declared) — a tripped gate fails the run (exit 1).
   * `report` — the threshold is computed and printed but never changes the exit code. */
  gate: 'fail' | 'report';
  /** Optional human note carried into the output, for a metric whose meaning is not its name. */
  description?: string;
}

/** One metric's numerator/denominator/value. `value` is `null` — never `0` — when the denominator is
 * empty, because "0% of nothing" and "0% of the corpus" are opposite findings and a metric that
 * silently reports the former as the latter is the exact bug this facility exists to catch. */
export interface EvalMetricTally {
  numerator: number;
  denominator: number;
  value: number | null;
}

/** How much of the corpus a metric could actually see. Always emitted, never conditional — point 9
 * ("no silent caps") and the anti-blind-metric rule are the same requirement, so they are the same
 * field. */
export interface EvalMetricCoverage {
  /** Every cell in the suite. */
  total: number;
  /** Cells that produced a gradeable classification (the SUT ran). */
  scored: number;
  /** `total - scored` — cells that could not be classified at all. */
  excluded: number;
  /** How many scored cells this metric's own denominator selected. */
  denominator: number;
}

/** One metric's computed result, overall and per tag. */
export interface EvalMetricResult {
  name: string;
  description?: string;
  overall: EvalMetricTally;
  /** Per-family sub-scores. An aggregate hides adversarial collapse: the first QA-5 baseline scored
   * 48.9% overall while scoring 0/3 on prompt injection, and a single blended number would have
   * shipped that. Keyed by tag, in the suite's tag order. */
  byTag: Record<string, EvalMetricTally>;
  coverage: EvalMetricCoverage;
  /** Every way this metric's denominator falls short of the whole corpus. Empty is the good case. */
  warnings: string[];
  /** Present when the metric declares any threshold. */
  gate?: {
    /** Which unit the thresholds are in. A consumer must never have to infer whether `2` meant two
     * cases or 200% — the two forms are mutually exclusive per metric, and this names which. */
    kind: 'fraction' | 'count';
    max?: number;
    min?: number;
    maxCount?: number;
    minCount?: number;
    mode: 'fail' | 'report';
    /** `false` = the threshold was breached. A breached `fail` gate fails the run. */
    passed: boolean;
    /** Why it failed; empty when it passed. Always states the unit. */
    reason?: string;
    /** The threshold as a human string, unit included (`≤ 2 case(s)`, `≤ 5.0%`). Rendered whether
     * the gate passed or failed, so a passing gate is as legible as a failing one. */
    summary: string;
  };
}

/**
 * A confusion matrix: rows = what the corpus expected, columns = what the SUT actually produced.
 *
 * The primary artifact of a classifier eval, because **which way it is wrong is the whole signal**:
 * on the approvals scale (`safe` · `destructive` · `catastrophic` · `attack`) an `attack` graded
 * `destructive` means a prompt instead of a halt, while a `destructive` graded `safe` is a security
 * incident. A single accuracy percentage cannot tell those apart.
 */
export interface EvalConfusionMatrix {
  /** Which dimension this matrix is over. */
  dimension: 'label' | 'action';
  /** Row axis (expected): the declared enum, plus {@link NO_EXPECTATION} when some cell declares
   * none. */
  rows: string[];
  /** Column axis (actual): the declared enum, plus {@link UNRECOGNIZED_LABEL} when some cell
   * produced an unmatched value, plus {@link NO_EXPECTATION} when some cell produced nothing. */
  columns: string[];
  /** `counts[expectedRow][actualColumn]`. Every row/column key is present (zeros included) so a
   * renderer never has to guess an axis. */
  counts: Record<string, Record<string, number>>;
  /** Cells counted here. `counted + excluded === ` the suite's cell total — asserted in the unit
   * suite, because a matrix that silently drops errored cells reads as "covered everything". */
  counted: number;
  /** Cells NOT counted: the SUT did not run, so there is nothing to place. */
  excluded: number;
}

/**
 * The suite-level classification report — the classifier eval's answer, attached to
 * {@link ./evalTypes.js EvalSuiteSummary}. Absent entirely for a suite that declares no
 * `classification:` block, so a #405-era suite's `results.json` is unchanged.
 */
export interface EvalClassificationReport {
  labels: string[];
  actions: string[];
  /** Every tag any case declared, sorted — the per-tag sub-score axis. */
  tags: string[];
  /** Corpus-wide coverage. `excluded > 0` means some cells could not be classified at all. */
  coverage: { total: number; scored: number; excluded: number };
  labelMatrix: EvalConfusionMatrix;
  /** Present only when the suite declares an action dimension. */
  actionMatrix?: EvalConfusionMatrix;
  /** Per-tag label matrices, keyed by tag — an adversarial family's matrix read on its own. */
  labelMatrixByTag: Record<string, EvalConfusionMatrix>;
  metrics: EvalMetricResult[];
  /** Report-level warnings (as opposed to per-metric ones): excluded cells, unrecognized outputs,
   * and anything else that bounds what these numbers cover. */
  warnings: string[];
  /** Names of metrics whose `gate: fail` threshold was breached. Non-empty ⇒ the run fails. */
  gateFailures: string[];
}

/**
 * One graded cell reduced to what the matrices and the metrics need. Built by
 * {@link ../evalRunner.js} from the graded results; its own tiny shape so both consumers read the
 * same thing and the aggregation is unit-testable without constructing whole `EvalCaseResult`s.
 */
export interface ClassifiedCell {
  id: string;
  tags: string[];
  expectedLabel?: string;
  expectedAction?: string;
  actualLabel?: string;
  actualAction?: string;
  /** BATCH-26 — the judgement the MODEL rendered, read by `model.label`. Equal to
   * {@link actualLabel} except where a deterministic step raised it; absent when nobody judged. See
   * {@link ./evalTypes.js ClassifyOutcome.modelLabel}. */
  modelLabel?: string;
  /** `false` = the SUT did not run / the classifier failed, so this cell has no place in any matrix
   * or denominator. It is counted as `excluded` and reported, never as a wrong answer. */
  scored: boolean;
}

/** One cell's classification, as recorded on its {@link ./evalTypes.js EvalCaseResult}. */
export interface EvalCaseClassification {
  expectedLabel?: string;
  expectedAction?: string;
  actualLabel?: string;
  actualAction?: string;
  /** BATCH-26 — the judgement the MODEL rendered, before any deterministic step overrode it. Equal
   * to {@link actualLabel} except where one did; absent when nobody judged. Written to the cell's
   * `results.json` so a floored case is diagnosable without re-running, and read by a `model.label`
   * metric. See {@link ./evalTypes.js ClassifyOutcome.modelLabel}. */
  modelLabel?: string;
  /** The raw text the extractors read, kept so an `(unrecognized)` result is diagnosable without
   * re-running. Omitted when it is identical to the cell's `answer`. */
  raw?: string;
  /** How many model calls this classification cost. Present only on the injected-classifier
   * (Half B) path; the answer-extraction path always costs the cell's own single run. */
  modelCalls?: number;
}
