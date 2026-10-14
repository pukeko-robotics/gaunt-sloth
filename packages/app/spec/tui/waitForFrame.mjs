/**
 * `vi.waitFor` for the Ink render specs, polling every {@link FRAME_POLL_MS} ms instead of
 * vitest's 50 ms. OPS-122.
 *
 * WHY. Most of what these specs cost on the Windows unit cell was not rendering, it was waiting
 * between polls. An Ink frame lands a few milliseconds after the keystroke or agent event that
 * causes it, so a `vi.waitFor` whose first check runs before that frame then sleeps a whole
 * interval — 50 ms asked, closer to 62 ms on that runner, whose timers tick at 15.6 ms — before it
 * looks again. A case that waits on twenty or thirty frames spends one to two seconds asleep, and
 * those cases sat nearest the 10 s per-test ceiling. Measured locally over
 * `packages/app/spec/tui/`: `App.spec.tsx` went from 12.7 s to 3.4 s summed over its 78 cases,
 * the same 78 passing.
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
