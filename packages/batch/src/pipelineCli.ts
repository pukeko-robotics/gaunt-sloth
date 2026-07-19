/**
 * @module pipelineCli
 *
 * BATCH-9 — the standalone `gth-batch` pipeline runner. A thin entry point that runs the BATCH-1
 * matrix runtime ({@link buildMatrix} + {@link runBatchMatrix}) directly from a shell pipeline,
 * without pulling in the whole `gaunt-sloth` app. It takes a prompt-executable script + `--over`
 * data (inline JSON/YAML, or piped on stdin), runs the matrix, and streams the **same structured
 * per-cell `CellResult`** that `gth batch` writes — one JSON object per line (JSONL) on stdout.
 *
 * Relationship to `gth batch` (packages/app/src/commands/batchCommand.ts): the two share the exact
 * matrix runtime and the exact per-cell run wiring. The production per-cell adapter
 * (`buildProductionRunCell`) lives in the app; this file mirrors it — its own `createResolvers()`,
 * a lean agent factory, `runSingleShot` in `exec` mode, and `cleanupTools()` on every path — so the
 * standalone bin needs only `@gaunt-sloth/core` + `@gaunt-sloth/agent` (both already dependencies),
 * never the app. The only intentional differences: over-data is inline/stdin (not a file path, which
 * the pipeline shell already handles) and output is JSONL on stdout (not a directory of files).
 *
 * stdout discipline: the run itself is noisy (the runtime's `display()`/`ProgressIndicator`/token
 * streaming all target `process.stdout`). The bin entry ({@link file://./bin.ts}) redirects
 * `process.stdout.write` to stderr for the duration and this module writes the machine JSONL
 * straight to fd 1 (`fs.writeSync`), so stdout stays a clean data channel — the same "protocol
 * channel" discipline `packages/app/cli.js` uses for ACP.
 */

import { writeSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { initConfig as realInitConfig } from '@gaunt-sloth/core/config.js';
import type { CommandLineConfigOverrides, GthConfig } from '@gaunt-sloth/core/config.js';
import {
  buildSystemMessages,
  readExecPrompt,
  wrapContent,
} from '@gaunt-sloth/core/utils/llmUtils.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';

import { buildMatrix } from '#src/matrix.js';
import { buildBatchSummary, runBatchMatrix } from '#src/BatchRunner.js';
import type { BatchSummary, MatrixRow, RunCellFn } from '#src/types.js';

/** Parsed `gth-batch` invocation. */
export interface BatchCliArgs {
  /** Path to the `.md` prompt-executable script to run over the matrix. */
  script: string;
  /** Inline `--over` data (JSON/YAML array of row objects). `undefined` = fall back to stdin. */
  over?: string;
  /** `--models a,b,c` parsed into a trimmed, non-empty list; `undefined` when the flag is absent. */
  models?: string[];
  /** `-j/--concurrency <n>` — max in-flight cells. */
  concurrency?: number;
  /** `--retry <n>` — retries on a failed cell. */
  retry?: number;
}

/** Injectable seams — all default to the real implementations; overridden in unit tests. */
export interface BatchCliDeps {
  /** Read the script file; default reads from disk. */
  readScript?: (scriptPath: string) => string;
  /** Read all of stdin to a string; default reads `process.stdin` to EOF. */
  readStdin?: () => Promise<string>;
  /** Machine-output sink for the JSONL cell records; default writes straight to fd 1. */
  write?: (chunk: string) => void;
  /** Human/error/summary sink; default writes to stderr. */
  logError?: (chunk: string) => void;
  /** The per-cell run function; default is the real `runSingleShot`-backed adapter. Injecting a
   * fake here is how unit tests drive the runtime with no live LLM. */
  runCell?: RunCellFn;
  /** Config loader; default is the real `initConfig`. Injectable so tests skip provider resolution. */
  initConfig?: (overrides: CommandLineConfigOverrides) => Promise<GthConfig>;
}

const USAGE =
  'Usage: gth-batch <script> [--over <json|yaml>] [--models a,b,c] [-j <n>] [--retry <n>]\n' +
  '  <script>        path to the .md prompt-executable to run over the matrix\n' +
  '  --over <data>   inline JSON/YAML array of row objects (or pipe it on stdin)\n' +
  '  --models a,b,c  comma-separated model axis (omit to use the configured model)\n' +
  '  -j, --concurrency <n>  max in-flight cells\n' +
  '  --retry <n>     retry a failed cell up to n times (default 0)';

/** Parse `--models a,b,c` into a trimmed, non-empty list; `undefined` when empty/absent. */
export function parseModels(models: string): string[] | undefined {
  const list = models
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return list.length > 0 ? list : undefined;
}

function parseIntArg(raw: string, flag: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${flag} expects an integer, got "${raw}"`);
  }
  return n;
}

/**
 * Parse `gth-batch`'s argv (already sliced past `node <script>`). Pure and dependency-free so the
 * arg surface is trivially unit-testable. Supports `--flag value` and `--flag=value`; throws a
 * clear `Error` (with usage) on an unknown option, a missing value, or a missing `<script>`.
 */
export function parseArgs(argv: string[]): BatchCliArgs {
  let script: string | undefined;
  let over: string | undefined;
  let models: string[] | undefined;
  let concurrency: number | undefined;
  let retry: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Normalize `--flag=value` into a name + inline value.
    let name = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${name}\n\n${USAGE}`);
      return v;
    };

    if (name === '--over') {
      over = takeValue();
    } else if (name === '--models') {
      models = parseModels(takeValue());
    } else if (name === '-j' || name === '--concurrency') {
      concurrency = parseIntArg(takeValue(), name);
    } else if (name === '--retry') {
      retry = parseIntArg(takeValue(), name);
    } else if (name === '-h' || name === '--help') {
      throw new Error(USAGE);
    } else if (name.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
    } else if (script === undefined) {
      script = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (script === undefined) {
    throw new Error(`Missing required <script> argument.\n\n${USAGE}`);
  }
  return { script, over, models, concurrency, retry };
}

/** Coerce a parsed row object's values to strings, mirroring `parseOver.ts`'s CSV/JSONL semantics
 * (every field becomes a string that `{{field}}` interpolation binds). */
function stringifyRowValues(record: Record<string, unknown>): MatrixRow {
  const row: MatrixRow = {};
  for (const [key, value] of Object.entries(record)) {
    row[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return row;
}

/**
 * Parse inline/stdin `--over` data — a JSON or YAML **array of row objects** — into
 * {@link MatrixRow}s. (The app's `parseOverFile` picks CSV vs JSONL by file extension; a shell
 * pipeline has no filename, so this bin standardizes on one self-describing format: JSON, which is
 * also valid YAML.) Throws a descriptive `Error` on malformed input — the one thing that should
 * make the bin exit non-zero.
 */
export function parseOverData(text: string): MatrixRow[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new Error(
      `--over data is not valid JSON/YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--over data must be a JSON/YAML array of row objects');
  }
  if (parsed.length === 0) {
    throw new Error('--over data is an empty array (no rows)');
  }
  return parsed.map((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`--over row ${i} must be an object, got ${JSON.stringify(row)}`);
    }
    return stringifyRowValues(row as Record<string, unknown>);
  });
}

/**
 * Resolve the input axis: inline `--over` if present, otherwise piped stdin, otherwise `undefined`
 * (no input axis → a single cell over the script's own content, exactly like `exec`).
 */
export async function resolveRows(
  args: BatchCliArgs,
  readStdin: () => Promise<string>
): Promise<MatrixRow[] | undefined> {
  if (args.over !== undefined) {
    return parseOverData(args.over);
  }
  const piped = (await readStdin()).trim();
  if (piped.length > 0) {
    return parseOverData(piped);
  }
  return undefined;
}

/** Build the exec-mode system preamble the same way `gth batch` does (app's `getExecSystemPrompt`),
 * flattened to a string, using only `@gaunt-sloth/core` prompt builders. */
export function getExecPreamble(config: GthConfig): string {
  const [systemMessage] = buildSystemMessages(config, readExecPrompt(config));
  const content = systemMessage?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === 'string' ? item : 'text' in item ? item.text : ''))
      .join('\n');
  }
  return '';
}

/**
 * Build a per-`model` {@link GthConfig} cache — the same idiom as `createCellConfigResolver`
 * (batchCommand.ts) / `createModelConfigResolver` (runWorkflow.ts): `undefined` model → the base
 * config; a named model → one cached `initConfig({ ...overrides, model })` call (cached by Promise
 * so concurrent cells for the same not-yet-resolved model share one in-flight build).
 */
function createModelConfigResolver(
  baseConfig: GthConfig,
  overrides: CommandLineConfigOverrides,
  initConfig: (overrides: CommandLineConfigOverrides) => Promise<GthConfig>
): (model: string | undefined) => Promise<GthConfig> {
  const configForModel = new Map<string, Promise<GthConfig>>();
  return (model: string | undefined): Promise<GthConfig> => {
    if (!model) return Promise.resolve(baseConfig);
    let cached = configForModel.get(model);
    if (!cached) {
      cached = initConfig({ ...overrides, model });
      configForModel.set(model, cached);
    }
    return cached;
  };
}

/**
 * The production per-cell adapter, mirroring `buildProductionRunCell` (batchCommand.ts) exactly:
 * a fresh `createResolvers()` per cell, a lean agent factory, `runSingleShot` in `exec` mode, and
 * `cleanupTools()` on every path. Kept here (not imported from the app) so the standalone bin
 * depends only on core + agent.
 */
async function buildProductionRunCell(
  baseConfig: GthConfig,
  preamble: string,
  overrides: CommandLineConfigOverrides,
  initConfig: (overrides: CommandLineConfigOverrides) => Promise<GthConfig>
): Promise<RunCellFn> {
  const { runSingleShot } = await import('@gaunt-sloth/core/runtime/singleShot.js');
  const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
  const { resolveAgentFactory } = await import('@gaunt-sloth/agent/core/resolveAgentFactory.js');

  const resolveCellModelConfig = createModelConfigResolver(baseConfig, overrides, initConfig);

  return async (cell) => {
    const modelConfig = await resolveCellModelConfig(cell.model);
    const cellConfig: GthConfig = {
      ...modelConfig,
      canInterruptInferenceWithEsc: false,
      writeOutputToFile: false,
      // Non-interactive pipeline: don't stream tokens to the (redirected) stdout; the answer is
      // captured in the cell's JSON record instead.
      streamOutput: false,
    };
    const content = wrapContent(cell.content, 'script', 'prompt-executable script', true);

    const resolvers = createResolvers();
    try {
      const { ok, answer, tokensInput, tokensOutput, tools } = await runSingleShot(
        `BATCH-${cell.id}`,
        preamble,
        content,
        cellConfig,
        resolvers,
        'exec',
        resolveAgentFactory(cellConfig, 'lean')
      );
      return { ok, answer, tokensInput, tokensOutput, tools };
    } catch (error) {
      // runSingleShot is documented to not throw for a normal LLM/tool failure; this guards the
      // rare genuinely-unexpected exception so one bad cell never takes the whole batch down.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      try {
        await resolvers.cleanupTools?.();
      } catch (cleanupError) {
        displayWarning(
          `Failed to clean up tools for cell ${cell.id}: ` +
            `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
  };
}

/**
 * Run the matrix and stream one JSON `CellResult` per line (JSONL) to `write`. Returns the
 * aggregate {@link BatchSummary}. Each emitted line is the exact object `gth batch` writes to
 * `<id>.json` (compact rather than pretty-printed) — the "same structured per-cell output".
 */
export async function runMatrixToStream(
  scriptContent: string,
  models: string[] | undefined,
  rows: MatrixRow[] | undefined,
  options: {
    concurrency?: number;
    retry?: number;
    runCell: RunCellFn;
    write: (chunk: string) => void;
  }
): Promise<BatchSummary> {
  const cells = buildMatrix(scriptContent, models, rows);
  const results = await runBatchMatrix(cells, {
    runCell: options.runCell,
    concurrency: options.concurrency,
    retry: options.retry,
  });
  for (const result of results) {
    options.write(`${JSON.stringify(result)}\n`);
  }
  return buildBatchSummary(results);
}

async function readStdinToEnd(): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readScriptFile(scriptPath: string): string {
  try {
    return readFileSync(resolve(scriptPath), 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read script "${scriptPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** A broken-pipe error — a downstream reader (`head`, `jq 'first'`, a quit pager) closed the pipe. */
function isEpipe(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EPIPE';
}

/**
 * The standalone `gth-batch` entry. Parses argv, resolves the script + input axis, wires the
 * per-cell runtime, runs the matrix, and streams JSONL cell records via `deps.write`.
 *
 * Exit-code contract (identical to `gth batch`): resolves to `0` iff the cells *ran* — a per-cell
 * failure is recorded in that cell's JSON, never reflected in the exit code. A harness-level error
 * (bad args, unreadable script, malformed `--over`, config failure) resolves to `1`. A downstream
 * reader closing the pipe early (`EPIPE` on the stdout channel — e.g. `| head`) is normal pipeline
 * usage and also resolves to `0`: the partial output already written is correct.
 *
 * @returns the process exit code (0 or 1).
 */
export async function runBatchCli(argv: string[], deps: BatchCliDeps = {}): Promise<number> {
  // Default stdout sink: once a downstream reader closes the pipe (EPIPE), stop writing and treat
  // it as a clean stop rather than letting the broken-pipe error bubble up as a harness failure.
  let stdoutClosed = false;
  const write =
    deps.write ??
    ((chunk: string): void => {
      if (stdoutClosed) return;
      try {
        writeSync(1, chunk);
      } catch (error) {
        if (isEpipe(error)) {
          stdoutClosed = true;
          return;
        }
        throw error;
      }
    });
  const logError = deps.logError ?? ((chunk: string): void => void process.stderr.write(chunk));

  try {
    const args = parseArgs(argv);
    const readScript = deps.readScript ?? readScriptFile;
    const readStdin = deps.readStdin ?? readStdinToEnd;
    const initConfig = deps.initConfig ?? realInitConfig;

    const scriptContent = readScript(args.script);
    const rows = await resolveRows(args, readStdin);

    let runCell = deps.runCell;
    if (!runCell) {
      const overrides: CommandLineConfigOverrides = {};
      const baseConfig = await initConfig(overrides);
      const preamble = getExecPreamble(baseConfig);
      runCell = await buildProductionRunCell(baseConfig, preamble, overrides, initConfig);
    }

    const summary = await runMatrixToStream(scriptContent, args.models, rows, {
      concurrency: args.concurrency,
      retry: args.retry,
      runCell,
      write,
    });

    logError(
      `gth-batch: ${summary.passed}/${summary.total} cell(s) ok` +
        (summary.failed > 0 ? `, ${summary.failed} failed` : '') +
        '\n'
    );
    return 0;
  } catch (error) {
    // A broken pipe on the stdout data channel (a downstream reader closed early) is a clean stop,
    // not a harness error: exit 0 and stay silent. Genuine harness errors (bad args, unreadable
    // script, malformed --over, config failure) carry no EPIPE code and still exit non-zero.
    if (isEpipe(error)) {
      return 0;
    }
    logError(`gth-batch: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
