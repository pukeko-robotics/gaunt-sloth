import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { GthCommand } from '@gaunt-sloth/core/core/types.js';
import { getExecSystemPrompt } from '#src/commands/commandIntrospection.js';
import { parseIntOption } from '#src/commands/cliOptionParsers.js';
import { displaySuccess, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';
import {
  fileSafeLocalDate,
  getGslothFilePath,
  readFileFromProjectDir,
  readMultipleFilesFromProjectDir,
} from '@gaunt-sloth/core/utils/fileUtils.js';
import type { RunCellFn, RunConversationFn } from '@gaunt-sloth/batch';

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
 * Build a per-model {@link GthConfig} cache: one genuinely fresh `initConfig()` call (fresh `.llm`
 * instance included) per DISTINCT `--models` value, not one per cell — a 20-cell matrix over 3
 * models must only construct 3 model instances.
 *
 * BATCH-1 fix (CI review finding, critical): the previous approach gave a cell its own model by
 * structurally cloning the shared `GthConfig.llm` instance (`Object.create` +
 * `getOwnPropertyDescriptors`) and setting `.model` on the clone. That never runs the original
 * class's constructor, so it never gets that instance's private (`#field`) slots — any LangChain
 * chat-model class whose methods touch a `#privateField` internally (not just the public `model`
 * field the old code checked for) would throw `TypeError: Cannot read private member from an
 * object whose class did not declare it` the moment such a method ran on the clone. That risk is
 * not provider-specific and cannot be ruled out by inspecting today's installed provider
 * versions. This replaces cloning with construction: each distinct model gets a real
 * `initConfig({ ...overrides, model })` call, which threads the override through
 * `tryJsonConfig` (`packages/core/src/config/loader.ts`) so the provider's own
 * `processJsonConfig()` builds the instance from scratch — the same supported path every other
 * model comes from, correct for any provider.
 *
 * Cached by `Promise<GthConfig>` (not just by resolved value) so concurrent cells requesting the
 * same not-yet-resolved model share one in-flight `initConfig()` call instead of racing to build
 * the model twice.
 */
function createCellConfigResolver(
  baseConfig: GthConfig,
  commandLineConfigOverrides: CommandLineConfigOverrides
): (model: string | undefined) => Promise<GthConfig> {
  const configForModel = new Map<string, Promise<GthConfig>>();

  return (model: string | undefined): Promise<GthConfig> => {
    if (!model) {
      return Promise.resolve(baseConfig);
    }
    let cached = configForModel.get(model);
    if (!cached) {
      cached = initConfig({ ...commandLineConfigOverrides, model });
      configForModel.set(model, cached);
    }
    return cached;
  };
}

/** Options for {@link buildProductionRunCell} — the bits that differ between `batch` (exec-mode,
 * script content) and `eval` (ask-mode, a case's user-message prompt); everything else about the
 * adapter (model-resolver cache, resolver cleanup, error handling) is shared. */
export interface ProductionRunCellOptions {
  /** The `GthCommand` mode forwarded to `runSingleShot` — selects the agent's mode prompt/behavior
   * (`'exec'` for `batch`, `'ask'` for `eval`). */
  command: GthCommand;
  /** Prefix for `runSingleShot`'s `source` naming (`<prefix>-<cell.id>`), used for output/session
   * file naming — `'BATCH'` for `batch`, `'EVAL'` for `eval`. */
  sourcePrefix: string;
  /** `wrapContent` block-prefix label for the cell's content — `'script'` for `batch`'s
   * prompt-executable scripts, `'message'` for `eval`'s case prompts. */
  wrapBlockPrefix: string;
  /** `wrapContent` human-readable prefix paired with {@link wrapBlockPrefix} (e.g.
   * `'prompt-executable script'` / `'user message'`). */
  wrapPrefix: string;
}

/**
 * Build the injectable {@link RunCellFn} that adapts the shared single-shot runtime
 * (`runSingleShot`) to one matrix cell. Isolated in its own function so each cell run gets a fresh
 * `createResolvers()` (its own MCP client instance) — matching batch's "N isolated model calls"
 * contract (docs/batch-mechanism-vs-judgment.md) rather than sharing one resolver/client across
 * concurrent cells.
 *
 * Shared between `gth batch` and `gth eval` (BATCH-2): both run N isolated single-shot calls
 * through this exact `runSingleShot` wiring (model-resolver cache, resolver cleanup-on-every-path,
 * error containment), differing only in which agent mode/prompt they run cells through and how the
 * cell's content is framed — see {@link ProductionRunCellOptions}. `gth eval`'s wiring lives in
 * `evalCommand.ts`, which imports this function rather than re-deriving it.
 *
 * batch/eval each write their own structured JSON per cell/case (`writeBatchOutput`/
 * `writeEvalOutput`), so `writeOutputToFile` is forced off for every cell run — the per-cell `.md`
 * report `runSingleShot` would otherwise write is not wanted here.
 */
export async function buildProductionRunCell(
  baseConfig: GthConfig,
  preamble: string,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  options: ProductionRunCellOptions
): Promise<RunCellFn> {
  const { runSingleShot } = await import('@gaunt-sloth/core/runtime/singleShot.js');
  const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
  const { resolveAgentFactory } = await import('@gaunt-sloth/agent/core/resolveAgentFactory.js');

  const resolveCellModelConfig = createCellConfigResolver(baseConfig, commandLineConfigOverrides);

  return async (cell) => {
    const modelConfig = await resolveCellModelConfig(cell.model);
    const cellConfig: GthConfig = {
      ...modelConfig,
      canInterruptInferenceWithEsc: false,
      writeOutputToFile: false,
    };
    const content = wrapContent(cell.content, options.wrapBlockPrefix, options.wrapPrefix, true);

    // BATCH-1 fix (CI review finding, critical): keep the resolvers reference and clean it up
    // unconditionally (success or failure) — the previous code passed `createResolvers()` inline
    // into `runSingleShot(...)` and discarded the reference, so `cleanupTools()` (which tears
    // down any MCP-server-backed tools/processes the cell's resolution opened) was never called —
    // an orphaned-process leak, one per cell.
    const resolvers = createResolvers();
    try {
      const { ok, answer, tokensInput, tokensOutput, tools, toolResults } = await runSingleShot(
        `${options.sourcePrefix}-${cell.id}`,
        preamble,
        content,
        cellConfig,
        resolvers,
        options.command,
        // batch/eval default to the lean backend, same as exec/ask; an explicit
        // config.agent.backend wins.
        resolveAgentFactory(cellConfig, 'lean')
      );
      return { ok, answer, tokensInput, tokensOutput, tools, toolResults };
    } catch (error) {
      // runSingleShot itself is documented to never throw for a normal LLM/tool failure (it
      // returns false instead); this guards the rare case of a genuinely unexpected exception so
      // one bad cell can never take the whole batch run down.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      try {
        await resolvers.cleanupTools?.();
      } catch (cleanupError) {
        // A cleanup failure must never mask or override the cell's real result (already returned
        // above) — surface it as a warning only.
        displayWarning(
          `Failed to clean up tools for cell ${cell.id}: ` +
            `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
  };
}

/**
 * BATCH-12 Task 2 — build the injectable {@link RunConversationFn} that adapts core's MULTI-TURN
 * `runConversation` to `gth eval`'s conversation seam. The multi-turn analogue of
 * {@link buildProductionRunCell}: same fresh-`createResolvers()` per conversation + cleanup-on-
 * every-path discipline, but it runs a whole scripted conversation (agent/tools built ONCE, messages
 * accumulated across turns) and returns one outcome per turn.
 *
 * No model axis (`gth eval` has no `--models`), so this takes the already-resolved SUT/identity
 * `config` directly — mirroring how `evalCommand.ts` builds one config per identity and passes it in
 * (it does NOT call `initConfig` here, so the command's `initConfig`-once-per-identity contract
 * holds). `writeOutputToFile` is forced off (eval writes its own per-cell JSON via `writeEvalOutput`).
 *
 * A rare throw from `runConversation` (e.g. agent init failed) is deliberately NOT swallowed here:
 * `runBatchMatrix` catches it as a failed cell and the runner surfaces the error on turn 1, which is
 * more informative than an empty result. The `finally` still tears the resolvers down exactly once.
 */
export async function buildProductionRunConversation(
  config: GthConfig,
  preamble: string,
  options: ProductionRunCellOptions
): Promise<RunConversationFn> {
  const { runConversation } = await import('@gaunt-sloth/core/runtime/conversation.js');
  const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
  const { resolveAgentFactory } = await import('@gaunt-sloth/agent/core/resolveAgentFactory.js');

  const cellConfig: GthConfig = {
    ...config,
    canInterruptInferenceWithEsc: false,
    writeOutputToFile: false,
  };

  return async (userMessages) => {
    // Wrap each turn's user message the same way single-turn cells wrap their content, so a turn's
    // framing matches an equivalent single-turn case exactly.
    const wrapped = userMessages.map((message) =>
      wrapContent(message, options.wrapBlockPrefix, options.wrapPrefix, true)
    );

    // Fresh resolvers (its own MCP client) per conversation, torn down once when the whole
    // conversation ends — the agent/tools persist ACROSS the turns inside `runConversation`.
    const resolvers = createResolvers();
    try {
      const turns = await runConversation(
        `${options.sourcePrefix}-conversation`,
        preamble,
        wrapped,
        cellConfig,
        resolvers,
        options.command,
        resolveAgentFactory(cellConfig, 'lean')
      );
      return turns.map(({ ok, answer, tokensInput, tokensOutput, tools, toolResults, error }) => ({
        ok,
        answer,
        tokensInput,
        tokensOutput,
        tools,
        toolResults,
        error,
      }));
    } finally {
      try {
        await resolvers.cleanupTools?.();
      } catch (cleanupError) {
        // A cleanup failure must never mask the conversation's real result — warn only.
        displayWarning(
          `Failed to clean up tools for conversation: ` +
            `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
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
      const runCell = await buildProductionRunCell(config, preamble, commandLineConfigOverrides, {
        command: 'exec',
        sourcePrefix: 'BATCH',
        wrapBlockPrefix: 'script',
        wrapPrefix: 'prompt-executable script',
      });

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
