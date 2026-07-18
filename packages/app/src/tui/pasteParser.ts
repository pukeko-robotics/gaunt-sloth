/**
 * TUI-C24 — pure, React-free bracketed-paste parsing.
 *
 * A terminal in **bracketed paste mode** (enabled with `\x1b[?2004h`) wraps pasted content
 * between a start marker `\x1b[200~` and an end marker `\x1b[201~`, so a multi-line paste can be
 * distinguished from typed keystrokes (in particular, the embedded newlines are NOT Enter presses
 * and must not submit the prompt). This module is the code-grounded, unit-testable implementation
 * of that protocol:
 *
 *   - {@link parsePasteChunk} / {@link createPasteParser} — a small state machine that, fed raw
 *     stdin chunks (including markers split across chunks and content typed before/after a paste
 *     burst), surfaces completed paste payloads separately from passthrough (typed) bytes.
 *   - {@link normalizePastedText} — collapses `\r\n` and lone `\r` to `\n` so a pasted payload's
 *     line breaks are consistent with the rest of the buffer (prevents the "\r jams lines" glitch).
 *
 * Runtime note (see `PromptInput.tsx`): Ink 7.1.0 already tokenizes bracketed paste internally and
 * exposes it via the `usePaste` hook, which is what the TUI wires up in production — so Ink owns the
 * live tokenizing and this parser is the protocol's tested reference implementation rather than the
 * primary runtime path. {@link normalizePastedText}, however, is on the real runtime path: the
 * `usePaste` handler runs every pasted payload through it before inserting it into the buffer.
 *
 * Deliberately depends on nothing from Ink/React so it stays drivable purely by feeding strings and
 * asserting the result.
 */

/** Bracketed-paste start marker: the terminal emits this immediately before pasted content. */
export const PASTE_START = '\x1b[200~';
/** Bracketed-paste end marker: the terminal emits this immediately after pasted content. */
export const PASTE_END = '\x1b[201~';

/** Result of feeding one chunk to the paste parser. */
export interface PasteParseResult {
  /**
   * Fully-delimited paste payloads completed by this chunk, in order (each already run through
   * {@link normalizePastedText}, so newlines are `\n`). Empty when the chunk contained no complete
   * paste.
   */
  pastes: string[];
  /**
   * Non-paste ("typed") bytes surfaced by this chunk, concatenated in order. Bytes belonging to a
   * paste (the markers and the payload between them) are never included here.
   */
  passthrough: string;
  /**
   * Bytes retained for the next call: either a partial start marker seen at the tail (we cannot yet
   * tell if a paste is beginning) or an in-progress paste (start marker + body still awaiting its
   * end marker). `''` when nothing is buffered. Feed this back as the `pending` argument of the
   * next {@link parsePasteChunk} call (the {@link createPasteParser} wrapper does this for you).
   */
  pending: string;
}

/**
 * Collapse `\r\n` (CRLF) and standalone `\r` (CR) to `\n` so pasted line breaks match how the rest
 * of the buffer stores them. Terminals variously deliver pasted newlines as `\r`, `\r\n`, or `\n`;
 * normalizing to `\n` is what stops a multi-line paste from either jamming onto one line or
 * splitting inconsistently. Idempotent and safe on single-line text (returns it unchanged).
 */
export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Length of the longest suffix of `tail` that is a *proper* prefix of the paste start marker.
 * For a chunk ending in `"\x1b[200"` this returns 5, so those bytes are held back as `pending`
 * (a start marker split across chunks) instead of leaking into `passthrough`. Returns 0 when the
 * tail ends in no marker prefix.
 */
function pendingStartMarkerLen(tail: string): number {
  const max = Math.min(tail.length, PASTE_START.length - 1);
  for (let k = max; k > 0; k--) {
    if (PASTE_START.startsWith(tail.slice(tail.length - k))) return k;
  }
  return 0;
}

/**
 * Parse one chunk of raw stdin, resuming from any `pending` carried over from the previous call.
 * Pure: no shared state, no side effects — the caller threads `pending` (or uses
 * {@link createPasteParser}).
 *
 * Handles, in one pass:
 *  - a complete `\x1b[200~ … \x1b[201~` sequence within the chunk (payload extracted, markers
 *    dropped);
 *  - multiple pastes and interleaved typed content in a single chunk;
 *  - a start or end marker split across chunk boundaries (retained in `pending`);
 *  - an in-progress paste body spanning several chunks (retained in `pending` until its end marker
 *    arrives);
 *  - `\r`/`\r\n` inside the payload, normalized to `\n` via {@link normalizePastedText}.
 */
export function parsePasteChunk(pending: string, chunk: string): PasteParseResult {
  const input = pending + chunk;
  const pastes: string[] = [];
  let passthrough = '';
  let index = 0;

  while (index < input.length) {
    const start = input.indexOf(PASTE_START, index);
    if (start === -1) {
      // No complete start marker ahead. The tail may still be a partial one (split across chunks);
      // hold that back as pending and surface the rest as typed passthrough.
      const tail = input.slice(index);
      const keep = pendingStartMarkerLen(tail);
      passthrough += tail.slice(0, tail.length - keep);
      return { pastes, passthrough, pending: tail.slice(tail.length - keep) };
    }

    // Everything before the start marker is ordinary typed input.
    passthrough += input.slice(index, start);

    const bodyStart = start + PASTE_START.length;
    const end = input.indexOf(PASTE_END, bodyStart);
    if (end === -1) {
      // Paste opened but not yet closed (body and/or end marker split across chunks): retain the
      // whole thing from the start marker so the next chunk can complete it.
      return { pastes, passthrough, pending: input.slice(start) };
    }

    pastes.push(normalizePastedText(input.slice(bodyStart, end)));
    index = end + PASTE_END.length;
  }

  return { pastes, passthrough, pending: '' };
}

/** Ergonomic stateful driver over {@link parsePasteChunk}: retains `pending` between pushes. */
export interface PasteParser {
  /** Feed the next raw stdin chunk; returns the pastes + passthrough completed by it. */
  push(chunk: string): { pastes: string[]; passthrough: string };
  /** The bytes currently held back awaiting more input (a split marker or in-progress paste). */
  readonly pending: string;
  /** Discard any retained `pending` (e.g. on teardown). */
  reset(): void;
}

/**
 * Create a stateful paste parser that accumulates `pending` across {@link PasteParser.push} calls,
 * so a caller can drive it chunk-by-chunk without threading state by hand.
 */
export function createPasteParser(): PasteParser {
  let pending = '';
  return {
    push(chunk: string) {
      const result = parsePasteChunk(pending, chunk);
      pending = result.pending;
      return { pastes: result.pastes, passthrough: result.passthrough };
    },
    get pending() {
      return pending;
    },
    reset() {
      pending = '';
    },
  };
}
