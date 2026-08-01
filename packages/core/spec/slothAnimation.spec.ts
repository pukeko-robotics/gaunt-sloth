import { describe, expect, it } from 'vitest';

import {
  LEFT_PAD,
  RESTING_FACE,
  RIGHT_COLUMN,
  SLOTH_ANIMATIONS,
  SLOTH_ANIMATION_STEPS,
  launchBannerRows,
  pickSlothAnimation,
  type SlothAnimation,
} from '#src/core/launchBanner.js';

/** Every distinct face the animations can put on screen, resting frame included. */
const allFaces = (): readonly (readonly string[])[] => [
  RESTING_FACE,
  ...SLOTH_ANIMATIONS.flatMap((name) => SLOTH_ANIMATION_STEPS[name].map((step) => step.face)),
];

const fields = { version: '2.0.0', model: 'gemini', provider: 'google', directory: '/tmp/x' };

describe('sloth animation frames', () => {
  it('has exactly the four animations the art was drawn for', () => {
    expect([...SLOTH_ANIMATIONS]).toEqual(['blink', 'nod', 'look-around', 'eyeroll']);
  });

  describe('every frame keeps the banner geometry', () => {
    // This is the invariant that makes an animation a data change: if a frame were a different
    // height or wider than the face field, the right column would move and the version/model/cwd
    // fields would jump around mid-play — or worse, wrap and shatter the art.
    it.each(SLOTH_ANIMATIONS)('%s frames are five lines each', (name: SlothAnimation) => {
      for (const step of SLOTH_ANIMATION_STEPS[name]) {
        expect(step.face).toHaveLength(RESTING_FACE.length);
      }
    });

    it('no face is wider than the face field', () => {
      // 16 columns: RIGHT_COLUMN (22) minus the left margin (1) minus the 5-column gutter.
      const faceField = RIGHT_COLUMN - LEFT_PAD - 5;
      for (const face of allFaces()) {
        for (const line of face) {
          expect([...line].length).toBeLessThanOrEqual(faceField);
        }
      }
    });

    it('renders every frame with the right column at the same place', () => {
      const restingRight = launchBannerRows({ ...fields, columns: 100 }).map((row) => row.right);
      for (const face of allFaces()) {
        const rows = launchBannerRows({ ...fields, columns: 100, face });
        expect(rows).toHaveLength(7); // blank + five art rows + blank
        expect(rows.map((row) => row.right)).toEqual(restingRight);
        for (const row of rows) {
          if (row.right) expect([...row.face].length).toBe(RIGHT_COLUMN);
        }
      }
    });

    it('leaves no row ending in trailing whitespace, for any frame', () => {
      for (const face of allFaces()) {
        for (const row of launchBannerRows({ ...fields, columns: 100, face })) {
          expect(`${row.face}${row.right}`).toBe(`${row.face}${row.right}`.replace(/\s+$/, ''));
        }
      }
    });

    it('still drops the right column on a narrow terminal, for any frame', () => {
      for (const face of allFaces()) {
        const rows = launchBannerRows({ ...fields, columns: 30, face });
        expect(rows.every((row) => row.right === '')).toBe(true);
      }
    });
  });

  describe('sequences', () => {
    it('never lists the resting face as the last step — playback settles there itself', () => {
      for (const name of SLOTH_ANIMATIONS) {
        const steps = SLOTH_ANIMATION_STEPS[name];
        expect(steps.at(-1)!.face).not.toBe(RESTING_FACE);
      }
    });

    it('nods twice, returning to level in between', () => {
      // Mari's annotation: the sloth dips, comes back level, dips again, then ends level.
      const nod = SLOTH_ANIMATION_STEPS.nod;
      expect(nod).toHaveLength(3);
      expect(nod[0].face).toBe(nod[2].face);
      expect(nod[1].face).toBe(RESTING_FACE);
    });

    it('blink and look-around each use two distinct frames in order', () => {
      for (const name of ['blink', 'look-around'] as const) {
        const steps = SLOTH_ANIMATION_STEPS[name];
        expect(steps).toHaveLength(2);
        expect(steps[0].face).not.toBe(steps[1].face);
      }
    });

    it('eyeroll is a single frame', () => {
      expect(SLOTH_ANIMATION_STEPS.eyeroll).toHaveLength(1);
    });

    it('gives every step a positive hold, so no frame is skipped past', () => {
      for (const name of SLOTH_ANIMATIONS) {
        for (const step of SLOTH_ANIMATION_STEPS[name]) {
          expect(step.holdMs).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('pickSlothAnimation', () => {
    it('covers all four over enough draws', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 400; i++) seen.add(pickSlothAnimation());
      expect([...seen].sort()).toEqual([...SLOTH_ANIMATIONS].sort());
    });

    it('maps the random range evenly across the four', () => {
      // One representative draw per quarter — the mapping, not the distribution.
      expect(pickSlothAnimation(() => 0)).toBe('blink');
      expect(pickSlothAnimation(() => 0.3)).toBe('nod');
      expect(pickSlothAnimation(() => 0.55)).toBe('look-around');
      expect(pickSlothAnimation(() => 0.99)).toBe('eyeroll');
    });

    it('does not fall off the end when random returns exactly 1', () => {
      // Math.random never returns 1, but a stub or a future source might.
      expect(SLOTH_ANIMATIONS).toContain(pickSlothAnimation(() => 1));
    });
  });

  it('renders the resting face by default, so a plain launch is unchanged', () => {
    const withoutFace = launchBannerRows({ ...fields, columns: 100 });
    const withResting = launchBannerRows({ ...fields, columns: 100, face: RESTING_FACE });
    expect(withoutFace).toEqual(withResting);
  });
});
