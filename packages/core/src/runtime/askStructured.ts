/**
 * @module runtime/askStructured
 *
 * A reusable, non-agentic "ask the LLM and get a schema-validated object back" primitive — the
 * structured-output half the (later) `gth workflow` host calls. Deliberately mirrors the
 * *mechanism* of the LLM-as-judge calls ({@link judgeEvalCase} in `@gaunt-sloth/batch`'s
 * `judge.ts`, and its in-core ancestor {@link judgeShellCommand} in `core/shell/judge.ts`):
 * `model.withStructuredOutput(schema)` for a single structured call, `.invoke([SystemMessage,
 * HumanMessage])` raced against a wall-clock timeout via `Promise.race`, a defensive `safeParse`
 * re-validation, `clearTimeout` in `finally`, and — crucially — it **never throws**, returning a
 * failure object instead.
 *
 * Differences from the judges: this one is **generic** over the Zod schema and takes the
 * system/user strings from the caller (the judges hard-code a schema and build a rubric/safety
 * prompt), and it reads the model from `config.llm` (like `runSingleShot`/`judgeShellCommand`),
 * so the workflow host can hand it the resolved {@link GthConfig} directly. `judgeEvalCase` could
 * later be refactored to delegate to this primitive — out of scope here.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import * as z from 'zod';

import type { GthConfig } from '#src/config.js';

/**
 * Default wall-clock budget (ms) for the structured LLM call — same value as the judges'
 * `EVAL_JUDGE_DEFAULT_TIMEOUT_MS` / `JUDGE_DEFAULT_TIMEOUT_MS`, kept as this module's own constant
 * since the primitive is conceptually independent of them.
 */
export const ASK_STRUCTURED_DEFAULT_TIMEOUT_MS = 30_000;

/** Inputs to {@link askStructured}. The caller supplies the model (via config), the two message
 * texts, and an optional timeout — the Zod schema is a separate positional argument so `<T>` can
 * be inferred from it. */
export interface AskStructuredOptions {
  config: GthConfig;
  /** System-message text (instructions). May be empty. */
  system: string;
  /** Human-message text (the actual content/question). */
  user: string;
  /** Wall-clock budget in ms. Default {@link ASK_STRUCTURED_DEFAULT_TIMEOUT_MS} (30_000). */
  timeoutMs?: number;
}

/** Discriminated result of {@link askStructured}: the parsed value on success, an error string on
 * any failure (unusable model, timeout, unparseable output, or a thrown error). Never throws. */
export type AskStructuredResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Ask the configured model for a single schema-validated object — a non-agentic structured-output
 * call that mirrors the judges' mechanism (see the module doc) and never throws.
 *
 * - No usable model (`config.llm` missing or lacking `withStructuredOutput`) →
 *   `{ ok: false, error: 'No usable model configured.' }`.
 * - Timeout → `{ ok: false, error: 'Structured call timed out after <ms>ms.' }`.
 * - Output that fails `schema.safeParse` → `{ ok: false, error: 'Model returned unparseable output.' }`.
 * - Any thrown error → `{ ok: false, error: <message> }`.
 * - Success → `{ ok: true, value }` with the parsed data.
 *
 * @param schema The Zod schema the model output must satisfy; `<T>` is inferred from it.
 * @param opts The model (via `config.llm`), the system/user message texts, and an optional timeout.
 */
export async function askStructured<T>(
  schema: z.ZodType<T>,
  opts: AskStructuredOptions
): Promise<AskStructuredResult<T>> {
  const { config, system, user } = opts;
  const timeoutMs = opts.timeoutMs ?? ASK_STRUCTURED_DEFAULT_TIMEOUT_MS;

  const model = config.llm;
  if (!model || typeof model.withStructuredOutput !== 'function') {
    return { ok: false, error: 'No usable model configured.' };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // `withStructuredOutput`'s output type is constrained to a record shape, but the schema here is
    // an unconstrained `z.ZodType<T>`; the cast is sound because we re-validate the result with
    // `schema.safeParse` below (a fake or misbehaving model could return a non-conforming object).
    const structured = model.withStructuredOutput(schema as z.ZodType<Record<string, unknown>>);
    const invokePromise = structured.invoke([new SystemMessage(system), new HumanMessage(user)]);

    const TIMEOUT = Symbol('ask-structured-timeout');
    const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });

    const raced = await Promise.race([invokePromise, timeoutPromise]);
    if (raced === TIMEOUT) {
      return { ok: false, error: `Structured call timed out after ${timeoutMs}ms.` };
    }

    const parsed = schema.safeParse(raced);
    if (!parsed.success) {
      return { ok: false, error: 'Model returned unparseable output.' };
    }
    return { ok: true, value: parsed.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
