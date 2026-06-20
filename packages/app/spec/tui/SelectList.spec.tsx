import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SelectList } from '#src/tui/components/SelectList.js';

const DOWN = '\x1b[B'; // Down arrow CSI sequence
const UP = '\x1b[A'; // Up arrow CSI sequence
const ENTER = '\r';

const tick = () => new Promise((r) => setTimeout(r, 10));

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
