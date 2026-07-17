import {
  DEFAULT_CONCURRENCY,
  type BatchRunnerOptions,
  type BatchSummary,
  type CellResult,
  type MatrixCell,
  type RunCellFn,
} from '#src/types.js';

/**
 * Run every cell of the matrix through the injected {@link RunCellFn}, capping in-flight work at
 * `concurrency` and retrying a failed cell up to `retry` times.
 *
 * Isolation: cells are independent by construction — nothing here shares state between them beyond
 * the caller-supplied `runCell` closure, matching the "N isolated model calls" framing batch is
 * scoped around (docs/batch-mechanism-vs-judgment.md). A cell throwing (rather than resolving
 * `{ ok: false }`) is caught and recorded as a failure like any other — one bad cell must never
 * take down the whole batch run or the other in-flight cells (the exit-code contract: `gth batch`
 * exits 0 iff the cells ran at all, regardless of how many of them failed).
 *
 * Returns results in the same order as `cells` (not completion order), so callers can zip them back
 * up with the matrix.
 */
export async function runBatchMatrix(
  cells: MatrixCell[],
  options: BatchRunnerOptions
): Promise<CellResult[]> {
  const concurrency = normalizeConcurrency(options.concurrency);
  const retry = normalizeRetry(options.retry);
  const results: CellResult[] = new Array(cells.length);

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex++;
      if (i >= cells.length) return;
      results[i] = await runCellWithRetry(cells[i], options.runCell, retry);
    }
  };

  const workerCount = Math.min(concurrency, cells.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

async function runCellWithRetry(
  cell: MatrixCell,
  runCell: RunCellFn,
  retry: number
): Promise<CellResult> {
  const startedAt = Date.now();
  let attempts = 0;
  // Always at least one attempt; `retry` additional attempts on failure.
  for (;;) {
    attempts++;
    try {
      const outcome = await runCell(cell);
      if (outcome.ok || attempts > retry) {
        return {
          ...outcome,
          id: cell.id,
          model: cell.model,
          inputIndex: cell.inputIndex,
          inputRow: cell.inputRow,
          durationMs: Date.now() - startedAt,
          retries: attempts - 1,
        };
      }
      // Failed but retries remain: loop around for another attempt.
    } catch (error) {
      if (attempts > retry) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          id: cell.id,
          model: cell.model,
          inputIndex: cell.inputIndex,
          inputRow: cell.inputRow,
          durationMs: Date.now() - startedAt,
          retries: attempts - 1,
        };
      }
      // Exception with retries remaining: loop around for another attempt.
    }
  }
}

function normalizeConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined || !Number.isFinite(concurrency) || concurrency < 1) {
    return DEFAULT_CONCURRENCY;
  }
  return Math.floor(concurrency);
}

function normalizeRetry(retry: number | undefined): number {
  if (retry === undefined || !Number.isFinite(retry) || retry < 0) {
    return 0;
  }
  return Math.floor(retry);
}

/** Build the lightweight aggregate "flake report" (pass/fail counts) from the per-cell results. */
export function buildBatchSummary(results: CellResult[]): BatchSummary {
  const cells = results.map((r) => ({
    id: r.id,
    model: r.model,
    inputIndex: r.inputIndex,
    ok: r.ok,
    retries: r.retries,
  }));
  const passed = cells.filter((c) => c.ok).length;
  return {
    total: cells.length,
    passed,
    failed: cells.length - passed,
    cells,
  };
}
