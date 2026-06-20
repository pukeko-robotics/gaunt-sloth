import type { BaseMessage } from '@langchain/core/messages';

/**
 * The non-message parts of a `wrapModelCall` request that also shape a turn: the tool
 * definitions, the system prompt, and the model params. Captured alongside the message
 * history so the `/debug` panel can show the full picture of what was sent to the model.
 *
 * SECURITY: these are assembled from an explicit allowlist at the capture site
 * (see `GthDeepAgent`); the raw model instance (which can carry an `apiKey`) is never
 * passed through here.
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
 * Debug-capture sink for the TUI's `/debug` panel.
 *
 * A {@link DebugCapture} is an OPT-IN callback the TUI sets on a live
 * {@link import('#src/core/GthDeepAgent.js').GthDeepAgent} after `init`. When present,
 * the deep agent's `wrapModelCall` middleware reports, per model call:
 *
 * - `request` — `request.messages: BaseMessage[]`, the real history sent to the model at
 *   call time (post-summarization / post-middleware), plus the {@link DebugRequestExtras}
 *   (tools, system prompt, model params) that also shape the turn. This supersedes any
 *   `getState`/`getMessageHistory` snapshot idea: it is exactly what the model saw.
 * - `response` — the resolved `AIMessage` returned by the handler, captured as a whole
 *   (decision (a): resolved message, not per-chunk frames; keeps the streaming core
 *   untouched).
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
