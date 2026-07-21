export { buildMatrix } from '#src/matrix.js';
export { bindCellContent } from '#src/interpolate.js';
export { parseOverFile } from '#src/parseOver.js';
export { runBatchMatrix, buildBatchSummary } from '#src/BatchRunner.js';
export { writeBatchOutput } from '#src/output.js';
export type {
  BatchRunnerOptions,
  BatchSummary,
  CellResult,
  CellRunOutcome,
  MatrixCell,
  MatrixRow,
  RunCellFn,
} from '#src/types.js';
export { DEFAULT_CONCURRENCY } from '#src/types.js';

// BATCH-2 — `gth eval`'s suite parsing, deterministic checks, judge, runner, and output writer.
export { parseEvalSuite } from '#src/evalSuite.js';
export { runDeterministicChecks } from '#src/deterministicChecks.js';
export {
  judgeEvalCase,
  buildJudgeMessages,
  EvalVerdictSchema,
  EVAL_JUDGE_DEFAULT_TIMEOUT_MS,
} from '#src/judge.js';
export type { EvalJudgeVerdict } from '#src/judge.js';
export { runEvalSuite } from '#src/evalRunner.js';
export { writeEvalOutput } from '#src/evalOutput.js';
export type {
  AdkAgentTarget,
  AgUiAgentTarget,
  DeterministicCheckResult,
  EvalCase,
  EvalCaseResult,
  EvalExpectation,
  EvalSuite,
  EvalSuiteSummary,
  EvalTarget,
  GthAgentTarget,
  EvalTurn,
  EvalTurnResult,
  JudgeFn,
  JudgeOutcome,
  JudgeVerdict,
  RunConversationFn,
  TurnRunOutcome,
} from '#src/evalTypes.js';
export type { RunEvalSuiteOptions } from '#src/evalRunner.js';
export { DEFAULT_EVAL_PASS_THRESHOLD } from '#src/evalTypes.js';

// BATCH-19 — the `gth eval` reporter facility (A1 seam). These are the public plugin contract an
// out-of-core `@gaunt-sloth/eval-reporter-*` package implements, exported from the package root so a
// reporter package can type its factory against ONE import.
export { resolveReporters, availableReporterNames } from '#src/reporters/registry.js';
export { driveReporters } from '#src/reporters/drive.js';
export { createTextReporter } from '#src/reporters/textReporter.js';
export type {
  EvalReporter,
  EvalReporterFactory,
  EvalRunContext,
  NamedReporter,
} from '#src/reporters/reporterTypes.js';

// BATCH-3 — the `gth workflow` host: runs a local JS orchestration script that drives one or more
// LLM calls through a small WorkflowContext.
export { runWorkflow } from '#src/workflow/runWorkflow.js';
export type {
  WorkflowAgentOptions,
  WorkflowContext,
  RunWorkflowOptions,
} from '#src/workflow/runWorkflow.js';
