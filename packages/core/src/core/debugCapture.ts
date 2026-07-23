import type { BaseMessage } from '@langchain/core/messages';

/**
 * The non-message parts of a `wrapModelCall` request that also shape a turn: the tool
 * definitions, the system prompt, and the model params. Captured alongside the message
 * history so the `/debug` panel can show the full picture of what was sent to the model.
 *
 * SECURITY: these are assembled from an explicit allowlist at the capture site
 * (see {@link extractDebugRequestExtras}); the raw model instance (which can carry an
 * `apiKey`) is never passed through here.
 */
export interface DebugRequestExtras {
  /** The composed system prompt string sent to the model for this call. */
  systemPrompt?: string;
  /** The tool definitions made available for this call (name + description + JSON schema). */
  tools?: DebugToolDef[];
  /** Scalar model params (model id, temperature, …) — a key-free allowlist. */
  modelParams?: Record<string, unknown>;
  /** The tool-choice configuration for this call, if any. */
  toolChoice?: unknown;
}

/** A single tool's debug-renderable definition. */
export interface DebugToolDef {
  name: string;
  description?: string;
  /** The tool's JSON-schema parameters, when resolvable. */
  schema?: unknown;
}

/**
 * GS2-56 — the always-on snapshot of the LAST model request, kept on
 * {@link import('#src/core/GthAbstractAgent.js').GthAbstractAgent} independent of any
 * {@link DebugCapture} sink. It is the SAME data the sink reports (the as-sent, post-summarization
 * `request.messages` plus the {@link DebugRequestExtras}), captured unconditionally at each model
 * call so `/debug-dump` can render the full model input even when the TUI `/debug` panel was never
 * opened and on non-TUI surfaces. Reuses {@link DebugRequestExtras} rather than forking a parallel
 * capture shape; `WriteDebugDumpInput.modelRequest` is this same type, so the caller threads
 * `agent.lastModelRequest` straight through with no reshaping.
 */
export interface LastModelRequest {
  /** The request extras (system prompt, tool defs with schema, model params, tool-choice). */
  extras?: DebugRequestExtras;
  /** The exact messages sent to the model for the last call (post-summarization / middleware). */
  messages?: BaseMessage[];
}

/**
 * Debug-capture sink for the TUI's `/debug` panel.
 *
 * A {@link DebugCapture} is an OPT-IN callback the TUI sets on a live agent after `init`
 * (on the shared {@link import('#src/core/GthAbstractAgent.js').GthAbstractAgent} base, so
 * both the lean and deep backends support it). When present, the agent's `wrapModelCall`
 * middleware reports, per model call:
 *
 * - `request` — `request.messages: BaseMessage[]`, the real history sent to the model at
 *   call time (post-summarization / post-middleware), plus the {@link DebugRequestExtras}
 *   (tools, system prompt, model params) that also shape the turn. This is exactly what the
 *   model saw.
 * - `response` — the resolved `AIMessage` returned by the handler, captured as a whole
 *   (resolved message, not per-chunk frames; keeps the streaming core untouched).
 *
 * The sink is read lazily inside the middleware (per call), so when no TUI debug panel is
 * attached the middleware is a transparent pass-through and the normal path pays nothing.
 */
export interface DebugCapture {
  /** The full message history sent to the model for this call, plus the request extras. */
  onRequest?(messages: BaseMessage[], extras?: DebugRequestExtras): void;
  /** The resolved model response for this call (an `AIMessage`). */
  onResponse?(response: unknown): void;
}

/**
 * Scalar model-param fields worth surfacing in the `/debug` panel. Deliberately an
 * allowlist (NOT a whole-object dump) so no credential field (`apiKey`, `accessToken`, …)
 * can ever leak into the rendered debug view.
 *
 * `streaming` is intentionally NOT here: it is the model instance's static flag, which is
 * usually `false` even when the turn streams — the GthAgentRunner decides streaming by calling
 * `.stream()` vs `.invoke()`, not by this property — so surfacing it just misleads.
 */
const DEBUG_MODEL_PARAM_KEYS = [
  'model',
  'modelName',
  'modelId',
  'deploymentName',
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'maxOutputTokens',
  'maxReasoningTokens',
  'reasoningEffort',
  'thinkingBudget',
  'stop',
  'provider',
] as const;

/** Pull the key-free scalar model params from the (provider-specific) model instance. */
function extractModelParams(model: unknown): Record<string, unknown> | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const src = model as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of DEBUG_MODEL_PARAM_KEYS) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    // Only scalars / scalar arrays — never nested objects that could carry credentials.
    if (typeof value === 'object' && !Array.isArray(value)) continue;
    out[key] = value;
  }
  // `model` / `modelName` / `modelId` are langchain aliases for the same value; collapse the
  // duplicates so the panel shows the model id once instead of two identical lines.
  if (typeof out.model !== 'string' && typeof out.modelName === 'string') {
    out.model = out.modelName;
  }
  if (out.modelName === out.model) delete out.modelName;
  if (out.modelId === out.model) delete out.modelId;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Best-effort tool definition (name + description + schema) for the debug view. */
function extractToolDefs(tools: unknown): DebugToolDef[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const defs: DebugToolDef[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const t = tool as Record<string, unknown>;
    const name = typeof t.name === 'string' ? t.name : undefined;
    if (!name) continue;
    const description = typeof t.description === 'string' ? t.description : undefined;
    // LangChain StructuredTools expose a Zod/JSON `schema`; some carry it on `lc_kwargs`.
    const schema = (t.schema as unknown) ?? undefined;
    defs.push({ name, description, schema });
  }
  return defs.length > 0 ? defs : undefined;
}

/**
 * Assemble the non-message request parts ({@link DebugRequestExtras}) for the `/debug`
 * panel from a `wrapModelCall` request, defensively and key-free. Never throws (the caller
 * already guards, but a debug sink must never break a run) and never dumps the raw model.
 * Shared by both the lean ({@link import('#src/core/GthLangChainAgent.js').GthLangChainAgent})
 * and deep backends so the panel behaves identically on either.
 */
export function extractDebugRequestExtras(request: unknown): DebugRequestExtras | undefined {
  if (!request || typeof request !== 'object') return undefined;
  const req = request as Record<string, unknown>;
  const systemMessage = req.systemMessage as { content?: unknown } | undefined;
  const systemPrompt =
    typeof req.systemPrompt === 'string' && req.systemPrompt
      ? req.systemPrompt
      : typeof systemMessage?.content === 'string'
        ? systemMessage.content
        : undefined;
  const extras: DebugRequestExtras = {
    systemPrompt,
    tools: extractToolDefs(req.tools),
    modelParams: extractModelParams(req.model),
    toolChoice: req.toolChoice,
  };
  // Return undefined when nothing useful was captured so the renderer can show a clear empty state.
  const hasAny =
    extras.systemPrompt !== undefined ||
    extras.tools !== undefined ||
    extras.modelParams !== undefined ||
    extras.toolChoice !== undefined;
  return hasAny ? extras : undefined;
}
