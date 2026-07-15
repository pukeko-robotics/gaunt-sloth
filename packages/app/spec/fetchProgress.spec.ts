import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { InkProgressRenderFn } from '#src/tui/components/FetchProgress.js';

/**
 * CFG-21 — the interactive "fetching models" indicator. Ink's real render needs a raw-mode-capable
 * stdin, so these tests drive {@link runWithInkProgress} through its injectable {@link InkProgressRenderFn}
 * seam (the same pattern as SelectList's `runInkSelect`) and assert the indicator mounts, exposes the
 * label, and is cleared + unmounted whichever way the wrapped work settles.
 */
describe('runWithInkProgress (CFG-21 indicator, part a)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** A fake Ink renderer that records the mounted node and its clear/unmount lifecycle. */
  function makeFakeRender(): {
    render: InkProgressRenderFn;
    clear: ReturnType<typeof vi.fn>;
    unmount: ReturnType<typeof vi.fn>;
    nodes: React.ReactElement[];
  } {
    const clear = vi.fn();
    const unmount = vi.fn();
    const nodes: React.ReactElement[] = [];
    const render: InkProgressRenderFn = (node) => {
      nodes.push(node);
      return { clear, unmount };
    };
    return { render, clear, unmount, nodes };
  }

  it('mounts the spinner with the label, runs the work, then clears + unmounts', async () => {
    const fake = makeFakeRender();
    const { runWithInkProgress } = await import('#src/tui/components/FetchProgress.js');

    const result = await runWithInkProgress(
      'Fetching models from OpenAI…',
      async () => 'RESULT',
      fake.render
    );

    expect(result).toBe('RESULT');
    // The indicator was mounted exactly once, carrying the label.
    expect(fake.nodes).toHaveLength(1);
    expect((fake.nodes[0].props as { label: string }).label).toBe('Fetching models from OpenAI…');
    // Cleared (so the spinner line does not linger) and unmounted after the work settled.
    expect(fake.clear).toHaveBeenCalledTimes(1);
    expect(fake.unmount).toHaveBeenCalledTimes(1);
  });

  it('still clears + unmounts when the wrapped work rejects', async () => {
    const fake = makeFakeRender();
    const { runWithInkProgress } = await import('#src/tui/components/FetchProgress.js');

    await expect(
      runWithInkProgress(
        'Fetching models from OpenAI…',
        async () => {
          throw new Error('fetch blew up');
        },
        fake.render
      )
    ).rejects.toThrow('fetch blew up');

    expect(fake.clear).toHaveBeenCalledTimes(1);
    expect(fake.unmount).toHaveBeenCalledTimes(1);
  });
});
