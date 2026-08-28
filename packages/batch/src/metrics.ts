import type {
  ClassifiedCell,
  EvalClassificationSpec,
  EvalMetricCoverage,
  EvalMetricResult,
  EvalMetricSpec,
  EvalMetricTally,
  MetricField,
  MetricPredicate,
} from '#src/classificationTypes.js';
import {
  METRIC_NONE_LITERAL,
  NO_EXPECTATION,
  UNRECOGNIZED_LABEL,
} from '#src/classificationTypes.js';

/**
 * BATCH-25 — the declared-metric layer: parse a metric predicate, compute it over the corpus, and
 * say out loud everywhere the number cannot see.
 *
 * ## Why this file is paranoid
 *
 * The QA-5 throwaway declared an `over-rejection` metric whose denominator was only the
 * `safe`-labelled cases. It read a clean **0/10 at both strictness settings** while that same
 * setting was rejecting seven routine commands back to the model. The number was perfect, the
 * behaviour was worse, and the number was trusted.
 *
 * Three structural answers, all in this file:
 *
 * 1. **Corpus-wide by construction.** {@link EvalMetricSpec.over} is optional; absent means every
 *    scored cell. An author who does not think about the denominator gets the safe one.
 * 2. **Every shortfall is a warning.** A declared subset denominator, cases excluded because the SUT
 *    failed, an empty denominator, and numerator cases sitting OUTSIDE the denominator each produce
 *    a {@link EvalMetricResult.warnings} entry naming the coverage. Crucially the subset warning
 *    fires on the EVALUATED denominator count, not on whether `over:` was written — a metric with no
 *    `over:` still has a subset denominator when cases error out, and 74/78 reported as if it were
 *    78/78 is the same blindness arriving through the front door.
 * 3. **Literals are enum-checked at parse time.** A typo'd label in a predicate would make a metric
 *    silently always-zero — a perfect score for a predicate that can never match. {@link
 *    parseMetricPredicate} rejects any literal outside the suite's declared enum.
 */

/** The five readable fields. `expected.*` is what the corpus declares, `actual.*` is what the SUT
 * produced, `model.label` is what the model itself judged before any deterministic step overrode it
 * — spelled out because a corpus plan's prose says "label" for one and "action" for the other, and
 * that ambiguity is what produces a silently-wrong metric. */
const METRIC_FIELDS: MetricField[] = [
  'expected.label',
  'expected.action',
  'actual.label',
  'actual.action',
  'model.label',
];

/** Matches the SHAPE of a field reference as one group; whether that shape is a field this engine
 * has is decided by {@link assertKnownField}, so `model.action` is refused by name rather than
 * falling through to the generic parse error. */
const FIELD_PATTERN = '((?:expected|actual|model)\\.(?:label|action))';
const TAG_RE = new RegExp(`^(not\\s+)?has_tag\\(\\s*([^)]*?)\\s*\\)$`);
const IN_RE = new RegExp(`^${FIELD_PATTERN}\\s+(not\\s+in|in)\\s*\\[([^\\]]*)\\]$`);
const COMPARE_RE = new RegExp(`^${FIELD_PATTERN}\\s*(==|!=)\\s*(.+)$`);

/** Strip one layer of matching quotes from a predicate literal. */
function unquote(raw: string): string {
  const text = raw.trim();
  if (
    text.length >= 2 &&
    (text[0] === '"' || text[0] === "'") &&
    text[text.length - 1] === text[0]
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** Which enum a field reads from. */
function enumFor(field: MetricField, spec: EvalClassificationSpec): string[] {
  return field.endsWith('.label') ? spec.labels : spec.actions;
}

/**
 * Parse ONE predicate string. Predicates come as a LIST and are ANDed; there is no `or`, no nesting
 * and no parentheses — see {@link MetricPredicate} for why that limit is deliberate.
 *
 * Accepted forms:
 * - `expected.label != safe` · `actual.action == approve`
 * - `actual.label == expected.label` (field-to-field — this is how accuracy is written)
 * - `expected.label in [destructive, catastrophic, attack]` · `actual.action not in [approve]`
 * - `has_tag(injection)` · `not has_tag(negotiation)`
 *
 * The literal `none` matches a cell where the field is absent.
 *
 * Every literal is validated against the suite's declared enum. That check is the point: a typo'd
 * value would make the predicate unsatisfiable and the metric a permanent, trusted zero.
 *
 * @throws Error with an actionable message (the offending text, the field, and the declared enum).
 */
export function parseMetricPredicate(
  raw: string,
  spec: EvalClassificationSpec,
  where: string
): MetricPredicate {
  const text = raw.trim();
  if (text.length === 0) {
    throw new Error(`${where}: empty predicate — write e.g. "expected.label != safe".`);
  }

  const tagMatch = TAG_RE.exec(text);
  if (tagMatch) {
    const tag = unquote(tagMatch[2]);
    if (tag.length === 0) {
      throw new Error(`${where}: has_tag() needs a tag name, e.g. "has_tag(injection)".`);
    }
    return { kind: 'tag', negated: Boolean(tagMatch[1]), tag };
  }

  const inMatch = IN_RE.exec(text);
  if (inMatch) {
    const field = assertKnownField(inMatch[1], where, text);
    const negated = inMatch[2].startsWith('not');
    const values = inMatch[3]
      .split(',')
      .map((value) => unquote(value))
      .filter((value) => value.length > 0);
    if (values.length === 0) {
      throw new Error(
        `${where}: "${text}" has an empty list — an \`in []\` predicate can never match, which ` +
          'would make this metric a permanent zero.'
      );
    }
    for (const value of values) assertKnownLiteral(value, field, spec, where, text);
    return { kind: 'in', field, negated, values };
  }

  const compareMatch = COMPARE_RE.exec(text);
  if (compareMatch) {
    const field = assertKnownField(compareMatch[1], where, text);
    const negated = compareMatch[2] === '!=';
    const rhs = unquote(compareMatch[3]);
    if (/^(?:expected|actual|model)\.(?:label|action)$/.test(rhs)) {
      const other = assertKnownField(rhs, where, text);
      if (field.endsWith('.label') !== other.endsWith('.label')) {
        throw new Error(
          `${where}: "${text}" compares a label field to an action field — they are different ` +
            'enums, so the comparison can never be true.'
        );
      }
      return { kind: 'compareField', field, negated, other };
    }
    assertKnownLiteral(rhs, field, spec, where, text);
    return { kind: 'compare', field, negated, value: rhs };
  }

  throw new Error(
    `${where}: could not parse predicate "${text}". Write one comparison per list entry (entries ` +
      'are ANDed): `<field> == <value>`, `<field> != <value>`, `<field> in [a, b]`, ' +
      '`<field> not in [a, b]`, or `has_tag(x)` / `not has_tag(x)`. Fields: ' +
      `${METRIC_FIELDS.join(', ')}. There is no \`or\` and no nesting.`
  );
}

/**
 * Reject a field reference whose SHAPE parsed but which this engine does not have.
 *
 * Today that is exactly `model.action`, and it is refused with its own sentence rather than by
 * falling through to the generic "could not parse predicate" error. The generic message would list
 * the legal fields and leave an author to notice the absence; the specific one says WHY there is no
 * such field, which is the difference between a typo and a misconception about the gate. A
 * predicate on a field that does not exist can never match — the permanent, trusted zero this file
 * exists to prevent.
 */
function assertKnownField(raw: string, where: string, text: string): MetricField {
  if ((METRIC_FIELDS as string[]).includes(raw)) return raw as MetricField;
  if (raw === 'model.action') {
    throw new Error(
      `${where}: "${text}" reads \`model.action\`, and there is no \`model.action\`. The model ` +
        'renders a JUDGEMENT, not an action: the deterministic layer decides what is done about ' +
        'it. Read `actual.action` for what the system did, or `model.label` for what the model ' +
        'judged.'
    );
  }
  throw new Error(
    `${where}: "${text}" reads "${raw}", which is not a field this engine has. Fields: ` +
      `${METRIC_FIELDS.join(', ')}.`
  );
}

/** Reject a literal the suite's enum does not declare. `none`, and the two synthetic buckets, are
 * always legal — they are how a metric talks about "absent" and "the model said something we could
 * not interpret", both of which are real, checkable states. */
function assertKnownLiteral(
  value: string,
  field: MetricField,
  spec: EvalClassificationSpec,
  where: string,
  text: string
): void {
  if (value === METRIC_NONE_LITERAL || value === UNRECOGNIZED_LABEL || value === NO_EXPECTATION) {
    return;
  }
  const declared = enumFor(field, spec);
  if (declared.includes(value)) return;
  const dimension = field.endsWith('.label') ? 'labels' : 'actions';
  throw new Error(
    `${where}: "${text}" uses ${dimension.slice(0, -1)} "${value}", which the suite's ` +
      `\`classification.${dimension}\` does not declare` +
      (declared.length > 0 ? ` (declared: ${declared.join(', ')})` : ' (none declared)') +
      '. A predicate on an undeclared value can never match, so the metric would report a ' +
      'permanent — and trusted — zero.'
  );
}

/** Every field a predicate list reads. Used to spot a denominator whose cells do not carry the
 * data the metric is about — see {@link computeMetric}'s absent-field warning. */
function referencedFields(predicates: MetricPredicate[]): MetricField[] {
  const fields = new Set<MetricField>();
  for (const predicate of predicates) {
    if (predicate.kind === 'tag') continue;
    fields.add(predicate.field);
    if (predicate.kind === 'compareField') fields.add(predicate.other);
  }
  return [...fields];
}

/** Read a field off a cell. `undefined` = absent, which the `none` literal matches. */
function fieldValue(cell: ClassifiedCell, field: MetricField): string | undefined {
  switch (field) {
    case 'expected.label':
      return cell.expectedLabel;
    case 'expected.action':
      return cell.expectedAction;
    case 'actual.label':
      return cell.actualLabel;
    case 'actual.action':
      return cell.actualAction;
    case 'model.label':
      return cell.modelLabel;
  }
}

/** Compare a field to a literal, with `none` meaning "absent". */
function literalMatches(actual: string | undefined, literal: string): boolean {
  if (literal === METRIC_NONE_LITERAL) return actual === undefined;
  return actual === literal;
}

/** Evaluate ONE predicate against one cell. */
export function evaluatePredicate(predicate: MetricPredicate, cell: ClassifiedCell): boolean {
  switch (predicate.kind) {
    case 'tag': {
      const has = cell.tags.includes(predicate.tag);
      return predicate.negated ? !has : has;
    }
    case 'in': {
      const value = fieldValue(cell, predicate.field);
      const inList = predicate.values.some((candidate) => literalMatches(value, candidate));
      return predicate.negated ? !inList : inList;
    }
    case 'compare': {
      const equal = literalMatches(fieldValue(cell, predicate.field), predicate.value);
      return predicate.negated ? !equal : equal;
    }
    case 'compareField': {
      const left = fieldValue(cell, predicate.field);
      const right = fieldValue(cell, predicate.other);
      // Two absent values are EQUAL: a case that declares no label and produced none is not a
      // mismatch, it is out of scope for an accuracy metric — and the denominator is where that is
      // expressed, not here.
      const equal = left === right;
      return predicate.negated ? !equal : equal;
    }
  }
}

/** All predicates in a list must hold (ANDed). An empty list is vacuously true — that is what "the
 * whole corpus" means for an absent `over:`. */
export function evaluatePredicates(predicates: MetricPredicate[], cell: ClassifiedCell): boolean {
  return predicates.every((predicate) => evaluatePredicate(predicate, cell));
}

/** numerator/denominator with the empty-denominator case kept honest: `value` is `null`, never `0`.
 * "0% of nothing" and "0% of the corpus" are opposite findings. */
function tally(numerator: number, denominator: number): EvalMetricTally {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Compute one declared metric over the corpus — overall and per tag — together with everything that
 * bounds what it can see.
 *
 * The denominator is every SCORED cell satisfying `over` (every scored cell when `over` is absent).
 * The numerator is the cells in that denominator that also satisfy `where`.
 *
 * Warnings, in the order they matter:
 * - **numerator outside the denominator** — the throwaway's exact bug shape: cases that satisfy what
 *   the metric is counting but sit outside what it divides by, so the metric cannot see them;
 * - **subset denominator** — fired on the evaluated count, so it catches both a narrowing `over:`
 *   and cells lost to SUT failures;
 * - **excluded cells** — cells that never produced a classification at all;
 * - **empty denominator** — the metric measured nothing, so its value is `null` rather than a
 *   flattering zero;
 * - **a raised label** (BATCH-26) — cells whose `actual.label` a deterministic step raised after the
 *   model answered, so a metric on that field is scoring the gate rather than the model. The two
 *   questions are written identically and only one of them is being answered.
 *
 * @param cells Every cell in the suite, scored and unscored alike (the unscored ones are what make
 *   the coverage numbers honest).
 */
export function computeMetric(
  spec: EvalMetricSpec,
  cells: ClassifiedCell[],
  tags: string[]
): EvalMetricResult {
  const total = cells.length;
  const scored = cells.filter((cell) => cell.scored);
  const excluded = total - scored.length;

  const over = spec.over ?? [];
  const denominatorCells = scored.filter((cell) => evaluatePredicates(over, cell));
  const numeratorCells = denominatorCells.filter((cell) => evaluatePredicates(spec.where, cell));

  const coverage: EvalMetricCoverage = {
    total,
    scored: scored.length,
    excluded,
    denominator: denominatorCells.length,
  };

  const warnings: string[] = [];

  // The throwaway's bug, named: cases the numerator predicate DOES describe, sitting outside the
  // denominator, therefore invisible to this metric however bad they get.
  const orphanNumerator = scored.filter(
    (cell) => !evaluatePredicates(over, cell) && evaluatePredicates(spec.where, cell)
  );
  if (orphanNumerator.length > 0) {
    warnings.push(
      `${orphanNumerator.length} scored case(s) satisfy this metric's numerator but fall OUTSIDE ` +
        `its denominator, so the metric cannot see them (e.g. ${orphanNumerator
          .slice(0, 3)
          .map((cell) => cell.id)
          .join(', ')}). Widen \`over:\` or drop it to score the whole corpus.`
    );
  }

  // Fired on the EVALUATED count, not on whether `over:` was written — cells lost to SUT failures
  // narrow the denominator just as effectively as a narrowing predicate.
  if (denominatorCells.length < total) {
    const share = total === 0 ? 0 : denominatorCells.length / total;
    warnings.push(
      `denominator covers ${denominatorCells.length}/${total} case(s) (${formatPercent(share)}) — ` +
        'a subset metric is structurally blind to regressions outside its denominator. Prefer a ' +
        'corpus-wide metric (omit `over:`) unless the subset IS the question.'
    );
  }

  if (excluded > 0) {
    warnings.push(
      `${excluded} case(s) produced no classification and are excluded from every count here.`
    );
  }

  if (denominatorCells.length === 0) {
    warnings.push(
      'denominator is EMPTY — this metric measured nothing. Its value is reported as n/a rather ' +
        'than 0, because a perfect score over no cases is not a perfect score.'
    );
  }

  // The MIRROR of the subset problem, and just as believable: a denominator containing cases that
  // do not carry the field the metric is about. On a corpus mixing label-asserting and action-only
  // cases, `actual.label != expected.label` is trivially TRUE for every case with no expected
  // label — so a case that asserts nothing is counted as an error, and the metric reports an
  // INFLATED rate. It also runs the other way, which is the more dangerous one: an ACCURACY metric
  // (`actual.label == expected.label`) counts each of those cases as a free HIT, because two absent
  // values compare equal. A `rater` suite's model-free cases are exactly that shape — no verdict was
  // rendered, so no label is reported — and a corpus of them scores 100%. Same failure, both signs,
  // same fix: say which cases, and point at the denominator.
  const fields = referencedFields([...spec.where, ...over]);

  // A metric whose own inputs were UNREADABLE. This warning is deliberately duplicated from the
  // report level onto each metric: a human reads the report header above the metrics and is
  // covered, but a machine consumer reads `metrics[].warnings` from results.json and would see an
  // empty array beside a perfect score. That asymmetry is precisely how an automated gate comes to
  // trust a number a human would have questioned — e.g. `false_approve: 0/3 (0.0%)` which is
  // perfect only because the extractor never produced `approve` at all.
  const unreadable = denominatorCells.filter((cell) =>
    fields.some((field) => fieldValue(cell, field) === UNRECOGNIZED_LABEL)
  );
  if (unreadable.length > 0) {
    warnings.push(
      `${unreadable.length}/${denominatorCells.length} case(s) in the denominator produced ` +
        `"${UNRECOGNIZED_LABEL}" for a field this metric reads (${fields.join(', ')}), e.g. ` +
        `${unreadable
          .slice(0, 3)
          .map((cell) => cell.id)
          .join(
            ', '
          )}. This metric's value may reflect output that could not be READ rather than ` +
        'behaviour that did not happen — check the extractor before trusting it.'
    );
  }

  const missingField = denominatorCells.filter((cell) =>
    fields.some((field) => fieldValue(cell, field) === undefined)
  );
  if (missingField.length > 0) {
    warnings.push(
      `${missingField.length} case(s) in the denominator do not carry every field this metric ` +
        `reads (${fields.join(', ')}), e.g. ${missingField
          .slice(0, 3)
          .map((cell) => cell.id)
          .join(
            ', '
          )}. An absent field still takes part in the comparison, and it lands on EITHER side: ` +
        'a case that asserts nothing is counted as a miss by `actual.label != expected.label`, and ' +
        'as a free HIT by `actual.label == expected.label` (two absent values compare equal) — ' +
        'which is how a corpus of deterministic, unlabelled cases scores 100% on label accuracy. ' +
        'Narrow `over:` to the cases the metric is about (e.g. `over: ["expected.label != none"]`).'
    );
  }

  // BATCH-26 — **this metric is about the GATE, and part of its denominator is a case where the
  // gate and the model disagreed.** `actual.label` is the outcome the decision settled on, which a
  // deterministic step may have RAISED after the model answered. That is the right field for
  // measuring what a user experiences and the wrong one for measuring the rater — and the two
  // questions are written identically, which is why the number has to say which one it answered.
  // Fired only when the metric actually reads `actual.label`: a metric already on `model.label` is
  // asking the other question and needs no note.
  if (fields.includes('actual.label')) {
    const raised = denominatorCells.filter(
      (cell) =>
        cell.modelLabel !== undefined &&
        cell.actualLabel !== undefined &&
        cell.modelLabel !== cell.actualLabel
    );
    if (raised.length > 0) {
      warnings.push(
        `${raised.length} of ${denominatorCells.length} case(s) in this denominator had their ` +
          `label RAISED by a deterministic step after the model answered (e.g. ${raised
            .slice(0, 3)
            .map((cell) => cell.id)
            .join(
              ', '
            )}). On those, \`actual.label\` is the decision the GATE reached and not the ` +
          "judgement the model rendered, so this metric scores the gate — the model's own answer " +
          'is excluded from it by construction. Read `model.label` for a metric about the model ' +
          'itself; it is recorded per cell in results.json as `modelLabel` wherever a model judged.'
      );
    }
  }

  const byTag: Record<string, EvalMetricTally> = {};
  for (const tag of tags) {
    const tagDenominator = denominatorCells.filter((cell) => cell.tags.includes(tag));
    const tagNumerator = numeratorCells.filter((cell) => cell.tags.includes(tag));
    byTag[tag] = tally(tagNumerator.length, tagDenominator.length);
  }

  const overall = tally(numeratorCells.length, denominatorCells.length);
  const result: EvalMetricResult = {
    name: spec.name,
    description: spec.description,
    overall,
    byTag,
    coverage,
    warnings,
  };

  if (
    spec.max !== undefined ||
    spec.min !== undefined ||
    spec.maxCount !== undefined ||
    spec.minCount !== undefined
  ) {
    result.gate = evaluateGate(spec, overall);
  }
  return result;
}

/** True when this metric's thresholds are absolute COUNTS rather than fractions. The two forms are
 * mutually exclusive per metric (enforced at parse time), so one flag decides the whole reading. */
export function isCountGate(spec: EvalMetricSpec): boolean {
  return spec.maxCount !== undefined || spec.minCount !== undefined;
}

/** The threshold as a human string, unit ALWAYS included. A reader seeing `3 > 2` must never have
 * to work out whether `2` was two cases or 200%. */
function gateSummary(spec: EvalMetricSpec): string {
  const parts: string[] = [];
  if (isCountGate(spec)) {
    if (spec.maxCount !== undefined) parts.push(`≤ ${spec.maxCount} case(s)`);
    if (spec.minCount !== undefined) parts.push(`≥ ${spec.minCount} case(s)`);
  } else {
    if (spec.max !== undefined) parts.push(`≤ ${formatPercent(spec.max)}`);
    if (spec.min !== undefined) parts.push(`≥ ${formatPercent(spec.min)}`);
  }
  return parts.join(' and ');
}

/**
 * Decide a metric's threshold, in whichever unit it declared.
 *
 * **COUNT form** (`max_count`/`min_count`) reads the NUMERATOR directly, so it is invariant to
 * corpus size — which is the entire reason it exists. "At most 2 cases may do this" keeps meaning
 * that when the corpus grows; `max: 0.0909` quietly becomes a different rule.
 *
 * **FRACTION form** (`max`/`min`) reads the value, and therefore inherits the empty-denominator
 * question: an empty denominator PASSES a `max` gate vacuously (nothing is above the ceiling) but
 * FAILS a `min` gate, because a recall floor that measured nothing has not been met — it has been
 * left unmeasured, and treating that as success is how a dead assertion survives. The
 * empty-denominator warning fires either way.
 *
 * The count form needs no such special case: an empty denominator yields a numerator of 0, which is
 * simply at-or-below any ceiling and below any positive floor.
 */
function evaluateGate(
  spec: EvalMetricSpec,
  overall: EvalMetricTally
): NonNullable<EvalMetricResult['gate']> {
  const base = {
    kind: isCountGate(spec) ? ('count' as const) : ('fraction' as const),
    max: spec.max,
    min: spec.min,
    maxCount: spec.maxCount,
    minCount: spec.minCount,
    mode: spec.gate,
    summary: gateSummary(spec),
  };

  if (isCountGate(spec)) {
    if (spec.maxCount !== undefined && overall.numerator > spec.maxCount) {
      return {
        ...base,
        passed: false,
        reason:
          `${overall.numerator} case(s) exceeds the maximum of ${spec.maxCount} case(s) ` +
          `(of ${overall.denominator} in the denominator)`,
      };
    }
    if (spec.minCount !== undefined && overall.numerator < spec.minCount) {
      return {
        ...base,
        passed: false,
        reason:
          `${overall.numerator} case(s) is below the minimum of ${spec.minCount} case(s) ` +
          `(of ${overall.denominator} in the denominator)`,
      };
    }
    return { ...base, passed: true };
  }

  if (overall.value === null) {
    if (spec.min !== undefined) {
      return {
        ...base,
        passed: false,
        reason:
          `n/a (empty denominator) does not meet the minimum ${formatPercent(spec.min)} — ` +
          'the metric measured nothing.',
      };
    }
    return { ...base, passed: true };
  }

  if (spec.max !== undefined && overall.value > spec.max) {
    return {
      ...base,
      passed: false,
      reason:
        `${overall.numerator}/${overall.denominator} = ${formatPercent(overall.value)} exceeds ` +
        `the maximum ${formatPercent(spec.max)}`,
    };
  }
  if (spec.min !== undefined && overall.value < spec.min) {
    return {
      ...base,
      passed: false,
      reason:
        `${overall.numerator}/${overall.denominator} = ${formatPercent(overall.value)} is below ` +
        `the minimum ${formatPercent(spec.min)}`,
    };
  }
  return { ...base, passed: true };
}

/** Format a tally for human output: `3/29 (10.3%)`, or `n/a (0 cases)` for an empty denominator —
 * which must never render as `0.0%`. */
export function formatTally(tally: EvalMetricTally): string {
  if (tally.value === null) return 'n/a (0 cases)';
  return `${tally.numerator}/${tally.denominator} (${formatPercent(tally.value)})`;
}
