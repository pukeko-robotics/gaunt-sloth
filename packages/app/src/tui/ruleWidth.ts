/**
 * Pure width math for the TUI's full-width horizontal rules, with no React or Ink in scope.
 *
 * Two callers need it and only one of them is a component: {@link Rule} draws the live,
 * resize-aware rule, while the markdown renderer bakes rules into a committed string. Keeping
 * the math here is what lets `markdown.ts` stay a plain string→string module — importing it
 * from `components/Rule.tsx` would drag the whole Ink reconciler into a renderer whose contract
 * is to be dependency-light and never throw.
 */

/** Width used when the terminal width is unknown (non-TTY / tests). */
const DEFAULT_COLUMNS = 80;
/** Never draw a rule narrower than this, even on a tiny / mis-reported terminal. */
const MIN_WIDTH = 1;

/**
 * Given the live `stdout.columns` (which Ink/Node leaves `undefined` when not attached to a
 * TTY), return the number of `─` glyphs to draw: the full column count, falling back to
 * {@link DEFAULT_COLUMNS} when unknown, and clamped to {@link MIN_WIDTH} so it can never
 * collapse to 0/negative.
 */
export function ruleWidth(columns: number | undefined): number {
  const cols = typeof columns === 'number' && Number.isFinite(columns) ? columns : DEFAULT_COLUMNS;
  return Math.max(MIN_WIDTH, Math.floor(cols));
}
