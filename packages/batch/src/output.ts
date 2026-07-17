import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBatchSummary } from '#src/BatchRunner.js';
import type { BatchSummary, CellResult } from '#src/types.js';

/**
 * Write one structured JSON record per cell (`<id>.json`) plus one aggregate `results.json`
 * (pass/fail counts + a per-cell one-liner — a lightweight flake report) into `outputDir`.
 * Creates `outputDir` (and any missing parents) if it doesn't exist.
 *
 * Pure I/O, deliberately separate from {@link runBatchMatrix}: the runner never touches the
 * filesystem, so unit tests can exercise matrix/concurrency/retry logic without a tmp dir, and this
 * function can be tested in isolation with a fixed set of results.
 *
 * @returns The aggregate {@link BatchSummary} that was written to `results.json`.
 */
export function writeBatchOutput(outputDir: string, results: CellResult[]): BatchSummary {
  mkdirSync(outputDir, { recursive: true });

  for (const result of results) {
    writeFileSync(join(outputDir, `${result.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }

  const summary = buildBatchSummary(results);
  writeFileSync(join(outputDir, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);

  return summary;
}
