import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalSuiteSummary } from '#src/evalTypes.js';

/**
 * Write one structured JSON record per cell (`<id>.json`, or `<id>__<identity>.json` for a
 * BATCH-12 identity-matrix cell) plus one aggregate `results.json` (suite totals + every cell's
 * verdict/checks/judge/reasons) into `outputDir`. Creates `outputDir` (and any missing parents) if
 * it doesn't exist. Mirrors BATCH-1's `writeBatchOutput` (`#src/output.js`) — same convention,
 * applied to eval's richer per-cell shape.
 *
 * Both the case `id` and the `identity` are validated at parse time to be plain filename-safe tokens
 * (`/^[\w.-]+$/`), so joining them with a `__` separator can neither traverse nor escape `outputDir`.
 * A no-identities cell writes `<id>.json` exactly as before BATCH-12.
 *
 * Pure I/O, deliberately separate from {@link ../evalRunner.js}'s `runEvalSuite`: the runner never
 * touches the filesystem, so unit tests can exercise grading logic without a tmp dir.
 */
export function writeEvalOutput(outputDir: string, summary: EvalSuiteSummary): void {
  mkdirSync(outputDir, { recursive: true });

  for (const result of summary.cases) {
    const fileBase = result.identity !== undefined ? `${result.id}__${result.identity}` : result.id;
    writeFileSync(join(outputDir, `${fileBase}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }

  writeFileSync(join(outputDir, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
