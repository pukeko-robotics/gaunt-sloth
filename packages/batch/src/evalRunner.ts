import { runBatchMatrix } from '#src/BatchRunner.js';
import { runDeterministicChecks } from '#src/deterministicChecks.js';
import { runToolCallChecks } from '#src/toolChecks.js';
import { runToolResultChecks } from '#src/toolResultChecks.js';
import type { CellResult, MatrixCell, RunCellFn, ToolResultRecord } from '#src/types.js';
import type {
  ClassifyOutcome,
  EvalCase,
  EvalCaseResult,
  EvalExpectation,
  EvalSuite,
  EvalSuiteSummary,
  EvalTurnResult,
  JudgeFn,
  JudgeOutcome,
  RunClassifyFn,
  RunConversationFn,
  TurnRunOutcome,
} from '#src/evalTypes.js';
import { mechanismNeedsPermissiveRating } from '#src/evalTypes.js';
import type {
  ClassifiedCell,
  EvalCaseClassification,
  EvalClassificationSpec,
} from '#src/classificationTypes.js';
import { UNRECOGNIZED_LABEL } from '#src/classificationTypes.js';
import { extractClassificationValue, readRaw } from '#src/classification.js';
import { buildClassificationReport } from '#src/classificationReport.js';

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
  /**
   * BATCH-12 Task 2 — the MULTI-TURN seam for the no-identities path: run a whole scripted
   * conversation (a case whose `turns.length > 1`) and return one {@link TurnRunOutcome} per turn.
   * Required only when the suite has multi-turn cases and no identities. Single-turn cases keep
   * using {@link runCell} (the proven `runSingleShot` path, byte-for-byte).
   */
  runConversation?: RunConversationFn;
  /**
   * BATCH-12 Task 2 — the MULTI-TURN seam per identity (matrix path): one {@link RunConversationFn}
   * per identity, each built once by the command from that identity's config, reused across cases.
   * The whole conversation runs once per identity, so per-identity "memory"/authorization is real.
   */
  runConversationByIdentity?: Map<string, RunConversationFn>;
  /** The injectable judge function. Only consulted for expectation blocks that declare a
   * `judgeRubric`; omitted entirely = every judge-rubric block fails with a "no judge configured"
   * reason (the runner degrades safely rather than throwing). The judge is orthogonal to identity:
   * it grades each cell's answer regardless of which identity produced it. */
  judge?: JudgeFn;
  /** Max in-flight cells — reuses BATCH-1's `runBatchMatrix` pool (`DEFAULT_CELL_CONCURRENCY`,
   * i.e. serial, when omitted); no second concurrency mechanism is introduced for eval. */
  concurrency?: number;
  /**
   * BATCH-25 Half B SEAM — an injected CLASSIFICATION target. When provided (and the suite declares
   * a `classification:` block), every case is dispatched through it INSTEAD of the agent runners:
   * the target returns the label/action per round directly, plus the model-call count that makes
   * `model_free` enforceable.
   *
   * Half B's `rater` target supplies it (`buildRaterClassifier`, #src/raterTarget.js) by driving
   * the approvals rating prompt + decision mapping at a declared rung. REQUIRED for a `rater`
   * suite — the guard at the top of {@link runEvalSuite} rejects the run without it rather than
   * letting the cases fall through to the agent.
   *
   * When absent, a classifier suite reads its label/action out of the ordinary agent answer via the
   * suite's declared extractors, which is what makes the facility usable on its own today.
   */
  classify?: RunClassifyFn;
}

/**
 * One (case × identity) unit of work — the normalized execution atom BOTH flat and matrix suites
 * reduce to. `identity` is `undefined` for a no-identities suite (a single run under the invoked
 * profile), so both modes share ONE downstream execution + grading loop. `cellId` is the
 * filename-safe DISPLAY/OUTPUT id (`<caseId>` flat, `<caseId>__<identity>` matrix) — it is NOT the
 * dispatch/grading key (that is the unique `inputIndex`; see {@link runEvalSuite}), because both
 * case ids and identity names permit `__`, so two distinct units can collapse to the same `cellId`.
 * `applicablePerTurn[i]` is the subset of turn `i`'s expectation blocks that grade THIS identity
 * (BATCH-12 Task 2 — one entry per conversational turn; length 1 for a single-turn case).
 */
interface EvalUnit {
  cellId: string;
  evalCase: EvalCase;
  identity?: string;
  applicablePerTurn: EvalExpectation[][];
}

/**
 * BATCH-25 — a case's tags, read defensively.
 *
 * `EvalCase.tags` is REQUIRED and `parseEvalSuite` always supplies it (`[]` when the case declares
 * none), following this layer's stated convention that arrays default to `[]` so callers never need
 * an existence check. But `EvalSuite` is a public export that a caller can also construct by hand,
 * and a missing array must degrade to "no tags" rather than crash a whole run — the same `?? []`
 * discipline `cellResult.tools`/`toolResults` already get here.
 */
function caseTags(evalCase: EvalCase): string[] {
  return evalCase.tags ?? [];
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
    for (const identity of identities) {
      units.push({
        cellId: identity === undefined ? evalCase.id : `${evalCase.id}__${identity}`,
        evalCase,
        identity,
        // BATCH-12 Task 2: filter EACH turn's blocks for this identity (length 1 = single-turn).
        applicablePerTurn: evalCase.turns.map((turn) =>
          turn.expectations.filter((e) => expectationAppliesTo(e, identity))
        ),
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
 * ONE concurrency pool: flat and matrix suites both normalize to {@link EvalUnit}s and ride the same
 * `runBatchMatrix` pool; the only divergence is which `RunCellFn` a unit's identity resolves to.
 *
 * BATCH-12 Task 2 — a unit whose case has `turns.length > 1` is a MULTI-TURN conversation: it runs
 * through the injected {@link RunConversationFn} seam (agent/tools built once, messages accumulated
 * across turns) instead of {@link RunCellFn}, still inside the SAME pool, and is graded turn-by-turn
 * by {@link gradeConversationUnit} — the cell PASSES iff EVERY turn's applicable blocks pass. A
 * single-turn unit keeps the proven `runCell` + {@link gradeUnit} path byte-for-byte.
 */
export async function runEvalSuite(
  suite: EvalSuite,
  options: RunEvalSuiteOptions
): Promise<EvalSuiteSummary> {
  // BATCH-25 Half B — a classification target that never arrived must be LOUD. `options.classify`
  // is optional (a classifier suite can read its label out of an agent answer), so a `rater` suite
  // whose command forgot to build the classifier would otherwise fall through to `runCell` and send
  // every shell command to the chat model as a prompt — a full run, billed, graded against prose,
  // and reported as if it had measured the rater. Fail before anything runs instead.
  if (suite.target.type === 'rater' && !options.classify) {
    throw new Error(
      'runEvalSuite: a "rater" target needs an injected `classify` function — build it with ' +
        '`buildRaterClassifier(suite.target, config)` (#src/raterTarget.js) and pass it as ' +
        '`options.classify`. Without it every case would be run through the ordinary agent.'
    );
  }

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

  // BATCH-12 Task 2 — the MULTI-TURN counterpart to `runCellFor`: resolve the conversational seam
  // for a unit's identity. Same missing-seam-is-a-wiring-bug discipline (throw → caught by
  // `runBatchMatrix` as a failed cell → the whole conversation FAILs) rather than a silent skip.
  const runConversationFor = (identity: string | undefined): RunConversationFn => {
    if (identity === undefined) {
      if (!options.runConversation) {
        throw new Error(
          'runEvalSuite: no `runConversation` provided for the multi-turn (no-identities) path.'
        );
      }
      return options.runConversation;
    }
    const identityRunConversation = options.runConversationByIdentity?.get(identity);
    if (!identityRunConversation) {
      throw new Error(`runEvalSuite: no runConversation provided for identity "${identity}".`);
    }
    return identityRunConversation;
  };

  const cells: MatrixCell[] = units.map((unit, index) => ({
    id: unit.cellId,
    modelIndex: 0,
    inputIndex: index,
    // Single-turn dispatch reads `content`; the multi-turn branch reads the unit's turns directly
    // (a MatrixCell has one `content`, so it can't carry a conversation) — turns[0].user is a
    // harmless placeholder there.
    content: unit.evalCase.turns[0].user,
  }));

  // BATCH-12 Task 2 — per-conversation per-turn outcomes, keyed by the unique `inputIndex` (a
  // side-channel so a whole conversation still rides ONE `runBatchMatrix` pool with the single-turn
  // cells — `CellRunOutcome` carries one answer, a conversation carries N). Only multi-turn cells
  // populate this; single-turn cells grade straight from their `CellResult` as before.
  const conversationOutcomes = new Map<number, TurnRunOutcome[]>();

  // The classification target is only in play for a suite that actually declares a `classification:`
  // block — an injected classifier with no label enum would have no axes to report against.
  const spec = suite.classification;
  const classifier = spec ? options.classify : undefined;

  // BATCH-25 — per-round classification outcomes from an injected classification target, keyed by
  // the same unique `inputIndex`. Populated only on the `options.classify` path.
  const classifyOutcomes = new Map<number, ClassifyOutcome[]>();

  const dispatchRunCell: RunCellFn = async (cell) => {
    const unit = unitByInputIndex.get(cell.inputIndex)!;

    // BATCH-25 — a CLASSIFICATION target decides the case itself; there is no agent turn to run.
    // Its per-round outcomes are stashed for grading and ALSO adapted into the conversation stash,
    // so a multi-round classifier case rides the existing per-turn grader unchanged.
    if (classifier) {
      const outcomes = await classifier({
        caseId: unit.evalCase.id,
        // BATCH-34 — one round per turn, carrying the §5.1 context the turn declared. The runner
        // still forms no opinion about it: what a round's rating may SEE is core's rule, applied in
        // the target (see `ClassifyRound`), and a turn that declares neither field produces exactly
        // the round this passed before it was an object.
        rounds: unit.evalCase.turns.map((turn) => ({
          command: turn.user,
          ...(turn.justification !== undefined ? { justification: turn.justification } : {}),
          ...(turn.userMessages !== undefined ? { userMessages: turn.userMessages } : {}),
        })),
        tags: caseTags(unit.evalCase),
        modelFree: unit.evalCase.modelFree,
        // Passed on as DECLARED, per round. The runner is target-agnostic and forms no opinion
        // about what a mechanism implies — `ClassifyRequest.forcedBy` says why that split matters.
        //
        // Where one round declares SEVERAL mechanisms, a mechanism needing a permissive rating is
        // preferred over one that does not, rather than simply taking the first block. Taking the
        // first made the verdict depend on BLOCK ORDER — two blocks passed in one order and failed
        // reversed, on identical assertions — because a round left undriven can never let its
        // preflight speak.
        //
        // BATCH-37 narrowed where this is load-bearing, and the marker it used to reconcile is now
        // unreachable on the common path: a round whose command the floor MATCHES is refused before
        // `forcedBy` is read at all (every rung but `bypass`), so it carries the floor's marker and
        // no other, and both orders agree whatever the preference does.
        //
        // It still decides exactly one shape, and `raterTarget.spec.ts` pins it there:
        // `hardline-floor` is the ONLY mechanism whose `mechanismNeedsPermissiveRating` is false, so
        // the preference can only ever differ from a plain "take the first" when a `hardline-floor`
        // block is declared AHEAD of a preflight on a command the floor does NOT match — a
        // mis-declaration, which is a real authoring mistake. Note what this rules out: for a round
        // whose mechanisms are all preflights both branches select the same block, so the preference
        // decides nothing there.
        forcedBy: unit.evalCase.turns.map(
          (turn) =>
            turn.expectations.find((block) => mechanismNeedsPermissiveRating(block.forcedBy))
              ?.forcedBy ??
            turn.expectations.find((block) => block.forcedBy !== undefined)?.forcedBy
        ),
      });
      classifyOutcomes.set(cell.inputIndex, outcomes);
      conversationOutcomes.set(
        cell.inputIndex,
        outcomes.map((outcome) => ({
          ok: outcome.ok,
          answer: outcome.rationale,
          error: outcome.error,
        }))
      );
      return {
        ok: outcomes.length > 0 && outcomes.every((outcome) => outcome.ok),
        answer: outcomes[0]?.rationale,
        error: outcomes[0]?.error,
      };
    }

    // Single-turn: the proven `runSingleShot`-backed path, byte-for-byte (unchanged dispatch).
    if (unit.evalCase.turns.length <= 1) {
      return runCellFor(unit.identity)(cell);
    }
    // Multi-turn: run the whole conversation ONCE (agent/tools built once), stash the per-turn
    // outcomes for grading, and report a synthetic pool outcome (`ok` iff every turn ran) so the
    // pool's own bookkeeping is coherent — grading reads the stash, not this outcome's answer.
    const outcomes = await runConversationFor(unit.identity)(
      unit.evalCase.turns.map((turn) => turn.user)
    );
    conversationOutcomes.set(cell.inputIndex, outcomes);
    return { ok: outcomes.length > 0 && outcomes.every((o) => o.ok) };
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
    const outcomes = conversationOutcomes.get(cellResult.inputIndex);
    // BATCH-25 — the per-round answers this unit produced, in turn order. A single-turn cell has one
    // (the cell's own answer); a multi-turn / classifier cell has one per round.
    const answersPerTurn =
      unit.evalCase.turns.length <= 1
        ? [cellResult.answer]
        : unit.evalCase.turns.map((_, index) => outcomes?.[index]?.answer);
    const classifications = buildActualClassifications(
      unit,
      spec,
      answersPerTurn,
      classifyOutcomes.get(cellResult.inputIndex)
    );

    if (unit.evalCase.turns.length <= 1) {
      results.push(await gradeUnit(unit, cellResult, options.judge, classifications?.[0]));
    } else {
      results.push(
        await gradeConversationUnit(unit, outcomes, cellResult, options.judge, classifications)
      );
    }
  }

  const passed = results.filter((result) => result.verdict === 'PASS').length;
  const summary: EvalSuiteSummary = {
    total: results.length,
    passed,
    failed: results.length - passed,
    cases: results,
  };

  // BATCH-25 — the classifier report (matrices + declared metrics) is attached ONLY for a suite that
  // declares `classification:`, so a #405-era `results.json` is byte-for-byte unchanged.
  if (spec) {
    summary.classification = buildClassificationReport(
      spec,
      // Same defensive read as `caseTags`: required on the parsed shape, tolerated absent on a
      // hand-constructed one.
      suite.metrics ?? [],
      toClassifiedCells(results)
    );
  }
  return summary;
}

/**
 * BATCH-25 — reduce the graded results to the shape the matrices and metrics read.
 *
 * `scored` is the load-bearing field: a cell whose SUT never ran has NO place in any matrix cell or
 * any metric denominator, and is instead counted as `excluded` and said out loud. Silently treating
 * it as a wrong answer would inflate the error rate; silently dropping it would inflate coverage.
 * Both are how a classifier report comes to claim more than it measured.
 */
export function toClassifiedCells(results: EvalCaseResult[]): ClassifiedCell[] {
  return results.map((result) => ({
    id: result.identity === undefined ? result.id : `${result.id}__${result.identity}`,
    tags: result.tags ?? [],
    expectedLabel: result.classification?.expectedLabel,
    expectedAction: result.classification?.expectedAction,
    actualLabel: result.classification?.actualLabel,
    actualAction: result.classification?.actualAction,
    scored: result.sutOk && result.classification !== undefined,
  }));
}

/**
 * BATCH-25 — build one {@link EvalCaseClassification} per round: what the corpus expected, and what
 * the SUT actually produced.
 *
 * The EXPECTED side comes from the round's APPLICABLE expectation blocks (already filtered to this
 * identity), so an identity-scoped or round-scoped expectation is read correctly. When two
 * applicable blocks declare different expected labels the first wins for reporting purposes — but
 * both are still graded independently, so a contradictory pair fails the case rather than being
 * quietly reconciled here.
 *
 * The ACTUAL side comes from the injected classification target when there is one, and otherwise
 * from the suite's declared extractors reading the round's answer. Either way a value the suite does
 * not declare becomes {@link UNRECOGNIZED_LABEL} — a visible bucket, never a dropped row.
 */
function buildActualClassifications(
  unit: EvalUnit,
  spec: EvalClassificationSpec | undefined,
  answersPerTurn: (string | undefined)[],
  classifyOutcomes: ClassifyOutcome[] | undefined
): EvalCaseClassification[] | undefined {
  if (!spec) return undefined;

  return unit.evalCase.turns.map((_turn, index) => {
    const applicable = unit.applicablePerTurn[index] ?? [];
    const expectedLabel = applicable.find((block) => block.expectLabel !== undefined)?.expectLabel;
    const expectedAction = applicable.find(
      (block) => block.expectAction !== undefined
    )?.expectAction;

    const outcome = classifyOutcomes?.[index];
    const answer = answersPerTurn[index];

    let actualLabel: string | undefined;
    let actualAction: string | undefined;
    let raw: string | undefined;

    if (outcome) {
      // A classification target reports its verdict directly — but it is still held to the suite's
      // declared enum, so a target returning an undeclared value shows up as `(unrecognized)`
      // rather than silently widening the axis.
      actualLabel = outcome.ok ? normalizeAgainstEnum(outcome.label, spec.labels) : undefined;
      actualAction =
        outcome.ok && spec.actions.length > 0
          ? normalizeAgainstEnum(outcome.action, spec.actions)
          : undefined;
      raw = outcome.rationale;
    } else if (answer !== undefined) {
      actualLabel = extractClassificationValue(answer, spec.labelFrom, spec.labels);
      if (spec.actionFrom) {
        actualAction = extractClassificationValue(answer, spec.actionFrom, spec.actions);
      }
      // Keep the text the extractor actually read when it is NOT just the whole answer, so an
      // `(unrecognized)` result is diagnosable from the per-cell JSON without re-running.
      const readValue = readRaw(answer, spec.labelFrom);
      if (readValue !== undefined && readValue !== answer) raw = readValue;
    }

    return {
      expectedLabel,
      expectedAction,
      actualLabel,
      actualAction,
      raw,
      modelCalls: outcome?.modelCalls,
    };
  });
}

/** Hold a classification target's own verdict to the suite's declared enum. An absent value stays
 * absent (the target reported nothing on this dimension); an undeclared one becomes
 * {@link UNRECOGNIZED_LABEL}. */
function normalizeAgainstEnum(value: string | undefined, declared: string[]): string | undefined {
  if (value === undefined) return undefined;
  return declared.includes(value) ? value : UNRECOGNIZED_LABEL;
}

/**
 * BATCH-25 — grade one round's classification assertions and the `model_free` contract.
 *
 * Returns failure reasons; empty means the round's classification assertions held. The label and
 * the action are graded SEPARATELY and both are reported, because they diverge by design: a
 * deterministic preflight can produce the right action from the wrong label, and a report that
 * collapsed them would hide which component drifted.
 */
function gradeClassificationBlock(
  block: EvalExpectation,
  classification: EvalCaseClassification | undefined
): string[] {
  const reasons: string[] = [];
  if (block.expectLabel !== undefined) {
    const actual = classification?.actualLabel;
    if (actual !== block.expectLabel) {
      reasons.push(`expected label "${block.expectLabel}" but got "${actual ?? '(none)'}"`);
    }
  }
  if (block.expectAction !== undefined) {
    const actual = classification?.actualAction;
    if (actual !== block.expectAction) {
      reasons.push(`expected action "${block.expectAction}" but got "${actual ?? '(none)'}"`);
    }
  }
  return reasons;
}

/** BATCH-25 — the `model_free` contract: a case declared free must cost ZERO model calls. A target
 * that quietly rings the model on such a case would otherwise be invisible, and these cases are
 * exactly the cheap, deterministic regression gate (the EXT-55 class — a hardline floor that had
 * silently stopped firing, invisible to build, lint and unit). `undefined` model calls means the
 * target did not report them, which is itself a failure of the contract. */
function gradeModelFree(
  evalCase: EvalCase,
  classification: EvalCaseClassification | undefined
): string[] {
  if (!evalCase.modelFree) return [];
  const calls = classification?.modelCalls;
  if (calls === undefined) {
    return [
      'model_free: the target reported no model-call count, so "zero model calls" could not be ' +
        'verified.',
    ];
  }
  if (calls > 0) {
    return [`model_free: expected 0 model calls but the target made ${calls}`];
  }
  return [];
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
 *
 * BATCH-25 adds ONE further way to reach `1`: a breached `gate: fail` metric threshold. That is a
 * product signal of exactly the same kind — and it is the one that a per-case pass/fail sweep cannot
 * express, because a classifier corpus can be entirely within per-case tolerance while its
 * false-approve rate is unacceptable. Per-case verdicts answer "did each case behave"; a gated
 * metric answers "is the aggregate shippable", and only the second gates a release.
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
  // BATCH-25 — every cell passed, but a declared metric breached its hard threshold. Still a
  // product signal (exit 1), never a harness one: the run worked, the aggregate is out of bounds.
  if ((summary.classification?.gateFailures.length ?? 0) > 0) {
    return 1;
  }
  // Every cell passed.
  return 0;
}

/**
 * Grade ONE answer (+ its tool trace) against a set of APPLICABLE expectation blocks — the shared
 * inner loop of both the single-turn {@link gradeUnit} and the multi-turn {@link gradeConversationUnit}.
 * Runs each block's deterministic checks, tool-trace checks, tool-RESULT checks (BATCH-21), and
 * judge (when it declares a rubric), accumulating failure `reasons` (a passing block/judge appends
 * nothing). `judgeOutcome` is the FIRST block that declared a judge, so a single-block case's
 * `judge` field is exactly that block's outcome (back-compat). For a single applicable block this
 * reproduces the pre-BATCH-12 grading byte-for-byte.
 */
async function gradeApplicableBlocks(
  answer: string,
  tools: string[],
  toolResults: ToolResultRecord[],
  applicable: EvalExpectation[],
  passThreshold: number,
  judge: JudgeFn | undefined,
  classification: EvalCaseClassification | undefined
): Promise<{
  reasons: string[];
  deterministicFailures: string[];
  judgeOutcome: JudgeOutcome | undefined;
}> {
  const deterministicFailures: string[] = [];
  const reasons: string[] = [];
  let judgeOutcome: JudgeOutcome | undefined;

  for (const block of applicable) {
    const checks = runDeterministicChecks(answer, block);
    // Tool-trace assertions read the captured tool names, not the answer, so they are graded
    // separately (see #src/toolChecks.js) and merged into `reasons` alongside the answer checks.
    const toolFailures = runToolCallChecks(tools, block);
    // BATCH-21 tool-RESULT assertions read the captured per-call results (isError + payload) — a
    // third input kind, graded by its own checker (#src/toolResultChecks.js) and merged into the
    // same `reasons` so they drive the same PASS/FAIL/exit contract.
    const toolResultFailures = runToolResultChecks(toolResults, block);
    // BATCH-25 classification assertions read the cell's CLASSIFICATION (a fourth input kind,
    // beside the answer, the tool trace and the tool results), so they are graded by their own
    // checker and merged into the same `reasons` — the same PASS/FAIL/exit contract as every other
    // assertion.
    const classificationFailures = gradeClassificationBlock(block, classification);
    deterministicFailures.push(...checks.failures);
    reasons.push(
      ...checks.failures,
      ...toolFailures,
      ...toolResultFailures,
      ...classificationFailures
    );

    if (block.judgeRubric) {
      let outcome: JudgeOutcome;
      if (!judge) {
        outcome = { attempted: false, ok: false, error: 'No judge configured for this suite.' };
        reasons.push('judge: not configured');
      } else {
        outcome = await judge(answer, block.judgeRubric);
        if (!outcome.ok || !outcome.verdict) {
          reasons.push(`judge error: ${outcome.error ?? 'unknown error'}`);
        } else if (outcome.verdict.rate < passThreshold) {
          reasons.push(
            `judge rate ${outcome.verdict.rate}/10 below threshold ${passThreshold}` +
              (outcome.verdict.reason ? `: ${outcome.verdict.reason}` : '')
          );
        }
      }
      if (judgeOutcome === undefined) judgeOutcome = outcome;
    }
  }

  return { reasons, deterministicFailures, judgeOutcome };
}

/**
 * Grade one SINGLE-TURN (case × identity) cell: run its (single turn's) APPLICABLE expectation
 * blocks' deterministic checks, tool-trace checks, and judge; the cell PASSES iff every applicable
 * block passes. For a flat case (exactly one unscoped applicable block) this produces byte-for-byte
 * the same `reasons`/`checks`/`judge`/`verdict` as the pre-BATCH-12 single-block grader.
 */
async function gradeUnit(
  unit: EvalUnit,
  cellResult: CellResult,
  judge: JudgeFn | undefined,
  classification: EvalCaseClassification | undefined
): Promise<EvalCaseResult> {
  const { evalCase, identity, applicablePerTurn } = unit;
  const applicable = applicablePerTurn[0];
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
    // BATCH-21: threaded parallel to `tools`; `undefined` for a runner that captured none, so a
    // pre-BATCH-21 cell's `<id>.json` keeps its exact keys (JSON.stringify drops undefined).
    toolResults: cellResult.toolResults,
    durationMs: cellResult.durationMs,
    // BATCH-25 — omitted entirely (not set to `undefined`) for a non-classifier suite, so a
    // pre-BATCH-25 `<id>.json` keeps its exact key set.
    ...(classification !== undefined ? { classification } : {}),
    ...(caseTags(unit.evalCase).length > 0 ? { tags: caseTags(unit.evalCase) } : {}),
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
  const toolResults = cellResult.toolResults ?? [];
  const { reasons, deterministicFailures, judgeOutcome } = await gradeApplicableBlocks(
    answer,
    tools,
    toolResults,
    applicable,
    evalCase.passThreshold,
    judge,
    classification
  );
  reasons.push(...gradeModelFree(evalCase, classification));

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

/**
 * Grade one MULTI-TURN (case × identity) cell (BATCH-12 Task 2): grade EACH turn's answer + per-turn
 * tool trace against THAT turn's applicable blocks, then roll them up. The cell PASSES iff EVERY turn
 * PASSes; its top-level `reasons` are every turn's reasons each prefixed with the failing turn
 * (`turn N: …`) so the summary/output pinpoints which turn broke, and the full per-turn breakdown is
 * in `turns`.
 *
 * `outcomes` is what the conversational runner returned (one per turn it attempted). A SHORT array
 * (the conversation aborted mid-way) or a MISSING one (`undefined` — the runner threw, so
 * `runBatchMatrix` recorded a failed cell with no stash) fails the un-run turns with a clear reason.
 * `sutOk` is TRUE iff at least one turn actually ran — so a totally-failed conversation is
 * `sutOk:false` (exit-2-eligible, like a single-shot SUT failure) while a turn-1-ran/turn-2-failed
 * cell is `sutOk:true`, a real product signal → exit 1.
 */
async function gradeConversationUnit(
  unit: EvalUnit,
  outcomes: TurnRunOutcome[] | undefined,
  cellResult: CellResult,
  judge: JudgeFn | undefined,
  classifications: EvalCaseClassification[] | undefined
): Promise<EvalCaseResult> {
  const { evalCase, identity, applicablePerTurn } = unit;
  const turnOutcomes = outcomes ?? [];

  const turnResults: EvalTurnResult[] = [];
  const cellReasons: string[] = [];
  let anyTurnRan = false;

  for (let i = 0; i < evalCase.turns.length; i++) {
    const turn = evalCase.turns[i];
    const applicable = applicablePerTurn[i];

    // NO-SILENT-PASS backstop (per turn × identity), mirroring gradeUnit's: unreachable under the
    // parse-time guard, but if bypassed THROW so it's a harness error (exit 2), never a silent pass.
    if (applicable.length === 0) {
      throw new Error(
        `no applicable expectation block for cell "${unit.cellId}" (identity ` +
          `"${identity ?? '(default)'}") turn ${i} — nothing would grade this (turn × identity), ` +
          'which is a suite-authoring error.'
      );
    }

    const outcome = turnOutcomes[i];
    const classification = classifications?.[i];
    const label = `turn ${i + 1}`;

    if (!outcome || !outcome.ok) {
      // This turn produced no answer: the conversation errored on it, or aborted before reaching it.
      let detail: string;
      if (outcome?.error) detail = `SUT run failed: ${outcome.error}`;
      else if (outcome) detail = 'SUT run failed.';
      else if (outcomes === undefined)
        detail = `SUT run failed: ${cellResult.error ?? 'the conversation could not run.'}`;
      else detail = 'SUT run failed: the conversation ended before this turn.';

      turnResults.push({
        user: turn.user,
        answer: outcome?.answer,
        tokensInput: outcome?.tokensInput,
        tokensOutput: outcome?.tokensOutput,
        tools: outcome?.tools,
        toolResults: outcome?.toolResults,
        ok: false,
        verdict: 'FAIL',
        reasons: [detail],
        ...(classification !== undefined ? { classification } : {}),
      });
      cellReasons.push(`${label}: ${detail}`);
      continue;
    }

    anyTurnRan = true;
    const answer = outcome.answer ?? '';
    const tools = outcome.tools ?? [];
    const toolResults = outcome.toolResults ?? [];
    const { reasons, deterministicFailures, judgeOutcome } = await gradeApplicableBlocks(
      answer,
      tools,
      toolResults,
      applicable,
      evalCase.passThreshold,
      judge,
      classification
    );
    reasons.push(...gradeModelFree(evalCase, classification));
    const turnVerdict: 'PASS' | 'FAIL' = reasons.length === 0 ? 'PASS' : 'FAIL';
    turnResults.push({
      user: turn.user,
      answer: outcome.answer,
      tokensInput: outcome.tokensInput,
      tokensOutput: outcome.tokensOutput,
      tools: outcome.tools,
      toolResults: outcome.toolResults,
      ok: true,
      verdict: turnVerdict,
      checks: { passed: deterministicFailures.length === 0, failures: deterministicFailures },
      judge: judgeOutcome,
      reasons,
      ...(classification !== undefined ? { classification } : {}),
    });
    for (const reason of reasons) cellReasons.push(`${label}: ${reason}`);
  }

  const verdict: 'PASS' | 'FAIL' = cellReasons.length === 0 ? 'PASS' : 'FAIL';
  return {
    id: evalCase.id,
    ...(identity !== undefined ? { identity } : {}),
    passThreshold: evalCase.passThreshold,
    // A multi-turn cell has no single answer/tools/checks/judge — read the per-turn breakdown below.
    durationMs: cellResult.durationMs,
    verdict,
    sutOk: anyTurnRan,
    reasons: cellReasons,
    turns: turnResults,
    // BATCH-25 — the cell-level classification is the LAST round's: a negotiation corpus asserts its
    // outcome on where the exchange ENDED (reject · reject · escalate), so that is the value the
    // confusion matrix and the metrics must read. Every round's own value is in `turns`.
    ...(classifications !== undefined && classifications.length > 0
      ? { classification: classifications[classifications.length - 1] }
      : {}),
    ...(caseTags(evalCase).length > 0 ? { tags: caseTags(evalCase) } : {}),
  };
}
