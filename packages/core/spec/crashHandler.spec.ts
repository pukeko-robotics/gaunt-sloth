import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the snapshot writer and node:fs so the handler is tested in isolation: we assert what it
// hands the writer, what it prints to stderr (fd 2 via writeSync), and that it exits — without
// touching disk or the real process. Per AGENTS.md, the mocked modules are placed at top level and
// the tested file is imported dynamically inside each test.
const writeCrashSnapshotMock = vi.fn();
vi.mock('#src/utils/debugDump.js', () => ({ writeCrashSnapshot: writeCrashSnapshotMock }));

const writeSyncMock = vi.fn();
vi.mock('node:fs', () => ({ writeSync: writeSyncMock }));

describe('utils/crashHandler (GS2-48)', () => {
  beforeEach(() => {
    // Fresh module state each test (the handler keeps a module-level re-entry/installed flag).
    vi.resetModules();
    vi.resetAllMocks();
  });

  const stderrText = (): string =>
    writeSyncMock.mock.calls
      .filter(([fd]) => fd === 2)
      .map(([, line]) => String(line))
      .join('');

  it('writes a snapshot, prints its path to stderr, then exits(1) — in that order', async () => {
    writeCrashSnapshotMock.mockReturnValue({
      crashDir: '/tmp/home/.gsloth/debug-dumps/crash-X',
      crashFile: '/tmp/home/.gsloth/debug-dumps/crash-X/crash.json',
    });
    const { handleCrash } = await import('#src/utils/crashHandler.js');

    const events: string[] = [];
    const exit = vi.fn(() => {
      events.push('exit');
    });
    writeCrashSnapshotMock.mockImplementation(() => {
      events.push('snapshot');
      return { crashDir: '/tmp/home/.gsloth/debug-dumps/crash-X', crashFile: '/x' };
    });

    const err = new Error('kaboom');
    handleCrash(err, 'uncaughtException', exit, () => ({
      config: { a: 1 },
      modelDisplayName: 'm',
      transcriptTail: [{ role: 'user' }],
    }));

    // Snapshot got the error + origin + context.
    expect(writeCrashSnapshotMock).toHaveBeenCalledTimes(1);
    expect(writeCrashSnapshotMock).toHaveBeenCalledWith({
      error: err,
      origin: 'uncaughtException',
      config: { a: 1 },
      modelDisplayName: 'm',
      transcriptTail: [{ role: 'user' }],
    });
    // Original error + snapshot path printed to fd 2.
    const out = stderrText();
    expect(out).toContain('fatal uncaughtException');
    expect(out).toContain('kaboom');
    expect(out).toContain('crash snapshot written to: /tmp/home/.gsloth/debug-dumps/crash-X');
    // Exit(1), and only after the snapshot was written.
    expect(exit).toHaveBeenCalledWith(1);
    expect(events).toEqual(['snapshot', 'exit']);
  });

  it('DEGRADES (never masks the original error, never loops) when snapshotting itself fails', async () => {
    const { handleCrash } = await import('#src/utils/crashHandler.js');
    writeCrashSnapshotMock.mockImplementation(() => {
      throw new Error('disk is a file, ENOTDIR');
    });
    const exit = vi.fn();

    handleCrash(new Error('original boom'), 'uncaughtException', exit, () => ({}));

    // The writer was invoked exactly once — no retry/loop on failure.
    expect(writeCrashSnapshotMock).toHaveBeenCalledTimes(1);
    const out = stderrText();
    // Original error is still surfaced…
    expect(out).toContain('original boom');
    // …plus a one-line reason for the snapshot failure.
    expect(out).toContain('failed to write crash snapshot: disk is a file, ENOTDIR');
    // …and the process still exits.
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('short-circuits on RE-ENTRY (a crash while handling a crash) — no second snapshot, still exits', async () => {
    const { handleCrash } = await import('#src/utils/crashHandler.js');
    const exit = vi.fn();

    // First call arms the module-level `handling` guard. Simulate a crash raised WHILE handling by
    // making the writer itself trigger a nested handleCrash — the nested call must NOT re-enter the
    // snapshot path.
    writeCrashSnapshotMock.mockImplementation(() => {
      handleCrash(new Error('nested crash'), 'unhandledRejection', exit, () => ({}));
      return { crashDir: '/d', crashFile: '/d/crash.json' };
    });

    handleCrash(new Error('outer crash'), 'uncaughtException', exit, () => ({}));

    // Writer ran once (the outer call); the nested call short-circuited to exit without re-invoking it.
    expect(writeCrashSnapshotMock).toHaveBeenCalledTimes(1);
    const out = stderrText();
    expect(out).toContain('crash handler re-entered while handling unhandledRejection');
    // Both the nested short-circuit and the outer completion call exit.
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('handles a non-Error rejection reason without throwing', async () => {
    writeCrashSnapshotMock.mockReturnValue({ crashDir: '/d', crashFile: '/d/crash.json' });
    const { handleCrash } = await import('#src/utils/crashHandler.js');
    const exit = vi.fn();

    expect(() =>
      handleCrash('a plain string reason', 'unhandledRejection', exit, () => ({}))
    ).not.toThrow();
    expect(writeCrashSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'a plain string reason', origin: 'unhandledRejection' })
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('installCrashHandler is idempotent and registers the two process listeners', async () => {
    const { installCrashHandler, uninstallCrashHandler } =
      await import('#src/utils/crashHandler.js');
    const before = {
      uncaught: process.listenerCount('uncaughtException'),
      unhandled: process.listenerCount('unhandledRejection'),
    };
    // Inject a no-op exit so a stray event during the test can't kill the runner.
    installCrashHandler({ exit: () => {} });
    installCrashHandler({ exit: () => {} }); // second call is a no-op
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.unhandled + 1);
    uninstallCrashHandler();
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(before.unhandled);
  });

  it('setCrashContext / updateCrashContext / clearCrashContext drive getCrashContext', async () => {
    const { setCrashContext, updateCrashContext, clearCrashContext, getCrashContext } =
      await import('#src/utils/crashHandler.js');
    setCrashContext({ config: { x: 1 }, modelDisplayName: 'm' });
    expect(getCrashContext()).toEqual({ config: { x: 1 }, modelDisplayName: 'm' });
    updateCrashContext({ transcriptTail: [1, 2] });
    expect(getCrashContext()).toEqual({
      config: { x: 1 },
      modelDisplayName: 'm',
      transcriptTail: [1, 2],
    });
    clearCrashContext();
    expect(getCrashContext()).toEqual({});
  });
});
