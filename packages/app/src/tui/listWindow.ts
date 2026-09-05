/**
 * Windowing for a bounded, scrolling list — the keep-the-cursor-in-view arithmetic CFG-15 built for
 * `<SelectList>` and TUI-C92 shares with the slash-command menu.
 *
 * Pure functions over indices and row counts: nothing here reads a terminal, so a spec pins the
 * behaviour without one, and a later list (TUI-C80's input-history recall) can take the arithmetic
 * without taking either widget.
 */

/**
 * Standard "keep the cursor in view" windowing. Given the previous window start, the current
 * cursor index, the window `size` and total item `count`, return the window start that keeps
 * `cursor` visible while moving as little as possible (sticky: the window only shifts when the
 * cursor crosses an edge). Clamped to `[0, count - size]` so it never scrolls past either end,
 * which also makes wraparound (cursor jumping to the far end) resolve to that end cleanly.
 */
export function clampWindowStart(
  prevStart: number,
  cursor: number,
  size: number,
  count: number
): number {
  const maxStart = Math.max(0, count - size);
  let start = Math.min(Math.max(0, prevStart), maxStart);
  if (cursor < start) {
    start = cursor;
  } else if (cursor >= start + size) {
    start = cursor - size + 1;
  }
  return Math.max(0, Math.min(start, maxStart));
}

/** A window of a list that fits, affordance rows included, in a fixed number of display rows. */
export interface RowWindow {
  /** Index of the first entry drawn. */
  start: number;
  /** How many entries are drawn. */
  size: number;
  /** Entries to announce as hidden above the window on an `↑ N more` row; `0` draws no row. */
  hiddenAbove: number;
  /** Entries to announce as hidden below the window on a `↓ N more` row; `0` draws no row. */
  hiddenBelow: number;
}

/**
 * TUI-C92 — the sticky window around `cursor` that fits in `maxRows` display rows **including**
 * the affordance rows that announce what it hides.
 *
 * The affordances cost rows out of the same budget, so their presence is decided together with
 * the window rather than after it: a list longer than the budget needs at least one, and a window
 * that lands with entries on both sides of it needs both. When every entry fits nothing is hidden
 * and nothing is announced, so a short list looks exactly as it would unbounded.
 *
 * A budget of one or two rows cannot hold the highlighted entry and its affordances together; the
 * entry wins and nothing is announced. Below one row the budget is read as one, so a mis-reported
 * terminal can never collapse the window to nothing.
 */
export function windowWithinRows(
  prevStart: number,
  cursor: number,
  maxRows: number,
  count: number
): RowWindow {
  const budget = Number.isFinite(maxRows) ? Math.max(1, Math.floor(maxRows)) : 1;
  if (count <= budget) return { start: 0, size: count, hiddenAbove: 0, hiddenBelow: 0 };
  // More entries than rows, so one affordance row is certain; size the window without it, and
  // without a second when the window then sits with entries hidden on both sides. Shrinking the
  // window by one can only move its start forward by at most one, so a window that needed both
  // affordances at the larger size still needs both at the smaller one — the second pass is final.
  let size = Math.max(1, budget - 1);
  let start = clampWindowStart(prevStart, cursor, size, count);
  if (start > 0 && start + size < count) {
    size = Math.max(1, budget - 2);
    start = clampWindowStart(prevStart, cursor, size, count);
  }
  const hiddenAbove = start;
  const hiddenBelow = count - (start + size);
  const affordanceRows = (hiddenAbove > 0 ? 1 : 0) + (hiddenBelow > 0 ? 1 : 0);
  if (size + affordanceRows > budget) return { start, size, hiddenAbove: 0, hiddenBelow: 0 };
  return { start, size, hiddenAbove, hiddenBelow };
}
