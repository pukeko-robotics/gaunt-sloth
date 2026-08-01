import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HitRegionRegistry,
  liveRegionOrigin,
  regionContains,
  type HitRegion,
} from '#src/tui/hitRegions.js';
import type { MouseEvent } from '#src/tui/mouseParser.js';

const press = (row: number, column: number): MouseEvent => ({
  type: 'press',
  button: 'left',
  row,
  column,
  shift: false,
  meta: false,
  ctrl: false,
});

const region = (over: Partial<HitRegion> = {}): HitRegion => ({
  id: 'r',
  top: 0,
  left: 0,
  width: 10,
  height: 2,
  ...over,
});

describe('liveRegionOrigin', () => {
  it('places the live frame at the bottom of the viewport', () => {
    // A 24-row terminal showing a 6-row live frame: the frame starts at absolute row 18.
    expect(liveRegionOrigin(24, 6)).toBe(18);
  });

  it('clamps to 0 when the frame is taller than the window', () => {
    // The top has scrolled off, so what is visible starts at row 0 — not at a negative row.
    expect(liveRegionOrigin(10, 30)).toBe(0);
  });

  it('is the whole screen when the frame fills it', () => {
    expect(liveRegionOrigin(24, 24)).toBe(0);
  });
});

describe('regionContains', () => {
  const origin = 20;

  it('matches a cell inside the rectangle, offset by the live-frame origin', () => {
    expect(regionContains(region({ top: 1 }), 21, 5, origin)).toBe(true);
  });

  it('excludes the row just above and the row just past the bottom edge', () => {
    const r = region({ top: 1, height: 2 }); // absolute rows 21-22
    expect(regionContains(r, 20, 5, origin)).toBe(false);
    expect(regionContains(r, 23, 5, origin)).toBe(false);
  });

  it('excludes the column just past the right edge', () => {
    const r = region({ left: 2, width: 4 }); // columns 2-5
    expect(regionContains(r, 20, 5, origin)).toBe(true);
    expect(regionContains(r, 20, 6, origin)).toBe(false);
  });

  it('does not match a click above the live frame — that is <Static> scrollback', () => {
    expect(regionContains(region(), 3, 5, origin)).toBe(false);
  });
});

describe('HitRegionRegistry', () => {
  let registry: HitRegionRegistry;

  beforeEach(() => {
    vi.resetAllMocks();
    registry = new HitRegionRegistry();
  });

  it('routes a click to the region under it', () => {
    const handler = vi.fn();
    registry.register(region({ id: 'banner', top: 0, height: 5, width: 40 }), handler);

    expect(registry.dispatch(press(20, 3), 20)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reports a miss without calling any handler', () => {
    const handler = vi.fn();
    registry.register(region({ id: 'banner' }), handler);

    expect(registry.dispatch(press(20, 50), 20)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('gives the handler coordinates local to its own region', () => {
    const handler = vi.fn();
    registry.register(region({ id: 'panel', top: 2, left: 4, width: 10, height: 3 }), handler);

    // Live frame starts at row 20, so the region occupies absolute rows 22-24, columns 4-13.
    registry.dispatch(press(23, 6), 20);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ localRow: 1, localColumn: 2 }));
  });

  it('forwards the event kind, so a consumer can act on a press and ignore the release', () => {
    const handler = vi.fn();
    registry.register(region({ id: 'panel' }), handler);

    registry.dispatch({ ...press(20, 1), type: 'release' }, 20);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'release' }));
  });

  it('gives an overlapping click to the region registered last — the one visually in front', () => {
    const behind = vi.fn();
    const front = vi.fn();
    registry.register(region({ id: 'behind', width: 20, height: 5 }), behind);
    registry.register(region({ id: 'front', width: 20, height: 5 }), front);

    registry.dispatch(press(20, 1), 20);

    expect(front).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();
  });

  it('replaces a region when the same id re-registers, rather than accumulating stale rectangles', () => {
    const first = vi.fn();
    const second = vi.fn();
    registry.register(region({ id: 'same', top: 0, height: 1 }), first);
    registry.register(region({ id: 'same', top: 4, height: 1 }), second);

    expect(registry.list()).toHaveLength(1);
    // The OLD rectangle must no longer match, or a resized component keeps a phantom hit area.
    expect(registry.dispatch(press(20, 1), 20)).toBe(false);
    expect(registry.dispatch(press(24, 1), 20)).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('stops routing to an unregistered region', () => {
    const handler = vi.fn();
    const unregister = registry.register(region({ id: 'gone' }), handler);

    unregister();

    expect(registry.dispatch(press(20, 1), 20)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('tracks the frame moving as the live region grows', () => {
    const handler = vi.fn();
    registry.register(region({ id: 'row-zero', top: 0, height: 1, width: 5 }), handler);

    // Same region, same click position on screen, but a taller frame starts higher up — so the
    // cell that used to be row 0 of the frame is now some other row.
    expect(registry.dispatch(press(20, 1), 20)).toBe(true);
    expect(registry.dispatch(press(20, 1), 18)).toBe(false);
    expect(registry.dispatch(press(18, 1), 18)).toBe(true);
  });
});
