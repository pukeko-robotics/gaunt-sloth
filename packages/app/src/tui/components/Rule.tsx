import React, { useEffect, useState } from 'react';
import { Text, useStdout } from 'ink';

/** Width used when the terminal width is unknown (non-TTY / tests). */
const DEFAULT_COLUMNS = 80;
/** Never draw a rule narrower than this, even on a tiny / mis-reported terminal. */
const MIN_WIDTH = 1;

/**
 * Pure width math for the rule, factored out of React so it is unit-testable without a
 * terminal. Given the live `stdout.columns` (which Ink/Node leaves `undefined` when not
 * attached to a TTY), return the number of `─` glyphs to draw: the full column count,
 * falling back to {@link DEFAULT_COLUMNS} when unknown, and clamped to {@link MIN_WIDTH}
 * so it can never collapse to 0/negative.
 */
export function ruleWidth(columns: number | undefined): number {
  const cols = typeof columns === 'number' && Number.isFinite(columns) ? columns : DEFAULT_COLUMNS;
  return Math.max(MIN_WIDTH, Math.floor(cols));
}

/**
 * A dim, full-width horizontal rule. Single-sourced so the two places that delimit regions
 * stay visually identical: between committed turns in the {@link Transcript}, and bracketing
 * the input dock at the bottom of the screen (status bar + prompt + hint) so the controls
 * read as a distinct zone rather than blending into the scrollback.
 *
 * The rule spans the live terminal width via {@link useStdout} and re-renders on resize.
 * Callers may pass an explicit `width` (e.g. when they already measure one); otherwise it
 * auto-fills the current terminal.
 */
export function Rule({ width }: { width?: number } = {}): React.ReactElement {
  const { stdout } = useStdout();
  // Re-render on resize: track the live column count in state and update it from the
  // stdout 'resize' event. Recomputing is just the repeat count, so this stays cheap.
  const [columns, setColumns] = useState<number | undefined>(stdout?.columns);

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setColumns(stdout.columns);
    // Sync once in case columns changed between initial state and effect subscription.
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const count = ruleWidth(width ?? columns);
  return <Text dimColor>{'─'.repeat(count)}</Text>;
}
