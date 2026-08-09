/**
 * @module runtime/askStructured
 *
 * A reusable, non-agentic "ask the LLM and get a schema-validated object back" primitive — the
 * structured-output half the (later) `gth workflow` host calls. Deliberately mirrors the
 * *mechanism* of the structured-evaluation calls ({@link judgeEvalCase} — the EVAL GRADER in
 * `@gaunt-sloth/batch`'s `judge.ts` — and its in-core sibling {@link rateShellCommand}, the
 * approvals AI rater in `core/shell/rater.ts`):
 * `model.withStructuredOutput(schema)` for a single structured call, `.invoke([SystemMessage,
 * HumanMessage])` raced against a wall-clock timeout via `Promise.race`, a defensive `safeParse`
 * re-validation, `clearTimeout` in `finally`, and — crucially — it **never throws**, returning a
 * failure object instead.
 *
 * Differences from those two: this one is **generic** over the Zod schema and takes the
 * system/user strings from the caller (they hard-code a schema and build a rubric/safety
 * prompt), and it reads the model from `config.llm` (like `runSingleShot`/`rateShellCommand`),
 * so the workflow host can hand it the resolved {@link GthConfig} directly. `judgeEvalCase` could
 * later be refactored to delegate to this primitive — out of scope here.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import * as z from 'zod';

import type { GthConfig } from '#src/config.js';
import { structuredOutputBoundary } from '#src/runtime/structuredOutput.js';

/**
 * Default wall-clock budget (ms) for the structured LLM call — same value as their
 * `EVAL_JUDGE_DEFAULT_TIMEOUT_MS` / `JUDGE_DEFAULT_TIMEOUT_MS`, kept as this module's own constant
 * since the primitive is conceptually independent of them.
 */
export const ASK_STRUCTURED_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The exact `error` text {@link askStructured} returns when its wall-clock budget fires — i.e. the
 * provider produced **no answer at all** within the budget.
 *
 * Exported as a builder rather than left as an inline literal because the three failure classes here
 * (no response · an answer that does not fit the schema · a call that failed outright) are the
 * question a reader of a red run has to answer first, and they are only distinguishable by this text.
 * A caller that re-types the sentence to recognise it stops recognising it the day the wording moves,
 * and silently re-files a stall as a rejection — which is precisely the confusion this exists to end.
 */
export function structuredCallTimedOutError(timeoutMs: number): string {
  return `Structured call timed out after ${timeoutMs}ms with no response from the provider.`;
}

/**
 * The exact `error` text {@link askStructured} returns when the provider **did** answer and the
 * answer failed the caller's own schema. The counterpart of {@link structuredCallTimedOutError};
 * see that doc for why both are exported rather than written inline.
 */
export const STRUCTURED_CALL_UNPARSEABLE_ERROR = 'Model returned unparseable output.';

/**
 * Which of {@link askStructured}'s three failure paths a result came from.
 *
 * - `timeout` — the budget fired and the provider had returned nothing at all.
 * - `unparseable` — the provider answered, and the answer failed the caller's schema.
 * - `call-failed` — the call threw before any answer arrived: a provider rejection (OpenAI's 400 on
 *   a strict `json_schema` is the canonical one), an auth failure, a transport failure.
 */
export type StructuredFailureKind = 'timeout' | 'unparseable' | 'call-failed';

/**
 * Name which failure happened, given the `error` string and the budget the call was made with.
 *
 * The single place the three classes are told apart. A stall and a rejection are the two failures a
 * reader has to distinguish first and the two that look most alike from the outside — a red that
 * cannot say which happened sends the reader to re-run a real defect, or to investigate a provider
 * hiccup. Every caller that wants to say which one it was calls this rather than matching the prose
 * itself, so the wording can only be got wrong in one place, and that place has a test.
 *
 * @param error The `error` from a `{ ok: false }` {@link AskStructuredResult}.
 * @param timeoutMs The budget passed to that same {@link askStructured} call — the timeout text
 *   carries it, so a different value here reports a genuine timeout as `call-failed`.
 */
export function classifyStructuredFailure(error: string, timeoutMs: number): StructuredFailureKind {
  if (error === structuredCallTimedOutError(timeoutMs)) return 'timeout';
  if (error === STRUCTURED_CALL_UNPARSEABLE_ERROR) return 'unparseable';
  return 'call-failed';
}

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
 * call that mirrors their mechanism (see the module doc) and never throws.
 *
 * - No usable model (`config.llm` missing or lacking `withStructuredOutput`) →
 *   `{ ok: false, error: 'No usable model configured.' }`.
 * - Timeout → `ok: false` with the error {@link structuredCallTimedOutError} builds for that budget.
 * - Output that fails `schema.safeParse` → `{ ok: false, error: {@link STRUCTURED_CALL_UNPARSEABLE_ERROR} }`.
 * - Any thrown error → `{ ok: false, error: <message> }` — a provider rejection (e.g. OpenAI's 400 on
 *   a strict `json_schema`), an auth or transport failure. Distinct from the two above BY CODE PATH,
 *   so a caller can classify a failure by comparing against those two exported texts.
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
    // EXT-88 — caller schemas are arbitrary, so this is the call site with the widest exposure to
    // the optional-field problem the boundary exists for; it also does the defensive re-validation
    // below, against the caller's own schema, so `<T>` is exactly what the caller declared.
    const boundary = structuredOutputBoundary(schema);
    const structured = model.withStructuredOutput(boundary.wireSchema);
    const invokePromise = structured.invoke([new SystemMessage(system), new HumanMessage(user)]);

    const TIMEOUT = Symbol('ask-structured-timeout');
    const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });

    const raced = await Promise.race([invokePromise, timeoutPromise]);
    if (raced === TIMEOUT) {
      return { ok: false, error: structuredCallTimedOutError(timeoutMs) };
    }

    const parsed = boundary.safeParse(raced);
    if (!parsed.success) {
      return { ok: false, error: STRUCTURED_CALL_UNPARSEABLE_ERROR };
    }
    return { ok: true, value: parsed.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
