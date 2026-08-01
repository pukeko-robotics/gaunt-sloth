/**
 * TUI-C37 — the hit-region registry: which component owns the cell the user clicked.
 *
 * A component registers a rectangle and gets clicks inside it. It never does coordinate arithmetic
 * itself, which is the point — the arithmetic has exactly one tricky step and it should be wrong or
 * right in one place rather than in each consumer.
 *
 * **The one tricky step.** A terminal reports clicks in ABSOLUTE screen cells: row 0 is the top of
 * the visible viewport, not the top of anything Ink drew. Ink's live region is the block it
 * re-renders each frame, and it sits at the BOTTOM of the viewport — committed `<Static>` output has
 * scrolled above it. So a region's position within the live frame has to be offset by where that
 * frame starts on screen, which is {@link liveRegionOrigin}.
 *
 * **`<Static>` content is out of reach, permanently.** Committed turns are written into real
 * scrollback; Ink cannot re-render them and the terminal reports nothing that distinguishes a click
 * on scrolled-off history from a click on the row that now occupies that cell. Clicks therefore
 * resolve against the live region only. That is a property of the terminal, not a gap to fill in
 * later — consumers should design for it rather than try to defeat it.
 */

import type { MouseEvent } from '#src/tui/mouseParser.js';

/** A rectangle claimed by a component, in cells relative to the top-left of the live region. */
export interface HitRegion {
  /** Caller-chosen identity, unique per registry. Re-registering the same id replaces it. */
  id: string;
  /** 0-based row offset from the top of the live region. */
  top: number;
  /** 0-based column offset from the left edge. */
  left: number;
  width: number;
  height: number;
}

/** A click that landed inside a registered region, with coordinates made local to it. */
export interface HitRegionEvent extends MouseEvent {
  /** Column relative to the region's left edge. */
  localColumn: number;
  /** Row relative to the region's top edge. */
  localRow: number;
}

export type HitRegionHandler = (event: HitRegionEvent) => void;

/**
 * Where the live region's first row sits in absolute screen coordinates.
 *
 * Ink pins the live frame to the bottom of the viewport, so the origin is simply the terminal
 * height minus the frame height. Clamped at 0 for the case that actually happens in practice: a
 * frame taller than the window, where the top rows have scrolled off and the visible part starts at
 * row 0.
 */
export function liveRegionOrigin(terminalRows: number, liveHeight: number): number {
  return Math.max(0, terminalRows - liveHeight);
}

/** Is an absolute cell inside this region, given where the live frame starts on screen? */
export function regionContains(region: HitRegion, row: number, column: number, origin: number) {
  const top = origin + region.top;
  return (
    row >= top &&
    row < top + region.height &&
    column >= region.left &&
    column < region.left + region.width
  );
}

/**
 * Registry of clickable rectangles.
 *
 * Deliberately not a React structure: registration happens in a layout effect and lookup happens in
 * an input handler, and keeping the store outside React state means a click resolves against what
 * is on screen right now rather than against a render that may not have committed yet.
 */
export class HitRegionRegistry {
  private readonly regions = new Map<string, { region: HitRegion; handler: HitRegionHandler }>();

  /** Claim a rectangle. Re-registering an existing id replaces it (a re-measure after a resize). */
  register(region: HitRegion, handler: HitRegionHandler): () => void {
    this.regions.set(region.id, { region, handler });
    return () => this.unregister(region.id);
  }

  unregister(id: string): void {
    this.regions.delete(id);
  }

  clear(): void {
    this.regions.clear();
  }

  /** Every currently claimed region, in registration order. Exposed for tests and debugging. */
  list(): HitRegion[] {
    return [...this.regions.values()].map((entry) => entry.region);
  }

  /**
   * Find the region under an absolute cell, or `undefined`.
   *
   * Later registrations win when rectangles overlap: a region registered on top of another is the
   * one visually in front, so it is the one the user believes they clicked.
   */
  find(row: number, column: number, origin: number): HitRegion | undefined {
    let found: HitRegion | undefined;
    for (const { region } of this.regions.values()) {
      if (regionContains(region, row, column, origin)) found = region;
    }
    return found;
  }

  /**
   * Route an event to the region under it. Returns true when a handler ran, so the caller can tell
   * a click that was consumed from one that landed on empty space.
   */
  dispatch(event: MouseEvent, origin: number): boolean {
    const hit = this.find(event.row, event.column, origin);
    if (!hit) return false;
    const entry = this.regions.get(hit.id);
    if (!entry) return false;
    entry.handler({
      ...event,
      localColumn: event.column - hit.left,
      localRow: event.row - (origin + hit.top),
    });
    return true;
  }
}
