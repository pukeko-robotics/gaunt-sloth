/**
 * @module displayWidth
 * The one place this repo answers "how many terminal COLUMNS does this string occupy, and where
 * may I cut it". Everything that fits text to a terminal — the launch banner's field budgets, the
 * tool-display caps — measures and slices through here.
 *
 * ## Why a code-point count is not a width
 *
 * `[...text].length` counts code points, which is right for UTF-16 safety and wrong for layout: a
 * CJK ideograph or an emoji is ONE code point occupying TWO columns. Text measured that way reads
 * as shorter than it renders, escapes whatever budget it was given, and wraps — and a wrapped
 * continuation line starts back at column 0, which is precisely the failure the budgets exist to
 * prevent. So the rule is: a value destined for a fixed column budget is measured with
 * {@link displayWidth} and cut with {@link sliceToWidth} / {@link sliceEndToWidth}, never with
 * `.length`, a spread, or `String.prototype.slice`.
 *
 * ## Why grapheme clusters are the cutting unit
 *
 * Slicing by code point is safe against halving a surrogate pair but not against halving a
 * CLUSTER: a flag, a skin-toned or ZWJ-joined emoji, or a base letter plus its combining mark are
 * several code points that a terminal draws as one glyph, and cutting between them produces
 * mojibake or an orphaned mark. `Intl.Segmenter` gives the same cluster boundaries the width
 * rules below are defined over, so the two agree by construction and a sliced string's width is
 * exactly the sum of the widths of the clusters kept.
 *
 * ## What the slices expect: PLAIN text
 *
 * {@link displayWidth} is ANSI-aware and the slices are NOT, and that asymmetry is a contract
 * rather than an oversight. An escape sequence is not one cluster — the terminal swallows it
 * whole, but `ESC`, `[`, `3`, `5`, `m` segment as five, four of them printable — so the two
 * disagree on an escape-bearing string and a slice can both under-fill its budget and cut inside
 * a sequence. Feed the slices the text a user will read, and colour it afterwards; that is what
 * every caller here does, since both render surfaces map a style tag to their own escapes at the
 * very end. Making the slices ANSI-aware would change what a coloured preview line renders as,
 * which is a decision for whoever needs it and not a silent detail of this module.
 *
 * ## Why ambiguous-width characters stay NARROW
 *
 * `string-width` defaults to treating East-Asian "Ambiguous" characters as one column, and that
 * default is load-bearing here rather than incidental: the sloth face is block elements, the
 * wordmark is box-drawing, and `…` is U+2026 — all Ambiguous. Counting them as two columns would
 * measure the 16-column face at 32 and shatter the layout it anchors. Do not pass
 * `ambiguousIsNarrow: false`; the specs pin the face at 16 and the wordmark at 19 so a change of
 * that policy fails loudly instead of quietly doubling the art.
 */
import stringWidth from 'string-width';

/**
 * Grapheme-cluster boundaries, i.e. what a terminal draws as one glyph. Built once: constructing
 * an `Intl.Segmenter` is expensive relative to the short strings this module handles.
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Terminal columns `text` occupies. Zero-width clusters (combining marks, default-ignorables)
 * count 0, wide clusters (CJK, emoji, fullwidth forms) count 2, everything else 1. ANSI escape
 * sequences are not counted, so a pre-coloured string measures as what the user sees — but the
 * slices below do not share that awareness, so do not read this as a licence to feed them one.
 */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

/** The clusters of `text`, in order — the only unit either slice is allowed to cut between. */
function clusters(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) out.push(segment);
  return out;
}

/**
 * The longest LEADING run of whole clusters whose total width is at most `maxWidth` — i.e. keep
 * the head, lose the tail. Total (never throws): a non-positive `maxWidth` yields `''`.
 *
 * A cluster is kept only if it fits ENTIRELY, so the result can come back one column short of
 * `maxWidth` when the next cluster is two columns wide. That is the point: half a wide glyph
 * cannot be drawn, and spending the column anyway is how text over-runs its budget.
 */
export function sliceToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;
  let width = 0;
  let kept = '';
  for (const cluster of clusters(text)) {
    const clusterWidth = displayWidth(cluster);
    if (width + clusterWidth > maxWidth) break;
    width += clusterWidth;
    kept += cluster;
  }
  return kept;
}

/**
 * The longest TRAILING run of whole clusters whose total width is at most `maxWidth` — i.e. keep
 * the tail, lose the head. The mirror of {@link sliceToWidth}, for values whose end is the
 * informative part (a path's leaf directory).
 */
export function sliceEndToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;
  const all = clusters(text);
  let width = 0;
  let kept = '';
  for (let index = all.length - 1; index >= 0; index--) {
    const clusterWidth = displayWidth(all[index]);
    if (width + clusterWidth > maxWidth) break;
    width += clusterWidth;
    kept = all[index] + kept;
  }
  return kept;
}
