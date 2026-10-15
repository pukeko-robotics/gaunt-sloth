/**
 * @packageDocumentation
 * Vertex AI request labels.
 *
 * Vertex AI accepts a `labels` map on every generateContent request and copies it onto the matching
 * Cloud Billing export rows, which is how spend is attributed to a caller, a command or a pipeline.
 * `@langchain/google` builds the request body from a fixed set of fields and has no `labels` option,
 * so the labels are added to the built params through an `invocationParams` override, the same hook
 * {@link @gaunt-sloth/core!providers/geminiThinking.applyGeminiThoughtSummaries | applyGeminiThoughtSummaries}
 * uses. The override survives `bindTools`, which wraps this same instance.
 *
 * Vertex AI validates the keys and values (lowercase, at most 63 characters, at most 64 labels) and
 * rejects the request when they break those rules.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

type InvocationParams = Record<string, unknown>;
type InvocationParamsFn = (options?: unknown) => InvocationParams;

/**
 * Reads the `labels` field of a `vertexai` `llm` block. Returns `undefined` when it is absent or
 * empty, and throws when it is not an object of string values.
 */
export function readVertexAiLabels(labels: unknown): Record<string, string> | undefined {
  if (labels === undefined) {
    return undefined;
  }
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    throw new Error('"llm.labels" must be an object of string keys and string values.');
  }
  const entries = Object.entries(labels);
  const invalid = entries.filter(([, value]) => typeof value !== 'string').map(([key]) => key);
  if (invalid.length > 0) {
    throw new Error(`"llm.labels" values must be strings; check: ${invalid.join(', ')}.`);
  }
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string>) : undefined;
}

/**
 * Adds `labels` to every request the model builds. Returns the same model instance; a model with no
 * `invocationParams` is returned untouched.
 */
export function applyVertexAiLabels<T extends BaseChatModel>(
  model: T,
  labels: Record<string, string> | undefined
): T {
  const holder = model as unknown as { invocationParams?: InvocationParamsFn };
  const original = holder.invocationParams;
  if (!labels || typeof original !== 'function') {
    return model;
  }
  const bound = original.bind(model) as InvocationParamsFn;
  holder.invocationParams = function invocationParamsWithLabels(
    options?: unknown
  ): InvocationParams {
    return { ...bound(options), labels };
  };
  return model;
}
