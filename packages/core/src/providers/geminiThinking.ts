/**
 * @packageDocumentation
 * CFG-33 — ask Gemini to RETURN the thinking it is already doing.
 *
 * Two knobs are easy to conflate. The thinking BUDGET is what costs money, and Gemini thinks by
 * default — those tokens are billed whether or not anyone sees them. Thought SUMMARIES
 * (`thinkingConfig.includeThoughts`, default off) decide only whether any of that is returned. So
 * without this, gaunt-sloth pays for reasoning on every Gemini turn and throws it away unseen, and
 * the `/reasoning` panel is empty.
 *
 * Hence the rule here: wherever thinking is enabled, show it. This never changes the budget, and it
 * is not opt-in — a knob belongs on the thing that actually costs (`thinkingBudget` /
 * `thinkingLevel` / `reasoningEffort` in the `llm` config), never on whether the user may see what
 * they have already paid for. Setting the budget to zero or minimal turns thinking off, and this
 * respects that: there are then no thoughts to show.
 *
 * Why an `invocationParams` override rather than a constructor field: `@langchain/google` derives
 * `generationConfig.thinkingConfig` from the budget/level fields on every call and does not read a
 * `thinkingConfig` passed to the constructor, so the ONLY way to add `includeThoughts` without also
 * pinning a budget is at the built params. Overriding the instance method (the shape
 * {@link applyGeminiToolSchemaSanitizer} already uses for `bindTools`) keeps working through
 * `bindTools`, which returns a `RunnableBinding` around this same instance.
 *
 * Gemini returns a thought summary as a content BLOCK marked `thought: true`, not in
 * `additional_kwargs`; `#src/core/reasoningBlocks.js` is the half of this fix that reads it.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

type GenerationConfig = Record<string, unknown> & { thinkingConfig?: unknown };
type InvocationParams = Record<string, unknown> & { generationConfig?: GenerationConfig };
type InvocationParamsFn = (options?: unknown) => InvocationParams;

/**
 * Model families that produce no thought summary to show. `@langchain/google` itself declines to
 * send any thinking config for a 2.5 image model, so injecting one there would send a field the
 * library deliberately withheld; image/tts generations have no reasoning panel to fill either way.
 * Skipping them keeps this change to the models it is about.
 */
function producesThoughtSummaries(model: unknown): boolean {
  if (typeof model !== 'string') return true;
  return !/image|tts/i.test(model);
}

/**
 * Wire thought summaries into a `ChatGoogle` model. Overrides the instance's `invocationParams` so
 * that `generationConfig.thinkingConfig.includeThoughts` is set — but ONLY when the library derived
 * no thinking config at all, which is the "user configured nothing, the API default budget applies"
 * case. When the user DID configure a budget or level, `@langchain/google` has already decided
 * `includeThoughts` from it (true when thinking is on, false when they asked for none/minimal) and
 * that decision is left exactly as it stands. Returns the same model instance for chaining.
 */
export function applyGeminiThoughtSummaries<T extends BaseChatModel>(model: T): T {
  const holder = model as unknown as { model?: unknown; invocationParams?: InvocationParamsFn };
  const original = holder.invocationParams;
  if (typeof original !== 'function' || !producesThoughtSummaries(holder.model)) {
    return model;
  }
  const bound = original.bind(model) as InvocationParamsFn;
  holder.invocationParams = function invocationParamsWithThoughtSummaries(
    options?: unknown
  ): InvocationParams {
    const params = bound(options);
    const generationConfig = params?.generationConfig;
    // `thinkingConfig` is always PRESENT as a key and may hold `undefined`; an explicit value means
    // the user's budget/level was honoured and must win.
    if (!generationConfig || generationConfig.thinkingConfig !== undefined) {
      return params;
    }
    return {
      ...params,
      generationConfig: { ...generationConfig, thinkingConfig: { includeThoughts: true } },
    };
  };
  return model;
}
