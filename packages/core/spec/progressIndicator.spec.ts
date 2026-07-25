import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ProgressIndicator writes through systemUtils' stdout wrapper (AGENTS.md: never console/process
// directly), so that is the seam we assert output on.
const stdoutWriteMock = vi.fn();
const systemUtilsMock = {
  stdout: { write: stdoutWriteMock },
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

/**
 * EXT-53. The indicator's 1s `setInterval` is an *active libuv handle*: while it is alive Node's
 * event loop cannot drain and the process cannot exit. These tests use fake timers so
 * `vi.getTimerCount()` pins the handle itself — a passing `stop()` must leave ZERO pending timers,
 * not merely "have been called".
 */
describe('ProgressIndicator', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the initial message and then a dot per second while running', async () => {
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Fetching.');
    expect(stdoutWriteMock).toHaveBeenCalledWith('Fetching.');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(3000);
    expect(stdoutWriteMock.mock.calls.filter((c) => c[0] === '.')).toHaveLength(3);

    indicator.stop();
  });

  it('stop() clears the interval so no timer handle is left holding the event loop open', async () => {
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Fetching.');
    expect(vi.getTimerCount()).toBe(1);

    indicator.stop();

    // The handle is gone — this is what lets the process exit.
    expect(vi.getTimerCount()).toBe(0);
    expect(stdoutWriteMock).toHaveBeenLastCalledWith('\n');

    // …and no further dots are ever emitted.
    stdoutWriteMock.mockClear();
    vi.advanceTimersByTime(10000);
    expect(stdoutWriteMock).not.toHaveBeenCalled();
  });

  it('stop() is idempotent: a second call is a no-op and emits no stray blank line', async () => {
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Fetching.');
    indicator.stop();

    stdoutWriteMock.mockClear();
    indicator.stop();
    indicator.stop();

    expect(stdoutWriteMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('emits exactly one newline across a success-path stop() plus a defensive finally stop()', async () => {
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Fetching.');
    try {
      indicator.stop(); // success-path stop, placed for output ordering
    } finally {
      indicator.stop(); // the EXT-53 belt-and-braces stop
    }

    expect(stdoutWriteMock.mock.calls.filter((c) => c[0] === '\n')).toHaveLength(1);
  });

  describe('manual mode', () => {
    it('starts no interval and advances only when indicate() is called', async () => {
      const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

      const indicator = new ProgressIndicator('reading STDIN', true);
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(5000);
      expect(stdoutWriteMock.mock.calls.filter((c) => c[0] === '.')).toHaveLength(0);

      indicator.indicate();
      expect(stdoutWriteMock.mock.calls.filter((c) => c[0] === '.')).toHaveLength(1);
    });

    it('still writes the terminating newline once on stop()', async () => {
      const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

      const indicator = new ProgressIndicator('reading STDIN', true);
      indicator.stop();
      indicator.stop();

      expect(stdoutWriteMock.mock.calls.filter((c) => c[0] === '\n')).toHaveLength(1);
    });

    it('indicate() still throws in automatic mode, including after stop() nulled the handle', async () => {
      const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

      const indicator = new ProgressIndicator('Fetching.');
      expect(() => indicator.indicate()).toThrow(
        'ProgressIndicator.indicate only to be called in manual mode'
      );

      indicator.stop();
      expect(() => indicator.indicate()).toThrow(
        'ProgressIndicator.indicate only to be called in manual mode'
      );
    });
  });
});
