import { resolveJsonPath } from '#src/deterministicChecks.js';
import type {
  ClassificationExtractor,
  ClassifiedCell,
  EvalClassificationSpec,
  EvalConfusionMatrix,
} from '#src/classificationTypes.js';
import { NO_EXPECTATION, UNRECOGNIZED_LABEL } from '#src/classificationTypes.js';

/**
 * BATCH-25 — read a classification value out of one cell's answer, and build confusion matrices
 * from the graded results.
 *
 * Both halves obey the same rule: **nothing is ever dropped.** An answer that matches no declared
 * value becomes {@link UNRECOGNIZED_LABEL}; a cell that never ran is counted as `excluded` and said
 * out loud. A classifier report that quietly discards the rows it could not interpret reports a
 * cleaner number than it earned, which is the failure mode this whole cluster exists to prevent.
 */

/**
 * Extract one declared enum value from an answer.
 *
 * TOTAL by construction — the return is always either a member of `allowed` or
 * {@link UNRECOGNIZED_LABEL}. There is deliberately no fuzzy/substring fallback: matching `safe`
 * inside "this is not safe" is exactly the silent misreading a classifier eval must not do.
 *
 * Matching is case-insensitive and whitespace-trimmed (a model that answers `"Safe\n"` meant
 * `safe`), and surrounding quotes/backticks/full stops are stripped, because those are formatting,
 * not content. Anything beyond that is the author's job via `json_path`.
 *
 * @param answer The cell's raw answer text (or the resolved JSON-path value, stringified).
 * @param extractor How to read it.
 * @param allowed The suite's declared enum for this dimension.
 * @returns The matched enum value, or {@link UNRECOGNIZED_LABEL}.
 */
export function extractClassificationValue(
  answer: string | undefined,
  extractor: ClassificationExtractor,
  allowed: string[]
): string {
  const raw = readRaw(answer, extractor);
  if (raw === undefined) return UNRECOGNIZED_LABEL;
  const normalized = normalizeValue(raw);
  if (normalized.length === 0) return UNRECOGNIZED_LABEL;
  const hit = allowed.find((candidate) => candidate.toLowerCase() === normalized);
  return hit ?? UNRECOGNIZED_LABEL;
}

/** The text an extractor actually reads — kept separate from matching so the per-cell record can
 * carry it for diagnosis (`(unrecognized)` with no trace of what was said is not diagnosable).
 * `undefined` = the extractor found nothing at all (no answer, unparseable JSON, unresolved path). */
export function readRaw(
  answer: string | undefined,
  extractor: ClassificationExtractor
): string | undefined {
  if (answer === undefined) return undefined;
  if (extractor.kind === 'answer') return answer;

  // json_path: parse the answer as JSON and resolve the path with the SAME minimal resolver the
  // `json_path` assertion uses, so an author who knows one knows the other. A non-JSON answer or an
  // unresolved path yields `undefined` → `(unrecognized)`, never a throw mid-run.
  let root: unknown;
  try {
    root = JSON.parse(answer);
  } catch {
    return undefined;
  }
  const { found, value } = resolveJsonPath(root, extractor.path);
  if (!found || value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Trim, strip wrapping quotes/backticks and a trailing full stop, lowercase. Formatting only —
 * never content. */
function normalizeValue(raw: string): string {
  let text = raw.trim();
  // Strip one layer of wrapping quotes/backticks, then a single trailing full stop.
  const quotes = ['"', "'", '`'];
  while (text.length >= 2 && quotes.includes(text[0]) && text[text.length - 1] === text[0]) {
    text = text.slice(1, -1).trim();
  }
  if (text.endsWith('.')) text = text.slice(0, -1).trim();
  return text.toLowerCase();
}

/**
 * Build one confusion matrix (rows = expected, columns = actual) over the given cells.
 *
 * Axis construction is deliberate: rows are the declared enum in DECLARED order (so two runs of the
 * same suite are diffable line by line) plus {@link NO_EXPECTATION} only when some cell declares no
 * expectation; columns are the declared enum plus {@link UNRECOGNIZED_LABEL} and/or
 * {@link NO_EXPECTATION} only when some cell actually produced one. Extra buckets never appear
 * speculatively, and never fail to appear when they are populated.
 *
 * `counted + excluded === cells.length`, always — asserted in the unit suite, because a matrix that
 * silently drops the cells it could not place reads as "covered everything" when it didn't.
 */
export function buildConfusionMatrix(
  cells: ClassifiedCell[],
  dimension: 'label' | 'action',
  declared: string[]
): EvalConfusionMatrix {
  const expectedOf = (cell: ClassifiedCell): string | undefined =>
    dimension === 'label' ? cell.expectedLabel : cell.expectedAction;
  const actualOf = (cell: ClassifiedCell): string | undefined =>
    dimension === 'label' ? cell.actualLabel : cell.actualAction;

  const scored = cells.filter((cell) => cell.scored);
  const excluded = cells.length - scored.length;

  const rowSet = new Set<string>(declared);
  const columnSet = new Set<string>(declared);
  for (const cell of scored) {
    rowSet.add(expectedOf(cell) ?? NO_EXPECTATION);
    columnSet.add(actualOf(cell) ?? NO_EXPECTATION);
  }
  // Preserve DECLARED order first, then any extra bucket in a stable order, so the rendered matrix
  // is diffable across runs.
  const order = (present: Set<string>): string[] => [
    ...declared.filter((value) => present.has(value)),
    ...[UNRECOGNIZED_LABEL, NO_EXPECTATION].filter((value) => present.has(value)),
  ];
  // Declared values always keep their row/column even at zero — an enum value that never appears is
  // itself a finding (the QA-5 "the caution tier was never emitted" result), so it must be visible.
  for (const value of declared) {
    rowSet.add(value);
    columnSet.add(value);
  }
  const rows = order(rowSet);
  const columns = order(columnSet);

  const counts: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    counts[row] = {};
    for (const column of columns) counts[row][column] = 0;
  }

  for (const cell of scored) {
    const row = expectedOf(cell) ?? NO_EXPECTATION;
    const column = actualOf(cell) ?? NO_EXPECTATION;
    counts[row][column] += 1;
  }

  return { dimension, rows, columns, counts, counted: scored.length, excluded };
}

/** Every tag any cell declares, sorted — the per-tag axis for matrices and metrics. */
export function collectTags(cells: ClassifiedCell[]): string[] {
  const tags = new Set<string>();
  for (const cell of cells) for (const tag of cell.tags) tags.add(tag);
  return [...tags].sort();
}

/**
 * Which enum a `classification` spec declares for a dimension. `actions` is `[]` when the suite has
 * no action dimension, which is what makes an `expect_action` assertion a parse error rather than a
 * silently ungradeable one.
 */
export function declaredValues(
  spec: EvalClassificationSpec,
  dimension: 'label' | 'action'
): string[] {
  return dimension === 'label' ? spec.labels : spec.actions;
}
