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
 * That asymmetry is also why a slice decides "does the whole string fit?" two different ways. For
 * plain text the cluster walk decides it: the widths of the clusters sum to the width of the
 * string, so walking until the budget is blown answers the question and answers it WITHOUT
 * touching the rest of the input — which is what keeps a megabyte-long preview line from being
 * measured end to end before it is cut at column 200. Only escape-bearing text is measured whole
 * first, because there the two rulers disagree and a coloured string that MEASURES as fitting must
 * be handed back whole rather than cut short by the bytes of its own escapes.
 *
 * ## Why ambiguous-width characters stay NARROW — and the one place they must not
 *
 * `string-width` defaults to treating East-Asian "Ambiguous" characters as one column, and that
 * default is load-bearing here rather than incidental: the sloth face is block elements, the
 * wordmark is box-drawing, and `…` is U+2026 — all Ambiguous. Counting them as two columns would
 * measure the 16-column face at 32 and shatter the layout it anchors. So {@link displayWidth} and
 * {@link sliceToWidth} keep the default, and the specs pin the face at 16 and the wordmark at 19 so
 * a change of that policy fails loudly instead of quietly doubling the art.
 *
 * That default is an **assumption about the reader's terminal**, and it is one this process cannot
 * check: an Ambiguous character occupies one cell or two depending on how the terminal is
 * configured, and several CJK locales — plus an option in xterm, urxvt and mlterm — choose two.
 * For layout art that assumption is free, because being wrong only makes the art look wrong.
 *
 * It is **not** free where a budget is a security boundary. {@link maxDisplayWidth} and
 * {@link sliceToMaxWidth} are the sanctioned exception: they measure Ambiguous as **two** columns,
 * i.e. the widest a terminal can render the string, so text fitted with them fits under *either*
 * policy. Use them wherever a row that overruns its budget would be wrapped by the terminal into a
 * consequence rather than into an untidy screen — `core/shell/framing` frames untrusted text this
 * way, because there a wrapped continuation line starts at column 0 and can forge a dialog's chrome.
 * The cost is under-fill: on a terminal that does render Ambiguous narrow, such a row can stop short
 * of its budget. Under-fill is cosmetic; overrun is not. True Wide characters (CJK ideographs,
 * emoji, fullwidth forms) measure 2 under both, so the common CJK case is unaffected either way.
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

/**
 * Terminal columns `text` occupies **at most** — the same measurement as {@link displayWidth} but
 * counting East-Asian Ambiguous characters as two columns rather than one, which is the widest any
 * terminal will render them.
 *
 * For a budget that must hold on a terminal whose ambiguous-width policy is unknown, this is the
 * only sound ruler: it is the supremum over the policies a terminal can be configured with, so a
 * string that fits under it fits under all of them. See the module docblock for when to reach for
 * this rather than {@link displayWidth}.
 */
export function maxDisplayWidth(text: string): number {
  return stringWidth(text, { ambiguousIsNarrow: false });
}

/**
 * The first grapheme cluster of `text`, or `''` when it is empty — i.e. the smallest piece a cut
 * can leave behind, for a caller that has to make progress through a string one drawable glyph at
 * a time.
 */
export function firstCluster(text: string): string {
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) return segment;
  return '';
}

/** The clusters of `text`, in order — the only unit either slice is allowed to cut between. */
function clusters(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) out.push(segment);
  return out;
}

/**
 * Whether the whole-string measurement is the only ruler that can answer "does this fit" for
 * `text` — true exactly when it carries an escape introducer (`ESC`, or the one-byte `CSI`), the
 * two characters `string-width` itself strips on. On anything else the cluster widths sum to the
 * whole-string width, so the walk decides the same question incrementally and a pre-measurement
 * would be a second full pass over the input for nothing.
 */
function needsWholeStringMeasure(text: string): boolean {
  return text.includes('\u001B') || text.includes('\u009B');
}

/**
 * The longest LEADING run of whole clusters whose total width is at most `maxWidth` — i.e. keep
 * the head, lose the tail. Total (never throws): a non-positive `maxWidth` yields `''`.
 *
 * A cluster is kept only if it fits ENTIRELY, so the result can come back one column short of
 * `maxWidth` when the next cluster is two columns wide. That is the point: half a wide glyph
 * cannot be drawn, and spending the column anyway is how text over-runs its budget.
 *
 * The clusters are produced one at a time and the walk stops at the budget, so the cost is the
 * length of the RESULT rather than the length of the input — the input here is a whole tool-output
 * line, which is unbounded.
 */
export function sliceToWidth(text: string, maxWidth: number): string {
  return sliceHeadToWidth(text, maxWidth, displayWidth);
}

/**
 * {@link sliceToWidth} measured by {@link maxDisplayWidth} — the head that fits the budget on any
 * terminal, whatever it does with Ambiguous characters. The cut for a budget that must hold rather
 * than merely look right.
 */
export function sliceToMaxWidth(text: string, maxWidth: number): string {
  return sliceHeadToWidth(text, maxWidth, maxDisplayWidth);
}

/**
 * The head-slice both public cuts are made of, given the ruler to measure with. The ruler is passed
 * rather than chosen here so the whole-string shortcut and the cluster walk can never end up on
 * different ones — measuring the shortcut narrow and the walk wide would hand back a string that
 * overruns the very budget the caller asked to be held to.
 */
function sliceHeadToWidth(
  text: string,
  maxWidth: number,
  measure: (text: string) => number
): string {
  if (maxWidth <= 0) return '';
  if (needsWholeStringMeasure(text) && measure(text) <= maxWidth) return text;
  let width = 0;
  let kept = '';
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    const clusterWidth = measure(segment);
    if (width + clusterWidth > maxWidth) break;
    width += clusterWidth;
    kept += segment;
  }
  return kept;
}

/**
 * The longest TRAILING run of whole clusters whose total width is at most `maxWidth` — i.e. keep
 * the tail, lose the head. The mirror of {@link sliceToWidth}, for values whose end is the
 * informative part (a path's leaf directory).
 *
 * This one materialises the clusters: it walks backwards, and cluster boundaries are only
 * derivable from the front. Its callers pass a path or a model id, so the input is a line rather
 * than a file.
 */
export function sliceEndToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (needsWholeStringMeasure(text) && displayWidth(text) <= maxWidth) return text;
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
