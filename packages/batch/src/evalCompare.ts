import type { EvalMetricTally } from '#src/classificationTypes.js';
import { formatTally } from '#src/metrics.js';
import type { EvalSuite, EvalSuiteSummary, EvalSweep, EvalSweepValue } from '#src/evalTypes.js';

/**
 * BATCH-25 — the comparison layer: run the same corpus across a sweep of configurations and emit
 * ONE comparison table, and diff a run against a previous one.
 *
 * ## Why a sweep is an OUTER loop and not a runner concept
 *
 * A sweep is "the same suite, a different config" — structurally identical to BATCH-19's
 * multi-suite loop, and unrelated to grading. Threading it into `runEvalSuite` would have meant
 * generalising the (case × identity) unit to (case × identity × sweep cell) and rewriting the
 * `RunCellFn` resolution that #405's identity matrix depends on. Instead the command runs the suite
 * once per cell and this module folds the N summaries into one table. The identity matrix is
 * untouched, and the run-over-run diff falls out of the same code for free.
 *
 * ## Why one table and not N reports
 *
 * The decisive QA-5 result came from running one corpus at two settings and diffing them; N
 * separate reports is the form in which that result is invisible. So the artifact is a table whose
 * rows are metrics and whose columns are cells, plus the same for overall accuracy.
 */

/** One sweep cell: a name and the config overrides that produce it. */
export interface SweepCell {
  /** `axis=value` joined by ` · ` across axes — stable, and derived from the declared names. */
  name: string;
  /** A filename-safe form of {@link name} (`rung-auto-safe__model-flash`), used as an output-dir
   * component. Built from parse-time-validated path-safe tokens, so it can neither traverse nor
   * escape the output root. */
  dirName: string;
  /** The `model` override for this cell, when any axis value sets one. */
  model?: string;
  /** The merged plain-data config overrides for this cell. */
  config: Record<string, unknown>;
}

/**
 * Expand a {@link EvalSweep} into its cartesian product of cells, in declared axis order.
 *
 * A later axis wins on a conflicting key, and that is documented rather than defended against: two
 * axes that set the same config key are describing the same knob twice, which the author should see
 * in the cell name.
 */
export function expandSweep(sweep: EvalSweep): SweepCell[] {
  let cells: { parts: { axis: string; value: EvalSweepValue }[] }[] = [{ parts: [] }];
  for (const axis of sweep.axes) {
    const next: typeof cells = [];
    for (const cell of cells) {
      for (const value of axis.values) {
        next.push({ parts: [...cell.parts, { axis: axis.name, value }] });
      }
    }
    cells = next;
  }

  return cells.map((cell) => {
    let model: string | undefined;
    let config: Record<string, unknown> = {};
    for (const part of cell.parts) {
      if (part.value.model !== undefined) model = part.value.model;
      if (part.value.config) config = deepMerge(config, part.value.config);
    }
    return {
      name: cell.parts.map((part) => `${part.axis}=${part.value.name}`).join(' · '),
      dirName: cell.parts.map((part) => `${part.axis}-${part.value.name}`).join('__'),
      model,
      config,
    };
  });
}

/**
 * Deep-merge plain data (the sweep's `config:` overrides) into a target.
 *
 * Objects merge recursively; arrays and scalars REPLACE. Replacing an array is the right default
 * for config: an override that appended to `mcpServers` or `allowedTools` would silently keep the
 * base value the author meant to displace, which is the harder bug to see.
 *
 * Prototype-polluting keys are skipped — a suite file is only semi-trusted input.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overrides: Record<string, unknown>
): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One column of the comparison table: a cell name and the summary it produced. */
export interface ComparisonColumn {
  name: string;
  summary: EvalSuiteSummary;
}

/**
 * Render the cross-cell comparison table.
 *
 * Rows are the metrics the suite declares (plus pass rate), columns are the sweep cells. A metric
 * that a cell could not compute renders `n/a`, never a blank and never a zero — the same rule the
 * metric engine follows, for the same reason.
 *
 * Per-tag sub-scores get their own rows under each metric, because the whole point of running a
 * sweep is to see which setting moved which family, and a blended per-cell number cannot show that.
 */
export function renderComparison(columns: ComparisonColumn[]): string[] {
  if (columns.length === 0) return [];

  const lines: string[] = ['', `COMPARISON across ${columns.length} cell(s)`];

  const nameWidth = Math.max(...columns.map((column) => column.name.length), 'metric'.length, 24);
  const columnWidth = Math.max(...columns.map((column) => column.name.length), 16) + 2;

  const header = columns.map((column) => column.name.padStart(columnWidth)).join('');
  lines.push(`  ${'metric'.padEnd(nameWidth)}${header}`);

  const row = (label: string, values: string[]): string =>
    `  ${label.padEnd(nameWidth)}${values.map((value) => value.padStart(columnWidth)).join('')}`;

  lines.push(
    row(
      'pass rate',
      columns.map((column) =>
        column.summary.total === 0
          ? 'n/a (0 cases)'
          : `${column.summary.passed}/${column.summary.total}`
      )
    )
  );
  lines.push(
    row(
      'classified',
      columns.map((column) => {
        const coverage = column.summary.classification?.coverage;
        return coverage ? `${coverage.scored}/${coverage.total}` : 'n/a';
      })
    )
  );

  // Metric rows, in the order the FIRST cell declares them, then any metric only later cells have
  // (which would mean the cells ran different suites — worth seeing rather than hiding).
  const metricNames: string[] = [];
  for (const column of columns) {
    for (const metric of column.summary.classification?.metrics ?? []) {
      if (!metricNames.includes(metric.name)) metricNames.push(metric.name);
    }
  }
  const tags: string[] = [];
  for (const column of columns) {
    for (const tag of column.summary.classification?.tags ?? []) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }

  for (const name of metricNames) {
    lines.push('');
    lines.push(
      row(
        name,
        columns.map((column) => cellMetricValue(column, name, undefined))
      )
    );
    for (const tag of tags) {
      lines.push(
        row(
          `  · ${tag}`,
          columns.map((column) => cellMetricValue(column, name, tag))
        )
      );
    }
    // A gate breach must be visible in the comparison itself, not only in the per-cell report.
    const breached = columns.filter((column) =>
      (column.summary.classification?.gateFailures ?? []).includes(name)
    );
    if (breached.length > 0) {
      lines.push(
        `  ${''.padEnd(nameWidth)}GATE FAILED in: ${breached.map((c) => c.name).join(', ')}`
      );
    }
  }

  return lines;
}

/** One cell's value for a metric (overall, or for one tag). `n/a` when the cell has no such metric
 * — never blank, never 0. */
function cellMetricValue(
  column: ComparisonColumn,
  metricName: string,
  tag: string | undefined
): string {
  const metric = column.summary.classification?.metrics.find((m) => m.name === metricName);
  if (!metric) return 'n/a';
  const tally: EvalMetricTally | undefined = tag === undefined ? metric.overall : metric.byTag[tag];
  if (!tally) return 'n/a';
  return formatTally(tally);
}

/** One case whose verdict or classification moved between two runs. */
export interface RunDiffEntry {
  id: string;
  before: string;
  after: string;
}

/** The run-over-run diff. */
export interface RunDiff {
  /** Cases in both runs. */
  compared: number;
  /** Cases that went PASS → FAIL. The regression list. */
  regressed: RunDiffEntry[];
  /** Cases that went FAIL → PASS. */
  fixed: RunDiffEntry[];
  /** Cases whose actual label/action changed, verdict aside — a rating-prompt edit's real signal. */
  reclassified: RunDiffEntry[];
  /** Metric deltas, `after - before`, for metrics both runs computed. */
  metricDeltas: { name: string; before: number | null; after: number | null; delta: number | null }[];
  /** Ids in only one of the two runs — reported, so a shrunken corpus cannot read as "no change". */
  onlyInBefore: string[];
  onlyInAfter: string[];
  warnings: string[];
}

/** The key a cell is diffed on across runs: id plus identity, since a matrix cell's id alone is
 * ambiguous. */
function diffKey(result: { id: string; identity?: string }): string {
  return result.identity === undefined ? result.id : `${result.id}__${result.identity}`;
}

/**
 * Diff two runs of the same suite, so a rating-prompt edit produces a signal rather than a vibe.
 *
 * Three separate lists, because they answer different questions: verdict regressions are what a CI
 * gate reads, verdict fixes are what a change claims to have done, and RECLASSIFICATIONS are what
 * a prompt edit actually moved — a case can keep its verdict while the label underneath it changes,
 * and that is exactly the drift a pass-rate comparison cannot see.
 */
export function diffRuns(before: EvalSuiteSummary, after: EvalSuiteSummary): RunDiff {
  const beforeByKey = new Map(before.cases.map((result) => [diffKey(result), result]));
  const afterByKey = new Map(after.cases.map((result) => [diffKey(result), result]));

  const regressed: RunDiffEntry[] = [];
  const fixed: RunDiffEntry[] = [];
  const reclassified: RunDiffEntry[] = [];
  let compared = 0;

  for (const [key, afterCase] of afterByKey) {
    const beforeCase = beforeByKey.get(key);
    if (!beforeCase) continue;
    compared += 1;

    if (beforeCase.verdict === 'PASS' && afterCase.verdict === 'FAIL') {
      regressed.push({ id: key, before: 'PASS', after: 'FAIL' });
    } else if (beforeCase.verdict === 'FAIL' && afterCase.verdict === 'PASS') {
      fixed.push({ id: key, before: 'FAIL', after: 'PASS' });
    }

    const beforeClass = describeClassification(beforeCase.classification);
    const afterClass = describeClassification(afterCase.classification);
    if (beforeClass !== afterClass && (beforeClass !== '-' || afterClass !== '-')) {
      reclassified.push({ id: key, before: beforeClass, after: afterClass });
    }
  }

  const onlyInBefore = [...beforeByKey.keys()].filter((key) => !afterByKey.has(key));
  const onlyInAfter = [...afterByKey.keys()].filter((key) => !beforeByKey.has(key));

  const metricDeltas: RunDiff['metricDeltas'] = [];
  for (const afterMetric of after.classification?.metrics ?? []) {
    const beforeMetric = before.classification?.metrics.find((m) => m.name === afterMetric.name);
    if (!beforeMetric) continue;
    const beforeValue = beforeMetric.overall.value;
    const afterValue = afterMetric.overall.value;
    metricDeltas.push({
      name: afterMetric.name,
      before: beforeValue,
      after: afterValue,
      delta: beforeValue === null || afterValue === null ? null : afterValue - beforeValue,
    });
  }

  const warnings: string[] = [];
  if (onlyInBefore.length > 0 || onlyInAfter.length > 0) {
    warnings.push(
      `the two runs do not cover the same cases: ${onlyInBefore.length} only in the baseline, ` +
        `${onlyInAfter.length} only in this run. The comparison covers ${compared} case(s); a ` +
        'case that disappeared cannot regress, so "no regressions" here is not "nothing broke".'
    );
  }

  return {
    compared,
    regressed,
    fixed,
    reclassified,
    metricDeltas,
    onlyInBefore,
    onlyInAfter,
    warnings,
  };
}

function describeClassification(
  classification: { actualLabel?: string; actualAction?: string } | undefined
): string {
  if (!classification) return '-';
  const label = classification.actualLabel ?? '-';
  const action = classification.actualAction;
  return action === undefined ? label : `${label}/${action}`;
}

/** Render a {@link RunDiff} as plain lines. */
export function renderRunDiff(diff: RunDiff): string[] {
  const lines: string[] = ['', 'RUN-OVER-RUN DIFF'];
  lines.push(`  compared: ${diff.compared} case(s)`);
  for (const warning of diff.warnings) lines.push(`  ! ${warning}`);

  const list = (title: string, entries: RunDiffEntry[]): void => {
    if (entries.length === 0) return;
    lines.push(`  ${title} (${entries.length}):`);
    for (const entry of entries) lines.push(`    ${entry.id}: ${entry.before} → ${entry.after}`);
  };
  list('REGRESSED', diff.regressed);
  list('fixed', diff.fixed);
  list('reclassified', diff.reclassified);

  if (diff.metricDeltas.length > 0) {
    lines.push('  metric deltas:');
    for (const delta of diff.metricDeltas) {
      const format = (value: number | null): string =>
        value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
      const change =
        delta.delta === null
          ? 'n/a'
          : `${delta.delta >= 0 ? '+' : ''}${(delta.delta * 100).toFixed(1)}pp`;
      lines.push(
        `    ${delta.name}: ${format(delta.before)} → ${format(delta.after)} (${change})`
      );
    }
  }

  if (
    diff.regressed.length === 0 &&
    diff.fixed.length === 0 &&
    diff.reclassified.length === 0 &&
    diff.metricDeltas.every((delta) => delta.delta === 0)
  ) {
    lines.push('  no change.');
  }
  return lines;
}

/** Does this suite declare a sweep? Small helper so the command reads declaratively. */
export function suiteSweep(suite: EvalSuite): EvalSweep | undefined {
  return suite.sweep;
}
