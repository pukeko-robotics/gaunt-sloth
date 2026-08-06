import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';

import { MouseProvider, useHitRegion, useMouseEnabled } from '#src/tui/useMouse.js';
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

/**
 * A test source standing in for the session module's bridge, so a spec can deliver a decoded event
 * exactly the way the real plumbing does.
 */
function mouseSource() {
  const listeners = new Set<(event: MouseEvent) => void>();
  return {
    subscribe: (listener: (event: MouseEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: (event: MouseEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/** A clickable box of a given height, claiming its rectangle through the real hook. */
function Clickable(props: { id: string; label: string; height: number; onClick: () => void }) {
  const ref = useHitRegion(props.id, (event) => {
    if (event.type === 'press') props.onClick();
  });
  return (
    <Box ref={ref} height={props.height} flexDirection="column">
      <Text>{props.label}</Text>
    </Box>
  );
}

/**
 * TUI-C37 — the hook and the provider working together against a real Ink render.
 *
 * The registry's arithmetic is proved in `hitRegions.spec.ts`. What only a render can prove is the
 * part that binds it to Ink: that `measureElement` plus the yoga offset walk produce a rectangle
 * that the frame origin actually resolves back onto, so a click at a terminal cell reaches the
 * component drawn at that cell.
 */
describe('tui useMouse', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * The absolute screen row of a given row of the rendered frame.
   *
   * TUI-C48 made this the identity: the frame is laid out to the whole terminal height, so it
   * starts at screen row 0 and a frame row IS a screen row. It stays a named helper rather than
   * being inlined so the assumption has one place to be wrong, and so a future layout that moved
   * the origin would have one place to be fixed.
   */
  const screenRow = (_frame: string | undefined, rowInFrame: number) => rowInFrame;

  it('delivers a click to the component rendered at that cell', () => {
    const source = mouseSource();
    const onClick = vi.fn();
    const { lastFrame, unmount } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <Clickable id="target" label="click me" height={1} onClick={onClick} />
      </MouseProvider>
    );

    source.emit(press(screenRow(lastFrame(), 0), 0));

    expect(onClick).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('routes to the right sibling when several are stacked', () => {
    const source = mouseSource();
    const first = vi.fn();
    const second = vi.fn();
    const { lastFrame } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <Clickable id="first" label="first" height={2} onClick={first} />
        <Clickable id="second" label="second" height={2} onClick={second} />
      </MouseProvider>
    );

    // Frame rows 0-1 are the first box, 2-3 the second.
    source.emit(press(screenRow(lastFrame(), 2), 0));

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('accumulates ancestor offsets, not just the element own position', () => {
    // Siblings alone cannot prove this: a walk that read only the element's own computed position
    // would still place them correctly, because their parent sits at the frame origin. Nesting the
    // target inside an offset container is what makes a missing ancestor walk observable.
    // The offset must live on the CONTAINER, not on the target: padding on a parent lands in the
    // child's own computed position, so it would survive a walk that never looks at ancestors.
    // Here the container is pushed down by a preceding sibling and indented by its own margin,
    // while the target's own position inside it is row 1, column 0.
    const source = mouseSource();
    const onClick = vi.fn();
    const { lastFrame } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <Box height={2} flexDirection="column">
          <Text>above</Text>
        </Box>
        <Box marginLeft={4} flexDirection="column">
          <Text>header</Text>
          <Clickable id="nested" label="deep" height={1} onClick={onClick} />
        </Box>
      </MouseProvider>
    );

    // True position: 2 (sibling) + 1 (own row in container) = row 3; 4 (container margin) = col 4.
    source.emit(press(screenRow(lastFrame(), 3), 4));
    expect(onClick).toHaveBeenCalledTimes(1);

    // Without the ancestor walk the claim would sit at row 1, column 0 — a click there must miss.
    onClick.mockClear();
    source.emit(press(screenRow(lastFrame(), 1), 0));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('ignores a click that lands outside every claimed rectangle', () => {
    const source = mouseSource();
    const onClick = vi.fn();
    render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <Clickable id="target" label="hi" height={1} onClick={onClick} />
      </MouseProvider>
    );

    // Well below the one-row frame — empty screen, which claims nothing.
    source.emit(press(12, 0));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not subscribe at all when mouse is disabled', () => {
    const source = mouseSource();
    const onClick = vi.fn();
    render(
      <MouseProvider subscribe={source.subscribe} enabled={false}>
        <Clickable id="target" label="hi" height={1} onClick={onClick} />
      </MouseProvider>
    );

    expect(source.listenerCount).toBe(0);
    source.emit(press(0, 0));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount, so a torn-down session stops receiving events', () => {
    const source = mouseSource();
    const { unmount } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <Text>hi</Text>
      </MouseProvider>
    );
    expect(source.listenerCount).toBe(1);

    unmount();

    expect(source.listenerCount).toBe(0);
  });

  it('stops routing to a component that has unmounted', () => {
    const source = mouseSource();
    const onClick = vi.fn();
    const { rerender, lastFrame } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <Clickable id="target" label="hi" height={1} onClick={onClick} />
      </MouseProvider>
    );

    rerender(
      <MouseProvider subscribe={source.subscribe} enabled>
        <Text>gone</Text>
      </MouseProvider>
    );
    source.emit(press(screenRow(lastFrame(), 0), 0));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('follows a component that moves as the frame reflows', () => {
    // The re-measure path: a component pushed down by new content above it must keep its rectangle
    // in step, or clicks land on whatever now occupies its old rows.
    const source = mouseSource();
    const onClick = vi.fn();
    const { rerender, lastFrame } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <Clickable id="target" label="hi" height={1} onClick={onClick} />
      </MouseProvider>
    );

    rerender(
      <MouseProvider subscribe={source.subscribe} enabled>
        <Box height={3} flexDirection="column">
          <Text>new</Text>
        </Box>
        <Clickable id="target" label="hi" height={1} onClick={onClick} />
      </MouseProvider>
    );

    // The target is now the LAST row of a taller frame: its offset within the frame changed, so a
    // claim left at its first measurement would no longer match.
    source.emit(press(screenRow(lastFrame(), 3), 0));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('reports the mouse state to components that adapt their hints', () => {
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useMouseEnabled());
      return <Text>probe</Text>;
    }
    render(
      <MouseProvider subscribe={mouseSource().subscribe} enabled={false}>
        <Probe />
      </MouseProvider>
    );

    expect(seen).toContain(false);
  });
});
