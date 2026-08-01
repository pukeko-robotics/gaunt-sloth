/**
 * TUI-C37 — the hit-region registry: which component owns the cell the user clicked.
 *
 * A component registers a rectangle and gets clicks inside it. It never does coordinate arithmetic
 * itself, which is the point — the arithmetic has exactly one tricky step and it should be wrong or
 * right in one place rather than in each consumer.
 *
 * **The one tricky step.** A terminal reports clicks in ABSOLUTE screen cells: row 0 is the top of
 * the visible viewport, not the top of anything Ink drew. So a region's position within the live
 * frame has to be offset by where that frame starts on screen, which is {@link liveRegionOrigin}.
 *
 * Where that is depends on how much has been printed. Ink paints the frame at the cursor, so at
 * launch it starts at row 0 with empty screen below, and only once output has scrolled the viewport
 * does it end on the last row. Assuming one or the other unconditionally is the single easiest way
 * to make every click land somewhere the user did not press.
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
 * **Ink does not pin the live frame to the bottom of the screen — it paints wherever the cursor
 * is.** That only coincides with the bottom once enough output has scrolled the screen full. At
 * launch it is the opposite: the TUI-C13 viewport bump homes the cursor, so the first frame is
 * painted at row 0 with the rest of the screen empty below it. Assuming the bottom there puts every
 * hit region a dozen rows below where it is drawn, which is why `rowsAbove` exists.
 *
 * `rowsAbove` is how much committed output sits above the frame. The frame starts there, unless
 * that would push it past the bottom of the screen — once content exceeds the viewport, the
 * terminal has scrolled and the frame ends on the last row.
 *
 * **The result is deliberately allowed to go negative, and must not be clamped.** When the frame is
 * taller than the window its top rows have scrolled off above the screen, so it starts at a row the
 * viewport cannot show — a 30-row frame in a 24-row terminal starts at -6, and the region sitting at
 * frame row 10 is on screen row 4. Clamping to 0 would shift every target down by the overflow.
 */
export function liveRegionOrigin(terminalRows: number, liveHeight: number, rowsAbove = 0): number {
  return Math.min(rowsAbove, terminalRows - liveHeight);
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
