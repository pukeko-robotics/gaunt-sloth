import type { EvalCaseResult, EvalSuiteSummary } from '#src/evalTypes.js';

/** Immutable per-run context handed to every reporter hook. Carries what a reporter needs beyond the
 * result objects themselves. `suitePath`/`outputDir` are already known to the command; passing them
 * now (unused by the text reporter's console output except outputDir) sets up A2 (JUnit
 * <testsuite name>) and B (per-suite output dirs) without another interface change. */
export interface EvalRunContext {
  /** The suite file path as given on the CLI. */
  suitePath: string;
  /** The directory this run's structured output (results.json etc.) is written to. */
  outputDir: string;
  /** The BATCH-10-Task-2 self-describing judge line, when a separate judge profile is in effect. */
  judgeNotice?: { profile: string; model?: string };
}

/** A reporter renders an eval run. Every hook is optional — a reporter implements only what it needs
 * (the text reporter uses all three; a future file reporter may use only onSuiteEnd). Hooks are
 * driven in lifecycle order by {@link driveReporters}. A reporter MUST NOT be able to fail the run:
 * the driver catches any hook error and surfaces it as a warning (see driveReporters). */
export interface EvalReporter {
  onSuiteStart?(ctx: EvalRunContext): void | Promise<void>;
  onCellResult?(result: EvalCaseResult, ctx: EvalRunContext): void | Promise<void>;
  onSuiteEnd?(summary: EvalSuiteSummary, ctx: EvalRunContext): void | Promise<void>;
}

/** Reporters are created per run (they may accumulate state, e.g. a JUnit doc), so the registry
 * stores factories, not instances. */
export type EvalReporterFactory = () => EvalReporter;
