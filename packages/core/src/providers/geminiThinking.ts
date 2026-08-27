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
 * `additional_kwargs`; `#src/core/reasoningBlocks.js` is the half of this fix that reads it. That
 * block is typed `text`, exactly like an answer block, so a surface that does NOT route content
 * through gsloth's own reasoning bridge cannot tell thinking from answer — which is what
 * {@link disableGeminiThoughtSummaries} is for.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

type GenerationConfig = Record<string, unknown> & { thinkingConfig?: unknown };
type InvocationParams = Record<string, unknown> & { generationConfig?: GenerationConfig };
type InvocationParamsFn = (options?: unknown) => InvocationParams;

/**
 * Model families to leave alone when ADDING a request for thought summaries. `@langchain/google`
 * itself declines to send any thinking config for a 2.5 image model, so injecting one there would
 * send a field the library deliberately withheld; image/tts generations have no reasoning panel to
 * fill either way. Skipping them keeps the enable path to the models it is about.
 *
 * This gates the ENABLE direction only, and it must never gate the disable one. The sentence it
 * encodes — "we are unsure this model produces a summary, so do not ask for one" — inverts into
 * "…so let one through" the moment the same test is applied to a leak-prevention override, and
 * these families are exactly where `@langchain/google` sets `includeThoughts: true` on its own
 * once a thinking budget is configured.
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
  if (!producesThoughtSummaries((model as unknown as { model?: unknown }).model)) {
    return model;
  }
  return overrideThinkingConfig(model, (thinkingConfig) =>
    // `thinkingConfig` is always PRESENT as a key and may hold `undefined`; an explicit value means
    // the user's budget/level was honoured and must win.
    thinkingConfig === undefined ? { includeThoughts: true } : thinkingConfig
  );
}

/**
 * The inverse, for a surface that must not receive thought summaries at all: keep whatever thinking
 * budget or level applies and force `includeThoughts: false`, so the model still thinks and only the
 * summary is withheld. Never express this as a zero/minimal budget — that turns THINKING off, which
 * is a different and much larger change, and the coercion differs between the 2.5 and 3.x presets.
 *
 * This exists for any consumer that routes content blocks by `type` without going through gsloth's
 * own reasoning bridge: Gemini's thought summary is typed `text` exactly like an answer block, so
 * such a consumer has no way to tell them apart and prints the thinking as the assistant's answer.
 * Not asking for the summary is the only thing that reliably stops that; nothing is stripped, so the
 * message kept in graph state (and any `thoughtSignature` riding on it) is untouched. Returns the
 * same instance.
 *
 * No production module calls it today (only its spec does). It is kept as published API —
 * `providers/geminiThinking.js` is a public deep-import path — and because a parent reading a child
 * agent's stream needs exactly this; that is the lean subagent primitive (GS2-25).
 *
 * It applies to EVERY model family, including the image/tts ones the enable path skips: those are
 * precisely where `@langchain/google` sets `includeThoughts: true` itself once a budget or level is
 * configured, so a shared "does this model produce summaries?" guard would let exactly those
 * summaries through. What it will not do is INTRODUCE a thinking config where the library built
 * none — a request that carries no `thinkingConfig` gets no summary anyway (that is the whole
 * premise of {@link applyGeminiThoughtSummaries}), and adding the field to a model family the
 * library withholds it from would send something it deliberately did not.
 */
export function disableGeminiThoughtSummaries<T extends BaseChatModel>(model: T): T {
  return overrideThinkingConfig(model, (thinkingConfig) =>
    thinkingConfig === undefined
      ? thinkingConfig
      : {
          ...(typeof thinkingConfig === 'object' && thinkingConfig !== null ? thinkingConfig : {}),
          includeThoughts: false,
        }
  );
}

/**
 * Shared plumbing: re-derive `generationConfig.thinkingConfig` on every built request. Models that
 * build no `generationConfig` (every non-Google provider) are left completely alone, so this is a
 * no-op wherever it does not apply. Which model families to skip is the CALLER's decision, because
 * it differs by direction — see {@link producesThoughtSummaries}. Overrides stack: the outermost one
 * sees what the inner ones produced, which is what lets a surface-level decision override the
 * construction-time default.
 */
function overrideThinkingConfig<T extends BaseChatModel>(
  model: T,
  next: (_thinkingConfig: unknown) => unknown
): T {
  const holder = model as unknown as { model?: unknown; invocationParams?: InvocationParamsFn };
  const original = holder.invocationParams;
  if (typeof original !== 'function') {
    return model;
  }
  const bound = original.bind(model) as InvocationParamsFn;
  holder.invocationParams = function invocationParamsWithThinkingConfig(
    options?: unknown
  ): InvocationParams {
    const params = bound(options);
    const generationConfig = params?.generationConfig;
    if (!generationConfig) {
      return params;
    }
    const thinkingConfig = next(generationConfig.thinkingConfig);
    if (thinkingConfig === generationConfig.thinkingConfig) {
      return params;
    }
    return { ...params, generationConfig: { ...generationConfig, thinkingConfig } };
  };
  return model;
}
