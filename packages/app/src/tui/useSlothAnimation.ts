/**
 * TUI-C40 — playback for the launch banner's sloth animations.
 *
 * The frames and the sequences are data in `@gaunt-sloth/core/core/launchBanner.js`; this is only
 * the clock. It is a hook rather than part of the component so the timing rules can be tested
 * directly, without measuring a rendered frame.
 *
 * **It never starts anything by itself.** There is no mount effect, no interval, no autoplay — the
 * only way a frame changes is a call to `play`, which the banner wires to a click. That is what
 * keeps a piped, non-TTY, `NO_COLOR` or test run byte-identical to a session with no animation code
 * at all: nothing schedules a timer until a human clicks something.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RESTING_FACE,
  SLOTH_ANIMATION_STEPS,
  pickSlothAnimation,
  type SlothAnimation,
} from '@gaunt-sloth/core/core/launchBanner.js';

export interface SlothAnimationPlayback {
  /** The face to draw right now — {@link RESTING_FACE} whenever nothing is playing. */
  face: readonly string[];
  /** Start one animation. A call while one is already playing is ignored, never queued. */
  play: () => void;
  /** Whether an animation is on screen; exposed for tests and for hint copy. */
  playing: boolean;
}

/**
 * Drive one animation at a time, settling back on the resting face.
 *
 * `pick` is injectable so a test can pin which animation runs; production passes nothing and gets
 * the random choice. It is held in a ref so an inline arrow from the caller does not re-create
 * `play` on every render.
 */
export function useSlothAnimation(
  pick: () => SlothAnimation = pickSlothAnimation
): SlothAnimationPlayback {
  const [face, setFace] = useState<readonly string[]>(RESTING_FACE);
  const [playing, setPlaying] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Read synchronously inside `play`, because two clicks in the same tick would both see the same
  // stale value if this were state.
  const playingRef = useRef(false);
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  // Unmount can land mid-animation — the banner is an intro and disappears at the first exchange —
  // so pending timers must not fire into a gone component.
  useEffect(() => clearTimers, [clearTimers]);

  const play = useCallback(() => {
    // Ignored rather than restarted: a rapid click-storm would otherwise strobe the art, and this
    // is the first thing on screen in a session. One click, one animation, played to its end.
    if (playingRef.current) return;
    playingRef.current = true;
    setPlaying(true);

    const steps = SLOTH_ANIMATION_STEPS[pickRef.current()];
    // The first frame paints synchronously: a click that takes a tick to respond feels broken, and
    // the hold times below are already tuned as "how long this frame stays", not "when it starts".
    setFace(steps[0].face);

    let elapsed = steps[0].holdMs;
    for (const step of steps.slice(1)) {
      const at = elapsed;
      timers.current.push(setTimeout(() => setFace(step.face), at));
      elapsed += step.holdMs;
    }

    timers.current.push(
      setTimeout(() => {
        setFace(RESTING_FACE);
        playingRef.current = false;
        setPlaying(false);
        timers.current = [];
      }, elapsed)
    );
  }, []);

  return { face, play, playing };
}
