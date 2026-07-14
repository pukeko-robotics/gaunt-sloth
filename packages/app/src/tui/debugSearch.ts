/**
 * Pure `less`-style incremental-search model for the docked `/debug` pane (TUI-C21).
 *
 * The search operates over the ACTIVE tab's rendered line model — the same `string[]` that
 * `debugPanelLines()` produces and that TUI-C11's viewport/scroll math already windows — so it
 * applies to every tab uniformly with ONE implementation (not a per-tab search) and can reuse the
 * existing scroll offset to jump the viewport to a match. Everything here is pure and
 * side-effect-free so it is unit-testable without rendering Ink; `<App>` owns the state and the
 * `<DebugPanel>` consumes the highlight segments.
 */

/** A run of a line, tagged whether it is part of a search match (for highlight rendering). */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Indices of the lines that contain `query`, case-insensitively. An empty query matches nothing
 * (so highlights and the count clear the moment the query is emptied). Matching is a plain
 * substring test — no regex, no smart-case (YAGNI, and it keeps the `less` idiom predictable).
 */
export function findMatches(lines: string[], query: string): number[] {
  if (query.length === 0) return [];
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) out.push(i);
  }
  return out;
}

/**
 * Step the current-match cursor with wrap-around. `current` and the return value are indices INTO
 * the `matches` array (0..n-1), not line indices; `dir` is +1 (next, `n`) or -1 (previous, `N`).
 * Past the last match wraps to the first and vice-versa. Returns -1 when there are no matches.
 */
export function stepMatch(matches: number[], current: number, dir: number): number {
  const n = matches.length;
  if (n === 0) return -1;
  return (((current + dir) % n) + n) % n;
}

/**
 * The scroll offset (top visible line) that brings `lineIndex` into view, clamped to the real
 * maximum exactly as TUI-C11's `clampDebugScroll` does — so jumping to a match can never push the
 * viewport past the end. The matched line is placed at the top of the window (or as close as the
 * clamp allows for matches near the end of the content).
 */
export function scrollOffsetForLine(
  lineIndex: number,
  viewportHeight: number,
  lineCount: number
): number {
  const maxOffset = Math.max(0, lineCount - viewportHeight);
  return Math.min(Math.max(0, lineIndex), maxOffset);
}

/**
 * Split `line` into alternating non-match / match runs for highlight rendering. Handles multiple
 * occurrences on one line; an empty query yields a single non-match segment (the whole line).
 * Case-insensitive, so the returned `text` preserves the ORIGINAL casing of the line.
 */
export function highlightSegments(line: string, query: string): HighlightSegment[] {
  if (query.length === 0) return [{ text: line, match: false }];
  const needle = query.toLowerCase();
  const hay = line.toLowerCase();
  const segs: HighlightSegment[] = [];
  let i = 0;
  while (i < line.length) {
    const idx = hay.indexOf(needle, i);
    if (idx === -1) {
      segs.push({ text: line.slice(i), match: false });
      break;
    }
    if (idx > i) segs.push({ text: line.slice(i, idx), match: false });
    segs.push({ text: line.slice(idx, idx + query.length), match: true });
    i = idx + query.length;
  }
  return segs;
}
