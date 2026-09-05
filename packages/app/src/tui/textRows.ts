import { displayWidth } from '@gaunt-sloth/core/utils/displayWidth.js';

/**
 * TUI-C92 — how many terminal rows Ink draws a plain `<Text>` on at a given width.
 *
 * A budget that counts rows before they are drawn cannot ask the layout engine, so it has to
 * predict what Ink will do. Ink wraps a `<Text>` with `wrap-ansi` in its `hard: true, trim: false`
 * mode — greedy word wrap on spaces, with a word wider than the row broken across rows — and
 * `ceil(width / columns)` is a lower bound on that: three words of thirty-nine cells at a width of
 * seventy-six take three rows where the division says two, and every such row is a row the
 * prompt takes from something else. So this mirrors the wrapping itself, for text with no ANSI
 * escapes, measured with the same `displayWidth` every other budget here is spent in.
 *
 * **The arithmetic is not trusted on its own.** `textRows.spec.tsx` renders a battery of strings
 * through Ink at several widths and asserts this function's answer equals the rows Ink drew; that
 * comparison is the contract, and a change to Ink's wrapping is meant to fail there rather than
 * surface as a prompt off the bottom of the screen.
 *
 * `wrap-ansi` is deliberately neither a dependency of this package nor imported out of Ink's own
 * `node_modules`: the first would pin a second copy of what Ink already resolves, the second
 * reaches across a package boundary that a `pnpm` layout does not promise to keep in place.
 */

/** Grapheme-cluster boundaries — what a terminal draws as one glyph and `wrap-ansi` breaks between. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Tab stops, as `wrap-ansi` expands them before it wraps. */
const TAB_SIZE = 8;

/** Every printable ASCII character is one cluster of width one, so the segmenter can be skipped. */
const ASCII_PRINTABLE = /^[ -~]*$/;

interface Cluster {
  value: string;
  width: number;
}

function clusters(word: string): Cluster[] {
  if (ASCII_PRINTABLE.test(word)) {
    return [...word].map((value) => ({ value, width: 1 }));
  }
  const out: Cluster[] = [];
  for (const { segment } of GRAPHEMES.segment(word)) {
    out.push({ value: segment, width: displayWidth(segment) });
  }
  return out;
}

/** A line's tabs expanded to the next tab stop, measured in columns as `wrap-ansi` does. */
function expandTabs(line: string): string {
  if (!line.includes('\t')) return line;
  let visible = 0;
  let expanded = '';
  let sinceTab = '';
  const parts = line.split('\t');
  for (const [index, part] of parts.entries()) {
    expanded += part;
    sinceTab += part;
    if (index < parts.length - 1) {
      visible += displayWidth(sinceTab);
      sinceTab = '';
      const spaces = TAB_SIZE - (visible % TAB_SIZE);
      expanded += ' '.repeat(spaces);
      visible += spaces;
    }
  }
  return expanded;
}

/** The rows of one line, per `wrap-ansi`'s `exec` in `{ hard: true, trim: false }` mode. */
function lineRows(line: string, columns: number): number {
  // The rows built so far, as their visible widths: the last entry is the row being filled.
  const rows: number[] = [0];
  const words = line.split(' ');
  for (const [index, word] of words.entries()) {
    const width = displayWidth(word);
    if (index > 0) {
      // The space between words. With `trim: false` a row already at the width gets a new row
      // for it, and the space is always written, even at the start of a row.
      if (rows[rows.length - 1] >= columns) rows.push(0);
      rows[rows.length - 1] += 1;
    }
    if (width > columns) {
      // A word wider than the row is broken across rows. It starts on this row only when doing
      // so costs no more breaks than starting on the next.
      const remaining = columns - rows[rows.length - 1];
      const breaksStartingThisRow = 1 + Math.floor((width - remaining - 1) / columns);
      const breaksStartingNextRow = Math.floor((width - 1) / columns);
      if (breaksStartingNextRow < breaksStartingThisRow) rows.push(0);
      wrapWord(rows, word, columns);
      continue;
    }
    if (rows[rows.length - 1] + width > columns && rows[rows.length - 1] > 0 && width > 0) {
      rows.push(0);
    }
    rows[rows.length - 1] += width;
  }
  return rows.length;
}

/**
 * Break one over-wide word across rows, cluster by cluster: a cluster that would overflow the row
 * starts a new one, a row filled exactly ends when more clusters follow, and a final row holding
 * only zero-width clusters folds back into the row before it.
 */
function wrapWord(rows: number[], word: string, columns: number): void {
  const parts = clusters(word);
  // Characters on the row being filled, so a trailing zero-width row can be told from an empty one.
  let charsOnRow = 0;
  for (const [index, { value, width }] of parts.entries()) {
    const visible = rows[rows.length - 1];
    if (width > 0 && visible > 0 && visible + width > columns) {
      rows.push(0);
      charsOnRow = 0;
    }
    rows[rows.length - 1] += width;
    charsOnRow += value.length;
    if (rows[rows.length - 1] === columns && index < parts.length - 1) {
      rows.push(0);
      charsOnRow = 0;
    }
  }
  if (rows[rows.length - 1] === 0 && charsOnRow > 0 && rows.length > 1) rows.pop();
}

/**
 * The rows Ink draws `text` on in a `<Text>` given `width` columns, for text that carries no ANSI
 * escapes. Zero for the empty string, which Ink measures as no rows at all. A width below one is
 * read as one, the way the callers here clamp theirs.
 */
export function wrappedRows(text: string, width: number): number {
  if (text.length === 0) return 0;
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const rawLines = text.split('\n');
  // Ink wraps nothing while the widest line fits: the rows are then simply the lines.
  if (rawLines.every((line) => displayWidth(line) <= columns)) return rawLines.length;
  return text
    .normalize()
    .replaceAll('\r\n', '\n')
    .split('\n')
    .reduce((rows, line) => rows + lineRows(expandTabs(line), columns), 0);
}
