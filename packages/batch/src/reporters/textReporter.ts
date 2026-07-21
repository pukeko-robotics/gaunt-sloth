import { display, displaySuccess, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import type { EvalCaseResult, EvalSuiteSummary } from '#src/evalTypes.js';
import type { EvalReporter, EvalRunContext } from '#src/reporters/reporterTypes.js';

/**
 * The built-in default reporter: the human-readable, `review`-flavored summary — one PASS/FAIL line
 * per cell (failures carry their reasons), then a suite-total line. Doesn't replicate `review`'s
 * exact `REVIEW RATING` block format, just its spirit (a scannable verdict, not a wall of JSON).
 *
 * A1: this is a byte-for-byte port of `evalCommand.ts`'s former `printSummary` onto the reporter
 * lifecycle — same lines, same order, same `display`/`displayWarning`/`displaySuccess` channels.
 */
export function createTextReporter(): EvalReporter {
  return {
    onSuiteStart(ctx: EvalRunContext): void {
      // BATCH-10 Task 2: when a separate judge profile is in effect, lead with a single
      // self-describing line so a captured run records which model graded it (reproducibility).
      // Emitted only for a separate judge — the default SUT-as-judge run prints exactly as before.
      if (ctx.judgeNotice) {
        display(
          `Judge: profile "${ctx.judgeNotice.profile}"` +
            (ctx.judgeNotice.model ? ` (model: ${ctx.judgeNotice.model})` : '')
        );
      }
    },

    onCellResult(result: EvalCaseResult): void {
      // BATCH-12: an identity-matrix cell tags its line with the identity it ran under, so the two
      // rows a case produces per (case × identity) are distinguishable. A no-identities cell prints
      // exactly as before (just the case id).
      const label = result.identity ? `${result.id} [${result.identity}]` : result.id;
      if (result.verdict === 'PASS') {
        display(`PASS  ${label}`);
      } else {
        displayWarning(`FAIL  ${label} — ${result.reasons.join('; ') || 'no reason recorded'}`);
      }
    },

    onSuiteEnd(summary: EvalSuiteSummary, ctx: EvalRunContext): void {
      // M1: X/Y counts CELLS in a matrix run (one per case × identity) — e.g. `2/2` for 1 case × 2
      // identities — so a bare "case(s)" would misreport the denominator. Use an identity-aware
      // noun: "case(s)" for a no-identities run (unchanged), "cell(s)" once any cell carries an
      // identity.
      const isMatrix = summary.cases.some((caseResult) => caseResult.identity !== undefined);
      const noun = isMatrix ? 'cell(s)' : 'case(s)';
      const verdictLine = `EVAL RESULT: ${summary.passed}/${summary.total} ${noun} passed`;
      if (summary.failed === 0) {
        displaySuccess(`${verdictLine}. Results written to ${ctx.outputDir}`);
      } else {
        displayWarning(
          `${verdictLine}, ${summary.failed} failed. Results written to ${ctx.outputDir}`
        );
      }
    },
  };
}
