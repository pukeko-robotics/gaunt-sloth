// EXT-35 — plain-text tool-call repair grammar.
//
// Ported (TypeScript, gaunt-sloth house style) from the openclaw
// `@openclaw/tool-call-repair` reference (`packages/tool-call-repair/src/grammar.ts`).
// Only the low-level scanners the standalone-block parser in `./payload.ts` needs are
// carried over; the reference's streaming/normalizer/strip helpers are intentionally omitted.
//
// These functions recognise the fixed protocol markers small/local models emit when they
// serialise a tool call as assistant TEXT instead of a native tool_call. They do no allow-list
// or size gating themselves — that lives in `./payload.ts` / `./promote.ts`.

/** Legacy marker some models emit after a serialized JSON tool request. */
export const END_TOOL_REQUEST = '[END_TOOL_REQUEST]';
/** Harmony stream marker that introduces the target channel before a tool call. */
export const HARMONY_CHANNEL_MARKER = '<|channel|>';
/** Harmony stream marker that may separate the header from the JSON payload. */
export const HARMONY_MESSAGE_MARKER = '<|message|>';
/** Harmony stream marker that may close a serialized tool-call payload. */
export const HARMONY_CALL_MARKER = '<|call|>';

/** Tool names in bracket/plain-text repairs intentionally match provider-safe ids only. */
export function isPlainTextToolNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}

/** Skips spaces and tabs only, preserving line boundaries for grammar decisions. */
export function skipHorizontalWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) {
    index += 1;
  }
  return index;
}

/** Skips all JavaScript whitespace when line structure is no longer meaningful. */
export function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? '')) {
    index += 1;
  }
  return index;
}

/** Consumes either Unix or Windows line endings and returns the first offset after them. */
export function consumeLineBreak(text: string, start: number): number | null {
  if (text[start] === '\r') {
    return text[start + 1] === '\n' ? start + 2 : start + 1;
  }
  if (text[start] === '\n') {
    return start + 1;
  }
  return null;
}

/**
 * Finds the exclusive end offset of a balanced JSON object starting at `start`. Returns null if
 * the object never closes, or (when `maxPayloadBytes` is set) as soon as the scan runs past the
 * cap — the payload-size gate that keeps a runaway blob from being treated as a tool call.
 */
export function findJsonObjectEnd(
  text: string,
  start: number,
  maxPayloadBytes?: number
): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    if (maxPayloadBytes !== undefined && index + 1 - start > maxPayloadBytes) {
      return null;
    }
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return null;
}
