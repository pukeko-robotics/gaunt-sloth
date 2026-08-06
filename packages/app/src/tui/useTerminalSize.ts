import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/**
 * Size to assume when the stream does not report one — a headless or test renderer.
 * A real terminal always reports its own size, so these only ever govern a non-TTY render.
 */
export const FALLBACK_TERMINAL_ROWS = 24;
export const FALLBACK_TERMINAL_COLUMNS = 80;

export interface TerminalSize {
  rows: number;
  columns: number;
}

/**
 * The live terminal size.
 *
 * Ink recalculates its layout on `SIGWINCH` but does **not** re-render the React tree, so a
 * component that reads `stdout.rows` / `stdout.columns` during render keeps the size it was
 * mounted with. This hook holds both in state and refreshes them from the stdout `resize` event.
 *
 * Both halves are load-bearing, for different reasons. The **height** is the frame's own height:
 * stale, it leaves the dock short of the terminal floor after a grow, or overflowing the screen
 * after a shrink. The **width** is what tells the transcript viewport that its committed items
 * have to be re-rendered — they are memoised on their props, and without a width among them a
 * committed markdown turn would keep the fence rules it was first drawn with.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    rows: stdout?.rows || FALLBACK_TERMINAL_ROWS,
    columns: stdout?.columns || FALLBACK_TERMINAL_COLUMNS,
  }));

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void =>
      setSize((previous) => {
        const rows = stdout.rows || FALLBACK_TERMINAL_ROWS;
        const columns = stdout.columns || FALLBACK_TERMINAL_COLUMNS;
        // Same object when nothing moved, so an unrelated resize event cannot force a re-render
        // of every committed item in the viewport.
        return previous.rows === rows && previous.columns === columns
          ? previous
          : { rows, columns };
      });
    // Sync once in case the terminal changed size between mount and this subscription.
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
