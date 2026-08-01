/**
 * TUI-C37 — turning terminal mouse reporting on, and the far more important job of turning it back
 * off again.
 *
 * A terminal left in mouse-reporting mode does not fail quietly. Every subsequent click in that
 * window writes escape bytes to whatever is reading stdin, so the user's shell fills with garbage
 * like `[<0;42;7M` long after `gth` exited. That is why teardown here covers a normal unmount, a
 * thrown error, `process.exit`, and the signals that would otherwise kill the process without ever
 * running an unmount path — and why {@link installMouseReporting} is written so that calling it
 * twice, or tearing down twice, is harmless.
 */

import { stdout } from '@gaunt-sloth/core/utils/systemUtils.js';

/**
 * Enable: normal button tracking (`1000`), button-event tracking so drags are reported (`1002`),
 * and the SGR extended encoding (`1006`).
 *
 * `1006` is the one that matters for correctness rather than features. The legacy encoding stuffs
 * coordinates into single bytes offset by 32, so it cannot express a column past 223 and mangles
 * anything beyond — on a modern wide terminal clicks on the right-hand side of the screen simply
 * report the wrong cell. SGR sends decimal parameters and has no such ceiling.
 */
export const MOUSE_ENABLE_SEQUENCE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

/** Disable, in the reverse order of enabling. */
export const MOUSE_DISABLE_SEQUENCE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

/** The signals worth intercepting: each one terminates the process without unwinding React. */
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** A live mouse-reporting session. `dispose` is idempotent. */
export interface MouseReportingHandle {
  /** Write the disable sequence and remove every teardown hook. Safe to call more than once. */
  dispose(): void;
}

/** Test seam: the sink the sequences are written to, defaulting to the real stdout. */
export interface MouseReportingOptions {
  write?: (text: string) => void;
  /** Test seam for the process-level hooks, so a spec never mutates the real process listeners. */
  process?: Pick<NodeJS.Process, 'on' | 'off' | 'kill' | 'pid'>;
}

/**
 * Turn on mouse reporting and register every teardown path, returning a handle that turns it off.
 *
 * Teardown is registered for:
 *  - the caller's own `dispose()` — the normal unmount path;
 *  - `process.on('exit')` — covers `process.exit()` and an uncaught exception, both of which reach
 *    'exit' but never reach React's unmount;
 *  - `SIGINT` / `SIGTERM` / `SIGHUP` — which by default terminate WITHOUT firing 'exit'.
 *
 * The signal handlers deliberately do not swallow the signal: they restore the terminal, remove
 * themselves, and re-raise it so the process still dies exactly as it would have. Swallowing would
 * turn Ctrl+C into a no-op, which is a far worse bug than the one being fixed.
 */
export function installMouseReporting(options: MouseReportingOptions = {}): MouseReportingHandle {
  const write = options.write ?? ((text: string) => void stdout.write(text));
  const proc = options.process ?? process;
  let disposed = false;

  const restore = () => {
    if (disposed) return;
    disposed = true;
    write(MOUSE_DISABLE_SEQUENCE);
    proc.off('exit', onExit);
    for (const signal of SIGNALS) proc.off(signal, handlers[signal]);
  };

  const onExit = () => restore();

  // One handler per signal so `off` can remove exactly the function it added.
  const handlers = Object.fromEntries(
    SIGNALS.map((signal) => [
      signal,
      () => {
        restore();
        // Re-raise: with our listener gone the default disposition applies again, so the process
        // terminates with the right status instead of silently continuing.
        proc.kill(proc.pid, signal);
      },
    ])
  ) as Record<NodeJS.Signals, () => void>;

  write(MOUSE_ENABLE_SEQUENCE);
  proc.on('exit', onExit);
  for (const signal of SIGNALS) proc.on(signal, handlers[signal]);

  return { dispose: restore };
}
