import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import stripAnsi from 'strip-ansi';
import { wrappedRows } from '#src/tui/textRows.js';

/**
 * TUI-C92 — `wrappedRows` is only worth having if it says what Ink does, so this file does not
 * trace the arithmetic: it draws each string through a real `<Text>` at each width and asserts
 * the function's answer equals the rows Ink drew. A change to Ink's wrapping fails here.
 *
 * The rows Ink drew are read off a marker placed directly under the text: the marker's row index
 * IS the row count, which also handles the two edges a `split('\n')` cannot — an empty `<Text>`
 * measures zero rows, and a row of nothing but spaces is trimmed to an empty string in the frame
 * but is still a row.
 *
 * One Ink render per cell — a (string, width) pair each. A cell that rendered every width in a
 * loop would carry a thirteenth of the per-test headroom a normal cell has, and be the first thing
 * to time out on a loaded CI runner; the per-test ceiling is not raised for it.
 */
const MARKER = '<<END>>';

function rowsInkDraws(text: string, width: number): number {
  // The marker sits OUTSIDE the sized box, so a width of one cannot wrap the marker itself.
  const { lastFrame, unmount } = render(
    <Box flexDirection="column">
      <Box flexDirection="column" width={width}>
        <Text>{text}</Text>
      </Box>
      <Text>{MARKER}</Text>
    </Box>
  );
  const rows = stripAnsi(lastFrame() ?? '').split('\n');
  unmount();
  const marker = rows.findIndex((row) => row.startsWith(MARKER));
  expect(marker, `marker row for ${JSON.stringify(text)} at width ${width}`).toBeGreaterThanOrEqual(
    0
  );
  return marker;
}

/** Widths from degenerate to the widest the harness can draw (its terminal is 100 columns). */
const WIDTHS = [1, 2, 3, 5, 8, 13, 20, 39, 40, 76, 77, 80, 100];

const long = (cell: string, n: number) => cell.repeat(n);

const BATTERY: Array<[string, string]> = [
  ['the empty string', ''],
  ['one short word', 'hello'],
  ['one long word (76 cells)', long('x', 76)],
  ['one long word (77 cells)', long('x', 77)],
  ['one long word (160 cells)', long('x', 160)],
  ['three 39-cell words', `${long('a', 39)} ${long('b', 39)} ${long('c', 39)}`],
  ['many short words', long('word ', 20).trim()],
  ['multiple spaces between words', 'a  b   c    d     e'],
  ['leading spaces', '   indented text here'],
  ['one trailing space after a long word', `${long('x', 76)} `],
  ['several trailing spaces', 'trailing spaces   '],
  ['only spaces', '     '],
  ['CJK wide characters', long('漢字', 20)],
  ['CJK among ASCII words', 'ab 漢字漢字漢字 cd 漢字 ef'],
  ['an emoji run', long('⚡', 10)],
  ['a ZWJ family emoji among words', 'the 👨‍👩‍👧 family went out'],
  ['an emoji with a variation selector', 'fire 🔥 and ❤️ heart and ✂️ scissors'],
  ['a decomposed accent', long('café latte ', 5).trim()],
  ['a zero-width space at the end of a word', 'ab​cd​ ef'],
  // Nothing follows the zero-width cluster here, so the row it would start on its own has to fold
  // back into the row before it; a following word re-creates that row and hides the fold.
  ['a zero-width space ending an over-wide word', 'wwww​'],
  ['a zero-width joiner on its own', 'ab‍'],
  ['a tab-separated line', 'col\tcol\tcol\tcol\tcol'],
  // Ink lays a tab out to the next 8-column stop, counted from the start of its own line, and
  // wraps on that width. These place the tab at every kind of column: the start of the line, just
  // before and exactly on a stop, after wide clusters, and on a line that is not the first.
  ['a tab at column 0', '\tindented'],
  ['two leading tabs', '\t\tx'],
  ['a tab after exactly 8 cells', 'abcdefgh\tz'],
  ['a tab after 7 cells', 'abcdefg\tz'],
  ['a tab after CJK', '漢字漢\tz'],
  ['tabs on the second line', 'first\nab\tcd\tef\tgh'],
  ['a tab on a second line after a longer first', 'abcde\nx\ty'],
  ['tabs inside a long wrapping line', 'aaaa bbbb cccc dddd\teeee ffff gggg\thhhh'],
  ['a tab then words', 'k\tthe quick brown fox jumps'],
  ['only a tab', '\t'],
  ['a tab after an emoji', '🔥\tz'],
  ['many tabs', 'a\tb\tc\td\te\tf\tg\th\ti'],
  ['two lines', 'first line\nsecond line'],
  ['a trailing newline', 'a\n'],
  ['a newline only', '\n'],
  ['a long line and a short one', `${long('y', 90)}\nshort`],
];

describe('wrappedRows mirrors the rows Ink draws (TUI-C92)', () => {
  describe.each(BATTERY)('%s', (_name, text) => {
    it.each(WIDTHS)('at width %i', (width) => {
      expect(wrappedRows(text, width), `at width ${width}`).toBe(rowsInkDraws(text, width));
    });
  });

  describe.each(WIDTHS)('a word exactly the width, and one cell over, at %i', (width) => {
    it.each([
      ['exactly the width', long('w', width)],
      ['one cell over', long('w', width + 1)],
      ['exactly the width, then a word', `${long('w', width)} next`],
    ])('%s', (_name, text) => {
      expect(wrappedRows(text, width), JSON.stringify(text)).toBe(rowsInkDraws(text, width));
    });
  });

  /**
   * The lower bound the function replaces, named so the difference is on record: greedy word wrap
   * can take a row more than the division says, and that row was coming out of the conversation.
   */
  it('exceeds ceil(width / columns) where word wrap does', () => {
    const text = `${long('a', 39)} ${long('b', 39)} ${long('c', 39)}`;
    expect(Math.ceil(119 / 76)).toBe(2);
    expect(wrappedRows(text, 76)).toBe(3);
  });
});
