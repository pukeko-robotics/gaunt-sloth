/**
 * `vi.waitFor` for the Ink render specs, polling every {@link FRAME_POLL_MS} ms instead of
 * vitest's 50 ms. OPS-122.
 *
 * WHY. An Ink frame lands a few milliseconds after the keystroke or agent event that causes it, so
 * a `vi.waitFor` whose first check runs before that frame then sleeps a whole 50 ms interval before
 * it looks again. In the specs that drive a whole conversation through `<App>`, that idle polling
 * was most of the cost. Measured on the Windows unit cell, summed per cell and averaged over four
 * cells before (runs 38648732784, 38648754702) and four after (38650003396, 38650007168):
 * `AppTranscriptScroll.spec.tsx` 28.0 s → 6.3 s, `AppTranscriptMounts.spec.tsx` 9.9 s → 2.5 s,
 * `AppFullScreen.spec.tsx` 4.7 s → 1.8 s. Where a case is bound by rendering instead, it helps
 * far less: `App.spec.tsx` went 37.8 s → 31.8 s there, against 12.7 s → 3.4 s on Linux.
 *
 * WHAT IT DOES NOT CHANGE. The callback, the timeout, and therefore every assertion are the
 * caller's own; only how soon a frame that has already landed is noticed moves. A number argument
 * is a timeout, exactly as in `vi.waitFor`, and an explicit `interval` still wins.
 *
 * NOT UNDER FAKE TIMERS. With fake timers `vi.waitFor` advances the fake clock by the interval on
 * every poll, so a shorter interval would change how much time a case lets pass. No caller of this
 * helper runs under fake timers; keep it that way, and use `vi.waitFor` where one does.
 *
 * Plain `.mjs` rather than `.ts` because the unit run collects every `.ts` under `spec/` as a test
 * file.
 */
import { vi } from 'vitest';

/** How often a frame is looked for. Far below any frame's own cost, so it adds no wait of its own. */
export const FRAME_POLL_MS = 5;

/**
 * @template T
 * @param {() => T | Promise<T>} callback
 * @param {number | { timeout?: number, interval?: number }} [options]
 * @returns {Promise<T>}
 */
export function waitForFrame(callback, options) {
  const given = typeof options === 'number' ? { timeout: options } : (options ?? {});
  return vi.waitFor(callback, { interval: FRAME_POLL_MS, ...given });
}
