/**
 * TUI-C48 — where the transcript viewport's bottom edge sits, and how a scroll gesture moves it.
 *
 * The alternate screen has no terminal scrollback, so the conversation is only reachable if we
 * scroll it ourselves. Everything in this module is a pure function over **measured** block
 * geometry: no estimate reaches it, so a drifting height estimate can never become a wrong scroll
 * position. {@link transcriptWindowStart} still decides how many items to MOUNT and is still a
 * deliberate lower bound; this decides where the edge sits among what was mounted.
 *
 * **The anchor is an item, and it is measured from that item's TOP.** A viewport pinned by a global
 * row offset drifts the moment anything below it grows — a streaming turn adds rows every chunk, so
 * the rows the user is reading would crawl up the screen while they read. Anchoring at
 * `visibleRows` rows below the top of block `bottomIndex` makes that impossible: growth below the
 * cut cannot move a row that is above it, and no arithmetic runs to keep it there. That is also why
 * this is counted from the top rather than the brief's `subRows` from the bottom — the two agree
 * for a committed item, which never changes height, and only the top-relative form is stable for
 * the streaming turn.
 *
 * **`stuck` is `null`.** Following new output is the default and is not an anchor at all: the
 * layout pins the tail, so there is nothing to keep in step.
 */

/** Where the viewport's bottom edge sits. `null` everywhere else in the app means "stuck". */
export interface TranscriptScroll {
  /**
   * The block the bottom edge cuts through. `0 … items.length - 1` are transcript items;
   * `items.length` is the tail block (the intro chrome and the streaming turn).
   */
  bottomIndex: number;
  /**
   * How many of that block's rows are visible, counted from **its top**. Always at least 1: a
   * zero-height clip collapses every child measurement to zero (measured), which would strand the
   * scroll with no geometry to move by.
   */
  visibleRows: number;
}

/** One mounted block's measured geometry. Rows, in the frame's own coordinates. */
export interface BlockLayout {
  /** Block index — the same numbering as {@link TranscriptScroll.bottomIndex}. */
  index: number;
  /** Rows from the top of the frame to this block's top. Negative when it is clipped off the top. */
  top: number;
  /** The block's own height. Unaffected by the clip it sits in (measured). */
  height: number;
}

/** Blocks that can hold the cut. A zero-height block has no row for the edge to sit on. */
function measurable(blocks: BlockLayout[]): BlockLayout[] {
  return blocks.filter((b) => b.height > 0);
}

/** The frame row just past the bottom of the mounted content, or null when nothing is mounted. */
export function contentBottomRow(blocks: BlockLayout[]): number | null {
  const usable = measurable(blocks);
  if (usable.length === 0) return null;
  return Math.max(...usable.map((b) => b.top + b.height));
}

/** The frame row of the top of the mounted content, or null when nothing is mounted. */
export function contentTopRow(blocks: BlockLayout[]): number | null {
  const usable = measurable(blocks);
  if (usable.length === 0) return null;
  return Math.min(...usable.map((b) => b.top));
}

/**
 * The frame row the bottom edge currently sits on: the bottom of the mounted content when stuck,
 * otherwise `visibleRows` below the anchored block's top.
 *
 * Returns null when the anchor names a block that is not mounted — which happens for exactly one
 * frame after the transcript is replaced under the viewport (`/clear`), and is the caller's cue to
 * fall back to the bottom rather than to compute against geometry that is not there.
 */
export function cutRow(blocks: BlockLayout[], scroll: TranscriptScroll | null): number | null {
  if (scroll === null) return contentBottomRow(blocks);
  const anchor = blocks.find((b) => b.index === scroll.bottomIndex);
  if (!anchor || anchor.height <= 0) return null;
  return anchor.top + scroll.visibleRows;
}

/**
 * The anchor whose bottom edge falls on frame row `cut`.
 *
 * The cut belongs to the block whose rows it lands *inside*, taking the bottom edge of a block as
 * belonging to that block rather than to the next one — otherwise a cut exactly on a boundary
 * would name the block below it with `visibleRows` of 0, which does not render.
 */
export function resolveCut(blocks: BlockLayout[], cut: number): TranscriptScroll | null {
  const usable = measurable(blocks);
  if (usable.length === 0) return null;
  for (const block of usable) {
    if (cut > block.top && cut <= block.top + block.height) {
      return { bottomIndex: block.index, visibleRows: cut - block.top };
    }
  }
  // Above everything mounted: sit on the first row of the topmost block. Below everything: the
  // caller has already decided whether that means "stuck", so pin the last block's bottom.
  const first = usable[0];
  const last = usable[usable.length - 1];
  if (cut <= first.top) return { bottomIndex: first.index, visibleRows: 1 };
  return { bottomIndex: last.index, visibleRows: last.height };
}

export interface ScrollRequest {
  /** Measured geometry of every mounted block, ascending by index. */
  blocks: BlockLayout[];
  /** The anchor to move, or null when currently stuck to the bottom. */
  scroll: TranscriptScroll | null;
  /** Rows to move the bottom edge by. Negative moves towards older output. */
  deltaRows: number;
  /** The measured height of the conversation region. */
  viewportRows: number;
  /** Whether the mounted slice reaches the first transcript item. */
  atStart: boolean;
  /** Whether the mounted slice reaches the newest block. */
  atEnd: boolean;
}

/**
 * Move the bottom edge by `deltaRows` and return the new anchor, or `null` for "stuck to bottom".
 *
 * Two clamps, and both are measured rather than assumed:
 *
 * - **The bottom.** Past the end of the mounted content the answer is "stuck" — but only when the
 *   mounted slice actually reaches the newest block. Otherwise the edge stops at the bottom of what
 *   is mounted, the next frame mounts more below it, and the gesture continues.
 * - **The top.** Once the slice reaches the oldest output, the edge may not rise so far that the
 *   conversation cannot fill the region below it — there is genuinely nothing above to fill it
 *   with, and a gesture that went further would open a blank band. While there is still older
 *   output to mount, the only limit is the first row of the topmost mounted block: the edge names
 *   an item, the slice is re-cut around that item in the very same render, so the region comes back
 *   full with no intermediate frame. Clamping to a region's worth THERE would make a page gesture
 *   move only as far as the previous frame happened to have mounted.
 */
export function scrollTranscript(request: ScrollRequest): TranscriptScroll | null {
  const { blocks, scroll, deltaRows, viewportRows, atStart, atEnd } = request;
  const bottom = contentBottomRow(blocks);
  const top = contentTopRow(blocks);
  if (bottom === null || top === null) return scroll;

  const current = cutRow(blocks, scroll) ?? bottom;
  const minCut = atStart
    ? Math.min(bottom, top + Math.max(1, viewportRows))
    : Math.min(bottom, top + 1);
  const target = Math.min(bottom, Math.max(minCut, current + deltaRows));

  if (atEnd && target >= bottom) return null;
  return resolveCut(blocks, target);
}

/**
 * Bring an out-of-date anchor back inside its block, and fill the region when the content above the
 * edge has run short. Returns the same object when nothing needs to move — which is what stops
 * measure-then-clamp-then-render-then-measure from oscillating, since a state update that changes
 * nothing still re-renders.
 *
 * Both directions are reachable without a scroll gesture: `Ctrl+T` re-folds every committed tool
 * panel, and a resize re-wraps everything, so the block the edge was cutting through can be shorter
 * than the edge's own offset into it, or the content above can stop covering the region.
 */
export function normalizeScroll(request: {
  blocks: BlockLayout[];
  scroll: TranscriptScroll | null;
  viewportRows: number;
  atStart: boolean;
  atEnd: boolean;
}): TranscriptScroll | null {
  const { blocks, scroll, viewportRows, atStart, atEnd } = request;
  if (scroll === null) return null;
  const bottom = contentBottomRow(blocks);
  const top = contentTopRow(blocks);
  if (bottom === null || top === null) return scroll;

  const anchor = blocks.find((b) => b.index === scroll.bottomIndex);
  // The anchored block is gone or has collapsed to nothing — the transcript changed under the
  // viewport. Following the newest output is the only position that is certainly still meaningful.
  if (!anchor || anchor.height <= 0) return null;

  let cut = anchor.top + Math.min(scroll.visibleRows, anchor.height);
  // Nothing older is mounted and the content no longer covers the region: drop the edge until it
  // does, so the conversation cannot end up floating with blank screen above it.
  if (atStart) cut = Math.max(cut, Math.min(bottom, top + Math.max(1, viewportRows)));
  cut = Math.min(cut, bottom);

  if (atEnd && cut >= bottom) return null;
  const next = resolveCut(blocks, cut);
  if (next === null) return null;
  // Same values → same object, so the caller's `!==` check is enough to stop the loop.
  return next.bottomIndex === scroll.bottomIndex && next.visibleRows === scroll.visibleRows
    ? scroll
    : next;
}

/** Rows one page gesture moves, leaving a row of overlap so the reader keeps their place. */
export function pageRows(viewportRows: number): number {
  return Math.max(1, viewportRows - 1);
}

/** Rows one wheel notch moves. Andrew's decided binding. */
export const WHEEL_ROWS_PER_NOTCH = 3;

/**
 * Whether a keystroke is the user composing a message — the node's "typing returns you to the end".
 *
 * Only a character that would actually land in the prompt counts. A modifier chord is a command,
 * not composition, and Enter, Escape, Tab and the arrows arrive with an `input` that is a control
 * byte rather than something the reader typed; treating those as composition would make half the
 * keyboard silently cancel a scroll.
 */
export function isComposingKeystroke(
  input: string,
  key: { ctrl?: boolean; meta?: boolean }
): boolean {
  if (key.ctrl || key.meta) return false;
  return /[^\x00-\x1f\x7f]/.test(input);
}
