import { display, displaySuccess, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { frameUntrustedText, frameWidthFor } from '@gaunt-sloth/core/core/shell/framing.js';
import { stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import type { EvalCaseResult, EvalSuiteSummary } from '#src/evalTypes.js';
import type { EvalReporter, EvalRunContext } from '#src/reporters/reporterTypes.js';
import { renderClassificationReport } from '#src/classificationRender.js';
import { renderToolCoverage } from '#src/toolCoverageRender.js';

/** BATCH-60 — `(2/3 runs passed, 67%, needs 67%)`, the numbers the verdict was decided on. */
function describeRepeat(result: EvalCaseResult): string {
  const repeat = result.repeat!;
  return (
    `(${repeat.passed}/${repeat.runs} runs passed, ${repeat.ratePercent}%, ` +
    `needs ${repeat.requiredPercent}%)`
  );
}

/** BATCH-60 — each run's outcome in one row: `PASS`, `FAIL`, or `ERROR` for a run that did not
 * finish. Each run's reasons are in the case's own reasons and in `results.json`. */
function describeRuns(result: EvalCaseResult): string {
  const runs = (result.runs ?? []).map(
    (run) => `${run.run}: ${run.sutOk ? run.verdict : 'ERROR'}${describeOutcome(run)}`
  );
  return `      runs ${runs.join(' · ')}`;
}

/** BATCH-62 — ` (ended on error_max_turns)` for a run graded under `grade_when` that did not end in
 * `success`, so a capped run is never read as a finished one; nothing for a finished run. */
function describeOutcome(result: EvalCaseResult): string {
  return result.outcome !== undefined ? ` (ended on ${result.outcome})` : '';
}

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
      // BATCH-60 — a repeated case names its rate on the verdict row and lists each run's outcome
      // on the row after. A case that ran once prints exactly as it always has.
      // BATCH-62 — a run graded under `grade_when` names how it ended on the same row.
      const baseLabel = result.identity ? `${result.id} [${result.identity}]` : result.id;
      const label = result.repeat
        ? `${baseLabel} ${describeRepeat(result)}`
        : `${baseLabel}${describeOutcome(result)}`;
      if (result.verdict === 'PASS') {
        display(`PASS  ${label}`);
        if (result.repeat) display(describeRuns(result));
        return;
      }
      const reasons = result.reasons.join('; ');
      if (!reasons) {
        displayWarning(`FAIL  ${label} — no reason recorded`);
        if (result.repeat) displayWarning(describeRuns(result));
        return;
      }
      // [[TUI-C71]] — **a reason is untrusted text, and this reporter writes to a terminal.**
      // `runConversation` swallows a run-ending approvals stop and hands its MESSAGE on as a
      // string (`ConversationTurnResult.error` → `evalRunner`'s `SUT run failed: …` detail), so a
      // stop reaches this line without this file ever seeing an `ApprovalStopError` — which is why
      // enumerating the error's consumers did not find it. The message is already neutralised at
      // construction, so nothing here can move a cursor; what framing closes is the residual that
      // buys: one long line the TERMINAL wraps, whose continuation starts at column 0 carrying
      // whatever the model put at that offset.
      //
      // Every reason is framed, not just a stop's: the rest of what lands here is SUT output and
      // judge prose, model-authored the same way, and a renderer that decided per string which of
      // them to trust would be a parser in a decision path.
      //
      // The verdict keeps its own row so the summary stays scannable, and the reasons follow it
      // inside the gutter rather than sharing the row that names the case.
      displayWarning(`FAIL  ${label}`);
      for (const row of frameUntrustedText(reasons, { width: frameWidthFor(stdout.columns) })
        .lines) {
        displayWarning(row);
      }
      if (result.repeat) displayWarning(describeRuns(result));
    },

    onSuiteEnd(summary: EvalSuiteSummary, ctx: EvalRunContext): void {
      // BATCH-25 — the classifier block prints ONLY for a suite that declares `classification:`.
      // Every #405-era suite has no such block, so its console output is byte-for-byte what it was.
      // It goes BEFORE the verdict line so the verdict stays the last thing on screen.
      if (summary.classification) {
        // Attribute the block to its sweep cell — without this, N cells print N unlabelled blocks.
        if (ctx.sweepCell) display(`CELL: ${ctx.sweepCell}`);
        for (const line of renderClassificationReport(summary.classification, {
          compact: ctx.sweepCell !== undefined,
        })) {
          // Warnings and gate failures carry `!` / `GATE FAILED` and are the lines a reader must
          // not skim past, so they get the warning channel; the matrices and tallies are data.
          if (line.trimStart().startsWith('!') || line.startsWith('METRIC GATE FAILED')) {
            displayWarning(line);
          } else {
            display(line);
          }
        }
      }

      // BATCH-32 — the coverage block, for any run that observed an advertised-tool inventory.
      // Before the verdict line for the same reason the classifier block is: the verdict stays the
      // last thing on screen.
      if (summary.toolCoverage) {
        for (const line of renderToolCoverage(summary.toolCoverage)) {
          // A warning or a breached gate is the line a reader must not skim past; the fraction and
          // its detail rows are data. Same split the classifier block uses.
          if (line.trimStart().startsWith('!') || line.startsWith('TOOL COVERAGE GATE FAILED')) {
            displayWarning(line);
          } else {
            display(line);
          }
        }
      }

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
