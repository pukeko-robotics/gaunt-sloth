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

/** The four readable fields. `expected.*` is what the corpus declares, `actual.*` is what the SUT
 * produced — spelled out because a corpus plan's prose says "label" for one and "action" for the
 * other, and that ambiguity is what produces a silently-wrong metric. */
const METRIC_FIELDS: MetricField[] = [
  'expected.label',
  'expected.action',
  'actual.label',
  'actual.action',
];

const FIELD_PATTERN = '(expected|actual)\\.(label|action)';
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
 * - `expected.label in [destructive, exfiltration]` · `actual.action not in [approve]`
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
    const field = `${inMatch[1]}.${inMatch[2]}` as MetricField;
    const negated = inMatch[3].startsWith('not');
    const values = inMatch[4]
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
    const field = `${compareMatch[1]}.${compareMatch[2]}` as MetricField;
    const negated = compareMatch[3] === '!=';
    const rhs = unquote(compareMatch[4]);
    if ((METRIC_FIELDS as string[]).includes(rhs)) {
      const other = rhs as MetricField;
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
 *   flattering zero.
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

  if (spec.max !== undefined || spec.min !== undefined) {
    result.gate = evaluateGate(spec, overall);
  }
  return result;
}

/** Decide a metric's threshold. An empty denominator PASSES a `max` gate vacuously (there is
 * nothing above the ceiling) but FAILS a `min` gate: a recall floor that measured nothing has not
 * been met, it has been left unmeasured, and treating that as success is how a dead assertion
 * survives. The empty-denominator warning fires either way. */
function evaluateGate(
  spec: EvalMetricSpec,
  overall: EvalMetricTally
): NonNullable<EvalMetricResult['gate']> {
  const mode = spec.gate;
  if (overall.value === null) {
    if (spec.min !== undefined) {
      return {
        max: spec.max,
        min: spec.min,
        mode,
        passed: false,
        reason:
          `n/a (empty denominator) does not meet the minimum ${formatPercent(spec.min)} — ` +
          'the metric measured nothing.',
      };
    }
    return { max: spec.max, min: spec.min, mode, passed: true };
  }

  if (spec.max !== undefined && overall.value > spec.max) {
    return {
      max: spec.max,
      min: spec.min,
      mode,
      passed: false,
      reason:
        `${overall.numerator}/${overall.denominator} = ${formatPercent(overall.value)} exceeds ` +
        `the maximum ${formatPercent(spec.max)}`,
    };
  }
  if (spec.min !== undefined && overall.value < spec.min) {
    return {
      max: spec.max,
      min: spec.min,
      mode,
      passed: false,
      reason:
        `${overall.numerator}/${overall.denominator} = ${formatPercent(overall.value)} is below ` +
        `the minimum ${formatPercent(spec.min)}`,
    };
  }
  return { max: spec.max, min: spec.min, mode, passed: true };
}

/** Format a tally for human output: `3/29 (10.3%)`, or `n/a (0 cases)` for an empty denominator —
 * which must never render as `0.0%`. */
export function formatTally(tally: EvalMetricTally): string {
  if (tally.value === null) return 'n/a (0 cases)';
  return `${tally.numerator}/${tally.denominator} (${formatPercent(tally.value)})`;
}
