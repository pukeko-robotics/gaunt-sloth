import { runBatchMatrix } from '#src/BatchRunner.js';
import { runDeterministicChecks } from '#src/deterministicChecks.js';
import { runToolCallChecks } from '#src/toolChecks.js';
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

/** The three-way process exit code for a completed `gth eval` run. See {@link classifyEvalExit}. */
export type EvalExitCode = 0 | 1 | 2;

/**
 * BATCH-11 (#405 his #6) — classify a completed suite's {@link EvalSuiteSummary} into a distinct
 * exit code so CI can tell a product regression from a broken harness:
 *
 * - `0` — every case passed (unchanged contract).
 * - `1` — the suite **ran** but ≥1 case FAILED (assertion/judge below threshold). A *product*
 *   signal: real, gradeable results, some below the bar.
 * - `2` — **harness error**: the suite couldn't be meaningfully evaluated. This function returns
 *   `2` only for the "no gradeable results at all" shape — an empty suite, or **every** case's SUT
 *   run failed (`sutOk === false`, i.e. a transport/auth/config failure produced no answer to
 *   grade). The other harness errors that never even reach a summary (suite-file load/parse error,
 *   config error) are mapped to `2` by the caller (`evalCommand.ts`) in a try/catch.
 *
 * Classification is anchored on `sutOk`, not the verdict: `sutOk === true` means the SUT produced a
 * gradeable answer, so a case that ran but whose *judge* errored (or whose answer failed a check)
 * is a real result → exit `1`, never `2`. Exit `2` is reserved for the case where no case produced
 * a gradeable answer. A *mix* of `sutOk:false` and `sutOk:true` cases therefore yields `1` (some
 * real results exist).
 */
export function classifyEvalExit(summary: EvalSuiteSummary): EvalExitCode {
  // No gradeable results at all → harness/environment error, not a product signal.
  if (summary.total === 0 || summary.cases.every((result) => !result.sutOk)) {
    return 2;
  }
  // Ran and produced gradeable results, but at least one case failed → product regression.
  if (summary.failed > 0) {
    return 1;
  }
  // Every case passed.
  return 0;
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
  // Tool-trace assertions read the captured tool names, not the answer, so they are graded by a
  // separate function (see #src/toolChecks.js) and merged into `reasons` alongside the answer checks.
  const toolFailures = runToolCallChecks(cellResult.tools ?? [], evalCase);
  const reasons = [...checks.failures, ...toolFailures];

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

  const verdict: 'PASS' | 'FAIL' =
    checks.passed && toolFailures.length === 0 && judgePassed ? 'PASS' : 'FAIL';

  return {
    ...base,
    verdict,
    sutOk: true,
    checks,
    judge: judgeOutcome,
    reasons,
  };
}
