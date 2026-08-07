import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALTERNATE_SCROLL_DISABLE_SEQUENCE,
  ALTERNATE_SCROLL_RESTORE_SEQUENCE,
  installAlternateScrollSuppression,
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

  it('requests button tracking but NOT drag reporting', () => {
    // TUI-C48 dropped `1002` (button-event tracking). Nothing in this codebase consumes a drag —
    // `LaunchBanner` is the only `MouseEvent.type` consumer and it reads `press` — so it was a
    // dozen decoded-and-discarded reports per drag. Asserting the mode numbers rather than
    // comparing the constant to itself is what makes this able to fail: a change that quietly
    // re-adds `1002` would otherwise sail through every other test in this file.
    expect(MOUSE_ENABLE_SEQUENCE).toContain('\x1b[?1000h');
    expect(MOUSE_ENABLE_SEQUENCE).not.toContain('\x1b[?1002h');
    expect(MOUSE_DISABLE_SEQUENCE).not.toContain('\x1b[?1002l');
  });

  it('leaves alternate-scroll untouched — that mode has its own handle', () => {
    // The two terminal modes are complements (see `installAlternateScrollSuppression`), so mouse
    // reporting must not also reach for `1007`, or the pair could never be swapped.
    expect(MOUSE_ENABLE_SEQUENCE).not.toContain('1007');
    expect(MOUSE_DISABLE_SEQUENCE).not.toContain('1007');
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

/**
 * TUI-C48 — alternate-scroll suppression, on the same teardown discipline as mouse reporting.
 *
 * It exists because in the alternate screen a terminal with no mouse mode set turns wheel notches
 * into bare Up/Down arrows, indistinguishable from real arrow presses — so the slash-command menu
 * would be driven by the wheel. Leaving the terminal unable to wheel-scroll after `gth` exits is
 * the same class of persistent damage as leaving mouse reporting on, which is why the restore paths
 * are asserted here rather than trusted.
 */
describe('installAlternateScrollSuppression', () => {
  let written: string[];
  let write: (_text: string) => void;

  beforeEach(() => {
    vi.resetAllMocks();
    written = [];
    write = (text: string) => void written.push(text);
  });

  it('disables alternate-scroll on install and restores it on dispose', () => {
    const handle = installAlternateScrollSuppression({ write, process: fakeProcess() as never });
    expect(written).toEqual([ALTERNATE_SCROLL_DISABLE_SEQUENCE]);

    handle.dispose();

    expect(written).toEqual([ALTERNATE_SCROLL_DISABLE_SEQUENCE, ALTERNATE_SCROLL_RESTORE_SEQUENCE]);
  });

  it('turns the mode OFF and hands it back ON — the two are not the same escape', () => {
    // A restore that repeated the disable sequence would look symmetric and leave the terminal
    // exactly as broken as no restore at all.
    expect(ALTERNATE_SCROLL_DISABLE_SEQUENCE).toBe('\x1b[?1007l');
    expect(ALTERNATE_SCROLL_RESTORE_SEQUENCE).toBe('\x1b[?1007h');
  });

  it('is idempotent — a second dispose does not write the restore twice', () => {
    const handle = installAlternateScrollSuppression({ write, process: fakeProcess() as never });

    handle.dispose();
    handle.dispose();

    expect(written.filter((w) => w === ALTERNATE_SCROLL_RESTORE_SEQUENCE)).toHaveLength(1);
  });

  it('restores on process exit — the path React unmount never reaches', () => {
    const proc = fakeProcess();
    installAlternateScrollSuppression({ write, process: proc as never });

    proc.fire('exit');

    expect(written).toContain(ALTERNATE_SCROLL_RESTORE_SEQUENCE);
  });

  describe.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('on %s', (signal) => {
    it('restores the terminal and re-raises so the process still dies', () => {
      const proc = fakeProcess();
      installAlternateScrollSuppression({ write, process: proc as never });

      proc.fire(signal);

      expect(written).toContain(ALTERNATE_SCROLL_RESTORE_SEQUENCE);
      expect(proc.kill).toHaveBeenCalledWith(proc.pid, signal);
      expect(proc.count(signal)).toBe(0);
    });
  });

  it('removes every hook on dispose, so a long-lived process does not leak listeners', () => {
    const proc = fakeProcess();
    const handle = installAlternateScrollSuppression({ write, process: proc as never });

    handle.dispose();

    expect(proc.count('exit')).toBe(0);
    expect(proc.count('SIGINT')).toBe(0);
    expect(proc.count('SIGTERM')).toBe(0);
    expect(proc.count('SIGHUP')).toBe(0);
  });
});
