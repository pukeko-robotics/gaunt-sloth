import stringWidth from 'string-width';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TUI-C34 — the shared terminal-width primitive every column budget in this repo measures and
 * slices through. The cases below pin the three things the callers depend on: the ambiguous-width
 * policy the ASCII art is drawn under, that widths are columns rather than code points, and that a
 * slice cuts only between whole grapheme clusters and never overspends its budget.
 */

/** The sloth face's widest line and the wordmark's — 16 and 19 columns of Ambiguous-width art. */
const FACE_LINE = '▀▄▀▀ ██████ ▀▀▄▀';
const WORDMARK_LINE = '┃┓┏┓┓┏┏┓╋  ┗┓┃┏┓╋┣┓';

/** A ZWJ family: seven code points, one cluster, two columns. */
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
/** A regional-indicator flag: two code points, one cluster, two columns. */
const FLAG = '\u{1F1F3}\u{1F1FF}';
/** DECOMPOSED e-acute: two code points, one cluster, one column. */
const E_ACUTE = 'é';

/**
 * Strings whose column width is not their code-point count, and whose clusters are not their code
 * points — plus a plain-ASCII and an empty control so the invariants below are not proven only on
 * exotic input.
 */
const AWKWARD = [FAMILY, FLAG, E_ACUTE, '한글', '/home/mari/開発/深層', 'gth-🚀', 'ascii', ''];

describe('utils/displayWidth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('counts columns, not code points', async () => {
    const { displayWidth } = await import('#src/utils/displayWidth.js');

    // One code point, two columns — the whole reason this module exists.
    expect(displayWidth('開')).toBe(2);
    expect(displayWidth('🚀')).toBe(2);
    // A ZWJ family and a flag are many code points drawn as one two-column glyph.
    expect(displayWidth(FAMILY)).toBe(2);
    expect([...FAMILY].length).toBe(7);
    expect(displayWidth(FLAG)).toBe(2);
    // A combining mark adds no column of its own.
    expect(displayWidth(E_ACUTE)).toBe(1);
    // ANSI escapes are not drawn, so they are not measured.
    expect(displayWidth('\x1b[35mabc\x1b[0m')).toBe(3);
    expect(displayWidth('')).toBe(0);
  });

  it('treats East-Asian AMBIGUOUS characters as narrow, which is what keeps the art 16 wide', async () => {
    const { displayWidth } = await import('#src/utils/displayWidth.js');

    // Block elements, box drawing and `…` are all Ambiguous width. Counting them wide would
    // measure the face at 32 and the wordmark at 38, and every column constant derived from them
    // would double.
    expect(displayWidth(FACE_LINE)).toBe(16);
    expect(displayWidth(WORDMARK_LINE)).toBe(19);
    expect(displayWidth('…')).toBe(1);
  });

  it('agrees with itself: a full-width slice returns the string unchanged', async () => {
    const { displayWidth, sliceEndToWidth, sliceToWidth } =
      await import('#src/utils/displayWidth.js');

    // The sum of the kept clusters' widths must equal the width of the whole string, or a slice
    // budgeted at exactly that width would drop something.
    for (const text of AWKWARD) {
      expect(sliceToWidth(text, displayWidth(text))).toBe(text);
      expect(sliceEndToWidth(text, displayWidth(text))).toBe(text);
    }
  });

  it('never overspends a budget, at any budget, and stays total at zero', async () => {
    const { sliceEndToWidth, sliceToWidth } = await import('#src/utils/displayWidth.js');
    // The oracle here is `string-width` directly, so a slice measured as fitting is fitting by an
    // authority the slice does not get to define.
    const displayWidth = stringWidth;

    for (const text of AWKWARD) {
      for (let budget = -1; budget <= displayWidth(text) + 1; budget++) {
        const head = sliceToWidth(text, budget);
        const tail = sliceEndToWidth(text, budget);
        expect(displayWidth(head)).toBeLessThanOrEqual(Math.max(0, budget));
        expect(displayWidth(tail)).toBeLessThanOrEqual(Math.max(0, budget));
        // What is kept is genuinely a prefix / suffix of the input, never a rearrangement.
        expect(text.startsWith(head)).toBe(true);
        expect(text.endsWith(tail)).toBe(true);
      }
      expect(sliceToWidth(text, 0)).toBe('');
      expect(sliceEndToWidth(text, 0)).toBe('');
    }
  });

  it('does NOT understand ANSI when slicing, which is why callers must pass plain text', async () => {
    const { displayWidth, sliceToWidth } = await import('#src/utils/displayWidth.js');
    const coloured = '\x1b[35mabcdefghij\x1b[0m';

    // The two disagree on escape-bearing input, on purpose and by contract: the measurement
    // strips escapes, the slice sees their bytes as ordinary printable characters.
    expect(displayWidth(coloured)).toBe(10);
    expect(sliceToWidth(coloured, 5)).toBe('\x1b[35ma');
    // At a budget narrower than the escape itself the cut lands INSIDE the sequence. This case
    // exists to make that visible rather than surprising: if a caller ever needs coloured input
    // sliced, the fix is a deliberate change here with this assertion updated, not a caller
    // quietly discovering mojibake.
    expect(sliceToWidth(coloured, 2)).toBe('\x1b[3');
  });

  it('drops a wide cluster whole rather than half-spending its columns', async () => {
    const { sliceEndToWidth, sliceToWidth } = await import('#src/utils/displayWidth.js');

    // One column left and a two-column glyph next: it cannot be drawn in half, so it goes.
    expect(sliceToWidth('a開b', 2)).toBe('a');
    expect(sliceToWidth('開', 1)).toBe('');
    expect(sliceEndToWidth('a開b', 2)).toBe('b');
    // And a multi-code-point cluster is never cut into its pieces.
    expect(sliceToWidth(`${FAMILY}x`, 2)).toBe(FAMILY);
    expect(sliceToWidth(`${FAMILY}x`, 1)).toBe('');
    expect(sliceEndToWidth(`x${FAMILY}`, 2)).toBe(FAMILY);
    expect(sliceEndToWidth(`x${FAMILY}`, 1)).toBe('');
    // A combining mark stays with the base it decorates.
    expect(sliceToWidth(`${E_ACUTE}x`, 1)).toBe(E_ACUTE);
    expect(sliceEndToWidth(`x${E_ACUTE}`, 1)).toBe(E_ACUTE);
  });
});
