import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEditorState,
  deleteBackward,
  deleteForward,
  insertText,
  killAll,
  killToLineEnd,
  killToLineStart,
  killWordLeft,
  killWordRight,
  layout,
  moveLeft,
  moveLineDown,
  moveLineEnd,
  moveLineStart,
  moveLineUp,
  moveRight,
  moveWordLeft,
  moveWordRight,
  pressEnter,
  type EditorState,
} from '#src/tui/lineEditor.js';

/**
 * TUI-C25 — the prompt's buffer and caret, away from Ink.
 *
 * Every case here is a keystroke a terminal user's fingers already know, and the failure modes are
 * off-by-ones: a caret one position early, half an emoji deleted, a sticky column that drifts. None
 * of those are stated precisely by any rendering assertion, which is why the model is tested by its
 * own numbers rather than through the component.
 */

/** A state with the caret placed by offset — most cases care about the middle of a buffer. */
function stateAt(value: string, cursor: number): EditorState {
  return { value, cursor };
}

describe('lineEditor — inserting and deleting', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('starts with the caret at the end of the supplied text, or on an empty buffer', () => {
    expect(createEditorState()).toEqual({ value: '', cursor: 0 });
    expect(createEditorState('hello')).toEqual({ value: 'hello', cursor: 5 });
  });

  it('inserts at the caret and lands after the inserted text', () => {
    expect(insertText(createEditorState('ab'), 'X')).toEqual({ value: 'abX', cursor: 3 });
    expect(insertText(stateAt('ab', 1), 'XY')).toEqual({ value: 'aXYb', cursor: 3 });
  });

  it('does not mutate the state it was given', () => {
    const before = createEditorState('ab');
    insertText(before, 'X');
    deleteBackward(before);
    expect(before).toEqual({ value: 'ab', cursor: 2 });
  });

  it('backspaces one character, and does nothing at the start of the buffer', () => {
    expect(deleteBackward(createEditorState('ab'))).toEqual({ value: 'a', cursor: 1 });
    expect(deleteBackward(stateAt('ab', 0))).toEqual({ value: 'ab', cursor: 0 });
  });

  it('backspaces a whole emoji with one press', () => {
    // 'ab😀' is four UTF-16 units; removing one would leave a lone surrogate on screen.
    expect(deleteBackward(createEditorState('ab😀'))).toEqual({ value: 'ab', cursor: 2 });
  });

  it('deletes FORWARD without moving the caret, and does nothing at the end of the buffer', () => {
    // TUI-C79 item (1). Stated against the backward case in the same breath, because a forward
    // deletion wired to `deleteBackward` passes any assertion that only counts characters.
    expect(deleteForward(stateAt('abc', 1))).toEqual({ value: 'ac', cursor: 1 });
    expect(deleteBackward(stateAt('abc', 1))).toEqual({ value: 'bc', cursor: 0 });
    expect(deleteForward(createEditorState('abc'))).toEqual({ value: 'abc', cursor: 3 });
    expect(deleteForward(createEditorState(''))).toEqual({ value: '', cursor: 0 });
  });

  it('deletes a whole emoji forward, and joins the next line when the caret is at a newline', () => {
    expect(deleteForward(stateAt('a😀b', 1))).toEqual({ value: 'ab', cursor: 1 });
    // `\n` is an ordinary code point to this operation — the same as Delete at end-of-line in any
    // editor a user has met.
    expect(deleteForward(stateAt('one\ntwo', 3))).toEqual({ value: 'onetwo', cursor: 3 });
  });
});

/**
 * TUI-C79 — the four killing verbs, and what makes them recoverable.
 *
 * Each direction is defined as *exactly the span its TUI-C25 motion traverses*, so the cases below
 * state the span in terms of that motion rather than by repeating a literal: a deletion and a motion
 * that drift apart is the failure this pairing exists to make impossible. The `killed` half matters
 * as much as the state — an empty kill would clobber the one slot that holds the text back.
 */
describe('lineEditor — killing a word, and killing to the ends of the line', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** What a backward kill from `state` must be, said in terms of the motion it mirrors. */
  const backwardSpan = (state: EditorState) => ({
    state: {
      value: state.value.slice(0, moveWordLeft(state).cursor) + state.value.slice(state.cursor),
      cursor: moveWordLeft(state).cursor,
    },
    killed: state.value.slice(moveWordLeft(state).cursor, state.cursor),
  });

  /** The forward twin. */
  const forwardSpan = (state: EditorState) => ({
    state: {
      value: state.value.slice(0, state.cursor) + state.value.slice(moveWordRight(state).cursor),
      cursor: state.cursor,
    },
    killed: state.value.slice(state.cursor, moveWordRight(state).cursor),
  });

  it('kills back over exactly the span word motion traverses', () => {
    const state = createEditorState('foo bar baz');
    expect(killWordLeft(state)).toEqual(backwardSpan(state));
    expect(killWordLeft(state)).toEqual({ state: { value: 'foo bar ', cursor: 8 }, killed: 'baz' });
    // Mid-word, and over a run of separators — both are the motion's own shape.
    const midWord = stateAt('foo bar baz', 10);
    expect(killWordLeft(midWord)).toEqual(backwardSpan(midWord));
    // The literal is what carries the weight: `backwardSpan` is built from `moveWordLeft`, the same
    // expression the implementation uses, so it would still hold if that motion were itself wrong.
    expect(killWordLeft(midWord)).toEqual({
      state: { value: 'foo bar z', cursor: 8 },
      killed: 'ba',
    });
    const afterGap = stateAt('foo   bar', 6);
    expect(killWordLeft(afterGap)).toEqual(backwardSpan(afterGap));
    expect(killWordLeft(afterGap)).toEqual({
      state: { value: 'bar', cursor: 0 },
      killed: 'foo   ',
    });
  });

  it('kills forward over exactly the span word motion traverses', () => {
    const state = stateAt('foo bar baz', 0);
    expect(killWordRight(state)).toEqual(forwardSpan(state));
    expect(killWordRight(state)).toEqual({
      state: { value: ' bar baz', cursor: 0 },
      killed: 'foo',
    });
    const midGap = stateAt('foo   bar', 3);
    expect(killWordRight(midGap)).toEqual(forwardSpan(midGap));
    expect(killWordRight(midGap)).toEqual({ state: { value: 'foo', cursor: 3 }, killed: '   bar' });
  });

  it('crosses a line boundary in both directions, because `\\n` is just another separator', () => {
    const backward = stateAt('foo\nbar', 4);
    expect(killWordLeft(backward)).toEqual(backwardSpan(backward));
    expect(killWordLeft(backward)).toEqual({ state: { value: 'bar', cursor: 0 }, killed: 'foo\n' });
    const forward = stateAt('foo\nbar', 3);
    expect(killWordRight(forward)).toEqual(forwardSpan(forward));
    expect(killWordRight(forward)).toEqual({ state: { value: 'foo', cursor: 3 }, killed: '\nbar' });
  });

  it('takes ONE alphanumeric word out of a punctuated token, not the whole token', () => {
    // Where TUI-C79's one-action decision is visible. readline's `unix-word-rubout` (what bash binds
    // `Ctrl+W` to) would take the whole of `foo.bar/baz`; both of this prompt's backward spellings
    // are the same action, and it is the word definition the motions already use.
    const state = createEditorState('foo.bar/baz');
    expect(killWordLeft(state)).toEqual({ state: { value: 'foo.bar/', cursor: 8 }, killed: 'baz' });
    expect(killWordLeft(state)).toEqual(backwardSpan(state));
  });

  it('kills to the end and the start of the caret OWN logical line', () => {
    const buffer = 'one\ntwo\nthree';
    expect(killToLineEnd(stateAt(buffer, 5))).toEqual({
      state: { value: 'one\nt\nthree', cursor: 5 },
      killed: 'wo',
    });
    // To the line START, not the whole line: the text after the caret is left exactly where it was.
    expect(killToLineStart(stateAt(buffer, 5))).toEqual({
      state: { value: 'one\nwo\nthree', cursor: 4 },
      killed: 't',
    });
    // Killing a whole line is the two of them in sequence, which is why neither does it alone.
    const toEnd = killToLineEnd(stateAt(buffer, 5));
    expect(killToLineStart(toEnd.state)).toEqual({
      state: { value: 'one\n\nthree', cursor: 4 },
      killed: 't',
    });
  });

  it('kills the WHOLE buffer, every line of it, wherever the caret was', () => {
    // TUI-C79 — Ctrl+C's first rung. The one kill whose span is not a motion's: `Ctrl+U`/`Ctrl+K`
    // are scoped to the caret's own line, so a multi-line draft scrapped with one keystroke can only
    // go in one piece here. Driven from mid-buffer, where a line-scoped implementation differs.
    expect(killAll(stateAt('one\ntwo\nthree', 5))).toEqual({
      state: { value: '', cursor: 0 },
      killed: 'one\ntwo\nthree',
    });
    // Scrapping nothing is not a kill — the slot must survive a Ctrl+C on an empty prompt.
    expect(killAll(createEditorState())).toEqual({ state: { value: '', cursor: 0 }, killed: '' });
  });

  it('reports an empty kill rather than clobbering the slot, when there is nothing to take', () => {
    // The slot is one deep and has no undo behind it, so a kill that removed nothing must be
    // distinguishable from a kill of the empty string — the caller stores what it is handed.
    expect(killToLineEnd(stateAt('one\ntwo', 3)).killed).toBe('');
    expect(killToLineStart(stateAt('one\ntwo', 4)).killed).toBe('');
    expect(killWordLeft(stateAt('foo bar', 0)).killed).toBe('');
    expect(killWordRight(stateAt('foo bar', 7)).killed).toBe('');
    // …and the state such a kill hands back is the buffer untouched.
    expect(killToLineEnd(stateAt('one\ntwo', 3)).state).toEqual({ value: 'one\ntwo', cursor: 3 });
  });

  it('does not mutate the state it was given, and clears the sticky column', () => {
    const before = stateAt('foo bar', 7);
    killWordLeft(before);
    killWordRight(stateAt('foo bar', 0));
    expect(before).toEqual({ value: 'foo bar', cursor: 7 });

    const down = moveLineDown(stateAt('long line\nab', 4));
    expect(down.desiredColumn).toBe(4);
    expect(killWordLeft(down).state.desiredColumn).toBeUndefined();
    expect(killWordRight(down).state.desiredColumn).toBeUndefined();
    expect(killToLineEnd(down).state.desiredColumn).toBeUndefined();
    expect(killToLineStart(down).state.desiredColumn).toBeUndefined();
    expect(deleteForward(down).desiredColumn).toBeUndefined();
  });
});

describe('lineEditor — caret by one character', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('clamps at both ends of the buffer', () => {
    expect(moveLeft(stateAt('ab', 0)).cursor).toBe(0);
    expect(moveRight(stateAt('ab', 2)).cursor).toBe(2);
    expect(moveLeft(createEditorState('')).cursor).toBe(0);
  });

  it('steps a whole code point in each direction', () => {
    // 'a😀b': the emoji occupies offsets 1..2, so a code-unit step would land inside it.
    expect(moveRight(stateAt('a😀b', 1)).cursor).toBe(3);
    expect(moveLeft(stateAt('a😀b', 3)).cursor).toBe(1);
    expect(moveRight(stateAt('a😀b', 3)).cursor).toBe(4);
  });
});

describe('lineEditor — word motion', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('moves left to the start of the word the caret is in or just past', () => {
    expect(moveWordLeft(createEditorState('foo bar baz')).cursor).toBe(8);
    // Mid-word: 'ba|z' goes to the start of 'baz', not past it.
    expect(moveWordLeft(stateAt('foo bar baz', 10)).cursor).toBe(8);
  });

  it('skips a run of separators before the word it lands on', () => {
    expect(moveWordLeft(stateAt('foo   bar', 6)).cursor).toBe(0);
    expect(moveWordRight(stateAt('foo   bar', 3)).cursor).toBe(9);
  });

  it('moves right to just after the end of the next word', () => {
    expect(moveWordRight(createEditorState('')).cursor).toBe(0);
    expect(moveWordRight(stateAt('foo bar baz', 0)).cursor).toBe(3);
    expect(moveWordRight(stateAt('foo bar baz', 3)).cursor).toBe(7);
  });

  it('crosses a newline like any other separator', () => {
    expect(moveWordLeft(createEditorState('foo\nbar')).cursor).toBe(4);
    expect(moveWordLeft(stateAt('foo\nbar', 4)).cursor).toBe(0);
    expect(moveWordRight(stateAt('foo\nbar', 3)).cursor).toBe(7);
  });

  it('does nothing at the buffer ends', () => {
    expect(moveWordLeft(stateAt('foo bar', 0)).cursor).toBe(0);
    expect(moveWordRight(stateAt('foo bar', 7)).cursor).toBe(7);
  });

  it('treats underscores and digits as word characters and punctuation as a separator', () => {
    // One word, not two: 'foo_bar' is what an identifier looks like at this prompt.
    expect(moveWordLeft(stateAt('foo_bar baz', 7)).cursor).toBe(0);
    expect(moveWordLeft(createEditorState('foo_bar9 baz')).cursor).toBe(9);
    // 'a.b c' — the dot separates, so right motion stops after each of a, b, c in turn.
    expect(moveWordRight(stateAt('a.b c', 0)).cursor).toBe(1);
    expect(moveWordRight(stateAt('a.b c', 1)).cursor).toBe(3);
    expect(moveWordRight(stateAt('a.b c', 3)).cursor).toBe(5);
    expect(moveWordLeft(stateAt('a.b c', 5)).cursor).toBe(4);
    expect(moveWordLeft(stateAt('a.b c', 4)).cursor).toBe(2);
  });
});

describe('lineEditor — start and end of the line', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const buffer = 'one\ntwo\nthree';

  it('bounds the caret to its OWN logical line, not the whole buffer', () => {
    expect(moveLineStart(stateAt(buffer, 5)).cursor).toBe(4);
    expect(moveLineEnd(stateAt(buffer, 5)).cursor).toBe(7);
  });

  it('bounds a single-line buffer to the buffer itself', () => {
    expect(moveLineStart(stateAt('hello', 2)).cursor).toBe(0);
    expect(moveLineEnd(stateAt('hello', 2)).cursor).toBe(5);
  });

  it('does nothing when the caret is already on the boundary', () => {
    expect(moveLineStart(stateAt(buffer, 4)).cursor).toBe(4);
    expect(moveLineEnd(stateAt(buffer, 7)).cursor).toBe(7);
    expect(moveLineEnd(createEditorState(buffer)).cursor).toBe(13);
  });

  it('stays put at offset 0, and never moves the caret to the RIGHT', () => {
    // Offset 0 has no preceding newline to sit after, whatever the buffer holds after it. The
    // buffer that begins with `\n` is the trap: a search for the preceding newline that starts
    // before the buffer finds THIS one and reports the line as starting at 1.
    expect(moveLineStart(stateAt(buffer, 0)).cursor).toBe(0);
    expect(moveLineStart(stateAt('\nabc', 0)).cursor).toBe(0);
    // The empty first line is also its own end — the newline at offset 0 terminates it.
    expect(moveLineEnd(stateAt('\nabc', 0)).cursor).toBe(0);
  });
});

describe('lineEditor — up, down, and the sticky column', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // Offsets: line 0 is 0..13, '\n' at 14; line 1 ('ab') is 15..16, '\n' at 17; line 2 starts 18.
  const buffer = 'long line here\nab\nanother long line';

  it('moves one line at a time, keeping the column where the target line is long enough', () => {
    // Column 1 of the short middle line, down into the long last line.
    expect(moveLineDown(stateAt(buffer, 16))).toEqual({
      value: buffer,
      cursor: 19,
      desiredColumn: 1,
    });
    // Column 5 of the last line, up into the two-column middle line: clamped to its end.
    expect(moveLineUp(stateAt(buffer, 18 + 5))).toEqual({
      value: buffer,
      cursor: 17,
      desiredColumn: 5,
    });
  });

  it('returns to the original column after passing through a shorter line', () => {
    // Column 10 of line 0 → line 1 has only 2 columns, so the caret clamps to its end…
    const down = moveLineDown(stateAt(buffer, 10));
    expect(down).toEqual({ value: buffer, cursor: 17, desiredColumn: 10 });
    // …and back up it is column 10 again, not column 2. That is the whole point of the stickiness.
    expect(moveLineUp(down)).toEqual({ value: buffer, cursor: 10, desiredColumn: 10 });
    // The same column also survives continuing DOWN across the short line into a long one.
    expect(moveLineDown(down)).toEqual({ value: buffer, cursor: 18 + 10, desiredColumn: 10 });
  });

  it('does not move on the first line or the last, but still records the column', () => {
    expect(moveLineUp(stateAt(buffer, 10))).toEqual({
      value: buffer,
      cursor: 10,
      desiredColumn: 10,
    });
    expect(moveLineDown(stateAt(buffer, 18 + 4))).toEqual({
      value: buffer,
      cursor: 18 + 4,
      desiredColumn: 4,
    });
    // Down into the short line, then Up twice: the second Up is blocked by the first line, and it
    // honours the column already recorded rather than recomputing one from where the caret sits.
    const blocked = moveLineUp(moveLineUp(moveLineDown(stateAt(buffer, 10))));
    expect(blocked).toEqual({ value: buffer, cursor: 10, desiredColumn: 10 });
  });

  it('treats offset 0 as the first line even when the buffer opens with a newline', () => {
    // The empty first line is a real line: Up from it is blocked, Down from it goes to line 1.
    expect(moveLineUp(stateAt('\nabc', 0))).toEqual({
      value: '\nabc',
      cursor: 0,
      desiredColumn: 0,
    });
    expect(moveLineDown(stateAt('\nabc', 0))).toEqual({
      value: '\nabc',
      cursor: 1,
      desiredColumn: 0,
    });
  });

  it('measures the column in code points, so an emoji counts once', () => {
    // '😀😀xy' — column 3 is after the second emoji plus 'x', i.e. offset 5.
    const emoji = '😀😀xy\nabcdef';
    expect(moveLineDown(stateAt(emoji, 5))).toEqual({
      value: emoji,
      cursor: 7 + 3,
      desiredColumn: 3,
    });
  });

  it('clears the sticky column on any other operation', () => {
    const down = moveLineDown(stateAt(buffer, 10));
    expect(down.desiredColumn).toBe(10);
    expect(insertText(down, 'x').desiredColumn).toBeUndefined();
    expect(deleteBackward(down).desiredColumn).toBeUndefined();
    expect(moveLeft(down).desiredColumn).toBeUndefined();
    expect(moveRight(down).desiredColumn).toBeUndefined();
    expect(moveWordLeft(down).desiredColumn).toBeUndefined();
    expect(moveWordRight(down).desiredColumn).toBeUndefined();
    expect(moveLineStart(down).desiredColumn).toBeUndefined();
    expect(moveLineEnd(down).desiredColumn).toBeUndefined();
  });
});

describe('lineEditor — what Enter means', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('continues the line when a backslash sits before the caret, consuming it', () => {
    expect(pressEnter(createEditorState('line one\\'))).toEqual({
      kind: 'continue',
      state: { value: 'line one\n', cursor: 9 },
    });
  });

  it('continues from the MIDDLE of the buffer, splitting the line there', () => {
    expect(pressEnter(stateAt('ab\\cd', 3))).toEqual({
      kind: 'continue',
      state: { value: 'ab\ncd', cursor: 3 },
    });
  });

  it('submits the buffer exactly as typed when nothing continues it', () => {
    expect(pressEnter(createEditorState('hello '))).toEqual({ kind: 'submit', value: 'hello ' });
    expect(pressEnter(createEditorState(''))).toEqual({ kind: 'submit', value: '' });
    // A backslash that is not immediately before the caret is ordinary text.
    expect(pressEnter(stateAt('a\\b', 3))).toEqual({ kind: 'submit', value: 'a\\b' });
  });

  it('submits a multi-line buffer whole, newlines intact and untrimmed', () => {
    expect(pressEnter(createEditorState('  one\ntwo\n'))).toEqual({
      kind: 'submit',
      value: '  one\ntwo\n',
    });
  });

  it('carries the acceptance sequence: two typed lines joined by a continuation', () => {
    let state = createEditorState('');
    state = insertText(state, 'line one');
    state = insertText(state, '\\');
    const first = pressEnter(state);
    expect(first.kind).toBe('continue');
    if (first.kind !== 'continue') throw new Error('expected a continuation');
    state = insertText(first.state, 'line two');
    expect(pressEnter(state)).toEqual({ kind: 'submit', value: 'line one\nline two' });
  });
});

describe('lineEditor — layout for the renderer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports one empty line for an empty buffer', () => {
    expect(layout(createEditorState(''))).toEqual({ lines: [''], line: 0, column: 0 });
  });

  it('locates the caret on a single line', () => {
    expect(layout(stateAt('hello', 2))).toEqual({ lines: ['hello'], line: 0, column: 2 });
  });

  it('locates the caret among several lines', () => {
    expect(layout(stateAt('one\ntwo\nthree', 5))).toEqual({
      lines: ['one', 'two', 'three'],
      line: 1,
      column: 1,
    });
    expect(layout(stateAt('one\ntwo\nthree', 4))).toEqual({
      lines: ['one', 'two', 'three'],
      line: 1,
      column: 0,
    });
  });

  it('puts the caret on the FIRST line at offset 0, whatever follows it', () => {
    expect(layout(stateAt('one\ntwo', 0))).toEqual({
      lines: ['one', 'two'],
      line: 0,
      column: 0,
    });
    // A leading newline must not be read as the caret's own preceding newline: doing so names row
    // 1 and a column of -1, which is a caret the renderer cannot draw.
    expect(layout(stateAt('\nabc', 0))).toEqual({ lines: ['', 'abc'], line: 0, column: 0 });
  });

  it('keeps the empty final line a trailing newline creates', () => {
    // This is the row the caret sits on right after a continuation; without it there is nothing to
    // draw the caret in.
    expect(layout(createEditorState('a\n'))).toEqual({ lines: ['a', ''], line: 1, column: 0 });
  });
});

describe('lineEditor — the caret at the top of a continued buffer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('survives the keystrokes that put it there: a bare continuation, then Up', () => {
    // Three keystrokes of the headline feature reach offset 0 of a buffer beginning with `\n`, so
    // this boundary is ordinary rather than contrived. Driving it through real operations, instead
    // of hand-building the state, is what proves the sequence is reachable at all.
    let state = insertText(createEditorState(''), '\\');
    const entered = pressEnter(state);
    if (entered.kind !== 'continue') throw new Error('expected a continuation');
    state = insertText(entered.state, 'hi');
    expect(state).toEqual({ value: '\nhi', cursor: 3 });

    const up = moveLineUp(state);
    expect(up).toEqual({ value: '\nhi', cursor: 0, desiredColumn: 2 });
    // The renderer draws from this: row 0, column 0 — not row 1 at column -1.
    expect(layout(up)).toEqual({ lines: ['', 'hi'], line: 0, column: 0 });
    // And the line-start key holds the caret still rather than pushing it onto the next line.
    expect(moveLineStart(up)).toEqual({ value: '\nhi', cursor: 0 });
  });
});
