import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import type { EvalSuiteSummary } from '#src/evalTypes.js';
import type { EvalRunContext, NamedReporter } from '#src/reporters/reporterTypes.js';

/** Run one reporter hook, swallowing any error (thrown OR a rejected Promise, the JUnit reporter's
 * real failure mode) into a warning. A reporter must NEVER change the eval exit code or abort the
 * run (the exit code is `classifyEvalExit`'s job alone), so a failing hook is contained here and the
 * run continues. The warning names WHICH reporter's WHICH hook failed — ambiguous once multiple
 * reporters (text + junit + custom) are real. */
async function runHookQuietly(
  reporterName: string,
  hook: string,
  run: () => void | Promise<void>
): Promise<void> {
  try {
    await run();
  } catch (error) {
    displayWarning(
      `eval reporter "${reporterName}" ${hook} hook failed: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

/**
 * Drive reporters over one completed run's results, in lifecycle order:
 * onSuiteStart → onCellResult per case (summary.cases order) → onSuiteEnd. A reporter hook that
 * throws is caught and surfaced via displayWarning — a reporter must NEVER change the eval exit code
 * or abort the run (the exit code is classifyEvalExit's job alone). Never throws.
 *
 * The lifecycle is phase-grouped across reporters (every reporter's onSuiteStart, then every
 * reporter's onCellResult per case, then every reporter's onSuiteEnd) so a shared surface like the
 * console is never interleaved out of order. With the single built-in `text` reporter this
 * reproduces the former `printSummary` output byte-for-byte.
 */
export async function driveReporters(
  reporters: NamedReporter[],
  summary: EvalSuiteSummary,
  ctx: EvalRunContext
): Promise<void> {
  for (const { name, reporter } of reporters) {
    const onSuiteStart = reporter.onSuiteStart;
    if (onSuiteStart) {
      await runHookQuietly(name, 'onSuiteStart', () => onSuiteStart.call(reporter, ctx));
    }
  }

  for (const result of summary.cases) {
    for (const { name, reporter } of reporters) {
      const onCellResult = reporter.onCellResult;
      if (onCellResult) {
        await runHookQuietly(name, 'onCellResult', () => onCellResult.call(reporter, result, ctx));
      }
    }
  }

  for (const { name, reporter } of reporters) {
    const onSuiteEnd = reporter.onSuiteEnd;
    if (onSuiteEnd) {
      await runHookQuietly(name, 'onSuiteEnd', () => onSuiteEnd.call(reporter, summary, ctx));
    }
  }
}
