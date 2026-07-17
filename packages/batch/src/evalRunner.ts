import { runBatchMatrix } from '#src/BatchRunner.js';
import { runDeterministicChecks } from '#src/deterministicChecks.js';
import type { CellResult, MatrixCell, RunCellFn } from '#src/types.js';
import type {
  EvalCase,
  EvalCaseResult,
  EvalSuite,
  EvalSuiteSummary,
  JudgeFn,
  JudgeOutcome,
} from '#src/evalTypes.js';

/** Options for {@link runEvalSuite}. */
export interface RunEvalSuiteOptions {
  /** The injectable per-case run function — same seam as BATCH-1's `RunCellFn`, adapted to send
   * each case's `prompt` through the SUT (production wiring: `evalCommand.ts`, reusing
   * `batchCommand.ts`'s `buildProductionRunCell`; tests inject a fake). */
  runCell: RunCellFn;
  /** The injectable judge function. Only consulted for cases that declare a `judgeRubric`;
   * omitted entirely = every judge-rubric case fails with a "no judge configured" reason (this
   * should not happen in production wiring, where `evalCommand.ts` always supplies one, but the
   * runner degrades safely rather than throwing if it's left out). */
  judge?: JudgeFn;
  /** Max in-flight cases — reuses BATCH-1's `runBatchMatrix` pool (`DEFAULT_CONCURRENCY` when
   * omitted); no second concurrency mechanism is introduced for eval. */
  concurrency?: number;
}

/**
 * Build one {@link MatrixCell} per case, `content` = the case's `prompt`. Unlike BATCH-1's
 * `buildMatrix` (a models × rows cross product), eval has exactly one cell per case — so cells are
 * built directly rather than via `buildMatrix`/`bindCellContent`, which would force an artificial
 * single-row/single-model matrix per case for no benefit (no `{{field}}` interpolation applies to
 * an eval case's literal `prompt`).
 *
 * `cell.id` is the case's own `id` (not a `cell-<m>-<r>` index) so per-case JSON output filenames
 * read naturally (`<case-id>.json` — see `#src/evalOutput.js`) and results are trivially traceable
 * back to the authored case. `parseEvalSuite` already rejects duplicate case ids, so this can't
 * collide.
 */
function buildEvalCells(cases: EvalCase[]): MatrixCell[] {
  return cases.map((evalCase, index) => ({
    id: evalCase.id,
    modelIndex: 0,
    inputIndex: index,
    content: evalCase.prompt,
  }));
}

/**
 * Run every case in the suite through the SUT ({@link RunEvalSuiteOptions.runCell}, pooled via
 * BATCH-1's `runBatchMatrix`), then grade each answer with deterministic checks and (when the case
 * declares a rubric) the judge. A case PASSES iff its deterministic checks pass AND (it has no
 * judge rubric OR the judge's rate is at/above the case's `passThreshold`) — ported from the field
 * user's proven harness semantics (`docs/batch-eval-user-requirements.md` Appendix A).
 */
export async function runEvalSuite(
  suite: EvalSuite,
  options: RunEvalSuiteOptions
): Promise<EvalSuiteSummary> {
  const cells = buildEvalCells(suite.cases);
  const cellResults = await runBatchMatrix(cells, {
    runCell: options.runCell,
    concurrency: options.concurrency,
  });

  const casesById = new Map(suite.cases.map((evalCase) => [evalCase.id, evalCase]));

  const results: EvalCaseResult[] = [];
  for (const cellResult of cellResults) {
    const evalCase = casesById.get(cellResult.id);
    /* istanbul ignore next -- cell ids are derived 1:1 from case ids by buildEvalCells above */
    if (!evalCase) continue;
    results.push(await gradeCase(evalCase, cellResult, options.judge));
  }

  const passed = results.filter((result) => result.verdict === 'PASS').length;
  return { total: results.length, passed, failed: results.length - passed, cases: results };
}

async function gradeCase(
  evalCase: EvalCase,
  cellResult: CellResult,
  judge: JudgeFn | undefined
): Promise<EvalCaseResult> {
  const base = {
    id: evalCase.id,
    passThreshold: evalCase.passThreshold,
    answer: cellResult.answer,
    tokensInput: cellResult.tokensInput,
    tokensOutput: cellResult.tokensOutput,
    tools: cellResult.tools,
    durationMs: cellResult.durationMs,
  };

  if (!cellResult.ok) {
    return {
      ...base,
      verdict: 'FAIL',
      sutOk: false,
      reasons: [cellResult.error ? `SUT run failed: ${cellResult.error}` : 'SUT run failed.'],
    };
  }

  const answer = cellResult.answer ?? '';
  const checks = runDeterministicChecks(answer, evalCase);
  const reasons = [...checks.failures];

  let judgeOutcome: JudgeOutcome | undefined;
  let judgePassed = true;
  if (evalCase.judgeRubric) {
    if (!judge) {
      judgeOutcome = { attempted: false, ok: false, error: 'No judge configured for this suite.' };
      judgePassed = false;
      reasons.push('judge: not configured');
    } else {
      judgeOutcome = await judge(answer, evalCase.judgeRubric);
      if (!judgeOutcome.ok || !judgeOutcome.verdict) {
        judgePassed = false;
        reasons.push(`judge error: ${judgeOutcome.error ?? 'unknown error'}`);
      } else if (judgeOutcome.verdict.rate < evalCase.passThreshold) {
        judgePassed = false;
        reasons.push(
          `judge rate ${judgeOutcome.verdict.rate}/10 below threshold ${evalCase.passThreshold}` +
            (judgeOutcome.verdict.reason ? `: ${judgeOutcome.verdict.reason}` : '')
        );
      }
    }
  }

  const verdict: 'PASS' | 'FAIL' = checks.passed && judgePassed ? 'PASS' : 'FAIL';

  return {
    ...base,
    verdict,
    sutOk: true,
    checks,
    judge: judgeOutcome,
    reasons,
  };
}
