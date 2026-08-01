import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

import { LaunchBanner } from '#src/tui/components/LaunchBanner.js';
import { MouseProvider } from '#src/tui/useMouse.js';
import { FALLBACK_TERMINAL_ROWS } from '#src/tui/useMouse.js';
import { RESTING_FACE, SLOTH_ANIMATION_STEPS } from '@gaunt-sloth/core/core/launchBanner.js';
import type { MouseEvent } from '#src/tui/mouseParser.js';

const press = (row: number, column: number): MouseEvent => ({
  type: 'press',
  button: 'left',
  row,
  column,
  shift: false,
  meta: false,
  ctrl: false,
});

function mouseSource() {
  const listeners = new Set<(event: MouseEvent) => void>();
  return {
    subscribe: (listener: (event: MouseEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: (event: MouseEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(1);

/**
 * TUI-C40 — the banner as a clickable thing, end to end through the real TUI-C37 layer.
 *
 * This is the node's central claim: a mouse event delivered the way the session module delivers one
 * reaches the banner's registered region and changes the art. The frame data and the playback clock
 * are proved in their own specs; what only a render can show is that the two are actually wired to
 * a hit region covering the block the user sees.
 */
describe('tui <LaunchBanner> click', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The banner is the whole frame here, so its rows run from the frame origin. */
  const bannerRow = (frame: string | undefined, row: number) =>
    FALLBACK_TERMINAL_ROWS - (frame ?? '').split('\n').length + row;

  it('plays an animation when its region is clicked', async () => {
    const source = mouseSource();
    const { lastFrame, unmount } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <LaunchBanner columns={100} pickAnimation={() => 'eyeroll'} />
      </MouseProvider>
    );
    // Row 0 is the blank pad row; row 1 is the first art row.
    expect(lastFrame()).toContain(RESTING_FACE[2]);

    source.emit(press(bannerRow(lastFrame(), 2), 4));
    await flush();

    expect(lastFrame()).toContain(SLOTH_ANIMATION_STEPS.eyeroll[0].face[2]);
    unmount();
  });

  it('settles back to the resting face when the animation ends', async () => {
    const source = mouseSource();
    const { lastFrame, unmount } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <LaunchBanner columns={100} pickAnimation={() => 'eyeroll'} />
      </MouseProvider>
    );

    source.emit(press(bannerRow(lastFrame(), 2), 4));
    await flush();
    await vi.advanceTimersByTimeAsync(SLOTH_ANIMATION_STEPS.eyeroll[0].holdMs);
    await flush();

    expect(lastFrame()).toContain(RESTING_FACE[2]);
    unmount();
  });

  it('keeps the version, model and directory fields fixed while the face changes', async () => {
    // The whole reason an animation is only a face swap: the live fields must not twitch.
    const source = mouseSource();
    const { lastFrame, unmount } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <LaunchBanner columns={100} model="gemini-3.1-pro" provider="google" pickAnimation={() => 'nod'} />
      </MouseProvider>
    );
    const rightHalves = (frame: string | undefined) =>
      (frame ?? '')
        .split('\n')
        .map((line) => line.slice(22))
        .join('\n');
    const before = rightHalves(lastFrame());

    source.emit(press(bannerRow(lastFrame(), 2), 4));
    await flush();

    expect(lastFrame()).toContain(SLOTH_ANIMATION_STEPS.nod[0].face[2]);
    expect(rightHalves(lastFrame())).toBe(before);
    unmount();
  });

  it('does nothing when the click lands outside the banner', async () => {
    const source = mouseSource();
    const { lastFrame, unmount } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <LaunchBanner columns={100} pickAnimation={() => 'eyeroll'} />
      </MouseProvider>
    );

    // Well above the live frame — committed <Static> scrollback, which is not clickable.
    source.emit(press(0, 4));
    await flush();

    expect(lastFrame()).toContain(RESTING_FACE[2]);
    unmount();
  });

  it('never animates when mouse is off, and paints the resting face', async () => {
    // A keyboard-only session, a piped run, NO_COLOR — all reach here with mouse disabled, and must
    // look exactly like a session built before this node existed.
    const source = mouseSource();
    const { lastFrame, unmount } = render(
      <MouseProvider subscribe={source.subscribe} enabled={false}>
        <LaunchBanner columns={100} pickAnimation={() => 'eyeroll'} />
      </MouseProvider>
    );

    source.emit(press(bannerRow(lastFrame(), 2), 4));
    await flush();

    expect(lastFrame()).toContain(RESTING_FACE[2]);
    unmount();
  });

  it('renders the resting face on mount and schedules nothing', async () => {
    const source = mouseSource();
    const { lastFrame, unmount } = render(
      <MouseProvider subscribe={source.subscribe} enabled>
        <LaunchBanner columns={100} />
      </MouseProvider>
    );

    expect(lastFrame()).toContain(RESTING_FACE[0]);
    expect(lastFrame()).toContain(RESTING_FACE[4]);
    unmount();
  });
});
