import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { SlashCommandMenu } from '#src/tui/components/SlashCommandMenu.js';
import { windowWithinRows } from '#src/tui/listWindow.js';
import type { SlashCommand } from '@gaunt-sloth/agent/modules/slashCommands.js';

/** `cmd-01`, `cmd-02`, … — two digits so a substring assertion on one name cannot hit another. */
const command = (n: number, description = `command number ${n}`): SlashCommand => ({
  name: `cmd-${String(n).padStart(2, '0')}`,
  description,
  run: () => ({}),
});
const commands = (count: number): SlashCommand[] =>
  Array.from({ length: count }, (_, i) => command(i + 1));

/** The menu's rows: an entry, or an `↑ / ↓ N more` affordance. Nothing else is in these frames. */
const menuRows = (frame: string): string[] =>
  frame
    .split('\n')
    .map((row) => stripAnsi(row))
    .filter((row) => /\/cmd-\d\d|[↑↓] \d+ more/.test(row));

/**
 * TUI-C92 — the pure windowing behind the menu: a sticky window that fits, affordance rows
 * included, in a fixed number of display rows.
 */
describe('windowWithinRows (TUI-C92 listWindow)', () => {
  it('draws everything and announces nothing when the list fits the budget', () => {
    expect(windowWithinRows(0, 0, 8, 5)).toEqual({
      start: 0,
      size: 5,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
    expect(windowWithinRows(0, 7, 8, 8)).toEqual({
      start: 0,
      size: 8,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
    // An empty list is an empty window, not an error.
    expect(windowWithinRows(0, 0, 8, 0)).toEqual({
      start: 0,
      size: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  it('spends one row on the single affordance a list longer than the budget needs', () => {
    // Cursor at the top: entries below only, so seven entries plus the `↓` row make eight.
    expect(windowWithinRows(0, 0, 8, 25)).toEqual({
      start: 0,
      size: 7,
      hiddenAbove: 0,
      hiddenBelow: 18,
    });
    // Cursor at the bottom: entries above only.
    expect(windowWithinRows(0, 24, 8, 25)).toEqual({
      start: 18,
      size: 7,
      hiddenAbove: 18,
      hiddenBelow: 0,
    });
  });

  it('spends two rows when the window sits with entries hidden on both sides', () => {
    // The cursor lands mid-list: six entries plus both affordances make eight, and the window
    // is the one that keeps the cursor on its last row.
    expect(windowWithinRows(0, 12, 8, 25)).toEqual({
      start: 7,
      size: 6,
      hiddenAbove: 7,
      hiddenBelow: 12,
    });
  });

  it('is sticky: the window moves only when the cursor crosses an edge', () => {
    const first = windowWithinRows(0, 7, 8, 25);
    expect(first.start).toBe(2);
    // One step back up, inside the same window: nothing moves.
    expect(windowWithinRows(first.start, 6, 8, 25).start).toBe(2);
    // Fed its own start again it is unchanged — the render-time persistence relies on this.
    expect(windowWithinRows(first.start, 7, 8, 25)).toEqual(first);
  });

  it('resolves a remembered start past the end of a narrowed list', () => {
    expect(windowWithinRows(18, 0, 8, 3)).toEqual({
      start: 0,
      size: 3,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
    // Still longer than the budget: the stale start clamps to the last window, and the cursor —
    // above it — pulls the window up to itself, moving it as little as keeping the cursor in
    // view allows. The same answer `clampWindowStart(99, 5, 3, 6)` gives in `SelectList.spec`.
    expect(windowWithinRows(18, 1, 8, 10)).toEqual({
      start: 1,
      size: 6,
      hiddenAbove: 1,
      hiddenBelow: 3,
    });
  });

  it('lets the entry win a budget that cannot hold it and its affordances', () => {
    // One row: the highlighted entry alone, wherever it is.
    expect(windowWithinRows(0, 12, 1, 25)).toEqual({
      start: 12,
      size: 1,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
    // Two rows at the top: one entry and the `↓` row still fit.
    expect(windowWithinRows(0, 0, 2, 25)).toEqual({
      start: 0,
      size: 1,
      hiddenAbove: 0,
      hiddenBelow: 24,
    });
    // Two rows mid-list: two affordances would need three, so neither is drawn.
    expect(windowWithinRows(0, 12, 2, 25)).toEqual({
      start: 12,
      size: 1,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
    // A budget below one, or not a number at all, is read as one.
    expect(windowWithinRows(0, 3, 0, 5).size).toBe(1);
    expect(windowWithinRows(0, 3, Number.NaN, 5).size).toBe(1);
  });
});

/**
 * TUI-C92 — the menu as a bounded viewport. Every frame here is read as rows, because the rows
 * are the claim: the bound is a number of display rows, and an entry is exactly one of them.
 */
describe('tui <SlashCommandMenu> bounded viewport (TUI-C92)', () => {
  it('draws every match with no affordance when there are fewer than the bound', () => {
    const { lastFrame } = render(
      <SlashCommandMenu commands={commands(5)} selectedIndex={0} maxRows={8} />
    );
    const rows = menuRows(lastFrame() ?? '');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatch(/^❯ \/cmd-01/);
    expect(rows[4]).toMatch(/^ {2}\/cmd-05/);
    expect(lastFrame() ?? '').not.toMatch(/[↑↓]/);
  });

  it('draws every match with no affordance at exactly the bound', () => {
    const { lastFrame } = render(
      <SlashCommandMenu commands={commands(8)} selectedIndex={7} maxRows={8} />
    );
    const rows = menuRows(lastFrame() ?? '');
    expect(rows).toHaveLength(8);
    expect(rows[7]).toMatch(/^❯ \/cmd-08/);
    expect(lastFrame() ?? '').not.toMatch(/[↑↓]/);
  });

  it('bounds a longer list to its rows and announces the hidden count', () => {
    const { lastFrame } = render(
      <SlashCommandMenu commands={commands(25)} selectedIndex={0} maxRows={8} />
    );
    const rows = menuRows(lastFrame() ?? '');
    // Seven entries and the one affordance row: eight, the bound.
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatch(/^❯ \/cmd-01/);
    expect(rows[6]).toMatch(/^ {2}\/cmd-07/);
    expect(rows[7]).toBe('  ↓ 18 more');
    expect(lastFrame() ?? '').not.toContain('/cmd-08');
    expect(lastFrame() ?? '').not.toContain('↑');
  });

  it('shows the last entry highlighted, with the hidden ones counted above', () => {
    const { lastFrame } = render(
      <SlashCommandMenu commands={commands(25)} selectedIndex={24} maxRows={8} />
    );
    const rows = menuRows(lastFrame() ?? '');
    expect(rows).toHaveLength(8);
    expect(rows[0]).toBe('  ↑ 18 more');
    expect(rows[1]).toMatch(/^ {2}\/cmd-19/);
    expect(rows[7]).toMatch(/^❯ \/cmd-25/);
    expect(lastFrame() ?? '').not.toContain('↓');
  });

  it('keeps the window where it was while the highlight moves inside it', () => {
    const at = (selectedIndex: number) => (
      <SlashCommandMenu commands={commands(25)} selectedIndex={selectedIndex} maxRows={8} />
    );
    const { lastFrame, rerender } = render(at(0));
    rerender(at(7)); // past the seven-entry window: it scrolls to keep the highlight in view
    let rows = menuRows(lastFrame() ?? '');
    expect(rows[0]).toBe('  ↑ 2 more');
    expect(rows[1]).toMatch(/^ {2}\/cmd-03/);
    expect(rows[6]).toMatch(/^❯ \/cmd-08/);
    expect(rows[7]).toBe('  ↓ 17 more');

    rerender(at(6)); // back up one row, still inside the window: the window does not move
    rows = menuRows(lastFrame() ?? '');
    expect(rows[0]).toBe('  ↑ 2 more');
    expect(rows[1]).toMatch(/^ {2}\/cmd-03/);
    expect(rows[5]).toMatch(/^❯ \/cmd-07/);
    expect(rows[7]).toBe('  ↓ 17 more');
  });

  it('resolves a narrowing filter that leaves the remembered window start past the end', () => {
    const { lastFrame, rerender } = render(
      <SlashCommandMenu commands={commands(25)} selectedIndex={24} maxRows={8} />
    );
    expect(menuRows(lastFrame() ?? '')[0]).toBe('  ↑ 18 more');
    // The list narrows to three: the remembered start of eighteen is past every one of them.
    rerender(<SlashCommandMenu commands={commands(3)} selectedIndex={0} maxRows={8} />);
    const rows = menuRows(lastFrame() ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^❯ \/cmd-01/);
    expect(rows[2]).toMatch(/^ {2}\/cmd-03/);
    expect(lastFrame() ?? '').not.toMatch(/[↑↓]/);
  });

  it('shows the highlighted entry, and only it, on a bound of one row', () => {
    const { lastFrame } = render(
      <SlashCommandMenu commands={commands(25)} selectedIndex={12} maxRows={1} />
    );
    const rows = menuRows(lastFrame() ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^❯ \/cmd-13/);
  });

  it('truncates a long description to one row and keeps the name column whole', () => {
    // ink-testing-library renders at 100 columns. The description alone is twice that: allowed to
    // wrap it would take three rows, and Yoga would shrink the name column to make room for it.
    const long = 'a description long enough to wrap, '.repeat(6).trim();
    const { lastFrame } = render(
      <SlashCommandMenu
        commands={[command(1), command(2, long), command(3)]}
        selectedIndex={1}
        maxRows={10}
      />
    );
    const rows = menuRows(lastFrame() ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/^❯ \/cmd-02 {2}a description long enough to wrap/);
    expect(rows[1].length).toBeLessThanOrEqual(100);
    expect(rows[1].endsWith('…')).toBe(true);
    // The full text is nowhere in the frame; only the row above and below are.
    expect(lastFrame() ?? '').not.toContain(long);
    expect(rows[2]).toMatch(/^ {2}\/cmd-03 {2}command number 3$/);
  });

  it('renders nothing when there are no matching commands', () => {
    const { lastFrame } = render(<SlashCommandMenu commands={[]} selectedIndex={0} maxRows={8} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });
});
