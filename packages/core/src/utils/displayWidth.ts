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
 * ## What the slices cut: text, with its escapes carried along
 *
 * The slices are ANSI-aware, and they agree with {@link displayWidth} by construction. An escape
 * sequence is not one cluster — the terminal swallows it whole, but `ESC`, `[`, `3`, `5`, `m`
 * segment as five, four of them printable. A walk that spent budget on those printable bytes
 * would answer a different question from the ruler it is paired with, since `string-width` strips
 * escapes before measuring; and at a budget narrower than the content it would cut INSIDE a
 * sequence, handing the terminal a mutilated escape.
 *
 * So a sequence is an indivisible token costing zero columns. It is kept whole, and it is carried
 * along with the text it introduces, so a truncated coloured string still renders coloured. A
 * sequence whose text is entirely cut away is dropped with that text rather than left dangling at
 * the end of the result, where it would style nothing and leak its colour into whatever the caller
 * appends next — an ellipsis, the next parameter, the status tag.
 *
 * **The result stays a genuine prefix (or suffix) of the input: no reset is appended.** Terminal
 * state belongs to the surface that owns the line, and both render surfaces already open and close
 * their own styling around each line they draw; an `ESC[0m` injected at the cut would close that
 * wrapper early and un-style everything after it.
 *
 * Because escapes cost no budget, the clusters kept sum to the width of the string as
 * {@link displayWidth} measures it, so the cluster walk decides "does the whole string fit?" on
 * its own — incrementally, stopping at the budget, WITHOUT a pre-measurement of the input. That is
 * what keeps a megabyte-long preview line from being measured end to end before it is cut at
 * column 200, and it is why the escape-bearing case needs no separate ruler.
 *
 * The one input the two do not agree on is an escape sequence placed INSIDE a grapheme cluster,
 * between a base character and its combining mark. The measurement strips the sequence and joins
 * what is left into one cluster; the walk cannot, because the sequence has already broken the
 * cluster in two. The walk then counts such a string WIDER than it renders, which spends budget
 * that is not needed and can leave a slice short — never over its budget, which is the direction
 * that matters.
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
 * sequences are not counted, so a pre-coloured string measures as what the user sees — and the
 * slices below share that awareness, so a coloured string may be handed to either of them.
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

/**
 * The code points a sequence can begin with: `ESC` (U+001B) and the one-byte `CSI` (U+009B) — the
 * same two characters `string-width` itself tests for before it strips.
 */
const ESCAPE_INTRODUCER_CODES = new Set([0x00_1b, 0x00_9b]);

/**
 * One ANSI escape sequence — an OSC string, or a CSI/two-character sequence — as a source pattern.
 *
 * This is the grammar of `ansi-regex`, which is what `strip-ansi` matches with and therefore what
 * `string-width` removes before it measures. It is reproduced here rather than imported so the walk
 * can never end up on a DIFFERENT copy of that package from the one `string-width` resolves: two
 * versions in one tree would let the ruler and the walk disagree about where a sequence ends, which
 * is the exact defect this module's ANSI-awareness exists to prevent. The spec cross-checks this
 * pattern against `strip-ansi` itself, so a divergence fails loudly rather than silently.
 *
 * The OSC payload stops at the first terminator character instead of scanning ahead for one, so an
 * unterminated OSC introducer cannot rescan the rest of the input — which is what keeps the walk
 * linear on a long line full of half-written escapes rather than quadratic.
 */
const ANSI_SEQUENCE_SOURCE = [
  '(?:\\u001B\\][^\\u0007\\u001B\\u009C]*(?:\\u0007|\\u001B\\u005C|\\u009C))',
  '[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]',
].join('|');

/**
 * The same grammar anchored with the sticky flag, so it answers "does a sequence START here?" in
 * one step at a known index rather than searching forward for the next one anywhere in the string.
 *
 * Module-level, because compiling it per slice would tax the common case that never uses it. Its
 * `lastIndex` is written immediately before every `exec`, with nothing in between, so a second walk
 * that begins while the first is suspended cannot observe a stale position.
 */
const ANSI_SEQUENCE_AT_INDEX = new RegExp(ANSI_SEQUENCE_SOURCE, 'y');

/** One indivisible piece of a string: a whole escape sequence, or one whole grapheme cluster. */
interface WidthToken {
  text: string;
  /** True for a whole escape sequence: zero columns, never cut into, never measured. */
  escape: boolean;
}

/**
 * The pieces of `text` in order — whole escape sequences and whole grapheme clusters, the only
 * units either slice is allowed to cut between.
 *
 * Lazy, and that is the point: the head slice stops pulling at its budget, so a megabyte-long line
 * costs the length of the RESULT rather than the length of the input.
 *
 * An escape introducer is always its own cluster, because the segmentation rules break on both
 * sides of a control character — so a sequence can only ever begin where a cluster begins, and one
 * anchored match there settles how far it runs. The clusters it spans are then skipped. A cluster
 * that STRADDLES the end of a sequence (a combining mark binding to the sequence's final byte)
 * yields only the part beyond it, so the pieces always reassemble into the input exactly.
 */
function* widthTokens(text: string): Generator<WidthToken> {
  let index = 0;
  for (const { segment, index: at } of GRAPHEME_SEGMENTER.segment(text)) {
    const end = at + segment.length;
    if (end <= index) continue; // wholly inside a sequence already yielded
    if (at < index) {
      // Straddles the end of that sequence: only what lies beyond it is still unyielded.
      const rest = text.slice(index, end);
      index = end;
      yield { text: rest, escape: false };
      continue;
    }
    if (segment.length === 1 && ESCAPE_INTRODUCER_CODES.has(segment.charCodeAt(0))) {
      ANSI_SEQUENCE_AT_INDEX.lastIndex = at;
      const match = ANSI_SEQUENCE_AT_INDEX.exec(text);
      if (match !== null) {
        index = at + match[0].length;
        yield { text: match[0], escape: true };
        continue;
      }
      // An introducer that begins no sequence falls through as an ordinary cluster. It is a
      // control character, so it measures zero and costs no budget either way.
    }
    index = end;
    yield { text: segment, escape: false };
  }
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
 * rather than chosen here so a caller cannot end up measured by one and cut by the other — reading
 * the budget narrow and spending it wide would hand back a string that overruns the very budget the
 * caller asked to be held to.
 *
 * The input is measured ONCE, incrementally, by the walk itself: escapes cost nothing, so the
 * clusters kept sum to what {@link displayWidth} would report for them, and "does the whole string
 * fit?" is answered by reaching the end rather than by a separate pass over the input first.
 *
 * Escapes are held back until a cluster is actually kept, so a sequence whose text all falls
 * outside the budget is dropped with it instead of trailing the result and colouring whatever the
 * caller appends next.
 */
function sliceHeadToWidth(
  text: string,
  maxWidth: number,
  measure: (text: string) => number
): string {
  if (maxWidth <= 0) return '';
  let width = 0;
  let kept = '';
  let pendingEscapes = '';
  for (const token of widthTokens(text)) {
    if (token.escape) {
      pendingEscapes += token.text;
      continue;
    }
    const clusterWidth = measure(token.text);
    if (width + clusterWidth > maxWidth) return kept;
    width += clusterWidth;
    kept += pendingEscapes + token.text;
    pendingEscapes = '';
  }
  // Every token fitted, so the answer is the input itself — returned rather than reassembled, so
  // a caller comparing the result with what it passed in gets the identity it is testing for.
  return text;
}

/**
 * The longest TRAILING run of whole clusters whose total width is at most `maxWidth` — i.e. keep
 * the tail, lose the head. The mirror of {@link sliceToWidth}, for values whose end is the
 * informative part (a path's leaf directory).
 *
 * This one materialises the pieces: it walks backwards, and both cluster and sequence boundaries
 * are only derivable from the front. Its callers pass a path or a model id, so the input is a line
 * rather than a file.
 *
 * Keeping the END means the escapes that OPENED a style sit in the discarded head and go with it,
 * so a tail comes back in the terminal's default styling. Only the sequences inside the kept span
 * are carried, which leaves the tail ending in whatever state the whole string ended in — the cut
 * introduces no bleed of its own.
 */
export function sliceEndToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const all = [...widthTokens(text)];
  let width = 0;
  let kept = '';
  let pendingEscapes = '';
  for (let index = all.length - 1; index >= 0; index--) {
    const token = all[index];
    if (token.escape) {
      pendingEscapes = token.text + pendingEscapes;
      continue;
    }
    const clusterWidth = displayWidth(token.text);
    if (width + clusterWidth > maxWidth) return kept;
    width += clusterWidth;
    kept = token.text + pendingEscapes + kept;
    pendingEscapes = '';
  }
  return text;
}
