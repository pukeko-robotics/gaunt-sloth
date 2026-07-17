import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { getExecSystemPrompt } from '#src/commands/commandIntrospection.js';
import { displaySuccess, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';
import {
  fileSafeLocalDate,
  getGslothFilePath,
  readFileFromProjectDir,
  readMultipleFilesFromProjectDir,
} from '@gaunt-sloth/core/utils/fileUtils.js';
import type { RunCellFn } from '@gaunt-sloth/batch';

interface BatchCommandOptions {
  /** `--over <path.csv|path.jsonl>` — the input axis: one matrix cell per row/record. */
  over?: string;
  /** `--models a,b,c` — the model axis: one matrix cell per model. */
  models?: string;
  /** `-j/--concurrency <n>` — max in-flight cells. */
  concurrency?: number;
  /** `--retry <n>` — retries on a failed cell. */
  retry?: number;
  /** `-o/--output <dir>` — where structured per-cell + summary output is written. */
  output?: string;
}

/**
 * Give a cell its own model, without mutating the config's shared `BaseChatModel` instance.
 *
 * `GthConfig.llm` is already an *instantiated* LangChain chat model by the time `initConfig()`
 * returns it (not a raw `{ type, model, apiKey, ... }` config record) — the resolved shape
 * `buildExecConfig`'s temperature knob also works against, via `execConfig.llm.temperature = …`.
 * That in-place mutation is safe for `exec` (one config, one run), but batch can run several
 * models concurrently, so mutating one shared instance's `.model` would race between cells.
 *
 * Instead this clones the instance with `Object.create` + `getOwnPropertyDescriptors` — same
 * prototype (so `.invoke`/`.bindTools`/etc. keep working), independent own properties (so setting
 * `.model` on the clone can't be seen by any other cell) — and sets `.model` on the clone. Every
 * built-in provider (`packages/core/src/providers/*.ts`) constructs its LangChain class with a
 * plain `model: llmConfig.model` field (not a private `#` field), which is the same assumption the
 * temperature knob already relies on; this has not been verified against a live provider call in
 * this task (see the task report's known-gaps section) — a class that keeps model-selection state
 * behind a private field or a lazily-built client would silently keep calling the original model.
 * Providers that don't expose `model` at all are left untouched rather than guessed at.
 */
function cloneLlmWithModel(llm: BaseChatModel, model: string): BaseChatModel {
  if (!('model' in llm)) {
    return llm;
  }
  const clone = Object.create(
    Object.getPrototypeOf(llm) as object,
    Object.getOwnPropertyDescriptors(llm)
  ) as BaseChatModel;
  (clone as unknown as { model: string }).model = model;
  return clone;
}

/**
 * Build the injectable {@link RunCellFn} that adapts the shared single-shot runtime
 * (`runSingleShot`) to one matrix cell. Isolated in its own function so each cell run gets a fresh
 * `createResolvers()` (its own MCP client instance) — matching batch's "N isolated model calls"
 * contract (docs/batch-mechanism-vs-judgment.md) rather than sharing one resolver/client across
 * concurrent cells.
 *
 * batch writes its own structured JSON per cell (via `writeBatchOutput`), so `writeOutputToFile` is
 * forced off for every cell run — the per-cell `.md` report `runSingleShot` would otherwise write is
 * not wanted here. `command: 'exec'` is passed through so cells get the same near-deterministic,
 * exec-mode prompt as `gth exec` — batch is "exec over a matrix" (docs/batch-eval-cli-surface.md).
 */
async function buildProductionRunCell(baseConfig: GthConfig, preamble: string): Promise<RunCellFn> {
  const { runSingleShot } = await import('@gaunt-sloth/core/runtime/singleShot.js');
  const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
  const { resolveAgentFactory } = await import('@gaunt-sloth/agent/core/resolveAgentFactory.js');

  return async (cell) => {
    const cellConfig: GthConfig = {
      ...baseConfig,
      canInterruptInferenceWithEsc: false,
      writeOutputToFile: false,
      ...(cell.model
        ? { llm: cloneLlmWithModel(baseConfig.llm, cell.model), modelDisplayName: cell.model }
        : {}),
    };
    const content = wrapContent(cell.content, 'script', 'prompt-executable script', true);

    try {
      const ok = await runSingleShot(
        `BATCH-${cell.id}`,
        preamble,
        content,
        cellConfig,
        createResolvers(),
        'exec',
        // batch defaults to the lean backend, same as exec; an explicit config.agent.backend wins.
        resolveAgentFactory(cellConfig, 'lean')
      );
      return { ok };
    } catch (error) {
      // runSingleShot itself is documented to never throw for a normal LLM/tool failure (it
      // returns false instead); this guards the rare case of a genuinely unexpected exception so
      // one bad cell can never take the whole batch run down.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** Parse `--models a,b,c` into a trimmed, non-empty list; `undefined` when the flag is absent. */
export function parseModelsOption(models: string | undefined): string[] | undefined {
  if (!models) return undefined;
  const list = models
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return list.length > 0 ? list : undefined;
}

/** Default output dir when `-o/--output` is omitted: a timestamped dir next to other gth reports. */
export function defaultBatchOutputDir(): string {
  return getGslothFilePath(`gth_${fileSafeLocalDate()}_BATCH`);
}

function parseIntOption(value: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected an integer, got "${value}"`);
  }
  return parsed;
}

/**
 * Adds the `batch` command to the program.
 *
 * `gth batch <script.md> --over <csv|jsonl> [--models a,b,c] [-j 8] [--retry 2] [-o out/]` — runs a
 * prompt-executable over a matrix (models × content-bound inputs), the way `exec` runs one. See
 * docs/batch-eval-cli-surface.md and docs/batch-mechanism-vs-judgment.md for the design.
 *
 * Exit-code contract (BATCH-1, decisive design point): `gth batch` exits 0 iff the cells *ran* —
 * it never fails because a cell's answer was poor quality (that is `gth eval`'s job, BATCH-2, not
 * this command). Only a harness-level error (a malformed `--over` file, a missing script, etc.)
 * sets a non-zero exit code; a per-cell failure is recorded in that cell's structured JSON output,
 * never reflected in the process exit code.
 *
 * @param program - The commander program
 * @param commandLineConfigOverrides - command line config overrides
 */
export function batchCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('batch')
    .description(
      'Run a markdown prompt-executable over a matrix of models and/or content-bound inputs ' +
        '("xargs for prompts"). Exits 0 iff the cells ran — a poor answer is not a harness failure.'
    )
    .argument('<script>', 'Path to the .md prompt-executable script to run over the matrix')
    .option(
      '--over <path>',
      'CSV or JSONL file whose rows/records bind into the script content via {{field}} ' +
        'placeholders — one matrix cell per row (content binding only; a glob-of-files path ' +
        'binding is not supported by this command)'
    )
    .option(
      '--models <list>',
      'Comma-separated list of models to fan out over (omit to use the configured model, no fan-out)'
    )
    .option('-j, --concurrency <n>', 'Max in-flight cells', parseIntOption)
    .option(
      '--retry <n>',
      'Retry a failed cell up to n times (default: 0, no retry)',
      parseIntOption
    )
    .option(
      '-o, --output <dir>',
      'Directory to write structured per-cell JSON + results.json summary to ' +
        '(default: a timestamped dir alongside other gth reports)'
    )
    .action(async (script: string, options: BatchCommandOptions) => {
      const config = await initConfig(commandLineConfigOverrides);

      // Specific `.js` subpaths (not the bare package root) — matches the house convention
      // (`@gaunt-sloth/core/runtime/singleShot.js`, `@gaunt-sloth/review/utils/fileUtils.js`, …)
      // that vitest's workspace-import resolver (vitest.config.ts) recognizes and resolves
      // straight to source, so specs exercise live `packages/batch/src` rather than a `dist/`
      // build that could go stale between an edit and a test run.
      const { buildMatrix } = await import('@gaunt-sloth/batch/matrix.js');
      const { parseOverFile } = await import('@gaunt-sloth/batch/parseOver.js');
      const { runBatchMatrix } = await import('@gaunt-sloth/batch/BatchRunner.js');
      const { writeBatchOutput } = await import('@gaunt-sloth/batch/output.js');

      const scriptContent = readMultipleFilesFromProjectDir([script]);
      const models = parseModelsOption(options.models);
      const rows = options.over
        ? parseOverFile(options.over, readFileFromProjectDir(options.over))
        : undefined;

      const cells = buildMatrix(scriptContent, models, rows);

      const preamble = getExecSystemPrompt(config);
      const runCell = await buildProductionRunCell(config, preamble);

      const results = await runBatchMatrix(cells, {
        runCell,
        concurrency: options.concurrency,
        retry: options.retry,
      });

      const outputDir = options.output ?? defaultBatchOutputDir();
      const summary = writeBatchOutput(outputDir, results);

      displaySuccess(
        `Batch complete: ${summary.passed}/${summary.total} cell(s) passed. ` +
          `Results written to ${outputDir}`
      );
      if (summary.failed > 0) {
        // Visible, but deliberately does NOT set a non-zero exit code — see the exit-code
        // contract above. A poor/failed cell is `eval`'s business, not batch's.
        displayWarning(
          `${summary.failed} cell(s) failed — see ${outputDir}/results.json for details.`
        );
      }
    });
}
