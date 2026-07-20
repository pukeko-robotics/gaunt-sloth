import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalCaseResult, EvalSuiteSummary } from '#src/evalTypes.js';

/** The per-cell output basename (no extension): `<id>` for a no-identities cell, `<id>__<identity>`
 * for an identity-matrix cell. Both `id` and `identity` are parse-time-validated filename-safe
 * tokens (`/^[\w.-]+$/`), so the `__` join can neither traverse nor escape the output dir. */
function outputFileBase(result: EvalCaseResult): string {
  return result.identity !== undefined ? `${result.id}__${result.identity}` : result.id;
}

/** A human label for a cell in diagnostics: `<id>` or `<id> [<identity>]`. */
function cellLabel(result: EvalCaseResult): string {
  return result.identity !== undefined ? `${result.id} [${result.identity}]` : result.id;
}

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
 * I1 belt-and-suspenders — because both ids and identity names permit `__`, two DISTINCT authored
 * cells can collapse to the same per-cell filename (e.g. case `x` + identity `y__z` and case `x__y`
 * + identity `z` both → `x__y__z.json`). Dispatch/grading are keyed by the unique `inputIndex` so
 * the run itself is always correct and `results.json` holds every cell, but writing per-cell files
 * by name would silently OVERWRITE one cell's record with another's. Detect that collision up front
 * and throw BEFORE creating the directory or writing anything (→ the eval command's catch → exit 2,
 * a suite-authoring signal) rather than emit a misleading, half-complete set of per-cell files.
 *
 * Pure I/O, deliberately separate from {@link ../evalRunner.js}'s `runEvalSuite`: the runner never
 * touches the filesystem, so unit tests can exercise grading logic without a tmp dir.
 */
export function writeEvalOutput(outputDir: string, summary: EvalSuiteSummary): void {
  const seenBy = new Map<string, EvalCaseResult>();
  for (const result of summary.cases) {
    const fileBase = outputFileBase(result);
    const prior = seenBy.get(fileBase);
    if (prior) {
      throw new Error(
        `eval output filename collision: cells "${cellLabel(prior)}" and "${cellLabel(result)}" ` +
          `both map to "${fileBase}.json". Case ids and identity names both allow "__", so distinct ` +
          '(case × identity) cells can collapse to one filename — rename the case id or identity so ' +
          'every cell has a unique <id>__<identity> name.'
      );
    }
    seenBy.set(fileBase, result);
  }

  mkdirSync(outputDir, { recursive: true });

  for (const result of summary.cases) {
    writeFileSync(
      join(outputDir, `${outputFileBase(result)}.json`),
      `${JSON.stringify(result, null, 2)}\n`
    );
  }

  writeFileSync(join(outputDir, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
