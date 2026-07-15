import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { SelectCancelledError } from '#src/tui/selectCancelled.js';

export interface SelectItem {
  /** The text shown for this row. */
  label: string;
}

/**
 * CFG-20 — the pure "does this row match the typed filter?" predicate: a case-insensitive
 * substring test on the row label (the model id, with its ⭐/padding prefix — a substring
 * match on the id still hits). The raw substring test; query trimming is done once by the
 * callers ({@link filteredItemIndices} / {@link filterSelectItems}), not here.
 */
export function matchesFilter(label: string, query: string): boolean {
  return label.toLowerCase().includes(query.toLowerCase());
}

/**
 * CFG-20 — **the single production filter path**: the absolute indices (into `items`) of the rows
 * whose label matches `query`, in source order. The query is trimmed, so a leading/trailing space
 * filters like the trimmed text and an all-whitespace query is treated as "no filter" (all rows).
 * The widget's live filter calls exactly this (see the `filteredIndices` memo below), and
 * {@link filterSelectItems} is a thin view over it — so a unit test can never validate a matcher
 * the widget doesn't actually run. Indices (not items) so the widget can map a filtered-view
 * selection back to the original absolute index even if two labels were to coincide.
 */
export function filteredItemIndices(items: SelectItem[], query: string): number[] {
  const q = query.trim();
  const indices: number[] = [];
  items.forEach((item, i) => {
    if (!q || matchesFilter(item.label, q)) indices.push(i);
  });
  return indices;
}

/**
 * CFG-20 — the items (not indices) surviving the filter, in source order: a thin view over the
 * production {@link filteredItemIndices}, so it can never diverge from the widget's live filter.
 * Mirrors the shape of TUI-C10's `filterSlashCommands` (pure, case-insensitive, empty/whitespace
 * query returns the full list) but deliberately does NOT re-rank prefix-before-substring: the
 * model list arrives already ordered ⭐ preferred-first then alphabetical (CFG-14), and that order
 * must be preserved within the filtered set, so the source order is kept rather than bucketed.
 */
export function filterSelectItems(items: SelectItem[], query: string): SelectItem[] {
  return filteredItemIndices(items, query).map((i) => items[i]);
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
 * move the highlight, Enter confirms.
 *
 * CFG-15 — the list renders within a bounded, scrolling viewport so a long option list (e.g.
 * openrouter's discovered model list) never overflows the terminal. At most a window's worth of
 * rows is shown; the window scrolls to keep the highlighted row in view, and dim `↑ N more` /
 * `↓ N more` affordances signal hidden items above / below.
 *
 * CFG-20 — **type-to-filter**: typing letters incrementally filters the list (case-insensitive
 * substring on the label — see {@link matchesFilter}), so a 200+-model catalog is reachable by
 * typing a few chars instead of scrolling. Backspace edits the filter; Esc clears it (a second
 * Esc, with the filter already empty, aborts — see `onCancel`). The filtered set keeps the source
 * order (⭐ preferred-first then alphabetical). Because letters now feed the filter, the old j/k
 * vim-nav shortcuts are gone — the arrow keys remain the movement keys.
 *
 * CFG-20 — **abort**: Ctrl+C (always) and Esc-on-empty-filter invoke `onCancel`, which the
 * `runInkSelect` host turns into a {@link SelectCancelledError} so the dialog can abort without
 * writing a config. Enter, Ctrl+C and Esc are handled as three DISTINCT keys (the previous
 * default-`exitOnCtrlC` behaviour silently collapsed Ctrl+C into "selected the default").
 *
 * `onSelect` is called once with the chosen **absolute** index into `items` (never the
 * filtered-view position); the caller is responsible for unmounting (the default `runInkSelect`
 * host calls `useApp().exit()` via `onSelect`/`onCancel`).
 */
export function SelectList({
  title,
  items,
  initialIndex = 0,
  onSelect,
  onCancel,
  viewportRows,
}: {
  title: string;
  items: SelectItem[];
  initialIndex?: number;
  onSelect: (index: number) => void;
  /**
   * CFG-20 — called when the user aborts the selection (Ctrl+C, or Esc with an empty filter).
   * Optional so a bare `<SelectList>` (e.g. in a render test) can omit it; `runInkSelect` always
   * supplies it.
   */
  onCancel?: () => void;
  /**
   * Explicit window height override, mainly for tests. When omitted the window is derived from
   * the live terminal height via {@link windowSize}.
   */
  viewportRows?: number;
}): React.ReactElement {
  const { stdout } = useStdout();
  // CFG-20 — the active type-to-filter query. Empty = show everything.
  const [filter, setFilter] = useState('');
  // `cursor` is a position within the CURRENT filtered view, not an absolute index. With an empty
  // filter the view is the identity of `items`, so the initial cursor is the caller's preferred
  // default (initialIndex); a filter reset the cursor to the top of the narrowed set (below).
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

  // The absolute indices of the rows that survive the current filter, in source order. Selection
  // maps back through this array so `onSelect` always reports the original index into `items`. This
  // is THE filter path — the same trimmed predicate the unit tests exercise via filterSelectItems.
  const filteredIndices = useMemo(() => filteredItemIndices(items, filter), [items, filter]);
  const count = filteredIndices.length;

  // Re-filter the list from the current query, resetting the cursor to the top of the narrowed set.
  const applyFilter = (next: string): void => {
    setFilter(next);
    setCursor(0);
  };

  useInput((input, key) => {
    // Ctrl+C is an unconditional abort (SIGINT semantics), regardless of any typed filter.
    if (key.ctrl && input === 'c') {
      onCancel?.();
      return;
    }
    if (key.return) {
      // Only confirm when the filtered set is non-empty (nothing to pick under a no-match filter).
      if (count > 0) onSelect(filteredIndices[cursor]);
      return;
    }
    if (key.escape) {
      // First Esc clears an active filter; a second Esc (empty filter) aborts.
      if (filter) applyFilter('');
      else onCancel?.();
      return;
    }
    if (key.upArrow) {
      if (count > 0) setCursor((c) => (c - 1 + count) % count);
      return;
    }
    if (key.downArrow) {
      if (count > 0) setCursor((c) => (c + 1) % count);
      return;
    }
    if (key.backspace || key.delete) {
      if (filter) applyFilter(filter.slice(0, -1));
      return;
    }
    // Any other printable, non-modified key extends the filter. Guard against control/meta combos
    // and non-printable input (arrows/return/etc. are handled above and arrive with empty `input`).
    if (input && !key.ctrl && !key.meta && !/[\x00-\x1f]/.test(input)) {
      applyFilter(filter + input);
    }
  });

  const size = typeof viewportRows === 'number' ? Math.max(1, viewportRows) : windowSize(rows);
  // Derive the display window from the remembered start + current cursor. Computing it in render
  // keeps the window valid even when the cursor jumps (wraparound), the filter narrows the list,
  // or the terminal resizes.
  const start = clampWindowStart(windowStart, cursor, size, count);
  // Persist the derived start so the window stays sticky across moves (converges in one pass).
  useEffect(() => {
    if (start !== windowStart) setWindowStart(start);
  }, [start, windowStart]);

  const visibleIndices = filteredIndices.slice(start, start + size);
  const hiddenAbove = start;
  const hiddenBelow = count - (start + visibleIndices.length);

  return (
    <Box flexDirection="column">
      <Text>{title}</Text>
      {filter ? <Text dimColor>{`  filter: ${filter}`}</Text> : null}
      {count === 0 ? (
        <Text dimColor>{`  (no matches for "${filter}")`}</Text>
      ) : (
        <>
          {hiddenAbove > 0 ? <Text dimColor>{`  ↑ ${hiddenAbove} more`}</Text> : null}
          {visibleIndices.map((absoluteIndex, i) => {
            const selected = start + i === cursor;
            return (
              <Text key={absoluteIndex} color={selected ? 'cyan' : undefined}>
                {selected ? '❯ ' : '  '}
                {items[absoluteIndex].label}
              </Text>
            );
          })}
          {hiddenBelow > 0 ? <Text dimColor>{`  ↓ ${hiddenBelow} more`}</Text> : null}
        </>
      )}
    </Box>
  );
}

/**
 * The subset of Ink's `render` that {@link runInkSelect} relies on: mount a node and expose a
 * promise that settles when the app exits. Declared as a seam so a test can inject a fake-stream
 * renderer and drive the real Ctrl+C→reject / Enter→resolve wire without a live TTY (the default
 * dynamic-`import('ink')` path is otherwise un-unit-testable, since Ink's `useInput` needs raw mode).
 */
export type InkRenderFn = (
  node: React.ReactElement,
  options?: { exitOnCtrlC?: boolean }
  // `unknown` (not `void`) so Ink's own `render` — whose `waitUntilExit()` resolves `unknown` — is
  // directly assignable; runInkSelect ignores the resolved value anyway.
) => { waitUntilExit: () => Promise<unknown> };

/**
 * Renders {@link SelectList} with Ink and resolves with the chosen absolute index — or **rejects
 * with a {@link SelectCancelledError}** when the user aborts (Ctrl+C, or Esc with an empty
 * filter). Imports `ink` dynamically (unless a `render` is injected) so this module never pulls
 * Ink into a readline-only run. Intended to be used only after the caller has confirmed an
 * interactive TTY + Ink availability.
 *
 * `exitOnCtrlC: false` — Ink's default would unmount on Ctrl+C and let `waitUntilExit()` resolve
 * normally, so the host would `resolve(chosen)` with the untouched default index (the CFG-20 bug:
 * Ctrl+C read as "picked the default"). We own Ctrl+C in {@link SelectList} instead and route it
 * to the reject path.
 *
 * @param render - injectable Ink renderer (defaults to Ink's `render`); for tests only.
 */
export async function runInkSelect(
  title: string,
  items: SelectItem[],
  initialIndex = 0,
  render?: InkRenderFn
): Promise<number> {
  const renderFn: InkRenderFn = render ?? (await import('ink')).render;
  return await new Promise<number>((resolve, reject) => {
    let chosen = initialIndex;
    let cancelled = false;
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
          onCancel={() => {
            cancelled = true;
            exit();
          }}
        />
      );
    };
    // Own Ctrl+C ourselves (see the doc comment) rather than letting Ink silently unmount.
    const instance = renderFn(<Host />, { exitOnCtrlC: false });
    instance
      .waitUntilExit()
      .then(() => (cancelled ? reject(new SelectCancelledError()) : resolve(chosen)));
  });
}
