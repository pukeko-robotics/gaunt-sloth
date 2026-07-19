/**
 * @module workflow/runWorkflow
 *
 * BATCH-3 — the `gth workflow` host. Runs a local JS orchestration script (`.mjs`/`.js`) that drives
 * one or more LLM calls through a small, generic {@link WorkflowContext}. This is the
 * script-orchestrated sibling of `gth batch` (matrix over a single prompt): a workflow is arbitrary
 * local code that decides *how* to fan calls out.
 *
 * The host provides two agent shapes, both reusing the proven production wiring:
 * - a **structured** call via {@link askStructured} (`@gaunt-sloth/core`) — a bare, non-agentic
 *   `withStructuredOutput` model call that returns a schema-validated object;
 * - a **text** call that mirrors `buildProductionRunCell` (packages/app/src/commands/batchCommand.ts)
 *   exactly — its own `createResolvers()`, a lean agent factory, `runSingleShot`, and
 *   `cleanupTools()` on every path.
 *
 * Packaging note: the text path pulls in `@gaunt-sloth/agent` (`createResolvers`,
 * `resolveAgentFactory`), so this package now declares `@gaunt-sloth/agent` as a dependency. That is
 * a deliberate widening of the batch package (whose matrix runtime was kept LLM/runner-agnostic) to
 * host the workflow runtime the BATCH-3 brief scopes here; `batch → agent → core` stays a clean DAG
 * (agent does not depend on batch).
 */

import * as z from 'zod';
import { resolve } from 'node:path';

import { initConfig } from '@gaunt-sloth/core/config.js';
import type { CommandLineConfigOverrides, GthConfig } from '@gaunt-sloth/core/config.js';
import type { GthCommand } from '@gaunt-sloth/core/core/types.js';
import { askStructured } from '@gaunt-sloth/core/runtime/askStructured.js';
import { importExternalFile } from '@gaunt-sloth/core/utils/fileUtils.js';
import { displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';

import { DEFAULT_CONCURRENCY } from '#src/types.js';

/** Options for a single {@link WorkflowContext.agent} call. */
export interface WorkflowAgentOptions {
  /** Zod schema → structured output (via {@link askStructured}). Omit for a plain-text agent run.
   * Build it with {@link WorkflowContext.z} so it is the exact zod instance the model introspects. */
  schema?: z.ZodType<unknown>;
  /** System-message text. Default `''`. */
  system?: string;
  /** Model override (e.g. `'google-genai:gemini-3.1-flash-lite'`); omit to use the host's base config. */
  model?: string;
  /** Agent mode for the text path's `runSingleShot` (default `'ask'`). Ignored for the schema path. */
  command?: GthCommand;
}

/** The context object a workflow script's default export receives. */
export interface WorkflowContext {
  /**
   * Run one LLM call. With `opts.schema` → returns the schema-validated object (throws `Error(msg)`
   * on a structured failure). Without a schema → returns the answer text (throws on failure).
   */
  agent(prompt: string, opts?: WorkflowAgentOptions): Promise<unknown>;
  /**
   * Run thunks concurrently (cap = {@link DEFAULT_CONCURRENCY}), results in input order; a throwing
   * thunk yields `null` in its slot and never rejects the whole `parallel`.
   */
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  /** The value passed via `--args <json>` (parsed), or `undefined`. */
  args: unknown;
  /** Emit a progress line (via `consoleUtils`, not raw `console.log`). */
  log(message: string): void;
  /**
   * The host's own zod module. Build schemas with `ctx.z` (not a bare `import 'zod'` from the
   * script's own location) so `agent({ schema })` uses the exact zod instance
   * `withStructuredOutput` introspects — a foreign copy triggers the dual-zod `instanceof` mismatch.
   */
  z: typeof z;
}

/** Inputs to {@link runWorkflow}. */
export interface RunWorkflowOptions {
  /** The resolved base config (the configured model), respecting `-i <profile>` etc. */
  baseConfig: GthConfig;
  /** CLI overrides, threaded into per-`model` `initConfig` calls (see the model resolver). */
  commandLineConfigOverrides: CommandLineConfigOverrides;
  /** The parsed `--args` value handed to the script as `ctx.args`. */
  args: unknown;
}

/** The shape a workflow script's default export must have (internal — used to type the cast). */
type WorkflowScript = (ctx: WorkflowContext) => Promise<unknown>;

/**
 * Build a per-`model` {@link GthConfig} cache — the same idiom as `createCellConfigResolver` in
 * `batchCommand.ts`: `undefined` model → the base config; a named model → one cached
 * `initConfig({ ...overrides, model })` call (cached by `Promise` so concurrent requests for the
 * same not-yet-resolved model share one in-flight build rather than racing).
 */
function createModelConfigResolver(
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

/**
 * Run a workflow script.
 *
 * Resolves `scriptPath` to an absolute path, dynamic-imports it (`.mjs`/`.js`), requires an async
 * function as its default export, builds the {@link WorkflowContext}, and returns whatever the
 * script resolves to. Script errors propagate (the CLI surfaces them).
 *
 * @param scriptPath Path to the workflow script (`.mjs`/`.js`).
 * @param options The base config, CLI overrides, and parsed `--args` value.
 */
export async function runWorkflow(
  scriptPath: string,
  options: RunWorkflowOptions
): Promise<unknown> {
  const { baseConfig, commandLineConfigOverrides, args } = options;

  const absolutePath = resolve(scriptPath);
  const imported = await importExternalFile(absolutePath);
  const scriptDefault = imported?.default;
  if (typeof scriptDefault !== 'function') {
    throw new Error(
      `Workflow script "${scriptPath}" must export an async function as its default export.`
    );
  }

  const resolveModelConfig = createModelConfigResolver(baseConfig, commandLineConfigOverrides);

  // The per-call config: the model's config, cloned the way batch does — no interactive ESC
  // interrupt and no per-call `.md` report file (a workflow's return value is its output).
  const cellConfigForModel = async (model: string | undefined): Promise<GthConfig> => {
    const modelConfig = await resolveModelConfig(model);
    return { ...modelConfig, canInterruptInferenceWithEsc: false, writeOutputToFile: false };
  };

  const agent = async (prompt: string, opts: WorkflowAgentOptions = {}): Promise<unknown> => {
    const cellConfig = await cellConfigForModel(opts.model);

    if (opts.schema) {
      // Structured path — a bare model call (no resolvers/tools); askStructured never throws.
      const result = await askStructured(opts.schema, {
        config: cellConfig,
        system: opts.system ?? '',
        user: prompt,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result.value;
    }

    // Text path — mirrors buildProductionRunCell (batchCommand.ts): own resolvers, lean agent
    // factory, cleanup on every path.
    const { runSingleShot } = await import('@gaunt-sloth/core/runtime/singleShot.js');
    const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
    const { resolveAgentFactory } = await import('@gaunt-sloth/agent/core/resolveAgentFactory.js');

    const resolvers = createResolvers();
    try {
      const { ok, answer } = await runSingleShot(
        `WORKFLOW-${Date.now()}`,
        opts.system ?? '',
        prompt,
        cellConfig,
        resolvers,
        opts.command ?? 'ask',
        resolveAgentFactory(cellConfig, 'lean')
      );
      if (!ok) {
        throw new Error('agent run failed');
      }
      return answer;
    } finally {
      // Guard cleanup so a teardown failure never masks the real return/throw above.
      try {
        await resolvers.cleanupTools?.();
      } catch (cleanupError) {
        displayWarning(
          `Failed to clean up workflow agent tools: ` +
            `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
  };

  const parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> => {
    const results: Array<T | null> = new Array(thunks.length).fill(null);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = nextIndex++;
        if (i >= thunks.length) return;
        try {
          results[i] = await thunks[i]();
        } catch {
          // A throwing thunk yields null in its slot and never fails the other thunks.
          results[i] = null;
        }
      }
    };
    const workerCount = Math.min(DEFAULT_CONCURRENCY, thunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  };

  const ctx: WorkflowContext = {
    agent,
    parallel,
    args,
    log: (message: string): void => displayInfo(message),
    z,
  };

  return (scriptDefault as WorkflowScript)(ctx);
}
