import React, { useEffect, useState } from 'react';
import { Text, useStdout } from 'ink';
import { ruleWidth } from '#src/tui/ruleWidth.js';

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
