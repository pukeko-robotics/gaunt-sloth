import type { BaseMessage } from '@langchain/core/messages';

/**
 * Debug-capture sink for the TUI's `/debug` panel.
 *
 * A {@link DebugCapture} is an OPT-IN callback the TUI sets on a live
 * {@link import('#src/core/GthDeepAgent.js').GthDeepAgent} after `init`. When present,
 * the deep agent's `wrapModelCall` middleware reports, per model call:
 *
 * - `request` — `request.messages: BaseMessage[]`, the real history sent to the model at
 *   call time (post-summarization / post-middleware). This supersedes any
 *   `getState`/`getMessageHistory` snapshot idea: it is exactly what the model saw.
 * - `response` — the resolved `AIMessage` returned by the handler, captured as a whole
 *   (decision (a): resolved message, not per-chunk frames; keeps the streaming core
 *   untouched).
 *
 * The sink is read lazily inside the middleware (per call), so when no TUI debug panel is
 * attached the middleware is a transparent pass-through and the normal path pays nothing.
 */
export interface DebugCapture {
  /** The full message history sent to the model for this call. */
  onRequest?(messages: BaseMessage[]): void;
  /** The resolved model response for this call (an `AIMessage`). */
  onResponse?(response: unknown): void;
}
