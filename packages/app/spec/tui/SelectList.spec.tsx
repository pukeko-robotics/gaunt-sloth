import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink-testing-library';
import { render as inkRender } from 'ink';
import {
  SelectList,
  clampWindowStart,
  filterSelectItems,
  filteredItemIndices,
  matchesFilter,
  runInkSelect,
  windowSize,
  type InkRenderFn,
} from '#src/tui/components/SelectList.js';
import { SelectCancelledError } from '#src/tui/selectCancelled.js';

const DOWN = '\x1b[B'; // Down arrow CSI sequence
const UP = '\x1b[A'; // Up arrow CSI sequence
const ENTER = '\r';
const ESC = '\x1b'; // lone Escape
const CTRL_C = '\x03'; // Ctrl+C (SIGINT byte)
const BACKSPACE = '\x7f'; // DEL / backspace

// 20ms so a lone ESC byte resolves: Ink briefly waits after \x1b to disambiguate a bare
// Escape from the start of a CSI sequence (e.g. an arrow key) before dispatching key.escape.
const tick = () => new Promise((r) => setTimeout(r, 20));

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

describe('CFG-20 filterSelectItems / matchesFilter predicate', () => {
  const items = [
    { label: '⭐ gpt-5.5' },
    { label: '⭐ gpt-5.4-mini' },
    { label: '   claude-sonnet-5' },
    { label: '   gemini-3.5-flash' },
    { label: '   grok-4.3' },
  ];

  it('matchesFilter is a case-insensitive substring test on the label', () => {
    expect(matchesFilter('⭐ gpt-5.5', 'gpt')).toBe(true);
    expect(matchesFilter('⭐ gpt-5.5', 'GPT')).toBe(true); // case-insensitive
    expect(matchesFilter('claude-sonnet-5', 'sonnet')).toBe(true); // mid-string substring
    expect(matchesFilter('claude-sonnet-5', 'gpt')).toBe(false);
  });

  it('empty (or whitespace) filter returns the full list, as a copy', () => {
    const full = filterSelectItems(items, '');
    expect(full).toEqual(items);
    expect(full).not.toBe(items); // fresh array, not the same reference
    expect(filterSelectItems(items, '   ')).toEqual(items);
  });

  it('narrows to substring matches, preserving the source (preferred-first) order', () => {
    // "5" hits both ⭐ gpt rows, claude-sonnet-5 and gemini-3.5-flash — in their original order.
    expect(filterSelectItems(items, '5').map((i) => i.label)).toEqual([
      '⭐ gpt-5.5',
      '⭐ gpt-5.4-mini',
      '   claude-sonnet-5',
      '   gemini-3.5-flash',
    ]);
    // Case-insensitive, and a filter that hits a single non-first row.
    expect(filterSelectItems(items, 'GROK').map((i) => i.label)).toEqual(['   grok-4.3']);
  });

  it('returns an empty list on a no-match filter', () => {
    expect(filterSelectItems(items, 'zzz')).toEqual([]);
  });

  it('trims the query, so leading/trailing (or all) whitespace filters like the trimmed text', () => {
    // A trailing/leading space must NOT turn a real match into "no matches".
    expect(filterSelectItems(items, 'grok ').map((i) => i.label)).toEqual(['   grok-4.3']);
    expect(filterSelectItems(items, '  gpt').map((i) => i.label)).toEqual([
      '⭐ gpt-5.5',
      '⭐ gpt-5.4-mini',
    ]);
    // All-whitespace is "no filter" (not "match rows containing a space" — which would hide the
    // ⭐ preferred rows whose labels have no space in the id).
    expect(filterSelectItems(items, '  ')).toEqual(items);
  });

  it('filteredItemIndices (the production path) returns absolute indices in source order', () => {
    expect(filteredItemIndices(items, '')).toEqual([0, 1, 2, 3, 4]); // no filter = every index
    expect(filteredItemIndices(items, '   ')).toEqual([0, 1, 2, 3, 4]); // whitespace = no filter
    expect(filteredItemIndices(items, 'grok')).toEqual([4]); // absolute index, not 0
    expect(filteredItemIndices(items, 'GROK ')).toEqual([4]); // case-insensitive + trimmed
    expect(filteredItemIndices(items, '5')).toEqual([0, 1, 2, 3]); // source order preserved
    expect(filteredItemIndices(items, 'zzz')).toEqual([]); // no match
    // filterSelectItems is exactly this path mapped back to items — proving they cannot diverge.
    expect(filterSelectItems(items, '5')).toEqual(filteredItemIndices(items, '5').map((i) => items[i]));
  });
});

describe('CFG-20 type-to-filter interaction', () => {
  const models = [
    { label: '⭐ gpt-5.5' }, // 0 (preferred, initial cursor)
    { label: '⭐ gpt-5.4-mini' }, // 1 (preferred)
    { label: '   claude-sonnet-5' }, // 2
    { label: '   gemini-3.5-flash' }, // 3
    { label: '   grok-4.3' }, // 4
  ];

  it('typing narrows the visible list and shows the active filter string', async () => {
    const { lastFrame, stdin } = render(
      <SelectList title="Pick a model" items={models} initialIndex={0} onSelect={vi.fn()} />
    );
    stdin.write('gpt');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('filter: gpt');
    // Only the two ⭐ gpt rows survive; the others are filtered out.
    expect(frame).toContain('gpt-5.5');
    expect(frame).toContain('gpt-5.4-mini');
    expect(frame).not.toContain('claude-sonnet-5');
    expect(frame).not.toContain('grok-4.3');
    // Filtered set keeps preferred-first order: the top (highlighted) row is gpt-5.5.
    expect(frame).toMatch(/❯ ⭐ gpt-5\.5/);
  });

  it('a trailing space in the typed filter still matches (widget trims, like the predicate)', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <SelectList title="Pick a model" items={models} initialIndex={0} onSelect={onSelect} />
    );
    stdin.write('grok '); // note the trailing space
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('no matches'); // the space must not break the match
    expect(frame).toMatch(/❯ {4}grok-4\.3/);
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith(4);
  });

  it('Enter after filtering returns the ORIGINAL absolute index, not the filtered position', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <SelectList title="Pick a model" items={models} initialIndex={0} onSelect={onSelect} />
    );
    // Filter to a single non-first row (grok, absolute index 4). Its filtered position is 0.
    stdin.write('grok');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(4); // absolute index, not 0
  });

  it('navigation within the filtered set resolves the right absolute index', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <SelectList title="Pick a model" items={models} initialIndex={0} onSelect={onSelect} />
    );
    stdin.write('gpt'); // filtered -> [0, 1]
    await tick();
    stdin.write(DOWN); // move to filtered position 1 => absolute index 1
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('Backspace edits the filter and Esc clears it back to the full list', async () => {
    const { lastFrame, stdin } = render(
      <SelectList title="Pick a model" items={models} initialIndex={0} onSelect={vi.fn()} />
    );
    stdin.write('grok');
    await tick();
    stdin.write(BACKSPACE); // "grok" -> "gro"
    await tick();
    expect(lastFrame() ?? '').toContain('filter: gro');
    stdin.write(ESC); // clears the filter
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('filter:');
    // Full list is back.
    expect(frame).toContain('claude-sonnet-5');
    expect(frame).toContain('grok-4.3');
  });

  it('shows a no-matches state and Enter does nothing while unmatched', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <SelectList title="Pick a model" items={models} initialIndex={0} onSelect={onSelect} />
    );
    stdin.write('zzz');
    await tick();
    expect(lastFrame() ?? '').toContain('no matches for "zzz"');
    stdin.write(ENTER);
    await tick();
    expect(onSelect).not.toHaveBeenCalled(); // nothing to select under a no-match filter
  });

  it('Ctrl+C invokes onCancel (abort) without selecting', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <SelectList
        title="Pick a model"
        items={models}
        initialIndex={0}
        onSelect={onSelect}
        onCancel={onCancel}
      />
    );
    stdin.write(CTRL_C);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Ctrl+C aborts even with an active filter typed', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <SelectList
        title="Pick a model"
        items={models}
        initialIndex={0}
        onSelect={onSelect}
        onCancel={onCancel}
      />
    );
    stdin.write('gpt');
    await tick();
    stdin.write(CTRL_C);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Esc on an empty filter aborts (second Esc after a clear)', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <SelectList
        title="Pick a model"
        items={models}
        initialIndex={0}
        onSelect={onSelect}
        onCancel={onCancel}
      />
    );
    stdin.write('gpt'); // filter active
    await tick();
    stdin.write(ESC); // first Esc clears the filter
    await tick();
    expect(onCancel).not.toHaveBeenCalled();
    stdin.write(ESC); // second Esc, empty filter -> abort
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('CFG-20 runInkSelect abort wire (real Ink render, fake streams)', () => {
  // Minimal fake TTY streams (mirrors ink-testing-library) so the REAL Ink `render` can mount and
  // `useInput` can run without a live terminal. This drives the exact code path the SelectList /
  // firstRunDialog unit tests skip: runInkSelect's `exitOnCtrlC: false` + cancelled→reject glue.
  class FakeStdout extends EventEmitter {
    get columns(): number {
      return 100;
    }
    frames: string[] = [];
    write = (frame: string): void => {
      this.frames.push(frame);
    };
    lastFrame = (): string | undefined => this.frames.at(-1);
  }
  class FakeStdin extends EventEmitter {
    isTTY = true;
    private data: string | null = null;
    write = (data: string): void => {
      this.data = data;
      this.emit('readable');
      this.emit('data', data);
    };
    setEncoding(): void {}
    setRawMode(): void {}
    resume(): void {}
    pause(): void {}
    ref(): void {}
    unref(): void {}
    read = (): string | null => {
      const { data } = this;
      this.data = null;
      return data;
    };
  }

  /** An injectable {@link InkRenderFn} backed by the real Ink render + fake streams. Captures the
   *  options runInkSelect passes (so `exitOnCtrlC:false` is asserted directly) and forwards them
   *  faithfully to Ink, so reverting that flag actually changes Ink's behaviour. */
  function makeTestRenderer(): {
    render: InkRenderFn;
    stdin: FakeStdin;
    options: { exitOnCtrlC?: boolean };
  } {
    const stdin = new FakeStdin();
    const options: { exitOnCtrlC?: boolean } = {};
    const render: InkRenderFn = (node, opts) => {
      Object.assign(options, opts);
      const instance = inkRender(node, {
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: opts?.exitOnCtrlC ?? true,
        patchConsole: false,
      });
      return { waitUntilExit: () => instance.waitUntilExit() };
    };
    return { render, stdin, options };
  }

  const items = [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }];

  it('rejects with SelectCancelledError when the host receives Ctrl+C', async () => {
    const { render, stdin, options } = makeTestRenderer();
    const promise = runInkSelect('Pick', items, 1, render);
    await tick(); // let the component mount + register useInput
    stdin.write(CTRL_C);
    await expect(promise).rejects.toBeInstanceOf(SelectCancelledError);
    // Directly guard the flag whose default reintroduced the bug (Ctrl+C reading as "the default").
    expect(options.exitOnCtrlC).toBe(false);
  });

  it('resolves the chosen index on Enter (normal confirm still works)', async () => {
    const { render, stdin } = makeTestRenderer();
    const promise = runInkSelect('Pick', items, 1, render); // initial highlight = index 1
    await tick();
    stdin.write(ENTER);
    await expect(promise).resolves.toBe(1);
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
