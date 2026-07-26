import type {
  EvalClassificationReport,
  EvalConfusionMatrix,
  EvalMetricResult,
} from '#src/classificationTypes.js';
import { formatTally } from '#src/metrics.js';

/**
 * BATCH-25 — render a {@link EvalClassificationReport} as plain lines.
 *
 * A pure string builder, deliberately separate from the reporter that prints it: the console
 * rendering is then unit-testable without mocking `consoleUtils`, and a future reporter (JUnit,
 * TeamCity, a third-party one) can emit the same block without reimplementing the layout.
 *
 * Every function here is total over the report — there is no "…and 12 more" anywhere. A renderer
 * that truncates is a silent cap, and a truncated matrix reads as a complete one.
 */

/** Render the whole report: coverage, matrices, metrics, warnings, gate verdict. */
export function renderClassificationReport(report: EvalClassificationReport): string[] {
  const lines: string[] = [];

  lines.push('');
  lines.push('CLASSIFICATION');
  // Coverage FIRST, before any number that depends on it. "no silent caps" is not a footnote.
  lines.push(
    `  coverage: ${report.coverage.scored}/${report.coverage.total} cell(s) classified` +
      (report.coverage.excluded > 0 ? `, ${report.coverage.excluded} excluded` : '')
  );

  for (const warning of report.warnings) lines.push(`  ! ${warning}`);

  lines.push('');
  lines.push(...renderConfusionMatrix(report.labelMatrix, 'label'));
  if (report.actionMatrix) {
    lines.push('');
    lines.push(...renderConfusionMatrix(report.actionMatrix, 'action'));
  }

  // Per-tag matrices only when there is more than one family — with a single tag the per-tag matrix
  // is the overall one, and printing it twice is noise, not information.
  if (report.tags.length > 1) {
    for (const tag of report.tags) {
      const matrix = report.labelMatrixByTag[tag];
      if (!matrix) continue;
      lines.push('');
      lines.push(...renderConfusionMatrix(matrix, `label · tag "${tag}"`));
    }
  }

  if (report.metrics.length > 0) {
    lines.push('');
    lines.push('METRICS');
    for (const metric of report.metrics) lines.push(...renderMetric(metric, report.tags));
  }

  if (report.gateFailures.length > 0) {
    lines.push('');
    lines.push(`METRIC GATE FAILED: ${report.gateFailures.join(', ')}`);
  }

  return lines;
}

/** Render one confusion matrix as a fixed-width grid: rows = expected, columns = actual. */
export function renderConfusionMatrix(matrix: EvalConfusionMatrix, title: string): string[] {
  const lines: string[] = [];
  lines.push(`  confusion (${title}) — rows = expected, cols = actual`);

  const rowLabelWidth = Math.max(...matrix.rows.map((row) => row.length), 'expected'.length);
  const columnWidths = matrix.columns.map((column) =>
    Math.max(
      column.length,
      ...matrix.rows.map((row) => String(matrix.counts[row][column] ?? 0).length)
    )
  );

  const header = matrix.columns
    .map((column, index) => column.padStart(columnWidths[index] + 2))
    .join('');
  lines.push(`    ${''.padEnd(rowLabelWidth)}${header}`);

  for (const row of matrix.rows) {
    const cells = matrix.columns
      .map((column, index) =>
        String(matrix.counts[row][column] ?? 0).padStart(columnWidths[index] + 2)
      )
      .join('');
    lines.push(`    ${row.padEnd(rowLabelWidth)}${cells}`);
  }

  lines.push(
    `    counted ${matrix.counted}` +
      (matrix.excluded > 0 ? `, EXCLUDED ${matrix.excluded} (not classified)` : '')
  );
  return lines;
}

/** Render one metric: headline value, gate verdict, per-tag sub-scores, then its warnings. */
export function renderMetric(metric: EvalMetricResult, tags: string[]): string[] {
  const lines: string[] = [];

  const gateSuffix = metric.gate
    ? metric.gate.passed
      ? ' [gate ok]'
      : ` [GATE ${metric.gate.mode === 'fail' ? 'FAILED' : 'breached (report-only)'}: ${
          metric.gate.reason ?? 'threshold breached'
        }]`
    : '';
  lines.push(`  ${metric.name}: ${formatTally(metric.overall)}${gateSuffix}`);
  if (metric.description) lines.push(`    ${metric.description}`);

  // Per-tag ALWAYS, not only when interesting: the 48.9%-overall / 0-of-3-on-injection result is
  // exactly the one a "print it if it looks bad" rule would have hidden, since it looked fine.
  for (const tag of tags) {
    const tally = metric.byTag[tag];
    if (!tally) continue;
    lines.push(`    ${tag}: ${formatTally(tally)}`);
  }

  lines.push(
    `    coverage: denominator ${metric.coverage.denominator}/${metric.coverage.total} case(s)`
  );
  for (const warning of metric.warnings) lines.push(`    ! ${warning}`);

  return lines;
}
