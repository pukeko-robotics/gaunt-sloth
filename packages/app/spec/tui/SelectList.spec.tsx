import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  SelectList,
  clampWindowStart,
  windowSize,
} from '#src/tui/components/SelectList.js';

const DOWN = '\x1b[B'; // Down arrow CSI sequence
const UP = '\x1b[A'; // Up arrow CSI sequence
const ENTER = '\r';

const tick = () => new Promise((r) => setTimeout(r, 10));

/** Build a list of `n` uniquely-labelled items (`opt-00`, `opt-01`, …). */
const makeItems = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `opt-${String(i).padStart(2, '0')}` }));

describe('tui <SelectList> (CFG-11 keyboard select)', () => {
  it('renders all options with the initial index highlighted', () => {
    const { lastFrame } = render(
      <SelectList
        title="Pick one"
        items={[{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }]}
        initialIndex={1}
        onSelect={vi.fn()}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pick one');
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
    expect(frame).toContain('gamma');
    // The highlighted row carries the ❯ marker.
    expect(frame).toMatch(/❯ beta/);
  });

  it('moves the highlight with arrow keys and confirms with Enter', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <SelectList
        title="Pick one"
        items={[{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }]}
        initialIndex={0}
        onSelect={onSelect}
      />
    );

    stdin.write(DOWN); // -> beta (1)
    await tick();
    stdin.write(DOWN); // -> gamma (2)
    await tick();
    stdin.write(UP); // -> beta (1)
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('wraps around at the ends', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <SelectList
        title="Pick one"
        items={[{ label: 'alpha' }, { label: 'beta' }]}
        initialIndex={0}
        onSelect={onSelect}
      />
    );

    stdin.write(UP); // wraps from 0 -> 1 (last)
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(onSelect).toHaveBeenCalledWith(1);
  });
});

describe('CFG-15 windowing helpers', () => {
  it('windowSize derives from terminal rows, reserving chrome, min 1', () => {
    expect(windowSize(24)).toBe(20); // 24 - 4 reserved
    expect(windowSize(6)).toBe(2);
    expect(windowSize(4)).toBe(1); // clamped to at least 1
    expect(windowSize(1)).toBe(1);
  });

  it('windowSize falls back to a constant when rows are unknown', () => {
    expect(windowSize(undefined)).toBe(10);
    expect(windowSize(Number.NaN)).toBe(10);
  });

  it('clampWindowStart keeps the cursor in view and stays sticky', () => {
    // Cursor within the current window: window does not move.
    expect(clampWindowStart(0, 1, 3, 6)).toBe(0);
    expect(clampWindowStart(0, 2, 3, 6)).toBe(0);
    // Cursor crosses the bottom edge: window shifts down by the overshoot.
    expect(clampWindowStart(0, 3, 3, 6)).toBe(1);
    // Cursor above the window: window snaps up to the cursor.
    expect(clampWindowStart(3, 1, 3, 6)).toBe(1);
    // Wraparound to the last item clamps to the final window.
    expect(clampWindowStart(0, 5, 3, 6)).toBe(3);
    // Never scrolls past the end even if a stale start is out of range.
    expect(clampWindowStart(99, 5, 3, 6)).toBe(3);
    // Short list (size >= count): window is always 0.
    expect(clampWindowStart(0, 2, 10, 3)).toBe(0);
  });
});

describe('CFG-15 scrolling viewport', () => {
  it('bounds a long list to the derived window and shows a ↓ affordance', () => {
    // 12 items, no explicit viewportRows -> falls back to the 10-row window.
    const { lastFrame } = render(
      <SelectList title="Pick one" items={makeItems(12)} initialIndex={0} onSelect={vi.fn()} />
    );
    const frame = lastFrame() ?? '';
    // Only the first window's worth of rows is visible.
    expect(frame).toContain('opt-00');
    expect(frame).toContain('opt-09');
    expect(frame).not.toContain('opt-10');
    expect(frame).not.toContain('opt-11');
    // At the top: a ↓ affordance for the 2 hidden below, none above.
    expect(frame).toContain('↓ 2 more');
    expect(frame).not.toContain('↑');
  });

  it('scrolls the window down when the cursor crosses the bottom edge', async () => {
    const { lastFrame, stdin } = render(
      <SelectList
        title="Pick one"
        items={makeItems(6)}
        initialIndex={0}
        viewportRows={3}
        onSelect={vi.fn()}
      />
    );
    // Initial window: opt-00..opt-02, only ↓ affordance.
    let frame = lastFrame() ?? '';
    expect(frame).toContain('opt-00');
    expect(frame).toContain('opt-02');
    expect(frame).not.toContain('opt-03');
    expect(frame).toContain('↓ 3 more');
    expect(frame).not.toContain('↑');

    // Move down past the bottom edge (cursor 0 -> 3): window shifts to opt-01..opt-03.
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).not.toContain('opt-00'); // top row dropped off
    expect(frame).toContain('opt-03'); // previously-hidden row now visible
    expect(frame).toMatch(/❯ opt-03/); // and highlighted
    expect(frame).toContain('↑ 1 more');
    expect(frame).toContain('↓ 2 more');
  });

  it('scrolls to the far window on upward wraparound', async () => {
    const { lastFrame, stdin } = render(
      <SelectList
        title="Pick one"
        items={makeItems(6)}
        initialIndex={0}
        viewportRows={3}
        onSelect={vi.fn()}
      />
    );
    // Up from the first item wraps to the last (5): window snaps to opt-03..opt-05.
    stdin.write(UP);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('opt-00');
    expect(frame).toContain('opt-05');
    expect(frame).toMatch(/❯ opt-05/);
    expect(frame).toContain('↑ 3 more');
    expect(frame).not.toContain('↓'); // at the bottom edge, no ↓
  });

  it('renders a short list in full with no affordance', () => {
    const { lastFrame } = render(
      <SelectList
        title="Pick one"
        items={makeItems(3)}
        initialIndex={0}
        viewportRows={3}
        onSelect={vi.fn()}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('opt-00');
    expect(frame).toContain('opt-01');
    expect(frame).toContain('opt-02');
    expect(frame).not.toContain('↑');
    expect(frame).not.toContain('↓');
    expect(frame).toMatch(/❯ opt-00/);
  });

  it('resolves the highlighted absolute index with Enter after scrolling', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <SelectList
        title="Pick one"
        items={makeItems(6)}
        initialIndex={0}
        viewportRows={3}
        onSelect={onSelect}
      />
    );
    // Scroll down to index 4, then confirm.
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(4);
  });
});
