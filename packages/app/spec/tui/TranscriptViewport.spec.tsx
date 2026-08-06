import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import type { TranscriptItem } from '#src/tui/types.js';

/**
 * Mount/unmount counters for the committed items.
 *
 * `CommandNotice` is the leaf a `notice` item renders, so replacing it with a counting component
 * measures the real component lifecycle of the real viewport — no wrapper, no probe injected into
 * production code. The effect deps are EMPTY on purpose: with index keys React keeps one instance
 * per slot and merely feeds it the next item's props, and a dep on the title would turn that prop
 * swap into a cleanup + setup pair that counted exactly like a genuine remount. Empty deps count
 * component INSTANCES, which is the thing the acceptance is about.
 */
const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('#src/tui/components/CommandNotice.js', async () => {
  const react = await import('react');
  const ink = await import('ink');
  return {
    CommandNotice: ({ title }: { title: string }) => {
      react.useEffect(() => {
        lifecycle.mounts += 1;
        return () => {
          lifecycle.unmounts += 1;
        };
      }, []);
      return react.createElement(ink.Text, null, title);
    },
  };
});

const { TranscriptViewport } = await import('#src/tui/components/TranscriptViewport.js');

/** A one-body-line notice: three estimated rows (bracketing rule + title + body). */
const notice = (id: number): TranscriptItem => ({
  kind: 'notice',
  id,
  title: `item-${id}`,
  lines: [`body-${id}`],
  tone: 'info',
});

const line = (id: number): TranscriptItem => ({
  kind: 'system',
  id,
  level: 'INFO',
  text: `line-${id}`,
});

/** The viewport inside a fixed-height frame, the way `<App>` mounts it. */
function Frame({
  items,
  height,
  budgetRows,
  dockRows = 0,
}: {
  items: TranscriptItem[];
  height: number;
  budgetRows?: number;
  dockRows?: number;
}) {
  return (
    <Box flexDirection="column" height={height}>
      <TranscriptViewport items={items} budgetRows={budgetRows ?? height} />
      <Box flexDirection="column" flexShrink={0}>
        {Array.from({ length: dockRows }, (_, i) => (
          <Text key={i}>{`dock-${i}`}</Text>
        ))}
      </Box>
    </Box>
  );
}

describe('<TranscriptViewport>', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;
  });

  describe('pins the tail of the conversation to the bottom of the region', () => {
    it('shows the NEWEST rows and clips the oldest, never the other way round', () => {
      const items = Array.from({ length: 40 }, (_, i) => line(i));
      const { lastFrame, unmount } = render(<Frame items={items} height={8} />);
      const rows = (lastFrame() ?? '').split('\n');

      // The newest line is the last row of the region…
      expect(rows[rows.length - 1]).toContain('line-39');
      // …the rows above it are its immediate predecessors, in order…
      expect(rows[rows.length - 2]).toContain('line-38');
      // …and the oldest ones are not on screen at all. A top-aligned region would show line-0
      // here and no line-39, which is precisely the failure this pins.
      expect(lastFrame()).not.toContain('line-0\n');
      expect(lastFrame()).not.toContain('line-10');

      unmount();
    });

    it('keeps the newest row against the dock, not against the bottom of the screen', () => {
      const items = Array.from({ length: 40 }, (_, i) => line(i));
      const { lastFrame, unmount } = render(<Frame items={items} height={10} dockRows={3} />);
      const rows = (lastFrame() ?? '').split('\n');

      expect(rows).toHaveLength(10);
      expect(rows[9]).toContain('dock-2');
      expect(rows[7]).toContain('dock-0');
      // The conversation ends on the row immediately above the dock.
      expect(rows[6]).toContain('line-39');

      unmount();
    });

    it('leaves NO blank band above the conversation when there is enough of it', () => {
      // The failure mode of an over-counting height estimate: the slice is cut too high, the
      // region cannot fill, and a band of empty rows appears above the conversation.
      const items = Array.from({ length: 60 }, (_, i) => line(i));
      const { lastFrame, unmount } = render(<Frame items={items} height={12} />);
      const rows = (lastFrame() ?? '').split('\n');

      expect(rows.filter((r) => r.trim() === '')).toHaveLength(0);

      unmount();
    });

    it('pads ABOVE, not below, when the conversation is shorter than the region', () => {
      const { lastFrame, unmount } = render(<Frame items={[line(1), line(2)]} height={6} />);
      const rows = (lastFrame() ?? '').split('\n');

      expect(rows).toHaveLength(6);
      expect(rows[0].trim()).toBe('');
      expect(rows[4]).toContain('line-1');
      expect(rows[5]).toContain('line-2');

      unmount();
    });

    it('renders a taller-than-the-region item by keeping its END on screen', () => {
      // A single assistant turn is routinely taller than the viewport, so "one item" is the floor
      // of the window and its top has to be what gets clipped.
      const tall: TranscriptItem = {
        kind: 'system',
        id: 1,
        level: 'INFO',
        text: Array.from({ length: 20 }, (_, i) => `chunk-${i}`).join('\n'),
      };
      const { lastFrame, unmount } = render(<Frame items={[tall]} height={5} />);
      const rows = (lastFrame() ?? '').split('\n');

      expect(rows).toHaveLength(5);
      expect(rows[4]).toContain('chunk-19');
      expect(lastFrame()).not.toContain('chunk-0\n');

      unmount();
    });
  });

  describe('unmounts what scrolls out of the window', () => {
    // The node's acceptance, asserted rather than assumed. There is no user-movable scroll yet, so
    // the window is advanced the way a session advances it: by appending. Each append pushes the
    // oldest mounted item out of the slice, and with `key={item.id}` that item's component is
    // destroyed. With `key={index}` React would keep one component per slot and swap its props, so
    // NOTHING would ever unmount — the guarantee would be false while the counter looked plausible.
    it('destroys the component of every item the window leaves behind', () => {
      // Saturate first: 20 three-row notices against a 12-row budget mount 5, so the window is
      // already full before a single append.
      const initial = Array.from({ length: 20 }, (_, i) => notice(i));
      const { rerender, unmount } = render(<Frame items={initial} height={12} />);

      const mountedAtStart = lifecycle.mounts;
      expect(mountedAtStart).toBeGreaterThan(0);
      expect(mountedAtStart).toBeLessThan(initial.length);
      expect(lifecycle.unmounts).toBe(0);

      const APPENDS = 20;
      let items = initial;
      for (let i = 0; i < APPENDS; i += 1) {
        items = [...items, notice(100 + i)];
        rerender(<Frame items={items} height={12} />);
      }

      // Every one of the 20 appends pushed exactly one item out of the window, so 20 components
      // were destroyed — and the number still mounted is the window size, unchanged.
      expect(lifecycle.unmounts).toBe(APPENDS);
      expect(lifecycle.mounts - lifecycle.unmounts).toBe(mountedAtStart);

      unmount();
    });

    it('churns nothing on a re-render that does not move the window', () => {
      // A spinner tick or a keystroke re-renders the frame many times a second. If those churned
      // the transcript the flat cost would be a fiction.
      const items = Array.from({ length: 20 }, (_, i) => notice(i));
      const { rerender, unmount } = render(<Frame items={items} height={12} />);
      const after = { mounts: lifecycle.mounts, unmounts: lifecycle.unmounts };

      for (let i = 0; i < 10; i += 1) rerender(<Frame items={items} height={12} />);

      expect(lifecycle.mounts).toBe(after.mounts);
      expect(lifecycle.unmounts).toBe(after.unmounts);

      unmount();
    });

    it('mounts a bounded number of components however long the transcript is', () => {
      // The DL-10 budget as a structural fact: 10 turns and 2000 turns mount the same components.
      const counts = [40, 500, 2000].map((n) => {
        lifecycle.mounts = 0;
        lifecycle.unmounts = 0;
        const items = Array.from({ length: n }, (_, i) => notice(i));
        const { unmount } = render(<Frame items={items} height={12} />);
        const mounted = lifecycle.mounts - lifecycle.unmounts;
        unmount();
        return mounted;
      });

      expect(new Set(counts).size).toBe(1);
      expect(counts[0]).toBeLessThanOrEqual(12);
    });
  });
});
