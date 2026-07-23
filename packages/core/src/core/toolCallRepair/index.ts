// EXT-35 — plain-text tool-call repair: promote a text-emitted tool call to a native tool_call.
// Ported/adapted from the openclaw `@openclaw/tool-call-repair` reference. See the sibling files
// for the per-dialect grammar (`grammar.ts`), the standalone-block parser (`payload.ts`), and the
// LangChain-message promotion + gates (`promote.ts`).
export {
  parseStandalonePlainTextToolCallBlocks,
  type PlainTextToolCallBlock,
  type PlainTextToolCallParseOptions,
} from './payload.js';
export {
  textToNativeToolCalls,
  promoteTextEmittedToolCallMessage,
  MAX_TEXT_EMITTED_TOOL_CALL_PAYLOAD_BYTES,
  type TextToolCallRepairOptions,
} from './promote.js';
