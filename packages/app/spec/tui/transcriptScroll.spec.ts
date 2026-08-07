import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BlockLayout,
  contentBottomRow,
  contentTopRow,
  cutRow,
  isComposingKeystroke,
  normalizeScroll,
  pageRows,
  resolveCut,
  scrollTranscript,
  WHEEL_ROWS_PER_NOTCH,
} from '#src/tui/transcriptScroll.js';

/**
 * TUI-C48 — the row arithmetic behind the scroll position, away from Ink.
 *
 * Every number here is a MEASURED row in the real design, so the fixtures are measurements too:
 * a list of blocks with a top and a height, exactly what `measureElement` plus the yoga walk hand
 * back. The point of testing it here rather than only through `<App>` is that the failure modes are
 * off-by-ones, and an off-by-one in this module shows up on screen as "the wheel scrolled a bit too
 * far", which no rendering assertion states precisely enough to catch.
 */

/** Blocks laid out end to end from `top`, which is what a column of rows really produces. */
function stack(heights: number[], top = 0): BlockLayout[] {
  const blocks: BlockLayout[] = [];
  let cursor = top;
  heights.forEach((height, index) => {
    blocks.push({ index, top: cursor, height });
    cursor += height;
  });
  return blocks;
}

describe('transcriptScroll — reading a layout', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports the top and bottom of the mounted content', () => {
    const blocks = stack([3, 5, 2], -4);
    expect(contentTopRow(blocks)).toBe(-4);
    expect(contentBottomRow(blocks)).toBe(6);
  });

  it('ignores zero-height blocks, which have no row for the edge to sit on', () => {
    // The tail block is empty whenever nothing is streaming and the intro is gone, and it still
    // reports itself. Counting it would put the bottom of the content on a row that draws nothing.
    const blocks: BlockLayout[] = [...stack([4, 3]), { index: 2, top: 7, height: 0 }];
    expect(contentBottomRow(blocks)).toBe(7);
    expect(resolveCut(blocks, 7)).toEqual({ bottomIndex: 1, visibleRows: 3 });
  });

  it('reports nothing at all when nothing is mounted', () => {
    expect(contentTopRow([])).toBeNull();
    expect(contentBottomRow([])).toBeNull();
    expect(resolveCut([], 3)).toBeNull();
  });

  it('resolves a cut to the block it lands inside, counting from that block top', () => {
    const blocks = stack([4, 3, 5]);
    expect(resolveCut(blocks, 1)).toEqual({ bottomIndex: 0, visibleRows: 1 });
    expect(resolveCut(blocks, 4)).toEqual({ bottomIndex: 0, visibleRows: 4 });
    // A cut exactly on a boundary belongs to the block ABOVE it: naming the block below with zero
    // visible rows is a clip that draws nothing and collapses its own measurements.
    expect(resolveCut(blocks, 5)).toEqual({ bottomIndex: 1, visibleRows: 1 });
    expect(resolveCut(blocks, 7)).toEqual({ bottomIndex: 1, visibleRows: 3 });
    expect(resolveCut(blocks, 12)).toEqual({ bottomIndex: 2, visibleRows: 5 });
  });

  it('gives the current cut row for an anchor, and the content bottom when stuck', () => {
    const blocks = stack([4, 3, 5]);
    expect(cutRow(blocks, null)).toBe(12);
    expect(cutRow(blocks, { bottomIndex: 1, visibleRows: 2 })).toBe(6);
    // An anchor naming a block that is no longer mounted — one frame after /clear.
    expect(cutRow(blocks, { bottomIndex: 9, visibleRows: 1 })).toBeNull();
  });
});

describe('transcriptScroll — moving the edge', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const blocks = stack([10, 10, 10, 10]); // 40 rows of content
  const viewportRows = 12;

  it('scrolls up by exactly the rows asked for, across a block boundary', () => {
    // From the bottom (row 40), three rows up is row 37 — still inside the last block.
    expect(
      scrollTranscript({
        blocks,
        scroll: null,
        deltaRows: -3,
        viewportRows,
        atStart: true,
        atEnd: true,
      })
    ).toEqual({ bottomIndex: 3, visibleRows: 7 });
    // Eleven rows up is row 29, which is one row into the block before it. The walk across the
    // boundary is where an item-granular design would have jumped a whole block instead.
    expect(
      scrollTranscript({
        blocks,
        scroll: null,
        deltaRows: -11,
        viewportRows,
        atStart: true,
        atEnd: true,
      })
    ).toEqual({ bottomIndex: 2, visibleRows: 9 });
  });

  it('scrolls back down to exactly where it came from', () => {
    const up = scrollTranscript({
      blocks,
      scroll: null,
      deltaRows: -11,
      viewportRows,
      atStart: true,
      atEnd: true,
    });
    const down = scrollTranscript({
      blocks,
      scroll: up,
      deltaRows: 11,
      viewportRows,
      atStart: true,
      atEnd: true,
    });
    // Back at the end means stuck again, not an anchor that merely happens to sit at the bottom —
    // otherwise new output would stop following.
    expect(down).toBeNull();
  });

  it('stops at the bottom of the mounted content when more is mounted below it', () => {
    // The slice does not reach the newest block, so the bottom is not the end of the conversation
    // and the gesture must not be read as "back to following".
    const next = scrollTranscript({
      blocks,
      scroll: { bottomIndex: 1, visibleRows: 4 },
      deltaRows: 999,
      viewportRows,
      atStart: false,
      atEnd: false,
    });
    expect(next).toEqual({ bottomIndex: 3, visibleRows: 10 });
  });

  it('will not scroll so far up that the content stops covering the region', () => {
    // 40 rows of content, a 12-row region: the highest the edge may go is row 12. A gesture asking
    // for more is clamped there rather than opening a blank band above the conversation.
    expect(
      scrollTranscript({
        blocks,
        scroll: null,
        deltaRows: -999,
        viewportRows,
        atStart: true,
        atEnd: true,
      })
    ).toEqual({ bottomIndex: 1, visibleRows: 2 });
  });

  it('may rise to the first mounted row while there is still older output to mount', () => {
    // The mirror of the case above, and the one that decides whether a page gesture is a page. Not
    // at the start, so the limit is not "leave a region above the edge" — that would cap the move
    // at whatever the previous frame happened to have mounted, which is a region's worth, so a
    // page gesture would move a fraction of a page. The slice is re-cut around the new anchor in
    // the same render, so naming the topmost mounted row is safe.
    expect(
      scrollTranscript({
        blocks,
        scroll: null,
        deltaRows: -999,
        viewportRows,
        atStart: false,
        atEnd: true,
      })
    ).toEqual({ bottomIndex: 0, visibleRows: 1 });
  });

  it('does not move at all when the whole conversation fits in the region', () => {
    const short = stack([3, 2]);
    expect(
      scrollTranscript({
        blocks: short,
        scroll: null,
        deltaRows: -20,
        viewportRows,
        atStart: true,
        atEnd: true,
      })
    ).toBeNull();
  });

  it('composes gestures that arrive before a re-render', () => {
    // Ink dispatches every keystroke in one stdin chunk synchronously, so three notches run against
    // one committed layout. Composing them must equal one gesture of the same size.
    let scroll = null as ReturnType<typeof scrollTranscript>;
    for (let i = 0; i < 3; i++) {
      scroll = scrollTranscript({
        blocks,
        scroll,
        deltaRows: -WHEEL_ROWS_PER_NOTCH,
        viewportRows,
        atStart: true,
        atEnd: true,
      });
    }
    expect(scroll).toEqual(
      scrollTranscript({
        blocks,
        scroll: null,
        deltaRows: -9,
        viewportRows,
        atStart: true,
        atEnd: true,
      })
    );
    expect(scroll).toEqual({ bottomIndex: 3, visibleRows: 1 });
  });
});

describe('transcriptScroll — normalizing an anchor the layout moved under', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const viewportRows = 12;

  it('hands back the SAME object when nothing needs to move', () => {
    // This identity is the convergence guard: the caller only re-renders when it gets a different
    // object, so an equal-but-new object here would be an endless measure/render loop.
    const blocks = stack([10, 10, 10, 10]);
    const scroll = { bottomIndex: 2, visibleRows: 4 };
    expect(normalizeScroll({ blocks, scroll, viewportRows, atStart: false, atEnd: true })).toBe(
      scroll
    );
  });

  it('pulls the edge back inside a block that got shorter', () => {
    // Ctrl+T re-folds every committed tool panel, so the anchored block can shrink under the edge.
    // Left alone the clip would keep its old height and quietly reveal the block BELOW it — the
    // position would have moved without a gesture, which is worse than a visible gap.
    const blocks = stack([10, 3, 10, 10]);
    expect(
      normalizeScroll({
        blocks,
        scroll: { bottomIndex: 1, visibleRows: 8 },
        viewportRows,
        atStart: false,
        atEnd: true,
      })
    ).toEqual({ bottomIndex: 1, visibleRows: 3 });
  });

  it('drops the edge until the region is covered once the oldest output is mounted', () => {
    // This is what settles Ctrl+Home: asking for the first row of the first item mounts the top of
    // the conversation, and the next commit lowers the edge until the region is full.
    const blocks = stack([10, 10, 10, 10]);
    expect(
      normalizeScroll({
        blocks,
        scroll: { bottomIndex: 0, visibleRows: 1 },
        viewportRows,
        atStart: true,
        atEnd: true,
      })
    ).toEqual({ bottomIndex: 1, visibleRows: 2 });
  });

  it('leaves a short edge alone while there is still older output to mount', () => {
    // Not at the start: more conversation exists above, it just is not mounted yet. Dropping the
    // edge here would undo the scroll the reader just asked for.
    const blocks = stack([10, 10, 10, 10]);
    const scroll = { bottomIndex: 0, visibleRows: 1 };
    expect(normalizeScroll({ blocks, scroll, viewportRows, atStart: false, atEnd: true })).toBe(
      scroll
    );
  });

  it('returns to following the newest output when the anchored block is gone', () => {
    // /clear replaces the transcript under the viewport. There is no position to preserve.
    expect(
      normalizeScroll({
        blocks: stack([4, 4]),
        scroll: { bottomIndex: 17, visibleRows: 2 },
        viewportRows,
        atStart: true,
        atEnd: true,
      })
    ).toBeNull();
  });

  it('converges: normalizing its own output changes nothing', () => {
    const blocks = stack([10, 3, 10, 10]);
    const once = normalizeScroll({
      blocks,
      scroll: { bottomIndex: 1, visibleRows: 8 },
      viewportRows,
      atStart: true,
      atEnd: true,
    });
    const twice = normalizeScroll({
      blocks,
      scroll: once,
      viewportRows,
      atStart: true,
      atEnd: true,
    });
    expect(twice).toBe(once);
  });
});

describe('transcriptScroll — gesture sizes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('pages by the region less one row of overlap, and never by zero', () => {
    expect(pageRows(24)).toBe(23);
    expect(pageRows(1)).toBe(1);
    expect(pageRows(0)).toBe(1);
  });

  it('moves three lines per wheel notch', () => {
    expect(WHEEL_ROWS_PER_NOTCH).toBe(3);
  });

  it('treats a printable character as composing, and a chord or a control key as not', () => {
    expect(isComposingKeystroke('a', {})).toBe(true);
    expect(isComposingKeystroke('/', {})).toBe(true);
    expect(isComposingKeystroke('é', {})).toBe(true);
    expect(isComposingKeystroke('', {})).toBe(false);
    expect(isComposingKeystroke('\r', {})).toBe(false);
    expect(isComposingKeystroke('\x1b', {})).toBe(false);
    expect(isComposingKeystroke('\t', {})).toBe(false);
    // Ctrl+T and the like are commands, not composition.
    expect(isComposingKeystroke('t', { ctrl: true })).toBe(false);
    expect(isComposingKeystroke('t', { meta: true })).toBe(false);
  });
});
