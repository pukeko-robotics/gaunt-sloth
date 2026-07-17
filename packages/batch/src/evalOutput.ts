import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalSuiteSummary } from '#src/evalTypes.js';

/**
 * Write one structured JSON record per case (`<id>.json`) plus one aggregate `results.json`
 * (suite totals + every case's verdict/checks/judge/reasons) into `outputDir`. Creates `outputDir`
 * (and any missing parents) if it doesn't exist. Mirrors BATCH-1's `writeBatchOutput` (`#src/
 * output.js`) — same convention, applied to eval's richer per-case shape.
 *
 * Pure I/O, deliberately separate from {@link ../evalRunner.js}'s `runEvalSuite`: the runner never
 * touches the filesystem, so unit tests can exercise grading logic without a tmp dir.
 */
export function writeEvalOutput(outputDir: string, summary: EvalSuiteSummary): void {
  mkdirSync(outputDir, { recursive: true });

  for (const result of summary.cases) {
    writeFileSync(join(outputDir, `${result.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }

  writeFileSync(join(outputDir, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
