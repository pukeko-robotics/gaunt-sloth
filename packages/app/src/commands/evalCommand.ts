import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { getAskSystemPrompt } from '#src/commands/commandIntrospection.js';
import { buildProductionRunCell } from '#src/commands/batchCommand.js';
import { display, displaySuccess, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  fileSafeLocalDate,
  getGslothFilePath,
  readFileFromProjectDir,
} from '@gaunt-sloth/core/utils/fileUtils.js';
import type { EvalSuiteSummary, JudgeFn } from '@gaunt-sloth/batch';

interface EvalCommandOptions {
  /** `-j/--concurrency <n>` — max in-flight cases. */
  concurrency?: number;
  /** `-o/--output <dir>` — where structured per-case + summary output is written. */
  output?: string;
}

function parseIntOption(value: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected an integer, got "${value}"`);
  }
  return parsed;
}

/** Default output dir when `-o/--output` is omitted: a timestamped dir next to other gth reports —
 * same convention as `defaultBatchOutputDir` in `batchCommand.ts`, `_EVAL` suffix instead. */
export function defaultEvalOutputDir(): string {
  return getGslothFilePath(`gth_${fileSafeLocalDate()}_EVAL`);
}

/**
 * Build the production {@link JudgeFn}: grades one case's answer with `judgeEvalCase` against
 * `config.llm` — the SAME model config as the SUT. Per the BATCH-2 Task 2 brief, a separate
 * `--judge <profile>` model is out of scope for this task (identity-matrix/pluggable-target work);
 * this is a known, real simplification for this first slice.
 */
function buildProductionJudge(config: GthConfig): JudgeFn {
  return async (answer, rubric) => {
    const { judgeEvalCase } = await import('@gaunt-sloth/batch/judge.js');
    return judgeEvalCase(answer, rubric, config.llm);
  };
}

/** Print the human-readable, `review`-flavored summary: one PASS/FAIL line per case (failures
 * carry their reasons), then a suite-total line — doesn't replicate `review`'s exact `REVIEW
 * RATING` block format, just its spirit (a scannable verdict, not a wall of JSON). */
function printSummary(summary: EvalSuiteSummary, outputDir: string): void {
  for (const caseResult of summary.cases) {
    if (caseResult.verdict === 'PASS') {
      display(`PASS  ${caseResult.id}`);
    } else {
      displayWarning(
        `FAIL  ${caseResult.id} — ${caseResult.reasons.join('; ') || 'no reason recorded'}`
      );
    }
  }

  const verdictLine = `EVAL RESULT: ${summary.passed}/${summary.total} case(s) passed`;
  if (summary.failed === 0) {
    displaySuccess(`${verdictLine}. Results written to ${outputDir}`);
  } else {
    displayWarning(`${verdictLine}, ${summary.failed} failed. Results written to ${outputDir}`);
  }
}

/**
 * Adds the `eval` command to the program.
 *
 * `gth eval <suite.yaml> [-j 8] [-o out/]` — grades a suite of cases (deterministic checks and/or
 * an LLM judge) against the SUT agent, the way `review` grades a diff. See
 * docs/batch-eval-cli-surface.md and docs/batch-eval-user-requirements.md for the design; this
 * command implements the single-`prompt`, `gth-agent`-target, `config.llm`-as-judge subset — see
 * the BATCH-2 Task 2 brief's "Not in scope" list for what's deliberately deferred.
 *
 * Exit-code contract (decisive design point, mirrors `review`): `gth eval` exits **0 iff every
 * case passed** — unlike `batch`, which exits 0 regardless of per-cell quality. A suite failure
 * and a harness-level error (a malformed suite file, etc.) are not distinguished in the exit code;
 * the whole contract is "did it pass".
 *
 * @param program - The commander program
 * @param commandLineConfigOverrides - command line config overrides
 */
export function evalCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('eval')
    .description(
      'Grade a suite of cases against the SUT agent with deterministic checks and/or an LLM ' +
        'judge ("pytest for prompts"). Exits 0 iff every case passed.'
    )
    .argument('<suite>', 'Path to the eval suite YAML file')
    .option('-j, --concurrency <n>', 'Max in-flight cases', parseIntOption)
    .option(
      '-o, --output <dir>',
      'Directory to write structured per-case JSON + results.json summary to ' +
        '(default: a timestamped dir alongside other gth reports)'
    )
    .action(async (suitePath: string, options: EvalCommandOptions) => {
      const config = await initConfig(commandLineConfigOverrides);

      // Specific `.js` subpaths (not the bare package root), matching batchCommand.ts's
      // convention — vitest's workspace-import resolver recognizes these and resolves straight to
      // source, so specs exercise live `packages/batch/src` rather than a `dist/` build.
      const { parseEvalSuite } = await import('@gaunt-sloth/batch/evalSuite.js');
      const { runEvalSuite } = await import('@gaunt-sloth/batch/evalRunner.js');
      const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');

      const suiteText = readFileFromProjectDir(suitePath);
      const suite = parseEvalSuite(suiteText, suitePath);

      const preamble = getAskSystemPrompt(config);
      const runCell = await buildProductionRunCell(config, preamble, commandLineConfigOverrides, {
        command: 'ask',
        sourcePrefix: 'EVAL',
        wrapBlockPrefix: 'message',
        wrapPrefix: 'user message',
      });
      const judge = buildProductionJudge(config);

      const summary = await runEvalSuite(suite, {
        runCell,
        judge,
        concurrency: options.concurrency,
      });

      const outputDir = options.output ?? defaultEvalOutputDir();
      writeEvalOutput(outputDir, summary);

      printSummary(summary, outputDir);

      if (summary.failed > 0) {
        setExitCode(1);
      }
    });
}
