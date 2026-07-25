import { stdout } from '#src/utils/systemUtils.js';

/**
 * A dot-per-second terminal progress indicator.
 *
 * **EXT-53 — always stop it, on every exit path.** In its automatic (non-`manual`) mode the
 * indicator owns a 1s `setInterval`, which is an *active libuv handle*: while it is alive Node's
 * event loop can never drain and the process cannot exit, no matter that every await has resolved.
 * A `stop()` that is only reachable on the success path therefore turns any error into a hang
 * rather than an exit. Construct the indicator OUTSIDE the `try` and clear it in a `finally`.
 *
 * `stop()` is idempotent (see below), so a `finally { indicator.stop() }` is always safe to add
 * even where a success-path `stop()` already ran.
 */
export class ProgressIndicator {
  private interval: number | undefined = undefined;
  private readonly manual: boolean;
  private stopped = false;

  constructor(initialMessage: string, manual?: boolean) {
    this.manual = !!manual;
    stdout.write(initialMessage);
    if (!this.manual) {
      this.interval = setInterval(this.indicateInner, 1000) as unknown as number;
    }
  }

  private indicateInner(): void {
    stdout.write('.');
  }

  indicate(): void {
    if (!this.manual) {
      throw new Error('ProgressIndicator.indicate only to be called in manual mode');
    }
    this.indicateInner();
  }

  /**
   * Clear the interval (releasing the libuv handle) and terminate the dot line with a newline.
   *
   * Idempotent: the handle is nulled and a second call is a complete no-op, so it emits no stray
   * blank line. That is what makes it safe to call from a `finally` on top of an existing
   * success-path `stop()`.
   */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    stdout.write('\n');
  }
}
