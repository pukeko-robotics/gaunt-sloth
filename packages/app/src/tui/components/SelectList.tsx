import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

export interface SelectItem {
  /** The text shown for this row. */
  label: string;
}

/** Window size used when the terminal height is unknown (non-TTY / tests). */
const DEFAULT_WINDOW = 10;
/**
 * Rows reserved from the terminal height for chrome around the option window: the title line
 * plus the two `↑ / ↓ N more` affordance lines, with one line of breathing room. The rest of
 * the terminal is given to visible options.
 */
const RESERVED_ROWS = 4;

/**
 * Derive how many option rows the scrolling window may show at once from the live terminal
 * height. Ink/Node leaves `rows` `undefined` when not attached to a TTY (and in tests), in
 * which case we fall back to {@link DEFAULT_WINDOW}. Always at least 1 so a tiny / mis-reported
 * terminal can never collapse the window to zero.
 */
export function windowSize(rows: number | undefined): number {
  if (typeof rows === 'number' && Number.isFinite(rows)) {
    return Math.max(1, Math.floor(rows) - RESERVED_ROWS);
  }
  return DEFAULT_WINDOW;
}

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

/**
 * CFG-11 — a minimal arrow-key + Enter selectable list for the first-run dialog. Up/Down
 * (and k/j) move the highlight, Enter confirms. It deliberately has no number-typing path:
 * the readline number menu remains the non-TTY fallback, this is the keyboard-driven TUI one.
 *
 * CFG-15 — the list renders within a bounded, scrolling viewport so a long option list (e.g.
 * openrouter's discovered model list) never overflows the terminal. At most a window's worth of
 * rows is shown; the window scrolls to keep the highlighted row in view, and dim `↑ N more` /
 * `↓ N more` affordances signal hidden items above / below.
 *
 * `onSelect` is called once with the chosen (absolute) index; the caller is responsible for
 * unmounting (the default `runInkSelect` host calls `useApp().exit()` via `onSelect`).
 */
export function SelectList({
  title,
  items,
  initialIndex = 0,
  onSelect,
  viewportRows,
}: {
  title: string;
  items: SelectItem[];
  initialIndex?: number;
  onSelect: (index: number) => void;
  /**
   * Explicit window height override, mainly for tests. When omitted the window is derived from
   * the live terminal height via {@link windowSize}.
   */
  viewportRows?: number;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [cursor, setCursor] = useState(
    initialIndex >= 0 && initialIndex < items.length ? initialIndex : 0
  );
  const [windowStart, setWindowStart] = useState(0);
  // Track the live terminal height in state and refresh it on resize, so the window resizes
  // with the terminal (mirrors the resize-aware pattern in Rule.tsx).
  const [rows, setRows] = useState<number | undefined>(stdout?.rows);
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setRows(stdout.rows);
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setCursor((c) => (c - 1 + items.length) % items.length);
    } else if (key.downArrow || input === 'j') {
      setCursor((c) => (c + 1) % items.length);
    } else if (key.return) {
      onSelect(cursor);
    }
  });

  const size = typeof viewportRows === 'number' ? Math.max(1, viewportRows) : windowSize(rows);
  // Derive the display window from the remembered start + current cursor. Computing it in render
  // keeps the window valid even when the cursor jumps (wraparound) or the terminal resizes.
  const start = clampWindowStart(windowStart, cursor, size, items.length);
  // Persist the derived start so the window stays sticky across moves (converges in one pass).
  useEffect(() => {
    if (start !== windowStart) setWindowStart(start);
  }, [start, windowStart]);

  const visible = items.slice(start, start + size);
  const hiddenAbove = start;
  const hiddenBelow = items.length - (start + visible.length);

  return (
    <Box flexDirection="column">
      <Text>{title}</Text>
      {hiddenAbove > 0 ? <Text dimColor>{`  ↑ ${hiddenAbove} more`}</Text> : null}
      {visible.map((item, i) => {
        const index = start + i;
        const selected = index === cursor;
        return (
          <Text key={index} color={selected ? 'cyan' : undefined}>
            {selected ? '❯ ' : '  '}
            {item.label}
          </Text>
        );
      })}
      {hiddenBelow > 0 ? <Text dimColor>{`  ↓ ${hiddenBelow} more`}</Text> : null}
    </Box>
  );
}

/**
 * Renders {@link SelectList} with Ink and resolves with the chosen index. Imports `ink`
 * dynamically so this module never pulls Ink into a readline-only run. Intended to be used
 * only after the caller has confirmed an interactive TTY + Ink availability.
 */
export async function runInkSelect(
  title: string,
  items: SelectItem[],
  initialIndex = 0
): Promise<number> {
  const { render } = await import('ink');
  return await new Promise<number>((resolve) => {
    let chosen = initialIndex;
    const Host = (): React.ReactElement => {
      const { exit } = useApp();
      return (
        <SelectList
          title={title}
          items={items}
          initialIndex={initialIndex}
          onSelect={(index) => {
            chosen = index;
            exit();
          }}
        />
      );
    };
    const instance = render(<Host />);
    instance.waitUntilExit().then(() => resolve(chosen));
  });
}
