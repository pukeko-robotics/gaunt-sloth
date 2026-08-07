import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { MouseProvider, useHitRegion } from '#src/tui/useMouse.js';
import { TranscriptViewport } from '#src/tui/components/TranscriptViewport.js';
import type { TranscriptScroll } from '#src/tui/transcriptScroll.js';
import type { TranscriptItem } from '#src/tui/types.js';
import type { MouseEvent } from '#src/tui/mouseParser.js';
import type { HitRegionEvent } from '#src/tui/hitRegions.js';

/**
 * TUI-C48 — a clickable region still resolves to the cell it is drawn on once the conversation
 * scrolls.
 *
 * The registry maps a click to whichever rectangle contains it, and a rectangle is re-measured from
 * the yoga layout on every render. Scrolling changes that layout by three separate mechanisms — a
 * different slice of items is mounted, the anchored block is lifted by a negative margin, and the
 * whole column is bottom-pinned inside a clip — so "the claim follows the component" is a property
 * of all three agreeing, not of any one of them.
 *
 * **Nothing in the app exercises this yet, and that is why it is asserted here.** `LaunchBanner` is
 * the only `useHitRegion` consumer in production, and it belongs to the intro chrome that is gone
 * after the first exchange, so it cannot coexist with a scrolled transcript. [[TUI-C38]] and
 * [[TUI-C39]] are what add real consumers inside the conversation; this is the guarantee they will
 * be built on, pinned before they arrive rather than discovered to be false afterwards.
 *
 * The assertion is deliberately not "the registered top is a number that changed". It reads the row
 * the probe is actually PAINTED on out of the frame, dispatches a real press at that row, and
 * requires the probe's own handler to receive it with the right local coordinates — so a registry
 * that lagged the layout fails, and so does one that merely moved by the wrong amount.
 */

const COLUMNS = 60;
const HEIGHT = 12;
const DOCK_ROWS = 2;
/** The region is whatever the dock leaves. `<TranscriptViewport>` needs it to cap its clip. */
const REGION_ROWS = HEIGHT - DOCK_ROWS;

const PROBE_ROWS = ['PROBE-a', 'PROBE-b', 'PROBE-c'];

const line = (id: number): TranscriptItem => ({
  kind: 'system',
  id,
  level: 'INFO',
  text: `line-${String(id).padStart(2, '0')}`,
});

function HitProbe({ onHit }: { onHit: (event: HitRegionEvent) => void }): React.ReactElement {
  const ref = useHitRegion('probe', onHit);
  return (
    <Box ref={ref} flexDirection="column">
      {PROBE_ROWS.map((text) => (
        <Text key={text}>{text}</Text>
      ))}
    </Box>
  );
}

/** A press at an absolute screen cell, as the SGR decoder would deliver it. */
const press = (row: number, column = 0): MouseEvent => ({
  type: 'press',
  button: 'left',
  column,
  row,
  shift: false,
  meta: false,
  ctrl: false,
});

function renderScene(scroll: TranscriptScroll | null, items: TranscriptItem[]) {
  const listeners = new Set<(event: MouseEvent) => void>();
  const hits: HitRegionEvent[] = [];
  const subscribe = (listener: (event: MouseEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const scene = (at: TranscriptScroll | null) => (
    <MouseProvider enabled subscribe={subscribe}>
      <Box flexDirection="column" height={HEIGHT}>
        <TranscriptViewport
          items={items}
          budgetRows={HEIGHT}
          columns={COLUMNS}
          scroll={at}
          regionRows={REGION_ROWS}
        >
          <HitProbe onHit={(event) => hits.push(event)} />
          <Text>{'TAIL-x'}</Text>
          <Text>{'TAIL-y'}</Text>
        </TranscriptViewport>
        <Box flexDirection="column" flexShrink={0}>
          {Array.from({ length: DOCK_ROWS }, (_, i) => (
            <Text key={i}>{`dock-${i}`}</Text>
          ))}
        </Box>
      </Box>
    </MouseProvider>
  );
  const result = render(scene(scroll));
  const frame = () => (result.lastFrame() ?? '').split('\n');
  return {
    ...result,
    hits,
    frame,
    /** Move the edge without remounting the tree, the way a scroll gesture does. */
    rerenderScroll: (at: TranscriptScroll | null) => result.rerender(scene(at)),
    /** Screen row the probe's first line is painted on, or -1 when it is not on screen. */
    probeRow: () => frame().findIndex((row) => row.includes(PROBE_ROWS[0])),
    click: (row: number) => {
      hits.length = 0;
      for (const listener of [...listeners]) listener(press(row));
      return hits;
    },
  };
}

describe('hit regions at a scroll offset (TUI-C48)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const items = Array.from({ length: 30 }, (_, i) => line(i));
  const tailIndex = items.length;

  // Following, then three anchored positions inside the tail block. The tail is five rows tall
  // (three probe rows plus two), so these walk the edge up through the probe itself.
  const positions: [string, TranscriptScroll | null][] = [
    ['following the newest output', null],
    ['anchored with the whole tail visible', { bottomIndex: tailIndex, visibleRows: 5 }],
    ['anchored with the edge just below the probe', { bottomIndex: tailIndex, visibleRows: 3 }],
    ['anchored with the edge inside the probe', { bottomIndex: tailIndex, visibleRows: 2 }],
    ['anchored on the probe’s first row', { bottomIndex: tailIndex, visibleRows: 1 }],
  ];

  it.each(positions)('resolves a press to the probe when %s', (_name, scroll) => {
    const scene = renderScene(scroll, items);

    const row = scene.probeRow();
    // The probe is on screen at every one of these positions — a case where it were not would
    // assert nothing at all, so this states it rather than skipping past it.
    expect(row).toBeGreaterThanOrEqual(0);

    // A press on the row the probe is PAINTED on reaches the probe, at its own first row.
    expect(scene.click(row).map((h) => h.localRow)).toEqual([0]);

    // The row above the probe belongs to the conversation, not to it: a claim that had not
    // followed the layout would still be sitting there.
    if (row > 0) expect(scene.click(row - 1)).toEqual([]);

    scene.unmount();
  });

  it('keeps the local row in step with the probe’s own rows, not with the screen', () => {
    // The distance is what states the property: a registry that tracked the scroll by the wrong
    // amount still resolves SOME row to the probe, and only the local coordinates say which.
    for (const [, scroll] of positions) {
      const scene = renderScene(scroll, items);
      const row = scene.probeRow();
      const visible = scene
        .frame()
        .slice(row)
        .filter((r) => PROBE_ROWS.some((p) => r.includes(p))).length;

      for (let offset = 0; offset < visible; offset += 1) {
        expect(scene.click(row + offset).map((h) => h.localRow)).toEqual([offset]);
      }

      scene.unmount();
    }
  });

  it('drops the claim entirely once the probe scrolls out of the mounted slice', () => {
    // The other half of the guarantee, and the one that fails silently: an unmounted consumer that
    // kept its rectangle would swallow clicks aimed at whatever now occupies those rows.
    //
    // The probe is mounted and PROVEN clickable first, then scrolled away. Starting already
    // scrolled away would assert nothing — the probe would never have claimed anything, so
    // "no hits" would hold on a registry that never released a claim in its life.
    const scene = renderScene(null, items);
    const row = scene.probeRow();
    expect(row).toBeGreaterThanOrEqual(0);
    expect(scene.click(row).map((h) => h.localRow)).toEqual([0]);

    scene.rerenderScroll({ bottomIndex: 4, visibleRows: 1 });

    expect(scene.probeRow()).toBe(-1);
    for (let screenRow = 0; screenRow < HEIGHT; screenRow += 1)
      expect(scene.click(screenRow)).toEqual([]);

    scene.unmount();
  });
});
