/**
 * @module judge
 *
 * BATCH-2 — LLM-as-judge grading for `gth eval`. Adapts the *mechanism* of EXT-10's shell-safety
 * judge (`packages/core/src/core/shell/judge.ts`): `model.withStructuredOutput(zodSchema)` for a
 * single non-agentic structured call, raced against a timeout. The failure policy differs on
 * purpose — EXT-10 fails CLOSED (escalates to a human approval prompt); eval has no human in the
 * loop, so a judge that can't produce a verdict simply FAILS the case ({@link JudgeOutcome.ok}
 * `false`), it does not "escalate" anywhere.
 *
 * Verdict scale matches `review`'s existing convention (`packages/review/src/middleware/
 * reviewRateMiddleware.ts`'s `RateSchema`: `rate` 0-10 + a reason/comment string) for UX
 * consistency — a user who knows `review`'s threshold semantics already knows eval's. `RateSchema`
 * itself is not imported/reused: it is coupled to review's middleware/tool-call/artifact-store
 * plumbing, which doesn't fit a plain structured-output call here.
 *
 * Model source: `config.llm` by default, i.e. the SAME model config as the SUT — matching
 * `judgeShellCommand`'s own default. A separate `--judge <profile>` model is BATCH-2's own
 * "Not in scope" list (identity-matrix/pluggable-target work); grading with the SUT's own model
 * config is a known, real simplification for this first slice.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import * as z from 'zod';

import type { JudgeOutcome } from '#src/evalTypes.js';

/** Structured verdict the judge model must return — 0-10 `rate` + a `reason`, matching `review`'s
 * `RateSchema` shape (`rate`/`comment`) closely enough that the scale/semantics are the same;
 * named `reason` here to read naturally as "why this rate" rather than a generic review comment. */
export const EvalVerdictSchema = z.object({
  rate: z
    .number()
    .min(0)
    .max(10)
    .describe('How well the answer satisfies the rubric, from 0 to 10.'),
  reason: z.string().describe('One or two sentences explaining the rate.'),
});

export type EvalJudgeVerdict = z.infer<typeof EvalVerdictSchema>;

/** Default wall-clock budget (ms) for the judge LLM call — same default as `judgeShellCommand`'s
 * `JUDGE_DEFAULT_TIMEOUT_MS`, kept as eval's own constant since the two judges live in different
 * packages (`@gaunt-sloth/core` vs `@gaunt-sloth/batch`) and are conceptually independent gates. */
export const EVAL_JUDGE_DEFAULT_TIMEOUT_MS = 30_000;

const EVAL_JUDGE_SYSTEM_PROMPT = [
  "You are gaunt-sloth's eval judge.",
  'You are given a rubric and an AI assistant answer, and must rate how well the answer satisfies',
  'that rubric.',
  '',
  'Rate on a scale from 0 to 10, where 0 is a complete failure to satisfy the rubric and 10 is a',
  'perfect match. Base the rating only on whether the answer satisfies the rubric — not on style,',
  'tone, or preferences the rubric does not mention.',
  'Use the reason field to briefly justify the rate, referencing what the rubric asked for and',
  'what the answer actually did.',
].join('\n');

/**
 * Build the judge's messages: a fixed system preamble and a user message embedding the rubric and
 * the SUT's answer. Exposed (and returning plain strings) so tests can assert structure without a
 * live model.
 */
export function buildJudgeMessages(
  answer: string,
  rubric: string
): { system: string; user: string } {
  const userLines = [
    'Rubric:',
    rubric,
    '',
    'Answer to evaluate:',
    '<answer>',
    answer || '(empty answer)',
    '</answer>',
  ];
  return { system: EVAL_JUDGE_SYSTEM_PROMPT, user: userLines.join('\n') };
}

/**
 * Grade one case's SUT answer against its rubric via LLM-as-judge.
 *
 * - Builds the judge prompt ({@link buildJudgeMessages}).
 * - Calls `model.withStructuredOutput(EvalVerdictSchema)`.
 * - Races the call against `timeoutMs` (default {@link EVAL_JUDGE_DEFAULT_TIMEOUT_MS}).
 * - **Fails the case, not closed-to-a-human:** any throw / timeout / unparseable output / unusable
 *   model returns `{ ok: false, error }` — never a verdict, and never an auto-pass.
 *
 * @param answer The SUT's answer text to grade.
 * @param rubric The case's judge rubric (already validated non-blank by `parseEvalSuite`).
 * @param model The judge model — the caller passes `config.llm` (see module doc); `undefined`
 *   fails the case immediately, same as an unusable model.
 */
export async function judgeEvalCase(
  answer: string,
  rubric: string,
  model: BaseChatModel | undefined,
  options?: { timeoutMs?: number }
): Promise<JudgeOutcome> {
  const timeoutMs = options?.timeoutMs ?? EVAL_JUDGE_DEFAULT_TIMEOUT_MS;

  if (!model || typeof model.withStructuredOutput !== 'function') {
    return { attempted: true, ok: false, error: 'No usable judge model configured.' };
  }

  const { system, user } = buildJudgeMessages(answer, rubric);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const structured = model.withStructuredOutput(EvalVerdictSchema);
    const judgePromise = structured.invoke([new SystemMessage(system), new HumanMessage(user)]);

    const TIMEOUT = Symbol('eval-judge-timeout');
    const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });

    const raced = await Promise.race([judgePromise, timeoutPromise]);
    if (raced === TIMEOUT) {
      return { attempted: true, ok: false, error: `Judge timed out after ${timeoutMs}ms.` };
    }

    // withStructuredOutput already coerces to the schema, but re-validate defensively: a fake or
    // misbehaving model could return a non-conforming object.
    const parsed = EvalVerdictSchema.safeParse(raced);
    if (!parsed.success) {
      return { attempted: true, ok: false, error: 'Judge returned unparseable output.' };
    }
    return { attempted: true, ok: true, verdict: parsed.data };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
