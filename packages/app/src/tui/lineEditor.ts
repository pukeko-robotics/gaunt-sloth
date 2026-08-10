/**
 * TUI-C25 — the prompt's buffer and caret, as a pure model.
 *
 * `ink-text-input` is a single-line widget: one cursor offset, one `<Text>`, no concept of a
 * logical line, and it returns early on Up/Down. Multi-line entry, cross-line caret movement, word
 * motion and line-start/end motion cannot be expressed through it, so the prompt owns its own
 * editor. Everything the editor *decides* lives here, with no React, no Ink and no terminal — which
 * is what makes the behaviour assertable deterministically on every platform of the unit matrix,
 * including the Windows cells, without a PTY.
 *
 * **Code points, not code units.** {@link EditorState.cursor} is a JS string index, but every
 * movement and deletion steps a whole code point, so a surrogate pair (an emoji) is never split —
 * one Backspace removes the whole character rather than half of it, which is what
 * `ink-text-input` does.
 *
 * **Enter's continuation syntax.** A backslash immediately before the caret makes Enter continue
 * the line instead of submitting: the backslash is consumed and a newline takes its place, the way
 * a shell reads a trailing `\`. **Known v1 limitation, intentional:** because the backslash is
 * always consumed there is no escape for a literal one, so a submitted line cannot end in a
 * backslash.
 *
 * Every exported function is pure: it returns a new {@link EditorState} and never mutates its
 * argument. A movement that cannot move returns an equivalent state.
 */

/** An immutable snapshot of the prompt buffer and where the caret sits in it. */
export interface EditorState {
  /** The whole buffer. Logical lines are separated by `\n`. */
  readonly value: string;
  /** Caret offset as a JS string index into `value`, 0..value.length. */
  readonly cursor: number;
  /**
   * The column Up/Down are trying to return to, in code points from the start of the logical line.
   * Set by {@link moveLineUp}/{@link moveLineDown}, cleared (undefined) by every other operation.
   */
  readonly desiredColumn?: number;
}

/** A word character for word motion; everything else — including a space and `\n` — separates. */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

export function createEditorState(value = ''): EditorState {
  return { value, cursor: value.length };
}

/**
 * A state at `cursor` with no sticky column — the shape every operation but Up/Down returns.
 * Hands back the same object when that is already true, so an unmoved caret cannot look like a
 * change to a caller comparing by identity.
 */
function at(state: EditorState, cursor: number): EditorState {
  if (state.cursor === cursor && state.desiredColumn === undefined) return state;
  return { value: state.value, cursor };
}

/** The index where the code point ending at `index` starts. `index` 0 stays 0. */
function previousCodePointStart(value: string, index: number): number {
  if (index <= 0) return 0;
  const code = value.charCodeAt(index - 1);
  // A low surrogate only ever ends a pair, so its high half is the real start of the character.
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
    const high = value.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return index - 2;
  }
  return index - 1;
}

/** The index just past the code point starting at `index`. At the end of the buffer, unchanged. */
function nextCodePointEnd(value: string, index: number): number {
  if (index >= value.length) return value.length;
  const codePoint = value.codePointAt(index);
  return index + (codePoint === undefined ? 1 : String.fromCodePoint(codePoint).length);
}

/** Whether the code point starting at `index` is a word character. */
function isWordAt(value: string, index: number): boolean {
  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) return false;
  return WORD_CHARACTER.test(String.fromCodePoint(codePoint));
}

/** How many code points `text` holds — the unit the sticky column is measured in. */
function codePointCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i = nextCodePointEnd(text, i)) count += 1;
  return count;
}

/** The start of the logical line `cursor` sits on: just past the preceding `\n`, or 0. */
function lineStartOffset(value: string, cursor: number): number {
  return value.lastIndexOf('\n', cursor - 1) + 1;
}

/** The end of the logical line `cursor` sits on: the next `\n`, or the end of the buffer. */
function lineEndOffset(value: string, cursor: number): number {
  const newline = value.indexOf('\n', cursor);
  return newline === -1 ? value.length : newline;
}

/** The offset `column` code points into the line `start`..`end`, clamped to `end`. */
function offsetForColumn(value: string, start: number, end: number, column: number): number {
  let offset = start;
  for (let stepped = 0; stepped < column && offset < end; stepped += 1) {
    offset = nextCodePointEnd(value, offset);
  }
  return Math.min(offset, end);
}

/** The caret's column on its own line, in code points. */
function currentColumn(state: EditorState): number {
  const start = lineStartOffset(state.value, state.cursor);
  return codePointCount(state.value.slice(start, state.cursor));
}

/** Insert literal text at the caret; caret lands after it. `desiredColumn` clears. */
export function insertText(state: EditorState, text: string): EditorState {
  if (text === '') return at(state, state.cursor);
  return {
    value: state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor),
    cursor: state.cursor + text.length,
  };
}

/** Backspace: remove the code point before the caret. No-op at offset 0. */
export function deleteBackward(state: EditorState): EditorState {
  if (state.cursor <= 0) return at(state, 0);
  const start = previousCodePointStart(state.value, state.cursor);
  return {
    value: state.value.slice(0, start) + state.value.slice(state.cursor),
    cursor: start,
  };
}

export function moveLeft(state: EditorState): EditorState {
  return at(state, previousCodePointStart(state.value, state.cursor));
}

export function moveRight(state: EditorState): EditorState {
  return at(state, nextCodePointEnd(state.value, state.cursor));
}

/**
 * Word motion (readline `Alt+B`): skip separators leftward, then the word itself, landing on its
 * start. `\n` is just another separator, so the motion crosses lines freely.
 */
export function moveWordLeft(state: EditorState): EditorState {
  const { value } = state;
  let offset = state.cursor;
  while (offset > 0 && !isWordAt(value, previousCodePointStart(value, offset))) {
    offset = previousCodePointStart(value, offset);
  }
  while (offset > 0 && isWordAt(value, previousCodePointStart(value, offset))) {
    offset = previousCodePointStart(value, offset);
  }
  return at(state, offset);
}

/**
 * Word motion (readline `Alt+F`): skip separators rightward, then the word itself, landing just
 * after its end.
 */
export function moveWordRight(state: EditorState): EditorState {
  const { value } = state;
  let offset = state.cursor;
  while (offset < value.length && !isWordAt(value, offset)) {
    offset = nextCodePointEnd(value, offset);
  }
  while (offset < value.length && isWordAt(value, offset)) {
    offset = nextCodePointEnd(value, offset);
  }
  return at(state, offset);
}

/** Start of the caret's own LOGICAL line (not of the whole buffer). */
export function moveLineStart(state: EditorState): EditorState {
  return at(state, lineStartOffset(state.value, state.cursor));
}

/** End of the caret's own LOGICAL line (not of the whole buffer). */
export function moveLineEnd(state: EditorState): EditorState {
  return at(state, lineEndOffset(state.value, state.cursor));
}

/**
 * Up one logical line, honouring the sticky {@link EditorState.desiredColumn}.
 *
 * On the first line there is nowhere to go, but the column is still recorded: that is what lets
 * Up-Down-Up out of a long line and back keep the column it started from.
 */
export function moveLineUp(state: EditorState): EditorState {
  const { value } = state;
  const column = state.desiredColumn ?? currentColumn(state);
  const start = lineStartOffset(value, state.cursor);
  if (start === 0) return { value, cursor: state.cursor, desiredColumn: column };
  const previousStart = lineStartOffset(value, start - 1);
  return {
    value,
    cursor: offsetForColumn(value, previousStart, start - 1, column),
    desiredColumn: column,
  };
}

/** Down one logical line, honouring the sticky {@link EditorState.desiredColumn}. */
export function moveLineDown(state: EditorState): EditorState {
  const { value } = state;
  const column = state.desiredColumn ?? currentColumn(state);
  const end = lineEndOffset(value, state.cursor);
  if (end === value.length) return { value, cursor: state.cursor, desiredColumn: column };
  const nextStart = end + 1;
  return {
    value,
    cursor: offsetForColumn(value, nextStart, lineEndOffset(value, nextStart), column),
    desiredColumn: column,
  };
}

export type EnterResult =
  | { readonly kind: 'continue'; readonly state: EditorState }
  | { readonly kind: 'submit'; readonly value: string };

/**
 * What Enter means for this state: a backslash immediately before the caret continues the line
 * (the backslash is replaced by a newline), anything else submits the buffer exactly as typed —
 * untrimmed, newlines intact. Clearing the buffer and dispatching the submission belong to the
 * caller.
 */
export function pressEnter(state: EditorState): EnterResult {
  const { value, cursor } = state;
  const start = previousCodePointStart(value, cursor);
  if (cursor > 0 && value.slice(start, cursor) === '\\') {
    return {
      kind: 'continue',
      state: { value: `${value.slice(0, start)}\n${value.slice(cursor)}`, cursor: start + 1 },
    };
  }
  return { kind: 'submit', value };
}

/**
 * What the renderer needs: the logical lines and where the caret is among them. An empty buffer is
 * one empty line, and a trailing `\n` yields a final empty line — the row the caret sits on after
 * a continuation, which still has to be drawn.
 */
export function layout(state: EditorState): {
  readonly lines: readonly string[];
  /** 0-based index into `lines`. */
  readonly line: number;
  /** Caret offset within that line, as a JS string index into `lines[line]`. */
  readonly column: number;
} {
  const lines = state.value.split('\n');
  const start = lineStartOffset(state.value, state.cursor);
  const line = start === 0 ? 0 : state.value.slice(0, start).split('\n').length - 1;
  return { lines, line, column: state.cursor - start };
}
