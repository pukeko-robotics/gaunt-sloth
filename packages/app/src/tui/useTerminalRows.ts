import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/**
 * Terminal height to assume when the stream does not report one — a headless or test renderer.
 * A real terminal always reports its own height, so this only ever governs a non-TTY render.
 */
export const FALLBACK_TERMINAL_ROWS = 24;

/**
 * The live terminal height, in rows.
 *
 * Ink recalculates its layout on `SIGWINCH` but does **not** re-render the React tree, so a
 * component that reads `stdout.rows` during render keeps the height it was mounted with. This
 * hook holds the value in state and refreshes it from the stdout `resize` event, which is what
 * keeps the full-screen frame the same height as the terminal after a resize instead of one
 * frame behind it.
 */
export function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState<number>(stdout?.rows || FALLBACK_TERMINAL_ROWS);

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setRows(stdout.rows || FALLBACK_TERMINAL_ROWS);
    // Sync once in case the terminal changed size between mount and this subscription.
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return rows;
}
