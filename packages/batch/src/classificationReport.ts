import { buildConfusionMatrix, collectTags } from '#src/classification.js';
import { computeMetric } from '#src/metrics.js';
import type {
  ClassifiedCell,
  EvalClassificationReport,
  EvalClassificationSpec,
  EvalMetricSpec,
} from '#src/classificationTypes.js';
import { UNRECOGNIZED_LABEL } from '#src/classificationTypes.js';

/**
 * BATCH-25 — assemble the suite-level classification report: the confusion matrices (overall and
 * per tag), every declared metric (overall and per tag), the corpus-wide coverage, and the list of
 * `gate: fail` metrics that were breached.
 *
 * Kept separate from both the extractor ({@link ./classification.js}) and the metric engine
 * ({@link ./metrics.js}) so neither imports the other, and so the whole aggregation is exercisable
 * from a plain array of {@link ClassifiedCell}s with no runner, no I/O, and no model.
 */
export function buildClassificationReport(
  spec: EvalClassificationSpec,
  metricSpecs: EvalMetricSpec[],
  cells: ClassifiedCell[]
): EvalClassificationReport {
  const tags = collectTags(cells);
  const total = cells.length;
  const scored = cells.filter((cell) => cell.scored);
  const excluded = total - scored.length;

  const labelMatrix = buildConfusionMatrix(cells, 'label', spec.labels);
  const actionMatrix =
    spec.actions.length > 0 ? buildConfusionMatrix(cells, 'action', spec.actions) : undefined;

  // Per-tag matrices are built from the tag's OWN cells, so a family's matrix reads on its own —
  // the 0/3-on-prompt-injection result that a 48.9% aggregate hid.
  const labelMatrixByTag: Record<string, ReturnType<typeof buildConfusionMatrix>> = {};
  for (const tag of tags) {
    labelMatrixByTag[tag] = buildConfusionMatrix(
      cells.filter((cell) => cell.tags.includes(tag)),
      'label',
      spec.labels
    );
  }

  const metrics = metricSpecs.map((metricSpec) => computeMetric(metricSpec, cells, tags));

  // Report-level warnings: everything that bounds what these numbers cover, stated once at the top
  // rather than left for a reader to infer from a denominator. "No silent caps" is not a per-metric
  // courtesy — it is the report's contract.
  const warnings: string[] = [];
  if (excluded > 0) {
    warnings.push(
      `${excluded}/${total} cell(s) produced no classification (the SUT did not run, or the ` +
        'classifier failed) and are excluded from every matrix and metric below. Coverage is ' +
        `${scored.length}/${total}, NOT ${total}/${total}.`
    );
  }
  const unrecognized = scored.filter(
    (cell) => cell.actualLabel === UNRECOGNIZED_LABEL || cell.actualAction === UNRECOGNIZED_LABEL
  );
  if (unrecognized.length > 0) {
    warnings.push(
      `${unrecognized.length} cell(s) produced output matching no declared value and are counted ` +
        `under "${UNRECOGNIZED_LABEL}" (e.g. ${unrecognized
          .slice(0, 3)
          .map((cell) => cell.id)
          .join(', ')}). They are scored, not dropped — an uninterpretable verdict is a finding.`
    );
  }

  const gateFailures = metrics
    .filter((metric) => metric.gate && metric.gate.mode === 'fail' && !metric.gate.passed)
    .map((metric) => metric.name);

  return {
    labels: spec.labels,
    actions: spec.actions,
    tags,
    coverage: { total, scored: scored.length, excluded },
    labelMatrix,
    actionMatrix,
    labelMatrixByTag,
    metrics,
    warnings,
    gateFailures,
  };
}
