import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';

import { useSlothAnimation } from '#src/tui/useSlothAnimation.js';
import {
  RESTING_FACE,
  SLOTH_ANIMATION_STEPS,
  type SlothAnimation,
} from '@gaunt-sloth/core/core/launchBanner.js';

/** Renders nothing useful; exposes the playback so a test can drive and observe it. */
function harness(pick?: () => SlothAnimation) {
  const seen: (readonly string[])[] = [];
  let play = (): void => {};
  let playing = false;

  function Probe() {
    const playback = useSlothAnimation(pick);
    seen.push(playback.face);
    play = playback.play;
    playing = playback.playing;
    return <Text>{playback.face[0]}</Text>;
  }

  const instance = render(<Probe />);
  return {
    ...instance,
    seen,
    play: () => play(),
    isPlaying: () => playing,
    /** The distinct faces shown so far, in order. */
    sequence: () => seen.filter((face, i) => i === 0 || face !== seen[i - 1]),
  };
}

/**
 * Let React and Ink commit. Ink schedules its commit on a macrotask, so under fake timers a state
 * change stays invisible until the clock moves. It advances by 1ms rather than 0 because a timer
 * due at the current instant is not fired by a zero-length advance — and every hold below is at
 * least 90ms, so the drift cannot reorder frames.
 */
const flush = () => vi.advanceTimersByTimeAsync(1);

/**
 * Advance the animation clock and let the resulting frame commit. The second, zero-length advance
 * is not redundant: firing a hold timer schedules React's commit, and that commit is itself a timer
 * which the first advance has already passed.
 */
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

describe('useSlothAnimation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the resting face and schedules nothing until asked', async () => {
    // The whole no-autoplay guarantee: mounting must not arm a single timer, or a piped/test run
    // would differ from one with no animation code at all.
    const h = harness(() => 'blink');

    expect(h.seen[0]).toBe(RESTING_FACE);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.isPlaying()).toBe(false);

    h.unmount();
  });

  it('paints the first frame immediately on play, so a click feels responsive', async () => {
    const h = harness(() => 'blink');

    h.play();
    await flush();

    expect(h.seen.at(-1)).toBe(SLOTH_ANIMATION_STEPS.blink[0].face);
    h.unmount();
  });

  it('walks blink through both frames and settles back on resting', async () => {
    const h = harness(() => 'blink');
    const [first, second] = SLOTH_ANIMATION_STEPS.blink;

    h.play();
    await advance(first.holdMs);
    expect(h.seen.at(-1)).toBe(second.face);

    await advance(second.holdMs);
    expect(h.seen.at(-1)).toBe(RESTING_FACE);
    expect(h.isPlaying()).toBe(false);

    h.unmount();
  });

  it('nods twice, passing through the resting face in the middle', async () => {
    const h = harness(() => 'nod');
    const steps = SLOTH_ANIMATION_STEPS.nod;

    h.play();
    await flush();
    for (const step of steps) await advance(step.holdMs);

    expect(h.sequence()).toEqual([
      RESTING_FACE,
      steps[0].face,
      steps[1].face, // level again
      steps[2].face,
      RESTING_FACE,
    ]);
    h.unmount();
  });

  it('plays exactly one animation per click — never chains into another', async () => {
    const h = harness(() => 'eyeroll');

    h.play();
    await flush();
    // Well past the end of the whole sequence.
    await advance(10_000);

    expect(h.sequence()).toEqual([
      RESTING_FACE,
      SLOTH_ANIMATION_STEPS.eyeroll[0].face,
      RESTING_FACE,
    ]);
    h.unmount();
  });

  it('does not loop — the resting face is final until the next click', async () => {
    const h = harness(() => 'blink');

    h.play();
    await advance(60_000);
    const settled = h.seen.length;
    await advance(60_000);

    expect(h.seen.length).toBe(settled);
    expect(h.seen.at(-1)).toBe(RESTING_FACE);
    h.unmount();
  });

  it('ignores a click during playback rather than queueing or restarting it', async () => {
    const picks: SlothAnimation[] = ['nod', 'eyeroll'];
    let i = 0;
    const h = harness(() => picks[Math.min(i++, picks.length - 1)]);
    const nod = SLOTH_ANIMATION_STEPS.nod;

    h.play();
    await flush();
    h.play(); // mid-flight: must be dropped
    h.play();
    await flush();

    for (const step of nod) await advance(step.holdMs);

    // Only the first pick ran; the eyeroll frame never appears.
    expect(h.sequence()).not.toContain(SLOTH_ANIMATION_STEPS.eyeroll[0].face);
    expect(h.seen.at(-1)).toBe(RESTING_FACE);
    // And nothing was left queued behind it: more time passes, the face does not move again.
    const settled = h.seen.length;
    await advance(10_000);
    expect(h.seen.length).toBe(settled);
    h.unmount();
  });

  it('accepts a new click once the previous animation has finished', async () => {
    const h = harness(() => 'eyeroll');

    h.play();
    await flush();
    await advance(SLOTH_ANIMATION_STEPS.eyeroll[0].holdMs);
    expect(h.seen.at(-1)).toBe(RESTING_FACE);
    expect(h.isPlaying()).toBe(false);

    h.play();
    await flush();
    expect(h.seen.at(-1)).toBe(SLOTH_ANIMATION_STEPS.eyeroll[0].face);
    h.unmount();
  });

  it('clears pending timers on unmount, so nothing fires into a gone component', async () => {
    // The banner is an intro: it disappears at the first exchange, which can land mid-animation.
    const h = harness(() => 'nod');

    h.play();
    await flush();
    const duringPlayback = h.seen.length;

    h.unmount();
    // Well past every remaining hold: a surviving timer would set state on an unmounted component,
    // which shows up either as another recorded render or as an unhandled React warning.
    await advance(10_000);

    expect(h.seen.length).toBe(duringPlayback);
  });
});
