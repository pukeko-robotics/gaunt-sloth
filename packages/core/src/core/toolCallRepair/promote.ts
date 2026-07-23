// EXT-35 — promote a text-emitted tool call to a native LangChain tool_call.
//
// The LangChain-message adaptation of the openclaw `@openclaw/tool-call-repair` reference
// (`packages/tool-call-repair/src/promote.ts`'s `promoteStandalonePlainTextToolCallMessage`).
// Small/local models (Gemma, lmstudio, gpt-oss) often serialise a tool call as assistant TEXT
// rather than a native `tool_call`; the ReAct graph then sees no tool_calls and ends the turn
// ("no tool calls = done"), stalling the loop. This module rescues a STANDALONE text-emitted call
// by rewriting the assistant message into one carrying a native `tool_call`, so the graph routes to
// the tools node and the loop continues.
//
// Three hard gates keep prose from ever being misread as a call:
//   1. name allow-list — only a call whose tool name is in the bound toolset promotes (an empty
//      allow-list promotes nothing, the prose-safe default);
//   2. payload-size cap — an oversized JSON blob is not treated as a call;
//   3. standalone-only — the message content must be ESSENTIALLY JUST the call (enforced by
//      {@link parseStandalonePlainTextToolCallBlocks}'s whole-input walk).
//
// Unlike the reference we do NOT set a `stopReason`/`toolUse` flag: langchain's ReAct router keys
// purely off the presence of `tool_calls` on the last AIMessage, so promoting the tool_calls array
// is sufficient to continue the loop.

import { AIMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import {
  MAX_TEXT_EMITTED_TOOL_CALL_PAYLOAD_BYTES,
  parseStandalonePlainTextToolCallBlocks,
  type PlainTextToolCallParseOptions,
} from './payload.js';

/**
 * A sane default cap on a single repaired call's serialized payload. A text blob larger than this
 * is never treated as a tool call. Overridable per call so a test can assert the cap with a small
 * value; production leaves it at the default. The single source of truth lives in `./payload.js`
 * and is re-exported here under its public name (EXT-43 unified the former duplicated literal).
 */
export { MAX_TEXT_EMITTED_TOOL_CALL_PAYLOAD_BYTES } from './payload.js';

/** LangChain native tool-call shape (structurally a `ToolCall` from `@langchain/core/messages`). */
type NativeToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  type: 'tool_call';
};

/** Gates for {@link textToNativeToolCalls} / {@link promoteTextEmittedToolCallMessage}. */
export interface TextToolCallRepairOptions {
  /**
   * The names of the tools bound to this run (the allow-list). Only a text-emitted call whose name
   * is one of these promotes; an unknown name is left as text. An EMPTY set promotes nothing — the
   * prose-safe default (no toolset ⇒ nothing is a call).
   */
  allowedToolNames: Iterable<string>;
  /** Payload-size cap; defaults to {@link MAX_TEXT_EMITTED_TOOL_CALL_PAYLOAD_BYTES}. */
  maxPayloadBytes?: number;
}

/**
 * Parse assistant `text` as one-or-more STANDALONE text-emitted tool calls and return them as
 * native LangChain tool_calls, or `undefined` when the text is not a standalone call, names a tool
 * outside the allow-list, or exceeds the payload cap. Fresh `id`s are minted per call (the model
 * emitted none). Empty allow-list ⇒ `undefined` (never promote).
 */
export function textToNativeToolCalls(
  text: string | undefined,
  options: TextToolCallRepairOptions
): NativeToolCall[] | undefined {
  const allowedToolNames = new Set(options.allowedToolNames);
  // Prose-safety default: with no bound tools nothing can be a call.
  if (allowedToolNames.size === 0) {
    return undefined;
  }
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    return undefined;
  }
  const parseOptions: PlainTextToolCallParseOptions = {
    allowedToolNames,
    maxPayloadBytes: options.maxPayloadBytes ?? MAX_TEXT_EMITTED_TOOL_CALL_PAYLOAD_BYTES,
  };
  const blocks = parseStandalonePlainTextToolCallBlocks(trimmed, parseOptions);
  if (!blocks) {
    return undefined;
  }
  return blocks.map((block) => ({
    id: randomUUID(),
    name: block.name,
    args: block.arguments,
    type: 'tool_call' as const,
  }));
}

/**
 * Repair one assistant {@link AIMessage}: if it has NO native tool_calls but its content is a
 * standalone text-emitted call (allow-listed, within the payload cap), return a NEW AIMessage that
 * carries the promoted native tool_calls; otherwise return `undefined` (the caller keeps the
 * original, so the native happy path is untouched).
 *
 * The returned message PRESERVES the original `id`. That is load-bearing: LangGraph's message-state
 * reducer merges by id, so a same-id message REPLACES the original in graph state (rather than
 * appending a duplicate/dangling assistant message). Content is cleared to '' since the raw
 * text-call is now represented natively as tool_calls.
 */
export function promoteTextEmittedToolCallMessage(
  message: AIMessage,
  options: TextToolCallRepairOptions
): AIMessage | undefined {
  // Happy path untouched: repair engages ONLY when there are no native tool_calls.
  if (message.tool_calls && message.tool_calls.length > 0) {
    return undefined;
  }
  const toolCalls = textToNativeToolCalls(message.text, options);
  if (!toolCalls) {
    return undefined;
  }
  return new AIMessage({
    id: message.id,
    content: '',
    tool_calls: toolCalls,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}
