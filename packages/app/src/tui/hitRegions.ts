/**
 * TUI-C37 — the hit-region registry: which component owns the cell the user clicked.
 *
 * A component registers a rectangle and gets clicks inside it. It never does coordinate arithmetic
 * itself, which is the point — the arithmetic has exactly one tricky step and it should be wrong or
 * right in one place rather than in each consumer.
 *
 * **The one tricky step, and why it is no longer tricky.** A terminal reports clicks in ABSOLUTE
 * screen cells: row 0 is the top of the visible viewport, not the top of anything Ink drew. Ink
 * paints its frame at the cursor, so where that frame starts used to depend on how much output had
 * scrolled past — exact at launch, exact once the screen had filled, and unresolvable in between.
 * TUI-C48's full-screen frame is laid out to the whole terminal height, so it starts at screen row
 * 0 unconditionally and a region's offset within the frame IS its screen row.
 *
 * **Everything on screen is in reach.** The transcript is a viewport the app owns and re-renders,
 * so a click on a committed turn lands on a mounted component rather than on terminal scrollback
 * that Ink could neither address nor redraw. What a click cannot reach is conversation scrolled out
 * of the viewport — it is not on screen, so the terminal never reports a cell for it.
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

  /**
   * Update a claimed rectangle's bounds in place, keeping its handler.
   *
   * Separate from {@link register} so a re-measure on every render does not delete and re-insert the
   * entry. That matters beyond efficiency: churning the map is a live-region-wide side effect, and
   * keeping entries stable means the set of claims does not silently reorder as unrelated
   * components re-render.
   */
  setBounds(id: string, bounds: Omit<HitRegion, 'id'>): void {
    const entry = this.regions.get(id);
    if (entry) entry.region = { id, ...bounds };
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
   * **The smallest matching rectangle wins.** Overlap here is almost always nesting — a clickable
   * caret inside a clickable panel — and the innermost thing under the cursor is what the user
   * believes they clicked.
   *
   * Registration order deliberately does NOT decide this. React runs layout effects child-first, so
   * children claim their rectangles before their parents do; a "last registration wins" rule would
   * therefore hand every click to the enclosing panel instead of the control inside it, and would
   * additionally shift as unrelated components re-rendered. Area is a property of the layout rather
   * than of render timing, so it stays stable.
   */
  find(row: number, column: number, origin: number): HitRegion | undefined {
    let found: HitRegion | undefined;
    let smallest = Number.POSITIVE_INFINITY;
    for (const { region } of this.regions.values()) {
      // A not-yet-measured claim is zero-area, and {@link regionContains} already excludes those —
      // its half-open bounds cannot admit a point when the extent is 0 — so there is no separate
      // guard here to drift out of step with that math.
      if (!regionContains(region, row, column, origin)) continue;
      const area = region.width * region.height;
      if (area < smallest) {
        smallest = area;
        found = region;
      }
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
