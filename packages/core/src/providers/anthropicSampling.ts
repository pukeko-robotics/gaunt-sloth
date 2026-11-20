/**
 * Anthropic sampling settings: why gth drops every one of them, and the helpers that do it.
 *
 * `@langchain/anthropic` 1.6.5 brings in `@anthropic-ai/sdk` 1.x, which sends
 * `anthropic-version: 2026-10-21`. On that API version a Messages request that carries
 * `temperature`, `top_p` or `top_k` is rejected with a 400 ("Extra inputs are not permitted") on
 * every model, **even at the default value** — so a `temperature: 1` is dropped as surely as a
 * `temperature: 0`. There is no replacement setting: the model samples at its own defaults. gth
 * therefore removes the settings before they can reach the request and says so, rather than pinning
 * an older API version or holding the dependency back.
 *
 * Routes into the request, measured against `@langchain/anthropic` 1.6.5 `dist/chat_models.js`:
 * - the `temperature`, `topP` and `topK` constructor fields, which `getSamplingParams` copies onto
 *   the request whenever they are defined;
 * - `invocationKwargs`, which is spread into the request body, so its `temperature`, `top_p` and
 *   `top_k` (and the camelCase spellings, which the API would reject as unknown fields anyway) reach
 *   the API directly;
 * - assigning the `temperature` field on a built model, which is how `gth exec -t` works — see
 *   {@link isAnthropicChatModel}.
 * A top-level `top_p` or `top_k`, a `modelKwargs` block and `clientOptions` are never read into the
 * request body, so they need no handling here.
 *
 * This module has no imports on purpose: the `exec` command consumes it, and its specs mock the
 * console and file helpers a provider module would pull in.
 */

/** The constructor fields `ChatAnthropic` copies onto the request as `temperature`/`top_k`/`top_p`. */
const SAMPLING_FIELDS = ['temperature', 'topP', 'topK'] as const;

/** Spellings that reach the request when placed in `invocationKwargs`, which is spread verbatim. */
const SAMPLING_KWARGS = ['temperature', 'top_p', 'top_k', 'topP', 'topK'] as const;

export interface DroppedSamplingSetting {
  /** Where the setting was found, as the user wrote it, e.g. `topP` or `invocationKwargs.top_p`. */
  name: string;
  value: unknown;
}

/**
 * Return a copy of an Anthropic `llm` config with every sampling setting removed, plus the list of
 * what was removed. The input object (and its `invocationKwargs`) is never mutated. A setting whose
 * value is `undefined` is removed silently, since it would not reach the request either.
 */
export function dropAnthropicSamplingSettings<T extends object>(
  llmConfig: T
): { config: T; dropped: DroppedSamplingSetting[] } {
  const config = { ...llmConfig } as Record<string, unknown>;
  const dropped: DroppedSamplingSetting[] = [];

  for (const field of SAMPLING_FIELDS) {
    if (field in config) {
      if (config[field] !== undefined) dropped.push({ name: field, value: config[field] });
      delete config[field];
    }
  }

  const kwargs = config.invocationKwargs;
  if (kwargs && typeof kwargs === 'object') {
    const kwargsCopy = { ...(kwargs as Record<string, unknown>) };
    for (const key of SAMPLING_KWARGS) {
      if (key in kwargsCopy) {
        if (kwargsCopy[key] !== undefined) {
          dropped.push({ name: `invocationKwargs.${key}`, value: kwargsCopy[key] });
        }
        delete kwargsCopy[key];
      }
    }
    config.invocationKwargs = kwargsCopy;
  }

  return { config: config as T, dropped };
}

/** The warning printed once when {@link dropAnthropicSamplingSettings} removed anything. */
export function formatDroppedSamplingWarning(
  model: string | undefined,
  dropped: DroppedSamplingSetting[]
): string {
  const list = dropped.map((d) => `${d.name} ${JSON.stringify(d.value)}`).join(', ');
  return (
    `Anthropic no longer accepts sampling settings (temperature, top_p, top_k) on any model; ` +
    `ignoring ${list} from the "llm" config for model "${model ?? 'unknown'}". ` +
    'The model samples at its own defaults.'
  );
}

/**
 * Whether a built chat model is a `ChatAnthropic`. Duck-typed on LangChain's `_llmType()` rather
 * than `instanceof`, so it holds when the consumer and core resolve different copies of the package.
 * A `ChatAnthropic` declares `temperature` as an own field even when unset, so a caller that checks
 * `'temperature' in llm` before assigning it will otherwise write straight into the request.
 */
export function isAnthropicChatModel(llm: unknown): boolean {
  const candidate = llm as { _llmType?: unknown } | null | undefined;
  return (
    typeof candidate?._llmType === 'function' &&
    (candidate as { _llmType: () => unknown })._llmType() === 'anthropic'
  );
}
