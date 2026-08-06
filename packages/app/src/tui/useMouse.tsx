/**
 * TUI-C37 — the React half of mouse support: a provider that routes decoded events into the
 * {@link HitRegionRegistry}, and the `useHitRegion` hook a component uses to claim a rectangle.
 *
 * A consumer never sees a coordinate. It attaches a ref to the Box it wants clickable and gets a
 * callback, which is the whole point of having a layer: [[TUI-C38]], [[TUI-C39]] and [[TUI-C40]]
 * sit on this rather than each re-deriving where Ink's live frame starts on screen.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Box, measureElement, type DOMElement } from 'ink';
import { HitRegionRegistry, type HitRegionHandler } from '#src/tui/hitRegions.js';
import type { MouseEvent } from '#src/tui/mouseParser.js';

/** Subscribe to decoded mouse events; returns an unsubscribe. Mirrors the App's other bridges. */
export type MouseSubscribe = (listener: (event: MouseEvent) => void) => () => void;

/**
 * Absolute screen row the live frame's first row sits on.
 *
 * TUI-C48 made this a constant rather than a guess. The frame is laid out to exactly the terminal
 * height, so it fills the alternate screen from its top row and every registered rectangle's frame
 * offset IS its screen row. Before that the origin had to be inferred from how much output had
 * scrolled past, which was exact at launch and exact once the screen had filled and wrong in
 * between — the window that put a click a few rows off its target.
 */
const FRAME_ORIGIN_ROW = 0;

interface MouseContextValue {
  registry: HitRegionRegistry;
  /** False when mouse is off — consumers use it to skip work and to keep hints honest. */
  enabled: boolean;
}

const MouseContext = createContext<MouseContextValue>({
  registry: new HitRegionRegistry(),
  enabled: false,
});

/** Is mouse input live this session? Components use it to gate mouse-only affordances and hints. */
export function useMouseEnabled(): boolean {
  return useContext(MouseContext).enabled;
}

export interface MouseProviderProps {
  /** The session's event source; absent when mouse is off. */
  subscribe?: MouseSubscribe;
  enabled: boolean;
  children: React.ReactNode;
}

/**
 * Wraps the live region and dispatches clicks against it.
 *
 * A region's claimed rectangle is an offset inside the frame, and the frame starts at screen row 0
 * (see {@link FRAME_ORIGIN_ROW}), so a claim maps to absolute screen cells with no arithmetic and
 * nothing to keep in step as the frame reflows.
 */
export function MouseProvider({ subscribe, enabled, children }: MouseProviderProps) {
  // The registry is rendered (it goes into the context value), so it is state, not a ref: a ref
  // would have to be read during render, and every render would build a throwaway registry just to
  // discard it. A `useState` initializer runs exactly once, which matters here because the object
  // holds the live registrations — recreating it would silently unclaim every hit region.
  const [registry] = useState(() => new HitRegionRegistry());

  useEffect(() => {
    if (!enabled || !subscribe) return;
    return subscribe((event) => {
      registry.dispatch(event, FRAME_ORIGIN_ROW);
    });
  }, [enabled, subscribe, registry]);

  return (
    <MouseContext.Provider value={{ registry, enabled }}>
      <Box flexDirection="column">{children}</Box>
    </MouseContext.Provider>
  );
}

/**
 * Claim a clickable rectangle. Attach the returned ref to the Box that should respond.
 *
 * Registration re-runs on every render so the rectangle follows the component as the frame reflows;
 * `measureElement` reports the box's own size, and its offset within the frame comes from walking
 * the yoga layout, so a component that moves down as the transcript grows stays correctly targeted.
 *
 * Handlers receive presses, drags, releases and wheel events alike — filter by `event.type`. Most
 * consumers want `type === 'press'` and should say so, or a click will fire twice.
 */
export function useHitRegion(id: string, handler: HitRegionHandler, enabled = true) {
  const ref = useRef<DOMElement | null>(null);
  const { registry, enabled: mouseEnabled } = useContext(MouseContext);
  // Held in a ref so re-registering does not depend on the caller memoizing its handler — an
  // inline arrow function is the natural way to write this and must not defeat it. Refreshed on
  // commit rather than during render: the committed handler is the one belonging to the frame the
  // user can actually click, and a layout effect lands it before control returns to the terminal,
  // so no event can reach a superseded one.
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  const active = enabled && mouseEnabled;

  // Claim once per mount. Kept separate from the re-measure below because a claim that is deleted
  // and re-inserted on every render would churn the registry for every component in the frame.
  useLayoutEffect(() => {
    if (!active) return;
    return registry.register({ id, top: 0, left: 0, width: 0, height: 0 }, (event) =>
      handlerRef.current(event)
    );
  }, [id, registry, active]);

  // Re-measure every render, so the rectangle follows the component as the frame reflows: a panel
  // moves down as the transcript grows, and a stale rectangle would leave a click landing on
  // whatever now occupies the old rows. A zero measurement means "not laid out yet", and `find`
  // skips zero-area claims rather than treating them as a hit.
  useLayoutEffect(() => {
    if (!active || !ref.current) return;
    const { width, height } = measureElement(ref.current);
    const { top, left } = elementOffset(ref.current);
    registry.setBounds(id, { top, left, width, height });
  });

  return ref;
}

/**
 * Walk an element's yoga layout up to the root to get its offset inside the live frame.
 *
 * `measureElement` deliberately reports size only, so position has to be accumulated from the
 * ancestors' computed layout — each yoga node knows where it sits inside its parent, and summing
 * that chain is what turns "this box is 5 rows tall" into "this box starts at row 12".
 */
export function elementOffset(element: DOMElement): { top: number; left: number } {
  let top = 0;
  let left = 0;
  let node: DOMElement | undefined = element;
  while (node?.yogaNode) {
    top += node.yogaNode.getComputedTop();
    left += node.yogaNode.getComputedLeft();
    node = node.parentNode as DOMElement | undefined;
  }
  return { top, left };
}
