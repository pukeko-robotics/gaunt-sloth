/**
 * TUI-C37 — keeping mouse bytes away from Ink's keyboard path.
 *
 * Ink has no notion of mouse input, so anything it receives it treats as typing. An unfiltered
 * mouse report reaches `useInput`, which hands it to `<PromptInput>`, which inserts it — the user
 * clicks and watches `<35;10;4M` appear in the middle of the sentence they were writing. Filtering
 * inside a `useInput` handler cannot fix this, because by then Ink has already fanned the same bytes
 * out to every other consumer.
 *
 * So the split happens upstream of Ink entirely: `render()` is handed {@link createMouseStdin}'s
 * proxy stream instead of the real stdin. The proxy forwards ordinary keystrokes through unchanged
 * and diverts mouse reports to a callback. Ink stays exactly as unaware of the mouse as it was, and
 * the keyboard model is untouched — which is what keeps every existing input spec and the PTY suite
 * meaningful rather than merely still-passing.
 */

import { PassThrough } from 'node:stream';
import { parseMouseReports, type MouseEvent } from '#src/tui/mouseParser.js';

/**
 * The longest a partial report can be before it cannot possibly become a valid one:
 * `ESC[<` + three 5-digit numbers + two separators + terminator. Past this the held-back text is
 * released as ordinary input rather than buffered forever.
 */
const MAX_PARTIAL = 24;

/** A trailing fragment that could still become a complete report once more bytes arrive. */
const PARTIAL_REPORT = /\x1b\[<\d{0,5}(?:;\d{0,5}){0,2}$/;

/**
 * Splits a byte stream into mouse events and everything else, across chunk boundaries.
 *
 * The boundary case is the whole reason this is a class rather than a function: a report can be
 * split by a chunk boundary, and a naive per-chunk parse would both miss the event and leak its
 * halves into the prompt. A trailing fragment that could still complete is held back until the next
 * chunk; anything too long to ever complete is released as ordinary input.
 */
export class MouseInputFilter {
  private pending = '';

  /** Feed a chunk; get the events it contained and the keyboard input to pass on. */
  push(chunk: string): { events: MouseEvent[]; rest: string } {
    const { events, rest } = parseMouseReports(this.pending + chunk);
    this.pending = '';

    const partial = PARTIAL_REPORT.exec(rest);
    if (partial && partial[0].length <= MAX_PARTIAL) {
      this.pending = partial[0];
      return { events, rest: rest.slice(0, partial.index) };
    }
    return { events, rest };
  }

  /** Release anything held back — used on teardown so buffered bytes are not silently swallowed. */
  flush(): string {
    const held = this.pending;
    this.pending = '';
    return held;
  }
}

/** The stdin shape Ink needs. A real `process.stdin` satisfies it; so does the proxy. */
type InkStdin = NodeJS.ReadStream;

/** A filtered stdin plus its teardown. */
export interface MouseStdin {
  /** Hand this to Ink's `render({ stdin })` in place of the real stdin. */
  stdin: InkStdin;
  /** Stop forwarding and detach from the real stdin. Idempotent. */
  dispose(): void;
}

/**
 * Wrap a real stdin in a proxy that strips mouse reports and reports them to `onMouse`.
 *
 * The proxy is a `PassThrough` carrying the TTY surface Ink actually touches — `isTTY`,
 * `setRawMode`, `ref`, `unref` — delegated to the real stream, because raw mode and the process
 * reference count belong to the real file descriptor and cannot be faked on a pipe.
 */
export function createMouseStdin(
  source: InkStdin,
  onMouse: (event: MouseEvent) => void
): MouseStdin {
  const filter = new MouseInputFilter();
  const proxy = new PassThrough() as unknown as InkStdin & PassThrough;
  let disposed = false;

  const onData = (chunk: Buffer | string) => {
    const { events, rest } = filter.push(
      typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    );
    // Forward the keyboard remainder FIRST so ordinary typing is never delayed behind a handler,
    // then deliver the events. Order only matters when a chunk carries both, which is rare, but
    // typing should never be the thing that waits.
    if (rest.length > 0) proxy.write(rest);
    for (const event of events) onMouse(event);
  };

  source.on('data', onData);

  // Ink asks the stream about, and mutates, the terminal itself; those calls have to reach the real
  // descriptor. `isTTY` is defined as a getter so it tracks the source rather than snapshotting it.
  Object.defineProperty(proxy, 'isTTY', { get: () => source.isTTY, configurable: true });
  proxy.setRawMode = (mode: boolean) => {
    source.setRawMode?.(mode);
    return proxy;
  };
  proxy.ref = () => {
    source.ref?.();
    return proxy;
  };
  proxy.unref = () => {
    source.unref?.();
    return proxy;
  };

  return {
    stdin: proxy,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      source.off('data', onData);
      const held = filter.flush();
      if (held.length > 0) proxy.write(held);
    },
  };
}
