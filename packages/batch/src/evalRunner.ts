import { runBatchMatrix } from '#src/BatchRunner.js';
import { runDeterministicChecks } from '#src/deterministicChecks.js';
import { runToolCallChecks } from '#src/toolChecks.js';
import type { CellResult, MatrixCell, RunCellFn } from '#src/types.js';
import type {
  EvalCase,
  EvalCaseResult,
  EvalExpectation,
  EvalSuite,
  EvalSuiteSummary,
  JudgeFn,
  JudgeOutcome,
} from '#src/evalTypes.js';

/** Options for {@link runEvalSuite}. */
export interface RunEvalSuiteOptions {
  /**
   * The single-run path (suite declares **no** `identities`): one injectable per-case run function,
   * same seam as BATCH-1's `RunCellFn` (production wiring: `evalCommand.ts` via
   * `batchCommand.ts`'s `buildProductionRunCell`; tests inject a fake). Required when the suite has
   * no identities.
   */
  runCell?: RunCellFn;
  /**
   * The matrix path (BATCH-12; suite declares `identities`): one `RunCellFn` per identity, keyed by
   * identity name. Each is built once by the command from `initConfig({ …, identityProfile })` — the
   * same fresh-`.llm` construction `gth batch --models` uses per model — and reused across cases.
   * The runner fans every case over these identities through the SAME execution + grading path the
   * single-run mode uses.
   */
  runCellByIdentity?: Map<string, RunCellFn>;
  /** The injectable judge function. Only consulted for expectation blocks that declare a
   * `judgeRubric`; omitted entirely = every judge-rubric block fails with a "no judge configured"
   * reason (the runner degrades safely rather than throwing). The judge is orthogonal to identity:
   * it grades each cell's answer regardless of which identity produced it. */
  judge?: JudgeFn;
  /** Max in-flight cells — reuses BATCH-1's `runBatchMatrix` pool (`DEFAULT_CONCURRENCY` when
   * omitted); no second concurrency mechanism is introduced for eval. */
  concurrency?: number;
}

/**
 * One (case × identity) unit of work — the normalized execution atom BOTH flat and matrix suites
 * reduce to. `identity` is `undefined` for a no-identities suite (a single run under the invoked
 * profile), so both modes share ONE downstream execution + grading loop. `cellId` is the
 * filename-safe DISPLAY/OUTPUT id (`<caseId>` flat, `<caseId>__<identity>` matrix) — it is NOT the
 * dispatch/grading key (that is the unique `inputIndex`; see {@link runEvalSuite}), because both
 * case ids and identity names permit `__`, so two distinct units can collapse to the same `cellId`.
 * `applicable` is the subset of the (single, Task-1) turn's expectation blocks that grade THIS
 * identity.
 */
interface EvalUnit {
  cellId: string;
  evalCase: EvalCase;
  identity?: string;
  applicable: EvalExpectation[];
}

/** A block applies to an identity when it names no identities (unscoped → all) or explicitly names
 * this one. For the single-run pseudo-identity (`undefined`) only unscoped blocks apply — and the
 * parser guarantees a no-identities suite has only unscoped blocks. */
function expectationAppliesTo(expectation: EvalExpectation, identity: string | undefined): boolean {
  if (!expectation.identities || expectation.identities.length === 0) return true;
  return identity !== undefined && expectation.identities.includes(identity);
}

/**
 * Reduce the suite to its (case × identity) units. A suite with no `identities` reduces to a single
 * pseudo-identity (`undefined`) so the runner has ONE code path — the whole point of the BATCH-12
 * design: flat cases are just the one-identity, one-unscoped-block special case of the matrix.
 */
function buildUnits(suite: EvalSuite): EvalUnit[] {
  const identities: (string | undefined)[] =
    suite.identities && suite.identities.length > 0 ? suite.identities : [undefined];

  const units: EvalUnit[] = [];
  for (const evalCase of suite.cases) {
    // Task 1: exactly one turn per case (the parser rejects `turns:` / multi-turn).
    const turn = evalCase.turns[0];
    for (const identity of identities) {
      units.push({
        cellId: identity === undefined ? evalCase.id : `${evalCase.id}__${identity}`,
        evalCase,
        identity,
        applicable: turn.expectations.filter((e) => expectationAppliesTo(e, identity)),
      });
    }
  }
  return units;
}

/**
 * Run every (case × identity) cell of the suite through the SUT ({@link RunCellFn}, pooled via
 * BATCH-1's `runBatchMatrix`), then grade each answer with the applicable expectation blocks'
 * deterministic checks, tool-trace checks, and (when a block declares a rubric) the judge. A cell
 * PASSES iff EVERY applicable block passes — ported from the field user's proven harness semantics
 * (`docs/batch-eval-user-requirements.md` Appendix A), generalized to per-identity blocks.
 *
 * ONE execution path: flat and matrix suites both normalize to {@link EvalUnit}s and flow through
 * this same `runBatchMatrix` + grading loop; the only divergence is which `RunCellFn` a unit's
 * identity resolves to.
 */
export async function runEvalSuite(
  suite: EvalSuite,
  options: RunEvalSuiteOptions
): Promise<EvalSuiteSummary> {
  const units = buildUnits(suite);
  // I1 — dispatch AND grading are keyed by the guaranteed-unique `inputIndex` (a unit's position in
  // this array, threaded onto its `MatrixCell`/`CellResult`), NEVER by the composite `cellId`
  // (`<caseId>__<identity>`). Both case ids and identity names permit `__`, so distinct cells can
  // collapse to the same `cellId` (e.g. case `x` + identity `y__z` and case `x__y` + identity `z`
  // both → `x__y__z`). A `cellId`-keyed Map would silently run/grade one cell under the WRONG
  // identity and drop the other — the worst failure for an authorization matrix. `cellId` is kept
  // for display and per-cell output filenames only (`evalOutput.ts` guards the filename collision).
  const unitByInputIndex = new Map(units.map((unit, index) => [index, unit]));

  // Resolve the RunCellFn for a unit's identity: the single `runCell` for the no-identities path,
  // else the per-identity runCell the command built. A missing runCell is a wiring bug — surface it
  // as a thrown error (caught by `runBatchMatrix` as a failed cell) rather than a silent skip.
  const runCellFor = (identity: string | undefined): RunCellFn => {
    if (identity === undefined) {
      if (!options.runCell) {
        throw new Error(
          'runEvalSuite: no `runCell` provided for the single-run (no-identities) path.'
        );
      }
      return options.runCell;
    }
    const identityRunCell = options.runCellByIdentity?.get(identity);
    if (!identityRunCell) {
      throw new Error(`runEvalSuite: no runCell provided for identity "${identity}".`);
    }
    return identityRunCell;
  };

  const cells: MatrixCell[] = units.map((unit, index) => ({
    id: unit.cellId,
    modelIndex: 0,
    inputIndex: index,
    content: unit.evalCase.turns[0].user,
  }));

  const dispatchRunCell: RunCellFn = (cell) => {
    const unit = unitByInputIndex.get(cell.inputIndex)!;
    return runCellFor(unit.identity)(cell);
  };

  const cellResults = await runBatchMatrix(cells, {
    runCell: dispatchRunCell,
    concurrency: options.concurrency,
  });

  const results: EvalCaseResult[] = [];
  for (const cellResult of cellResults) {
    const unit = unitByInputIndex.get(cellResult.inputIndex);
    /* istanbul ignore next -- inputIndex is derived 1:1 from units (each cell's inputIndex is its
       unit's array position, preserved through runBatchMatrix), so every result maps to one unit */
    if (!unit) continue;
    results.push(await gradeUnit(unit, cellResult, options.judge));
  }

  const passed = results.filter((result) => result.verdict === 'PASS').length;
  return { total: results.length, passed, failed: results.length - passed, cases: results };
}

/** The three-way process exit code for a completed `gth eval` run. See {@link classifyEvalExit}. */
export type EvalExitCode = 0 | 1 | 2;

/**
 * BATCH-11 (#405 his #6) — classify a completed suite's {@link EvalSuiteSummary} into a distinct
 * exit code so CI can tell a product regression from a broken harness. BATCH-12 counts matrix
 * CELLS (one per case × identity), not cases:
 *
 * - `0` — every cell passed (unchanged contract).
 * - `1` — the suite **ran** but ≥1 cell FAILED (assertion/judge below threshold). A *product*
 *   signal: real, gradeable results, some below the bar.
 * - `2` — **harness error**: no gradeable results at all — an empty suite, or **every** cell's SUT
 *   run failed (`sutOk === false`). (The other harness errors that never reach a summary — suite
 *   load/parse error, config error, an unresolved identity precondition — are mapped to `2` by the
 *   caller (`evalCommand.ts`) in a try/catch.)
 *
 * Classification is anchored on `sutOk`, not the verdict: a cell that ran (`sutOk === true`) but
 * whose judge errored (or whose answer failed a check) is a real result → exit `1`, never `2`. A
 * *mix* of `sutOk:false` and `sutOk:true` cells therefore yields `1`.
 */
export function classifyEvalExit(summary: EvalSuiteSummary): EvalExitCode {
  // No gradeable results at all → harness/environment error, not a product signal.
  if (summary.total === 0 || summary.cases.every((result) => !result.sutOk)) {
    return 2;
  }
  // Ran and produced gradeable results, but at least one cell failed → product regression.
  if (summary.failed > 0) {
    return 1;
  }
  // Every cell passed.
  return 0;
}

/**
 * Grade one (case × identity) cell: run each APPLICABLE expectation block's deterministic checks,
 * tool-trace checks, and judge; the cell PASSES iff every applicable block passes. For a flat case
 * (exactly one unscoped applicable block) this produces byte-for-byte the same `reasons`/`checks`/
 * `judge`/`verdict` as the pre-BATCH-12 single-block grader.
 */
async function gradeUnit(
  unit: EvalUnit,
  cellResult: CellResult,
  judge: JudgeFn | undefined
): Promise<EvalCaseResult> {
  const { evalCase, identity, applicable } = unit;
  const base = {
    id: evalCase.id,
    // Omit `identity` entirely (rather than set it to `undefined`) for the no-identities path, so
    // its `<id>.json` output stays byte-for-byte identical to before BATCH-12.
    ...(identity !== undefined ? { identity } : {}),
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

  // NO-SILENT-PASS backstop (M2): a cell with zero applicable blocks is a suite-AUTHORING error, not
  // a product regression — nothing would grade this (case × identity). The parser rejects this
  // statically when the suite declares identities, so this branch is only reachable if that guard is
  // bypassed; when it is, THROW so the eval command's catch classifies it as a harness error
  // (exit 2), never a product FAIL (exit 1) or, worse, a silent trivial pass. Throwing aborts the
  // whole suite, which is acceptable precisely because this is unreachable under the parse-time guard.
  if (applicable.length === 0) {
    throw new Error(
      `no applicable expectation block for cell "${unit.cellId}" (identity ` +
        `"${identity ?? '(default)'}") — nothing would grade this (case × identity), which is a ` +
        'suite-authoring error.'
    );
  }

  const answer = cellResult.answer ?? '';
  const tools = cellResult.tools ?? [];

  const deterministicFailures: string[] = [];
  const reasons: string[] = [];
  // Representative judge outcome = the FIRST applicable block that declares a judge, so a flat
  // single-block case's `judge` field is exactly that block's outcome (back-compat). Every judge's
  // verdict/error is still reflected in `reasons`.
  let judgeOutcome: JudgeOutcome | undefined;

  for (const block of applicable) {
    const checks = runDeterministicChecks(answer, block);
    // Tool-trace assertions read the captured tool names, not the answer, so they are graded
    // separately (see #src/toolChecks.js) and merged into `reasons` alongside the answer checks.
    const toolFailures = runToolCallChecks(tools, block);
    deterministicFailures.push(...checks.failures);
    reasons.push(...checks.failures, ...toolFailures);

    if (block.judgeRubric) {
      let outcome: JudgeOutcome;
      if (!judge) {
        outcome = { attempted: false, ok: false, error: 'No judge configured for this suite.' };
        reasons.push('judge: not configured');
      } else {
        outcome = await judge(answer, block.judgeRubric);
        if (!outcome.ok || !outcome.verdict) {
          reasons.push(`judge error: ${outcome.error ?? 'unknown error'}`);
        } else if (outcome.verdict.rate < evalCase.passThreshold) {
          reasons.push(
            `judge rate ${outcome.verdict.rate}/10 below threshold ${evalCase.passThreshold}` +
              (outcome.verdict.reason ? `: ${outcome.verdict.reason}` : '')
          );
        }
      }
      if (judgeOutcome === undefined) judgeOutcome = outcome;
    }
  }

  // A cell PASSES iff nothing was recorded against it: every applicable block's deterministic
  // checks, tool-trace checks, and judge all passed (a passing judge appends no reason). For a
  // single applicable block this is exactly the pre-BATCH-12 verdict.
  const verdict: 'PASS' | 'FAIL' = reasons.length === 0 ? 'PASS' : 'FAIL';

  return {
    ...base,
    verdict,
    sutOk: true,
    checks: { passed: deterministicFailures.length === 0, failures: deterministicFailures },
    judge: judgeOutcome,
    reasons,
  };
}
