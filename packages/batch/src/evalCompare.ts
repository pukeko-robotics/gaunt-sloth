import type { EvalMetricTally } from '#src/classificationTypes.js';
import { formatTally } from '#src/metrics.js';
import type {
  EvalCaseResult,
  EvalSuite,
  EvalSuiteSummary,
  EvalSweep,
  EvalSweepValue,
  JudgeOutcome,
} from '#src/evalTypes.js';
import type { RaterPromptArm } from '#src/raterPromptArm.js';

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
  /** A filename-safe form of {@link name} (`rung-assisted__model-flash`), used as an output-dir
   * component. Built from parse-time-validated path-safe tokens, so it can neither traverse nor
   * escape the output root. */
  dirName: string;
  /** The `model` override for this cell, when any axis value sets one. */
  model?: string;
  /** The merged plain-data config overrides for this cell. */
  config: Record<string, unknown>;
  /**
   * [[BATCH-31]] — the cell's rater prompt arm, when an axis value declares one.
   *
   * **A sibling of {@link config}, never a key inside it, and that separation is the facility's
   * first enforcement leg.** `initConfigForCell` deep-merges `config` onto the resolved `GthConfig`
   * and nothing else; keeping the arm out of it is what makes the omission unable to become a
   * config value — and therefore unable to be written in a config file, an env var or a CLI flag,
   * the three carriers that would make it reachable from a live session's approvals gate.
   */
  notes?: RaterPromptArm;
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
    // [[BATCH-31]] — the arm follows `model`'s rule, not `config`'s: a later axis REPLACES it rather
    // than merging. Two axes declaring arms are describing the same knob twice (the cell name shows
    // it), and a union of their omissions would build a third arm neither axis wrote.
    let notes: RaterPromptArm | undefined;
    for (const part of cell.parts) {
      if (part.value.model !== undefined) model = part.value.model;
      if (part.value.config) config = deepMerge(config, part.value.config);
      if (part.value.notes !== undefined) notes = part.value.notes;
    }
    return {
      name: cell.parts.map((part) => `${part.axis}=${part.value.name}`).join(' · '),
      dirName: cell.parts.map((part) => `${part.axis}-${part.value.name}`).join('__'),
      model,
      config,
      ...(notes !== undefined ? { notes } : {}),
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

/**
 * BATCH-33 — how a run-over-run JUDGE-SCORE drift report is filtered.
 *
 * ## Why there is a filter at all, and why the raw form is not a member of this union
 *
 * A judge score is a model's 0-10 opinion, and it wobbles between identical runs. Reporting every
 * per-case delta therefore prints a section on every run, most of it noise, and trains the reader to
 * skip it — at which point the real slide is skipped along with it. That is strictly WORSE than
 * reporting no drift at all: a section nobody reads still spends the run's credibility, which is the
 * same failure BATCH-25's untrusted metric ran into.
 *
 * So the raw unfiltered form is deliberately not representable. There is no `all` member, and no
 * value of the knobs below reaches one — {@link parseJudgeDriftFilter} rejects `min:0` and bounds
 * the threshold-ward tolerance, because a knob that admits its own degenerate value ships the form
 * this type exists to withhold.
 *
 * ## What each member is for
 *
 * - `threshold-ward` (**the default**) — report a case only when its score CROSSED the pass
 *   threshold, or moved DOWN to within `tolerance` points of it. Distance to the gate is the thing
 *   worth alerting on: a 10 → 8 that stays clear of a gate at 6 is a different event from a 7 → 6
 *   sitting on it, and only the second is about to cost a verdict. It is the default because it is
 *   the one filter whose false-positive rate on a stable suite is near zero: at the default
 *   tolerance a score must land at or below its own gate to report, so a corpus grading anywhere
 *   above its gate wobbles freely and prints nothing.
 * - `min-points` — report any movement of at least N points, either direction. The blunt
 *   instrument: it sees large swings wherever they land, and pays for that by firing on a wobbly
 *   judge no matter how much headroom the case had.
 * - `mean` — report only the suite-level mean. Averaging over the corpus cancels the wobble, so it
 *   is the quietest form of all and the one that cannot say WHICH case moved.
 * - `off` — no drift report. Opting out is not the raw form; it prints less, not more.
 */
export type JudgeDriftFilter =
  | { mode: 'threshold-ward'; tolerance: number }
  | { mode: 'min-points'; points: number }
  | { mode: 'mean' }
  | { mode: 'off' };

/**
 * How many points above the gate still counts as sitting ON it, when the caller names no tolerance.
 *
 * Zero, and the reason is a measurement rather than a preference. A local judge asked to re-rate one
 * fixed answer against one fixed rubric twelve times returned rates spanning a full point (7 and 8,
 * on the same input every time). So one point of movement carries no information: it is the width of
 * the noise. A shoulder of 1 would report every cell that wobbled from 8 to 7 against the default
 * gate of 6 — an ordinary judged suite grades right there, so the section would fire on a stable
 * re-run, which is the one failure this node exists to avoid.
 *
 * At zero the rule still reports both movements the node names: a 7 → 6 lands ON the gate and
 * reports, a 10 → 8 stays clear and does not. The shoulder was buying nothing those two clauses did
 * not already cover, and was costing exactly the measured noise band. Widen it deliberately with
 * `--drift threshold-ward:<n>` on a corpus whose judge is steadier than this.
 */
export const DEFAULT_JUDGE_DRIFT_TOLERANCE = 0;

/**
 * The widest tolerance a caller may ask for. The judge scale is 0-10 and a typical gate is 6, so a
 * shoulder much wider than this covers the whole usable band and every downward move reports —
 * the unfiltered form by another route, which is what the bound exists to refuse.
 */
export const MAX_JUDGE_DRIFT_TOLERANCE = 3;

/** The filter {@link diffRuns} applies when the caller names none. */
export const DEFAULT_JUDGE_DRIFT_FILTER: JudgeDriftFilter = {
  mode: 'threshold-ward',
  tolerance: DEFAULT_JUDGE_DRIFT_TOLERANCE,
};

/**
 * Parse a `--drift` spec into a {@link JudgeDriftFilter}, throwing on anything unrecognised —
 * including the degenerate values that would reconstitute the raw per-case report.
 *
 * Accepted: `threshold-ward` (or `threshold-ward:<tolerance>`), `min:<points>`, `mean`, `off`.
 */
export function parseJudgeDriftFilter(spec: string): JudgeDriftFilter {
  const parts = spec.trim().split(':');
  if (parts.length > 2) throw new Error(driftSpecError(spec));
  const mode = parts[0].trim().toLowerCase();
  const value = parts[1];

  if (mode === 'off' || mode === 'mean') {
    if (value !== undefined) throw new Error(driftSpecError(spec));
    return mode === 'off' ? { mode: 'off' } : { mode: 'mean' };
  }

  if (mode === 'min') {
    const points = driftNumber(value, spec);
    // 0 or less would keep every movement — the unfiltered report this filter exists to avoid.
    if (points < 1 || points > 10) {
      throw new Error(
        `--drift min:<points> takes 1-10, so "${spec}" is not accepted: it would report every ` +
          'judge-score movement, which is the unfiltered form that trains readers to skip the ' +
          'section.'
      );
    }
    return { mode: 'min-points', points };
  }

  if (mode === 'threshold-ward' || mode === 'threshold') {
    if (value === undefined)
      return { mode: 'threshold-ward', tolerance: DEFAULT_JUDGE_DRIFT_TOLERANCE };
    const tolerance = driftNumber(value, spec);
    if (tolerance < 0 || tolerance > MAX_JUDGE_DRIFT_TOLERANCE) {
      throw new Error(
        `--drift threshold-ward:<tolerance> takes 0-${MAX_JUDGE_DRIFT_TOLERANCE}, so "${spec}" is ` +
          'not accepted: a shoulder that wide reports nearly every downward move, which is the ' +
          'unfiltered form that trains readers to skip the section.'
      );
    }
    return { mode: 'threshold-ward', tolerance };
  }

  throw new Error(driftSpecError(spec));
}

function driftSpecError(spec: string): string {
  return (
    `unrecognised --drift filter "${spec}". Use "threshold-ward" (the default, optionally ` +
    `"threshold-ward:<0-${MAX_JUDGE_DRIFT_TOLERANCE}>"), "min:<1-10>", "mean", or "off".`
  );
}

function driftNumber(raw: string | undefined, spec: string): number {
  if (raw === undefined || raw.trim() === '') throw new Error(driftSpecError(spec));
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) throw new Error(driftSpecError(spec));
  return value;
}

/** One case whose JUDGE SCORE moved between two runs, as kept by a {@link JudgeDriftFilter}. */
export interface JudgeDriftEntry {
  id: string;
  before: number;
  after: number;
  /** `after - before`. Negative is a slide toward the gate. */
  delta: number;
  /** The gate the movement is measured against — THIS run's, since that is the one now in force. */
  passThreshold: number;
  /** Why the filter kept it: the score crossed the gate, slid onto the gate's shoulder, or simply
   * moved far enough for a `min-points` filter. */
  reason: 'crossed' | 'near-threshold' | 'moved';
}

/** The suite-level judge-score mean — the `mean` filter's whole output. */
export interface JudgeDriftMean {
  before: number;
  after: number;
  delta: number;
  /** Cases carrying a rate on BOTH sides, i.e. the mean's denominator. */
  cases: number;
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
  /**
   * BATCH-60 — cases whose pass rate FELL but stayed above zero: the agent still does it, just not
   * every time. Classified only when at least one of the two runs repeated the case; see
   * {@link diffRuns}.
   */
  flaky: RunDiffEntry[];
  /** BATCH-60 — cases whose pass rate fell TO ZERO: no run passes any more. Same condition. */
  broke: RunDiffEntry[];
  /** Metric deltas, `after - before`, for metrics both runs computed. */
  metricDeltas: {
    name: string;
    before: number | null;
    after: number | null;
    delta: number | null;
  }[];
  /**
   * BATCH-33 — per-case judge-score movements the active filter kept. The signal a VERDICT-only
   * diff structurally cannot see: a judge-graded suite with no `classification:` block has neither
   * `reclassified` nor `metricDeltas`, so before this its diff was strictly binary and a score
   * sliding toward its gate reported "no change." until the run it finally broke.
   *
   * EMPTY under the `mean` and `off` filters, which report no per-case rows at all.
   */
  judgeDrift: JudgeDriftEntry[];
  /** The suite-level mean, under the `mean` filter only. */
  judgeDriftMean?: JudgeDriftMean;
  /** The filter that produced the two fields above, echoed so the render can name it: a quiet drift
   * section means nothing unless the reader can see WHICH filter was quiet. */
  judgeDriftFilter: JudgeDriftFilter;
  /** Ids in only one of the two runs — reported, so a shrunken corpus cannot read as "no change". */
  onlyInBefore: string[];
  onlyInAfter: string[];
  warnings: string[];
}

/**
 * The judge rate representing one CELL, or `undefined` when no verdict was rendered for it.
 *
 * A single-turn cell carries its own {@link EvalCaseResult.judge}. A MULTI-TURN cell leaves that
 * unset and grades per turn, so its representative rate is the LOWEST any turn scored: the cell
 * passes iff every turn passes, which makes the weakest turn the one sitting nearest the gate and
 * therefore the one this report is about. Reading only the top-level field would hand every
 * multi-turn suite an empty drift section forever — the same silence this node exists to end.
 */
function judgeRateOf(result: EvalCaseResult): number | undefined {
  // BATCH-60 — a repeated case carries its judge scores per run; the weakest run is the one nearest
  // the gate, by the same reasoning as the weakest turn below.
  if (result.runs !== undefined) {
    const runRates = result.runs
      .map((run) => judgeRateOf(run))
      .filter((rate): rate is number => rate !== undefined);
    return runRates.length === 0 ? undefined : Math.min(...runRates);
  }
  const direct = rateOfOutcome(result.judge);
  if (direct !== undefined) return direct;
  const turnRates = (result.turns ?? [])
    .map((turn) => rateOfOutcome(turn.judge))
    .filter((rate): rate is number => rate !== undefined);
  return turnRates.length === 0 ? undefined : Math.min(...turnRates);
}

/** A usable 0-10 rate, or `undefined`. A judge that errored, timed out, returned something
 * unparseable or was never asked has no score to compare, and substituting one would report a slide
 * nobody measured. */
function rateOfOutcome(judge: JudgeOutcome | undefined): number | undefined {
  if (judge?.ok !== true) return undefined;
  const rate = judge.verdict?.rate;
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : undefined;
}

/**
 * Does one movement survive the filter? Returns the reason it was kept, or `undefined`.
 *
 * The threshold-ward rule is two clauses and BOTH are load-bearing:
 *
 * - a CROSSING of the gate, either direction, always reports. That is the moment the score changed
 *   what it is worth, and its numbers are what explain the verdict flip printed beside it.
 * - otherwise, only a DOWNWARD move landing within `tolerance` of the gate. Direction alone is not
 *   the rule — a 10 → 8 is downward and still clear of a gate at 6, and keeping it is exactly how
 *   the section fills with wobble. Proximity alone is not the rule either, or a case recovering
 *   6 → 7 would report. It is the pair, and a reader tempted to simplify one clause away should
 *   expect the section to go noisy on the next stable re-run.
 */
function driftReason(
  before: number,
  after: number,
  passThreshold: number,
  filter: JudgeDriftFilter
): JudgeDriftEntry['reason'] | undefined {
  if (filter.mode === 'min-points') {
    return Math.abs(after - before) >= filter.points ? 'moved' : undefined;
  }
  if (filter.mode !== 'threshold-ward') return undefined;
  if (before >= passThreshold !== after >= passThreshold) return 'crossed';
  if (after < before && after <= passThreshold + filter.tolerance) return 'near-threshold';
  return undefined;
}

/**
 * BATCH-60 — a case's pass rate for the flaky/broke classification, or `undefined` when it has
 * none worth comparing.
 *
 * A repeated case reports its own whole-percent rate. A case that ran once counts as a rate of
 * 100% or 0% by its verdict, which is what lets a repeated run be compared with a single-run
 * baseline and the other way round. A harness error (`sutOk: false`) has no rate: its runs did not
 * all finish, and a rate read off it would report infrastructure as flakiness.
 */
function passRateOf(result: EvalCaseResult): { label: string; percent: number } | undefined {
  if (!result.sutOk) return undefined;
  if (result.repeat !== undefined) {
    const { passed, runs, ratePercent } = result.repeat;
    return { label: `${passed}/${runs} (${ratePercent}%)`, percent: ratePercent };
  }
  const percent = result.verdict === 'PASS' ? 100 : 0;
  return { label: `${percent === 100 ? 1 : 0}/1 (${percent}%)`, percent };
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
 *
 * A fourth, {@link RunDiff.judgeDrift}, covers the suites the other three cannot: `reclassified`
 * and `metricDeltas` both need a `classification:` block, so an ordinary judge-graded corpus got a
 * strictly binary diff and learned nothing until a score finally broke its gate. `filter` decides
 * how much of that movement is worth printing — see {@link JudgeDriftFilter} for why it defaults to
 * the threshold-ward one and why the unfiltered form is not on offer. **The default lives here, not
 * only in the CLI**, so every caller gets the quiet behaviour without having to know to ask.
 */
export function diffRuns(
  before: EvalSuiteSummary,
  after: EvalSuiteSummary,
  filter: JudgeDriftFilter = DEFAULT_JUDGE_DRIFT_FILTER
): RunDiff {
  const beforeByKey = new Map(before.cases.map((result) => [diffKey(result), result]));
  const afterByKey = new Map(after.cases.map((result) => [diffKey(result), result]));

  const regressed: RunDiffEntry[] = [];
  const fixed: RunDiffEntry[] = [];
  const reclassified: RunDiffEntry[] = [];
  const flaky: RunDiffEntry[] = [];
  const broke: RunDiffEntry[] = [];
  const ratePairs: { key: string; before: number; after: number; passThreshold: number }[] = [];
  let lostRates = 0;
  let movedGates = 0;
  let compared = 0;

  for (const [key, afterCase] of afterByKey) {
    const beforeCase = beforeByKey.get(key);
    if (!beforeCase) continue;
    compared += 1;

    const beforeRate = judgeRateOf(beforeCase);
    const afterRate = judgeRateOf(afterCase);
    if (beforeRate !== undefined && afterRate !== undefined) {
      ratePairs.push({
        key,
        before: beforeRate,
        after: afterRate,
        passThreshold: afterCase.passThreshold,
      });
      if (beforeCase.passThreshold !== afterCase.passThreshold) movedGates += 1;
    } else if (beforeRate !== undefined) {
      lostRates += 1;
    }

    if (beforeCase.verdict === 'PASS' && afterCase.verdict === 'FAIL') {
      regressed.push({ id: key, before: 'PASS', after: 'FAIL' });
    } else if (beforeCase.verdict === 'FAIL' && afterCase.verdict === 'PASS') {
      fixed.push({ id: key, before: 'FAIL', after: 'PASS' });
    }

    // BATCH-60 — flaky vs broke, by pass rate. Only when at least one side repeated the case: two
    // single runs can only go 100% → 0%, which is exactly a regression and already listed as one,
    // and calling it "broke" as well would change every existing diff while saying nothing a single
    // run can tell apart. A rate that held or rose is in neither list.
    const repeated = beforeCase.repeat !== undefined || afterCase.repeat !== undefined;
    const beforePassRate = repeated ? passRateOf(beforeCase) : undefined;
    const afterPassRate = repeated ? passRateOf(afterCase) : undefined;
    if (
      beforePassRate !== undefined &&
      afterPassRate !== undefined &&
      afterPassRate.percent < beforePassRate.percent
    ) {
      (afterPassRate.percent > 0 ? flaky : broke).push({
        id: key,
        before: beforePassRate.label,
        after: afterPassRate.label,
      });
    }

    // A repeated case has no single classification at the top level (each run carries its own),
    // so a reclassification is not read off it; its rate above is the comparison that applies.
    if (!repeated) {
      const beforeClass = describeClassification(beforeCase.classification);
      const afterClass = describeClassification(afterCase.classification);
      if (beforeClass !== afterClass && (beforeClass !== '-' || afterClass !== '-')) {
        reclassified.push({ id: key, before: beforeClass, after: afterClass });
      }
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

  // BATCH-33 — the judge-score drift, as much of it as the filter keeps. `mean` reports only the
  // suite aggregate (no per-case rows); every other filter reports rows and no aggregate.
  const judgeDrift: JudgeDriftEntry[] = [];
  let judgeDriftMean: JudgeDriftMean | undefined;
  if (filter.mode === 'mean') {
    if (ratePairs.length > 0) {
      const mean = (pick: (pair: (typeof ratePairs)[number]) => number): number =>
        ratePairs.reduce((sum, pair) => sum + pick(pair), 0) / ratePairs.length;
      const meanBefore = mean((pair) => pair.before);
      const meanAfter = mean((pair) => pair.after);
      judgeDriftMean = {
        before: meanBefore,
        after: meanAfter,
        delta: meanAfter - meanBefore,
        cases: ratePairs.length,
      };
    }
  } else {
    for (const pair of ratePairs) {
      const reason = driftReason(pair.before, pair.after, pair.passThreshold, filter);
      if (reason === undefined) continue;
      judgeDrift.push({
        id: pair.key,
        before: pair.before,
        after: pair.after,
        delta: pair.after - pair.before,
        passThreshold: pair.passThreshold,
        reason,
      });
    }
  }

  const warnings: string[] = [];
  if (lostRates > 0 && filter.mode !== 'off') {
    warnings.push(
      `${lostRates} case(s) were judged in the baseline and produced no judge score in this run, ` +
        'so their drift could not be computed. A quiet drift section here is not "the scores held".'
    );
  }
  if (movedGates > 0 && filter.mode !== 'off') {
    warnings.push(
      `${movedGates} case(s) changed their pass threshold between the two runs. Drift is measured ` +
        "against THIS run's gate, so some of the distance reported here is the gate moving rather " +
        'than the score.'
    );
  }
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
    flaky,
    broke,
    metricDeltas,
    judgeDrift,
    judgeDriftMean,
    judgeDriftFilter: filter,
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
  // BATCH-60 — `flaky` and `broke` stay REQUIRED on `RunDiff`, so every producer (`diffRuns`) must
  // fill them. The renderer alone tolerates their absence, because a `RunDiff` can also reach it
  // from outside this package — built by a caller, or read back from an older shape — and a diff
  // that predates repeats has nothing to say about them rather than something to crash on.
  const flaky = (diff as Partial<RunDiff>).flaky ?? [];
  const broke = (diff as Partial<RunDiff>).broke ?? [];
  const lines: string[] = ['', 'RUN-OVER-RUN DIFF'];
  lines.push(`  compared: ${diff.compared} case(s)`);
  for (const warning of diff.warnings) lines.push(`  ! ${warning}`);

  const list = (title: string, entries: RunDiffEntry[]): void => {
    if (entries.length === 0) return;
    lines.push(`  ${title} (${entries.length}):`);
    for (const entry of entries) lines.push(`    ${entry.id}: ${entry.before} → ${entry.after}`);
  };
  list('REGRESSED', diff.regressed);
  // BATCH-60 — upper case like REGRESSED, since both are bad news a reader must not skim past.
  list('BROKE', broke);
  list('FLAKY', flaky);
  list('fixed', diff.fixed);
  list('reclassified', diff.reclassified);

  // BATCH-33 — judge drift under its own heading, so a judge-graded suite with no `classification:`
  // block has something to read here at all. Nothing is printed when the filter kept nothing: a
  // quiet section IS the report on a stable re-run, and adding a reassuring "no drift" line would
  // put a row on every run, which is the noise the filter exists to prevent.
  if (diff.judgeDrift.length > 0) {
    lines.push(
      `  JUDGE DRIFT — ${describeDriftFilter(diff.judgeDriftFilter)} (${diff.judgeDrift.length}):`
    );
    for (const entry of diff.judgeDrift) {
      const sign = entry.delta >= 0 ? '+' : '';
      const margin = entry.after - entry.passThreshold;
      const where =
        entry.reason === 'crossed'
          ? `CROSSED the pass threshold ${entry.passThreshold}`
          : entry.reason === 'near-threshold'
            ? margin === 0
              ? `now AT the pass threshold ${entry.passThreshold}`
              : margin < 0
                ? `now ${-margin} BELOW the pass threshold ${entry.passThreshold}`
                : `now ${margin} above the pass threshold ${entry.passThreshold}`
            : `pass threshold ${entry.passThreshold}`;
      lines.push(
        `    ${entry.id}: ${entry.before} → ${entry.after} (${sign}${entry.delta}) — ${where}`
      );
    }
  }

  if (diff.judgeDriftMean) {
    const mean = diff.judgeDriftMean;
    const sign = mean.delta >= 0 ? '+' : '';
    lines.push(
      `  judge mean: ${mean.before.toFixed(2)} → ${mean.after.toFixed(2)} ` +
        `(${sign}${mean.delta.toFixed(2)}) over ${mean.cases} case(s)`
    );
  }

  if (diff.metricDeltas.length > 0) {
    lines.push('  metric deltas:');
    for (const delta of diff.metricDeltas) {
      const format = (value: number | null): string =>
        value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
      const change =
        delta.delta === null
          ? 'n/a'
          : `${delta.delta >= 0 ? '+' : ''}${(delta.delta * 100).toFixed(1)}pp`;
      lines.push(`    ${delta.name}: ${format(delta.before)} → ${format(delta.after)} (${change})`);
    }
  }

  if (
    diff.regressed.length === 0 &&
    diff.fixed.length === 0 &&
    diff.reclassified.length === 0 &&
    flaky.length === 0 &&
    broke.length === 0 &&
    diff.metricDeltas.every((delta) => delta.delta === 0) &&
    // BATCH-33 — drift has to count here too, or a run that printed a JUDGE DRIFT section would
    // print "no change." underneath it and contradict itself.
    diff.judgeDrift.length === 0 &&
    (diff.judgeDriftMean === undefined || diff.judgeDriftMean.delta === 0)
  ) {
    lines.push('  no change.');
  }
  return lines;
}

/** How the active drift filter is named in the report heading. */
function describeDriftFilter(filter: JudgeDriftFilter): string {
  switch (filter.mode) {
    case 'threshold-ward':
      return `toward the pass threshold (tolerance ${filter.tolerance})`;
    case 'min-points':
      return `movements of ${filter.points}+ point(s)`;
    case 'mean':
      return 'suite mean';
    case 'off':
      return 'off';
  }
}

/** Does this suite declare a sweep? Small helper so the command reads declaratively. */
export function suiteSweep(suite: EvalSuite): EvalSweep | undefined {
  return suite.sweep;
}
