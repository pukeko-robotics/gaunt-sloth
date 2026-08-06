/**
 * TUI-C48 — the React half of transcript scrolling: what the conversation region measures, and the
 * gestures that move its bottom edge.
 *
 * The arithmetic lives in `transcriptScroll.ts` as pure functions over measured rows. This file
 * only supplies the measurements and holds the anchor, and it is deliberately thin, because the
 * one thing that can make a scrolling viewport pathological is a measurement that feeds back into
 * render state. So:
 *
 * - **Nothing is measured during render, and no height is ever stored.** The geometry is read
 *   straight off the committed layout at the moment a gesture arrives. There is no height cache to
 *   invalidate, which is what makes a terminal resize free: the estimator re-slices, the region
 *   re-renders, and the next gesture measures the new heights. A cache here would cost a
 *   full re-measure on every width change — seconds of frozen terminal on a long session.
 * - **The one place measurement does reach state is the normalizer**, and it only ever runs when a
 *   clamped anchor genuinely differs from the held one. Without that guard, measure → clamp →
 *   render → measure is an infinite re-render: invisible in a test and obvious as a hot CPU.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { measureElement, type DOMElement } from 'ink';
import { elementOffset } from '#src/tui/useMouse.js';
import {
  type BlockLayout,
  normalizeScroll,
  pageRows,
  scrollTranscript,
  type TranscriptScroll,
} from '#src/tui/transcriptScroll.js';

/** What the conversation region publishes about itself after every commit. */
interface RegionState {
  /** The block index of the tail block (the intro chrome and the streaming turn). */
  tailIndex: number;
  /** Whether the mounted slice reaches the first transcript item. */
  atStart: boolean;
  /** Whether the mounted slice reaches the tail block. */
  atEnd: boolean;
}

/**
 * The live layout of the conversation region, read on demand.
 *
 * A mutable registry rather than state on purpose: a scroll gesture must see the layout the user is
 * actually looking at, and Ink dispatches every keystroke parsed out of one stdin chunk in a
 * synchronous loop — three wheel notches in one chunk all run before a single re-render. Reading
 * the committed layout each time is what makes them compose instead of all acting on the first.
 */
export class TranscriptGeometry {
  private readonly rows = new Map<number, DOMElement>();
  private viewport: DOMElement | null = null;
  private tail: DOMElement | null = null;
  private region: RegionState = { tailIndex: 0, atStart: true, atEnd: true };

  /** Claim a transcript item's row. The index is the item's position in the transcript, which
   *  never changes for a committed item, so the claim survives a memoised row not re-rendering. */
  registerRow(index: number, node: DOMElement | null): () => void {
    if (node) this.rows.set(index, node);
    return () => {
      if (this.rows.get(index) === node) this.rows.delete(index);
    };
  }

  /** Published by the region itself on every commit — the two nodes plus where the slice ends. */
  commit(input: {
    viewport: DOMElement | null;
    tail: DOMElement | null;
    region: RegionState;
  }): void {
    this.viewport = input.viewport;
    this.tail = input.tail;
    this.region = input.region;
  }

  /** Measured height of the conversation region, or 0 before the first layout. */
  viewportRows(): number {
    return this.viewport ? measureElement(this.viewport).height : 0;
  }

  get atStart(): boolean {
    return this.region.atStart;
  }

  get atEnd(): boolean {
    return this.region.atEnd;
  }

  /**
   * Every mounted block's position and height, ascending by index.
   *
   * Positions are accumulated up the yoga tree, so a block sitting inside the clip reports where it
   * really is rather than where the clip stops — which is exactly the geometry a scroll back down
   * needs, and the reason the blocks below the edge are mounted at all.
   */
  blocks(): BlockLayout[] {
    const out: BlockLayout[] = [];
    for (const [index, node] of this.rows) {
      if (!node.yogaNode) continue;
      out.push({
        index,
        top: elementOffset(node).top,
        height: measureElement(node).height,
      });
    }
    if (this.tail?.yogaNode) {
      out.push({
        index: this.region.tailIndex,
        top: elementOffset(this.tail).top,
        height: measureElement(this.tail).height,
      });
    }
    return out.sort((a, b) => a.index - b.index);
  }
}

export interface TranscriptScrollController {
  /** The held anchor, or null while the region follows new output. */
  scroll: TranscriptScroll | null;
  /** The region's measured height, which the region needs back to size its clip safely. */
  regionRows: number;
  /** Handed to the conversation region so it can publish its layout. */
  geometry: TranscriptGeometry;
  /** Move the bottom edge. Negative rows move towards older output. */
  scrollByRows: (deltaRows: number) => void;
  /** Move by whole regions. `-1` is one page towards older output. */
  scrollByPages: (pages: number) => void;
  /** Follow new output again — the position typing, `Esc` and `Ctrl+End` return to. */
  scrollToBottom: () => void;
  /** Jump to the oldest output the session still holds. */
  scrollToStart: () => void;
}

export function useTranscriptScroll(): TranscriptScrollController {
  const [scroll, setScroll] = useState<TranscriptScroll | null>(null);
  // Fed back into the region so its clip can never be taller than the region itself — see the
  // `regionRows` prop on `<TranscriptViewport>` for what goes wrong when it is. It is a fixed
  // point rather than a loop: the region is `flexGrow: 1` under a fixed-height frame beside a
  // non-shrinking dock, so its height is a function of the terminal and the dock and not of
  // anything drawn inside it.
  const [regionRows, setRegionRows] = useState(0);
  const [geometry] = useState(() => new TranscriptGeometry());
  // The handler's own view of the anchor. `scroll` in a closure is the value from the last render,
  // which is one gesture behind whenever a chunk carries more than one.
  const scrollRef = useRef<TranscriptScroll | null>(null);

  const apply = useCallback(
    (next: TranscriptScroll | null): void => {
      scrollRef.current = next;
      setScroll(next);
    },
    [setScroll]
  );

  const scrollByRows = useCallback(
    (deltaRows: number): void => {
      apply(
        scrollTranscript({
          blocks: geometry.blocks(),
          scroll: scrollRef.current,
          deltaRows,
          viewportRows: geometry.viewportRows(),
          atStart: geometry.atStart,
          atEnd: geometry.atEnd,
        })
      );
    },
    [apply, geometry]
  );

  const scrollByPages = useCallback(
    (pages: number): void => {
      scrollByRows(pages * pageRows(geometry.viewportRows()));
    },
    [scrollByRows, geometry]
  );

  const scrollToBottom = useCallback((): void => {
    apply(null);
  }, [apply]);

  // The oldest block is not mounted, so its height is unknown and the edge cannot be placed on it
  // directly. Asking for the first row of the first item is a position the normalizer then settles
  // — it mounts the top of the conversation, measures it, and drops the edge until the region is
  // full. One extra frame, and no estimate anywhere in it.
  const scrollToStart = useCallback((): void => {
    apply({ bottomIndex: 0, visibleRows: 1 });
  }, [apply]);

  // Runs after every commit, because the two things that invalidate an anchor without a gesture are
  // both silent: `Ctrl+T` re-folds every committed tool panel, and a resize re-wraps the whole
  // conversation. Either can leave the edge pointing past the bottom of the block it names — which
  // does NOT show as a gap, it quietly reveals the block below — or leave the content above the edge
  // too short to fill the region.
  useLayoutEffect(() => {
    const held = scrollRef.current;
    if (held === null) return;
    const next = normalizeScroll({
      blocks: geometry.blocks(),
      scroll: held,
      viewportRows: geometry.viewportRows(),
      atStart: geometry.atStart,
      atEnd: geometry.atEnd,
    });
    // The convergence guard. `normalizeScroll` hands back the very object it was given when nothing
    // moved, so this comparison is what stops the effect re-rendering itself for ever.
    if (next === held) return;
    scrollRef.current = next;
    setScroll(next);
  });

  useLayoutEffect(() => {
    const measured = geometry.viewportRows();
    // Only on a real change, for the same reason the normalizer above compares: a state update
    // that changes nothing still re-renders, and this effect runs after every one of them.
    setRegionRows((previous) => (previous === measured ? previous : measured));
  });

  return {
    scroll,
    regionRows,
    geometry,
    scrollByRows,
    scrollByPages,
    scrollToBottom,
    scrollToStart,
  };
}
