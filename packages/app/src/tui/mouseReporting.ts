/**
 * TUI-C37 — putting the terminal into a mode, and the far more important job of putting it back.
 *
 * A terminal left in mouse-reporting mode does not fail quietly. Every subsequent click in that
 * window writes escape bytes to whatever is reading stdin, so the user's shell fills with garbage
 * like `[<0;42;7M` long after `gth` exited. That is why teardown here covers a normal unmount, a
 * thrown error, `process.exit`, and the signals that would otherwise kill the process without ever
 * running an unmount path — and why every handle is written so that calling it twice, or tearing
 * down twice, is harmless.
 *
 * TUI-C48 adds a second mode to the same discipline (see
 * {@link installAlternateScrollSuppression}), because a terminal setting we change and do not
 * change back is the same class of damage whichever setting it is.
 */

import { stdout } from '@gaunt-sloth/core/utils/systemUtils.js';

/**
 * Enable: normal button tracking (`1000`) and the SGR extended encoding (`1006`).
 *
 * `1006` is the one that matters for correctness rather than features. The legacy encoding stuffs
 * coordinates into single bytes offset by 32, so it cannot express a column past 223 and mangles
 * anything beyond — on a modern wide terminal clicks on the right-hand side of the screen simply
 * report the wrong cell. SGR sends decimal parameters and has no such ceiling.
 *
 * Button-EVENT tracking (`1002`, motion reports while a button is held) is deliberately absent:
 * nothing in this codebase consumes a drag — `LaunchBanner` is the only `MouseEvent.type` consumer
 * and it reads `press` — so it would be a dozen decoded-and-discarded reports per drag. It buys
 * nothing back either: measured in a real terminal, `1000` alone is already enough for the terminal
 * to swallow the button press and refuse to start a native selection, so dropping `1002` does NOT
 * restore drag-select. Shift+drag is the override that does, and the `/mouse on` notice names it.
 */
export const MOUSE_ENABLE_SEQUENCE = '\x1b[?1000h\x1b[?1006h';

/** Disable, in the reverse order of enabling. */
export const MOUSE_DISABLE_SEQUENCE = '\x1b[?1006l\x1b[?1000l';

/**
 * TUI-C48 — turn OFF alternate-scroll (`1007`), which converts wheel notches into arrow keys.
 *
 * It only bites in the alternate screen with mouse tracking off, and that combination did not
 * exist before the full-screen dock: the terminal would deliver a wheel notch as bare `ESC[A` /
 * `ESC[B`, indistinguishable from a real arrow press, so scrolling the wheel would silently drive
 * the slash-command menu. They must not be bound to scrolling for the same reason.
 */
export const ALTERNATE_SCROLL_DISABLE_SEQUENCE = '\x1b[?1007l';

/**
 * Restore alternate-scroll on the way out.
 *
 * The terminals that implement `1007` enable it by default, so "on" is the state we took it from
 * and the one to hand back — leaving a terminal unable to scroll with the wheel after `gth` exits
 * is exactly the persistent change this module exists to prevent.
 */
export const ALTERNATE_SCROLL_RESTORE_SEQUENCE = '\x1b[?1007h';

/** The signals worth intercepting: each one terminates the process without unwinding React. */
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** A live terminal-mode session. `dispose` is idempotent. */
export interface MouseReportingHandle {
  /** Write the restore sequence and remove every teardown hook. Safe to call more than once. */
  dispose(): void;
}

/** Test seam: the sink the sequences are written to, defaulting to the real stdout. */
export interface MouseReportingOptions {
  write?: (text: string) => void;
  /** Test seam for the process-level hooks, so a spec never mutates the real process listeners. */
  process?: Pick<NodeJS.Process, 'on' | 'off' | 'kill' | 'pid'>;
}

/**
 * Write `set`, and register every teardown path that will write `restore`.
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
function installTerminalMode(
  set: string,
  restoreSequence: string,
  options: MouseReportingOptions
): MouseReportingHandle {
  const write = options.write ?? ((text: string) => void stdout.write(text));
  const proc = options.process ?? process;
  let disposed = false;

  const restore = () => {
    if (disposed) return;
    disposed = true;
    write(restoreSequence);
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

  write(set);
  proc.on('exit', onExit);
  for (const signal of SIGNALS) proc.on(signal, handlers[signal]);

  return { dispose: restore };
}

/** Turn on mouse reporting and register every teardown path, returning a handle that turns it off. */
export function installMouseReporting(options: MouseReportingOptions = {}): MouseReportingHandle {
  return installTerminalMode(MOUSE_ENABLE_SEQUENCE, MOUSE_DISABLE_SEQUENCE, options);
}

/**
 * Suppress alternate-scroll for as long as the handle lives, restoring it on every exit path.
 *
 * Installed exactly when mouse tracking is OFF — with tracking on the terminal reports the wheel
 * as an SGR event and alternate-scroll never applies, so suppressing it then would change a
 * setting for no reason.
 */
export function installAlternateScrollSuppression(
  options: MouseReportingOptions = {}
): MouseReportingHandle {
  return installTerminalMode(
    ALTERNATE_SCROLL_DISABLE_SEQUENCE,
    ALTERNATE_SCROLL_RESTORE_SEQUENCE,
    options
  );
}
