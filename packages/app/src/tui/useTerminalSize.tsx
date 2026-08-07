import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
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
 * The published terminal size, or null where no component above has published one.
 *
 * **One subscription per tree, and that is a hard requirement rather than a tidiness.** A resize
 * listener is a listener on Node's `stdout`, whose default `MaxListeners` is ten; components that
 * each subscribe make the count a function of how many of them are mounted, and the transcript
 * viewport mounts a rule per separator. Cross the limit and Node writes a four-line
 * `MaxListenersExceededWarning` through `console.error` — which Ink's default `patchConsole` routes
 * into the frame, so on the alternate screen the user gets a memory-leak warning shoved into their
 * session and the frame repainted under it. Raising the limit would only move the threshold and
 * mask the next genuine leak; publishing one subscription removes the cause, and collapses N
 * handler calls per SIGWINCH to one.
 */
const TerminalSizeContext = createContext<TerminalSize | null>(null);

/**
 * Publish a measured size to the subtree. The publisher is whoever owns the frame — `<App>` — and
 * it is the only component that subscribes.
 *
 * **The published value's IDENTITY is load-bearing, and it is enforced here rather than asked of
 * the caller.** A context consumer re-renders whenever the value's reference changes, whatever the
 * numbers say — and the rules the transcript draws are consumers sitting inside `React.memo`'d
 * transcript rows, whose whole purpose is to stay out of an unrelated frame. Publishing a fresh
 * object per render therefore defeats the memo for every rule on screen: measured at 120x40 over
 * twenty-five frames of a streaming turn, `<Rule>` renders went from 40 to 200 — the DL-10 cost
 * axis, multiplied by the size of the mounted slice, with nothing on screen to show for it.
 *
 * Memoising on the two numbers means a caller cannot lose the invariant by constructing its
 * argument inline, which is the natural way to write a call site and would otherwise be a silent
 * five-fold cost with no visible symptom.
 */
export function TerminalSizeProvider({
  size,
  children,
}: {
  size: TerminalSize;
  children?: React.ReactNode;
}): React.ReactElement {
  const published = useMemo(
    () => ({ rows: size.rows, columns: size.columns }),
    [size.rows, size.columns]
  );
  return <TerminalSizeContext.Provider value={published}>{children}</TerminalSizeContext.Provider>;
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
 *
 * Under a {@link TerminalSizeProvider} the published value is returned and nothing is subscribed;
 * that is the shape a session runs in. Standalone — a component rendered on its own by a spec, or
 * any future surface that mounts one of these without the frame around it — it falls back to its
 * own subscription, so a component is never silently frozen at its mount size.
 */
export function useTerminalSize(): TerminalSize {
  const published = useContext(TerminalSizeContext);
  const measured = useMeasuredTerminalSize(published === null);
  return published ?? measured;
}

/** The subscribing half. Inert unless it is the one doing the measuring. */
function useMeasuredTerminalSize(active: boolean): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    rows: stdout?.rows || FALLBACK_TERMINAL_ROWS,
    columns: stdout?.columns || FALLBACK_TERMINAL_COLUMNS,
  }));

  useEffect(() => {
    if (!active || !stdout) return;
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
  }, [stdout, active]);

  return size;
}
