import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installMouseReporting,
  MOUSE_DISABLE_SEQUENCE,
  MOUSE_ENABLE_SEQUENCE,
} from '#src/tui/mouseReporting.js';

/**
 * A stand-in for the process-level hooks, so a spec never touches the real listeners. Records what
 * was registered and lets a test fire it, which is the only way to prove the teardown paths that by
 * definition never run during a normal test.
 */
function fakeProcess() {
  const listeners = new Map<string, Set<(..._args: unknown[]) => void>>();
  const kill = vi.fn();
  return {
    kill,
    pid: 4242,
    on(event: string, listener: (..._args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return this;
    },
    off(event: string, listener: (..._args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    fire(event: string) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
    count(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

describe('installMouseReporting', () => {
  let written: string[];
  let write: (_text: string) => void;

  beforeEach(() => {
    vi.resetAllMocks();
    written = [];
    write = (text: string) => void written.push(text);
  });

  it('writes the enable sequence on install', () => {
    installMouseReporting({ write, process: fakeProcess() as never });

    expect(written).toEqual([MOUSE_ENABLE_SEQUENCE]);
  });

  it('requests SGR encoding, without which clicks past column 223 report the wrong cell', () => {
    expect(MOUSE_ENABLE_SEQUENCE).toContain('\x1b[?1006h');
  });

  it('writes the disable sequence on dispose', () => {
    const handle = installMouseReporting({ write, process: fakeProcess() as never });

    handle.dispose();

    expect(written).toEqual([MOUSE_ENABLE_SEQUENCE, MOUSE_DISABLE_SEQUENCE]);
  });

  it('is idempotent — a second dispose does not write the sequence twice', () => {
    const handle = installMouseReporting({ write, process: fakeProcess() as never });

    handle.dispose();
    handle.dispose();

    expect(written.filter((w) => w === MOUSE_DISABLE_SEQUENCE)).toHaveLength(1);
  });

  it('restores the terminal on process exit — the path React unmount never reaches', () => {
    const proc = fakeProcess();
    installMouseReporting({ write, process: proc as never });

    proc.fire('exit');

    expect(written).toContain(MOUSE_DISABLE_SEQUENCE);
  });

  describe.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('on %s', (signal) => {
    it('restores the terminal', () => {
      const proc = fakeProcess();
      installMouseReporting({ write, process: proc as never });

      proc.fire(signal);

      expect(written).toContain(MOUSE_DISABLE_SEQUENCE);
    });

    it('re-raises the signal so the process still dies as it would have', () => {
      // Swallowing the signal would turn Ctrl+C into a no-op — a worse bug than the one being fixed.
      const proc = fakeProcess();
      installMouseReporting({ write, process: proc as never });

      proc.fire(signal);

      expect(proc.kill).toHaveBeenCalledWith(4242, signal);
    });

    it('removes its own handler first, so the re-raise is not caught again', () => {
      const proc = fakeProcess();
      installMouseReporting({ write, process: proc as never });

      proc.fire(signal);

      expect(proc.count(signal)).toBe(0);
    });
  });

  it('removes every hook on dispose, so a long-lived process does not leak listeners', () => {
    const proc = fakeProcess();
    const handle = installMouseReporting({ write, process: proc as never });

    handle.dispose();

    expect(proc.count('exit')).toBe(0);
    expect(proc.count('SIGINT')).toBe(0);
    expect(proc.count('SIGTERM')).toBe(0);
    expect(proc.count('SIGHUP')).toBe(0);
  });

  it('does not write again on exit after an explicit dispose', () => {
    const proc = fakeProcess();
    const handle = installMouseReporting({ write, process: proc as never });

    handle.dispose();
    proc.fire('exit');

    expect(written.filter((w) => w === MOUSE_DISABLE_SEQUENCE)).toHaveLength(1);
  });
});
