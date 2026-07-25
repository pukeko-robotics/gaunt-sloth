import { describe, expect, it } from 'vitest';
import type { CellRunOutcome, MatrixCell, RunCellFn } from '#src/types.js';

function makeCells(n: number): MatrixCell[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `cell-0-${i}`,
    modelIndex: 0,
    inputIndex: i,
    content: `content-${i}`,
  }));
}

/** A deferred promise, for precise control over when a fake cell "finishes". */
function deferred<T>(): { promise: Promise<T>; resolve: (_value: T) => void } {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe('runBatchMatrix', () => {
  it('runs every cell and preserves matrix order in the results', async () => {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cells = makeCells(5);
    const runCell: RunCellFn = async (cell) => ({ ok: true, answer: cell.content });

    const results = await runBatchMatrix(cells, { runCell });

    expect(results).toHaveLength(5);
    expect(results.map((r) => r.id)).toEqual([
      'cell-0-0',
      'cell-0-1',
      'cell-0-2',
      'cell-0-3',
      'cell-0-4',
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('never lets more than `concurrency` cells run at once', async () => {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cells = makeCells(6);
    const gates = cells.map(() => deferred<void>());
    let inFlight = 0;
    let maxInFlight = 0;

    const runCell: RunCellFn = async (cell) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const index = Number(cell.id.split('-').pop());
      await gates[index].promise;
      inFlight--;
      return { ok: true };
    };

    const runPromise = runBatchMatrix(cells, { runCell, concurrency: 2 });

    // Let the first wave of workers start.
    await Promise.resolve();
    await Promise.resolve();
    expect(inFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(2);

    // Release all gates so the run can complete.
    gates.forEach((g) => g.resolve());
    await runPromise;

    expect(maxInFlight).toBe(2);
  });

  /** Run `n` cells and report the highest number that were ever in flight at the same time. */
  async function observeMaxInFlight(n: number, concurrency?: number): Promise<number> {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cells = makeCells(n);
    let maxInFlight = 0;
    let inFlight = 0;
    const runCell: RunCellFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true };
    };

    await runBatchMatrix(cells, { runCell, concurrency });
    return maxInFlight;
  }

  // BATCH-24: asserted against the LITERAL 1, not against DEFAULT_CELL_CONCURRENCY. A test written
  // relative to the constant passes at any value and so proves nothing about the number — and the
  // number is the whole point here: a parallel default melts a local single-GPU backend.
  it('defaults to running exactly ONE cell at a time when `-j` is omitted', async () => {
    expect(await observeMaxInFlight(5)).toBe(1);
  });

  it('honours an explicit concurrency of 4 (opt-in throughput still fans out)', async () => {
    expect(await observeMaxInFlight(8, 4)).toBe(4);
  });

  it('normalizes an invalid concurrency to the default rather than deadlocking', async () => {
    // concurrency: 0 is invalid (< 1) and must fall back to the serial default, not to 0 workers.
    expect(await observeMaxInFlight(5, 0)).toBe(1);
  });

  it('exposes the cell default as DEFAULT_CELL_CONCURRENCY = 1', async () => {
    const { DEFAULT_CELL_CONCURRENCY } = await import('#src/types.js');
    expect(DEFAULT_CELL_CONCURRENCY).toBe(1);
  });

  it('retries a failing cell up to `retry` times, then records failure', async () => {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cells = makeCells(1);
    let calls = 0;
    const runCell: RunCellFn = async () => {
      calls++;
      return { ok: false, error: `attempt ${calls} failed` };
    };

    const results = await runBatchMatrix(cells, { runCell, retry: 2 });

    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(results[0].ok).toBe(false);
    expect(results[0].retries).toBe(2);
    expect(results[0].error).toEqual('attempt 3 failed');
  });

  it('stops retrying as soon as a cell succeeds', async () => {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cells = makeCells(1);
    let calls = 0;
    const runCell: RunCellFn = async (): Promise<CellRunOutcome> => {
      calls++;
      return calls < 3 ? { ok: false, error: 'transient' } : { ok: true, answer: 'finally' };
    };

    const results = await runBatchMatrix(cells, { runCell, retry: 5 });

    expect(calls).toBe(3);
    expect(results[0].ok).toBe(true);
    expect(results[0].retries).toBe(2);
    expect(results[0].answer).toEqual('finally');
  });

  it('does not retry by default (retry: 0)', async () => {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cells = makeCells(1);
    let calls = 0;
    const runCell: RunCellFn = async () => {
      calls++;
      return { ok: false };
    };

    const results = await runBatchMatrix(cells, { runCell });

    expect(calls).toBe(1);
    expect(results[0].retries).toBe(0);
  });

  it('catches a thrown error from runCell and records it as a failure instead of propagating', async () => {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cells = makeCells(1);
    const runCell: RunCellFn = async () => {
      throw new Error('boom');
    };

    const results = await runBatchMatrix(cells, { runCell, retry: 1 });

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toEqual('boom');
    expect(results[0].retries).toBe(1);
  });

  it('one failing cell does not affect the outcome of other cells (isolation)', async () => {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cells = makeCells(4);
    const runCell: RunCellFn = async (cell) => {
      if (cell.inputIndex === 2) throw new Error('cell 2 exploded');
      return { ok: true };
    };

    const results = await runBatchMatrix(cells, { runCell });

    expect(results[2].ok).toBe(false);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  it('records a per-cell durationMs >= 0', async () => {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cells = makeCells(1);
    const runCell: RunCellFn = async () => ({ ok: true });

    const results = await runBatchMatrix(cells, { runCell });

    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('echoes model and inputRow onto the result for traceability', async () => {
    const { runBatchMatrix } = await import('#src/BatchRunner.js');
    const cell: MatrixCell = {
      id: 'cell-0-0',
      modelIndex: 0,
      model: 'gpt-x',
      inputIndex: 0,
      inputRow: { a: '1' },
      content: 'x',
    };
    const runCell: RunCellFn = async () => ({ ok: true });

    const results = await runBatchMatrix([cell], { runCell });

    expect(results[0].model).toEqual('gpt-x');
    expect(results[0].inputRow).toEqual({ a: '1' });
  });
});

describe('concurrencyHint', () => {
  it('nudges when more than one unit ran and no `-j` was supplied', async () => {
    const { concurrencyHint } = await import('#src/BatchRunner.js');
    expect(concurrencyHint(5, undefined)).toBe(
      'Cells ran one at a time. Pass -j <n> to run them in parallel.'
    );
  });

  it("uses the surface's own noun for eval", async () => {
    const { concurrencyHint } = await import('#src/BatchRunner.js');
    expect(concurrencyHint(3, undefined, 'Cases')).toBe(
      'Cases ran one at a time. Pass -j <n> to run them in parallel.'
    );
  });

  it('stays silent when the user passed an explicit -j', async () => {
    const { concurrencyHint } = await import('#src/BatchRunner.js');
    expect(concurrencyHint(5, 4)).toBeUndefined();
    // Even an explicit -j 1: the user already chose serial, so there is nothing to tell them.
    expect(concurrencyHint(5, 1)).toBeUndefined();
  });

  it('stays silent for a single-unit run (nothing to parallelize)', async () => {
    const { concurrencyHint } = await import('#src/BatchRunner.js');
    expect(concurrencyHint(1, undefined)).toBeUndefined();
    expect(concurrencyHint(0, undefined)).toBeUndefined();
  });

  // BATCH-24 hard requirement: suggesting a number would hand the wrong advice to the local
  // single-GPU backend this default exists to protect.
  it('never names a concurrency number', async () => {
    const { concurrencyHint } = await import('#src/BatchRunner.js');
    expect(concurrencyHint(9, undefined)).not.toMatch(/-j\s*\d/);
    expect(concurrencyHint(9, undefined, 'Cases')).not.toMatch(/-j\s*\d/);
  });
});

describe('buildBatchSummary', () => {
  it('counts total/passed/failed and includes a per-cell line', async () => {
    const { buildBatchSummary } = await import('#src/BatchRunner.js');
    const summary = buildBatchSummary([
      { id: 'a', ok: true, inputIndex: 0, durationMs: 1, retries: 0 },
      { id: 'b', ok: false, inputIndex: 1, durationMs: 1, retries: 1, error: 'nope' },
      { id: 'c', ok: true, inputIndex: 2, durationMs: 1, retries: 0 },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.cells).toEqual([
      { id: 'a', model: undefined, inputIndex: 0, ok: true, retries: 0 },
      { id: 'b', model: undefined, inputIndex: 1, ok: false, retries: 1 },
      { id: 'c', model: undefined, inputIndex: 2, ok: true, retries: 0 },
    ]);
  });

  it('handles an empty result set', async () => {
    const { buildBatchSummary } = await import('#src/BatchRunner.js');
    const summary = buildBatchSummary([]);
    expect(summary).toEqual({ total: 0, passed: 0, failed: 0, cells: [] });
  });
});
