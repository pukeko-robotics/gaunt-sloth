import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

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

/** A preview line of the shape the per-line cap exists for: long, and mixed-script throughout. */
const LONG_MIXED = `ascii-段落-${FAMILY}-🚀-${E_ACUTE}-한글-${'x'.repeat(20)}-`.repeat(200);

/** Cluster boundaries, taken from the platform rather than from the module under test. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const clustersOf = (text: string): string[] =>
  [...GRAPHEMES.segment(text)].map(({ segment }) => segment);

/**
 * What a whole-cluster slice MUST return, worked out from the definition — the longest run of
 * clusters whose `string-width` widths sum to at most the budget — rather than from the module's
 * own arithmetic. Both the boundaries and the widths come from outside the subject, so a slice
 * that measures with a broken ruler, cuts on code points, or spends its budget one column short
 * disagrees with this immediately.
 */
const longestHead = (text: string, budget: number): string => {
  let width = 0;
  let kept = '';
  for (const cluster of clustersOf(text)) {
    const clusterWidth = stringWidth(cluster);
    if (width + clusterWidth > budget) break;
    width += clusterWidth;
    kept += cluster;
  }
  return kept;
};

const longestTail = (text: string, budget: number): string => {
  const all = clustersOf(text);
  let width = 0;
  let kept = '';
  for (let index = all.length - 1; index >= 0; index--) {
    const clusterWidth = stringWidth(all[index]);
    if (width + clusterWidth > budget) break;
    width += clusterWidth;
    kept = all[index] + kept;
  }
  return kept;
};

describe('utils/displayWidth', () => {
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

  it('keeps the longest run of whole clusters that fits, at EVERY budget inside the string', async () => {
    const { sliceEndToWidth, sliceToWidth } = await import('#src/utils/displayWidth.js');

    for (const text of AWKWARD) {
      const width = stringWidth(text);
      // Budgets strictly inside the string are the ones that make the cluster walk run: at a
      // full-width budget a slice may hand the string straight back without ever walking it.
      for (let budget = 1; budget <= width; budget++) {
        expect(sliceToWidth(text, budget)).toBe(longestHead(text, budget));
        expect(sliceEndToWidth(text, budget)).toBe(longestTail(text, budget));
      }
      // And a budget of exactly the string's own width keeps all of it — measured by
      // `string-width`, so the budget does not come from the thing being checked.
      expect(sliceToWidth(text, width)).toBe(text);
      expect(sliceEndToWidth(text, width)).toBe(text);
    }
  });

  it('measures a string as the sum of its clusters, which is what lets a slice walk instead of measure', async () => {
    const { displayWidth } = await import('#src/utils/displayWidth.js');
    const sumOfClusters = (text: string): number =>
      clustersOf(text).reduce((total, cluster) => total + displayWidth(cluster), 0);

    // The slices spend a whole-string budget one cluster at a time, which is only the same
    // question when the parts add up to the whole. They do — for plain text.
    for (const text of [...AWKWARD, LONG_MIXED]) {
      expect(sumOfClusters(text)).toBe(stringWidth(text));
    }
    // Escapes are exactly where that stops holding, and the reason the slices ask for plain text:
    // the measurement drops the sequence, the clusters keep its printable bytes.
    const coloured = '\x1b[35mabcdefghij\x1b[0m';
    expect(stringWidth(coloured)).toBe(10);
    expect(sumOfClusters(coloured)).toBe(17);
  });

  it('slices a long mixed-script line by the same rule as a short one', async () => {
    const { sliceEndToWidth, sliceToWidth } = await import('#src/utils/displayWidth.js');
    const width = stringWidth(LONG_MIXED);
    expect(width).toBeGreaterThan(8_000); // the "one-line minified bundle" shape, mixed-script

    // Budgets at the head, deep inside, and one column short of the whole: the walk has to land
    // on a cluster boundary in every one of them, however far in it is.
    for (const budget of [1, 2, 3, 47, 200, 1_999, width - 1]) {
      expect(sliceToWidth(LONG_MIXED, budget)).toBe(longestHead(LONG_MIXED, budget));
      expect(sliceEndToWidth(LONG_MIXED, budget)).toBe(longestTail(LONG_MIXED, budget));
      expect(stringWidth(sliceToWidth(LONG_MIXED, budget))).toBeLessThanOrEqual(budget);
      expect(stringWidth(sliceEndToWidth(LONG_MIXED, budget))).toBeLessThanOrEqual(budget);
    }
    expect(sliceToWidth(LONG_MIXED, width)).toBe(LONG_MIXED);
    expect(sliceEndToWidth(LONG_MIXED, width)).toBe(LONG_MIXED);
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
    const { displayWidth, sliceEndToWidth, sliceToWidth } =
      await import('#src/utils/displayWidth.js');
    const coloured = '\x1b[35mabcdefghij\x1b[0m';

    // The two disagree on escape-bearing input, on purpose and by contract: the measurement
    // strips escapes, the slice sees their bytes as ordinary printable characters.
    expect(displayWidth(coloured)).toBe(10);
    expect(sliceToWidth(coloured, 5)).toBe('\x1b[35ma');
    // Between the two rulers' answers — 10 visible columns, 17 columns of clusters — the
    // MEASUREMENT decides, so a coloured string that visibly fits comes back whole instead of
    // being cut short by the bytes of its own escapes.
    expect(sliceToWidth(coloured, 12)).toBe(coloured);
    expect(sliceEndToWidth(coloured, 12)).toBe(coloured);
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
