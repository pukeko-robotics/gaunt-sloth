/**
 * TUI-C37 — the React half of mouse support: a provider that routes decoded events into the
 * {@link HitRegionRegistry}, and the `useHitRegion` hook a component uses to claim a rectangle.
 *
 * A consumer never sees a coordinate. It attaches a ref to the Box it wants clickable and gets a
 * callback, which is the whole point of having a layer: [[TUI-C38]], [[TUI-C39]] and [[TUI-C40]]
 * sit on this rather than each re-deriving where Ink's live frame starts on screen.
 */

import React, { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { Box, measureElement, useStdout, type DOMElement } from 'ink';
import { HitRegionRegistry, liveRegionOrigin, type HitRegionHandler } from '#src/tui/hitRegions.js';
import type { MouseEvent } from '#src/tui/mouseParser.js';

/** Subscribe to decoded mouse events; returns an unsubscribe. Mirrors the App's other bridges. */
export type MouseSubscribe = (listener: (event: MouseEvent) => void) => () => void;

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
 * Wraps the live region, measures it, and dispatches clicks against it.
 *
 * The measured element is the live frame itself, so `origin` is recomputed whenever the frame grows
 * or the window resizes — the two things that would otherwise silently shift every registered
 * region by a few rows and make clicks land one panel off.
 */
export function MouseProvider({ subscribe, enabled, children }: MouseProviderProps) {
  const registryRef = useRef(new HitRegionRegistry());
  const liveRef = useRef<DOMElement | null>(null);
  const { stdout } = useStdout();
  // Read at dispatch time rather than captured in the subscription: a click must resolve against
  // the frame as it is now, not as it was when the listener was attached.
  const heightRef = useRef(0);

  useLayoutEffect(() => {
    if (liveRef.current) heightRef.current = measureElement(liveRef.current).height;
  });

  useEffect(() => {
    if (!enabled || !subscribe) return;
    const registry = registryRef.current;
    return subscribe((event) => {
      const rows = stdout?.rows ?? 24;
      registry.dispatch(event, liveRegionOrigin(rows, heightRef.current));
    });
  }, [enabled, subscribe, stdout]);

  return (
    <MouseContext.Provider value={{ registry: registryRef.current, enabled }}>
      <Box flexDirection="column" ref={liveRef}>
        {children}
      </Box>
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
  // inline arrow function is the natural way to write this and must not defeat it.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const active = enabled && mouseEnabled;

  useLayoutEffect(() => {
    if (!active || !ref.current) {
      registry.unregister(id);
      return;
    }
    const { width, height } = measureElement(ref.current);
    if (width === 0 || height === 0) {
      // Not laid out yet (or genuinely invisible) — an empty rectangle would swallow nothing but
      // could still match a zero-width click, so drop the claim instead of registering a phantom.
      registry.unregister(id);
      return;
    }
    const { top, left } = elementOffset(ref.current);
    return registry.register({ id, top, left, width, height }, (event) => handlerRef.current(event));
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
function elementOffset(element: DOMElement): { top: number; left: number } {
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
