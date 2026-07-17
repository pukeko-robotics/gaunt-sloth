import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CellResult } from '#src/types.js';

describe('writeBatchOutput', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gth-batch-output-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one JSON file per cell plus an aggregate results.json', async () => {
    const { writeBatchOutput } = await import('#src/output.js');
    const outputDir = join(dir, 'run-1');
    const results: CellResult[] = [
      { id: 'cell-0-0', ok: true, answer: 'hi', inputIndex: 0, durationMs: 12, retries: 0 },
      { id: 'cell-0-1', ok: false, error: 'nope', inputIndex: 1, durationMs: 5, retries: 1 },
    ];

    const summary = writeBatchOutput(outputDir, results);

    const cell0 = JSON.parse(readFileSync(join(outputDir, 'cell-0-0.json'), 'utf8'));
    expect(cell0).toEqual(results[0]);

    const cell1 = JSON.parse(readFileSync(join(outputDir, 'cell-0-1.json'), 'utf8'));
    expect(cell1).toEqual(results[1]);

    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson).toEqual(summary);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('creates the output directory (and parents) when it does not exist', async () => {
    const { writeBatchOutput } = await import('#src/output.js');
    const outputDir = join(dir, 'nested', 'deeper', 'run');

    writeBatchOutput(outputDir, [
      { id: 'cell-0-0', ok: true, inputIndex: 0, durationMs: 1, retries: 0 },
    ]);

    const content = readFileSync(join(outputDir, 'results.json'), 'utf8');
    expect(JSON.parse(content).total).toBe(1);
  });

  it('handles an empty result set without throwing', async () => {
    const { writeBatchOutput } = await import('#src/output.js');
    const outputDir = join(dir, 'empty-run');

    const summary = writeBatchOutput(outputDir, []);

    expect(summary).toEqual({ total: 0, passed: 0, failed: 0, cells: [] });
  });
});
