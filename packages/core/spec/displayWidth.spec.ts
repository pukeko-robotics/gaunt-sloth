import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
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

/**
 * The node's witness: a colour-wrapped ten-character string. It MEASURES ten columns, and its raw
 * grapheme clusters — nineteen of them — sum to seventeen, because four of the five characters in
 * each escape are printable. That gap is what a byte-counting walk spends its budget on.
 */
const WITNESS = '\x1b[35mabcdefghij\x1b[0m';

/**
 * Escape-bearing strings of the shapes that actually reach the tool-output preview: a wrapped run,
 * colour that is never closed, several styles in one line, colour around wide glyphs, a one-byte
 * C1 introducer, an OSC hyperlink, and escapes with no text at all. Every sequence here is
 * WELL-FORMED — half-written ones are a separate case, and would defeat the partial-cut oracle.
 */
const COLOURED = [
  WITNESS,
  '\x1b[31mred and never closed',
  '\x1b[1m\x1b[4mbold underlined\x1b[0m plain \x1b[32mgreen\x1b[0m',
  'plain then \x1b[36m開発\x1b[0m then plain',
  '\x9b31mone-byte CSI\x9b0m',
  '\x1b]8;;https://example.com\x07link text\x1b]8;;\x07',
  '\x1b[35m\x1b[0m',
  '\x1b[35m',
];

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
    // Escapes are where a RAW cluster walk stops holding — the measurement drops the sequence, the
    // clusters keep its printable bytes — which is why the slices walk whole sequences rather than
    // the clusters they segment into. The gap this records is the one they close.
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

  it('never cuts INSIDE an escape sequence, at any budget', async () => {
    const { sliceEndToWidth, sliceToWidth } = await import('#src/utils/displayWidth.js');

    // A cut landing inside a sequence leaves an introducer with no terminator behind it. Asking
    // whether any ESC in the result still begins a whole sequence catches that directly: strip
    // every complete sequence and no introducer may survive.
    const hasPartialSequence = (text: string): boolean => stripAnsi(text).includes('\x1b');

    for (const text of COLOURED) {
      for (let budget = -1; budget <= stringWidth(text) + 1; budget++) {
        expect(hasPartialSequence(sliceToWidth(text, budget))).toBe(false);
        expect(hasPartialSequence(sliceEndToWidth(text, budget))).toBe(false);
      }
    }
    // The witness from the node, at the budget that used to bisect it: two columns is narrower
    // than the escape's own printable bytes, which is exactly where a byte-counting walk cut.
    expect(hasPartialSequence(sliceToWidth(WITNESS, 2))).toBe(false);
    expect(sliceToWidth(WITNESS, 2)).toBe('\x1b[35mab');
  });

  it('agrees with the measurement on escape-bearing text, which is what makes the walk sound', async () => {
    const { displayWidth, sliceToWidth } = await import('#src/utils/displayWidth.js');

    // The witness: ten visible columns, but nineteen raw clusters summing to seventeen columns.
    // The walk has to answer 10, or every budget it spends is measured in the wrong unit.
    expect(displayWidth(WITNESS)).toBe(10);
    expect(clustersOf(WITNESS).length).toBe(19);

    for (const text of COLOURED) {
      // Sum of the widths of what the walk KEEPS, taken one budget at a time, equals the
      // whole-string measurement once the budget covers it all.
      expect(displayWidth(sliceToWidth(text, stringWidth(text)))).toBe(stringWidth(text));
      // …and the string comes back byte-identical, which is what `truncate` in toolDisplay uses
      // to decide a line needs no ellipsis. Budget at least 1: a non-positive budget is the
      // documented total-function case and yields `''` whatever the input, including a string
      // made only of escapes, whose width is zero.
      expect(sliceToWidth(text, Math.max(1, stringWidth(text)))).toBe(text);

      // At every budget, the VISIBLE content kept is exactly the longest fitting run of visible
      // clusters. `strip-ansi` is the authority `string-width` itself measures through, so this
      // pins the walk's sequence boundaries against the ones the ruler uses — not against the
      // module's own idea of where a sequence ends.
      for (let budget = 0; budget <= stringWidth(text) + 1; budget++) {
        expect(stripAnsi(sliceToWidth(text, budget))).toBe(longestHead(stripAnsi(text), budget));
      }
    }
  });

  it('carries a kept sequence along, and never appends a reset of its own', async () => {
    const { sliceEndToWidth, sliceToWidth } = await import('#src/utils/displayWidth.js');

    // Truncated coloured text stays coloured: the opening sequence is carried with the text it
    // introduces rather than dropped, so a cut preview line does not render as plain.
    expect(sliceToWidth(WITNESS, 4)).toBe('\x1b[35mabcd');

    // The result is a genuine PREFIX / SUFFIX — no reset is added. Both surfaces wrap and close
    // their own styling per line, and an inner reset would close that wrapper early.
    for (const text of COLOURED) {
      for (let budget = 0; budget <= stringWidth(text) + 1; budget++) {
        expect(text.startsWith(sliceToWidth(text, budget))).toBe(true);
        expect(text.endsWith(sliceEndToWidth(text, budget))).toBe(true);
      }
    }

    // A sequence whose text is entirely cut away goes with it, rather than trailing the result
    // and colouring whatever the caller appends next (an ellipsis, the next parameter).
    expect(sliceToWidth('abc\x1b[31mdef', 3)).toBe('abc');
    // Keeping the END discards the head, so the sequence that opened the colour goes with it.
    expect(sliceEndToWidth('\x1b[31mabcdef', 3)).toBe('def');
  });

  it('terminates on a degenerate line of half-written escapes rather than rescanning it', async () => {
    const { displayWidth, sliceToWidth } = await import('#src/utils/displayWidth.js');

    // An unterminated OSC introducer must not scan ahead for a terminator that never comes: that
    // is what would turn one long line into a quadratic walk. The elapsed-time bound is what makes
    // a rescan-per-introducer regression FAIL rather than merely run slowly — a plain timeout
    // cannot interrupt a synchronous walk, so it would hang the suite instead of reddening it.
    const unterminated = '\x1b]8;;'.repeat(20_000) + 'x'.repeat(20_000);
    const started = Date.now();
    expect(displayWidth(sliceToWidth(unterminated, 50))).toBeLessThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(2_000);

    // An introducer that never becomes a sequence is not a sequence at all — it is an ordinary
    // zero-width control character, so the budget is spent on the printable bytes around it and
    // the walk stops after ten of them. The trailing introducer is kept for the same reason any
    // zero-width cluster is: it costs nothing, so it cannot overspend.
    const partials = '\x1b['.repeat(20_000);
    expect(sliceToWidth(partials, 10)).toBe('\x1b['.repeat(10) + '\x1b');
    expect(displayWidth(sliceToWidth(partials, 10))).toBe(10);
  }, 10_000);

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
