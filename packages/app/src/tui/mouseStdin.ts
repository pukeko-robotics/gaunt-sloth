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
 *
 * TUI-C62 — being upstream of Ink is also the only place a *keyboard* sequence delivered in two
 * reads can still be reassembled, because by the time Ink fans bytes out it has already decided they
 * were a keypress. A trailing `ESC` is held for {@link ESCAPE_HOLD_MS} and then handed on as the
 * Escape key if nothing completes it, which is the disambiguation timer `vi` and `readline` have
 * always had.
 *
 * **The residual, which is unresolvable in principle rather than unimplemented.** Two keystrokes
 * that arrive in the SAME read cannot be separated by any timer: the timing evidence is gone before
 * the bytes reach us. Releasing a held `ESC` also hands Ink a lone escape byte, which Ink holds
 * briefly on its own account before deciding, so a key pressed within roughly that much of a genuine
 * Escape still merges with it into a meta-chord and the Escape is lost. The whole window stays under
 * the ~160 ms floor of two deliberate human keypresses, which is what makes it a rarity rather than
 * a defect — but it is real, and it is the same ambiguity every terminal program has.
 */

import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { parseMouseReports, type MouseEvent } from '#src/tui/mouseParser.js';

/**
 * The longest a partial sequence can be before it cannot possibly become a valid one:
 * `ESC[<` + three 5-digit numbers + two separators + terminator. A partial never carries the
 * terminator, so a meta-prefixed one still fits inside this bound with room to spare. Past this the
 * held-back text is released as ordinary input rather than buffered forever.
 */
const MAX_PARTIAL = 24;

/**
 * TUI-C62 — how long a trailing `ESC` is held back before it is handed on as the Escape key.
 *
 * A meta-prefixed key is **one terminal write** the kernel may give us in two reads: Terminal.app
 * sends `Option+↑` as `ESC` followed by `ESC[A`, and 6 of 7 presses arrive split. The continuation
 * therefore follows sub-millisecond — measured at 0, 0, 1, 0, 0, 0 ms — while the fastest
 * *deliberate* human repeat is ~160 ms. Those two populations do not overlap, and this constant
 * sits in the void between them.
 *
 * It is **not** sized against the measured 1 ms. It is sized against a split arriving *late* on
 * hardware nobody measured — a loaded CI runner, an SBC, a contended VM — because that is the only
 * direction in which being wrong costs anything: a late split is exactly what reproduces the defect,
 * a running turn cancelling itself because the leading `ESC` was read as the interrupt key. Too
 * short merely reproduces today's behaviour and is never a new defect; too long delays a genuine
 * Escape by that much, and 100 ms still leaves 60 ms of clearance below the fastest deliberate human
 * press. Do not shave it to look tighter.
 */
const ESCAPE_HOLD_MS = 100;

/**
 * A trailing fragment that could still become a complete sequence once more bytes arrive.
 *
 * It matches from `ESC` onward — not just from `ESC[<`, and not just from `ESC[` — because a chunk
 * boundary can fall anywhere. A split right after `ESC[` would otherwise release those two bytes to
 * Ink and leave the next chunk starting at `<0;10;10M`, which no longer looks like a report and gets
 * typed into the prompt verbatim. The optional second `ESC` is the meta prefix, so the hold starts
 * at the *outermost* `ESC` of `ESC ESC [ A`; without it the leading byte of a split meta key escapes
 * to Ink as a bare Escape, which is the whole defect.
 */
const PARTIAL_SEQUENCE = /\x1b\x1b?(?:\[(?:<\d{0,5}(?:;\d{0,5}){0,2})?)?$/;

/**
 * The held fragments whose leading `ESC` could still be the Escape KEY, and therefore the only ones
 * the {@link ESCAPE_HOLD_MS} timer applies to. Everything longer has committed to being an
 * introducer — `ESC[` is never a keypress — and keeps the untimed hold, which cannot swallow an
 * interrupt because it was never one.
 *
 * `ESC ESC` is in the set because it is a legitimate prefix of `ESC ESC [ A`. It is also what an
 * auto-repeating Escape looks like: the repeat interval is 83 ms, *below* the hold, so both bytes
 * land inside one window. That is why release is per-`ESC` rather than per-buffer — the older one is
 * handed on when *its* window closes and the younger one keeps its own — and it is why holding
 * Escape still repeats instead of collapsing into a single keypress.
 */
const AMBIGUOUS_ESCAPE = /^\x1b\x1b?$/;

/**
 * Splits a byte stream into mouse events and everything else, across chunk boundaries.
 *
 * The boundary case is the whole reason this is a class rather than a function: a sequence can be
 * split by a chunk boundary, and a naive per-chunk parse would both miss the event and leak its
 * halves into the prompt. A trailing fragment that could still complete is held back until the next
 * chunk; anything too long to ever complete is released as ordinary input.
 *
 * The clock is a parameter rather than something this class reads, so the hold-back is decided by
 * arithmetic on values the caller supplies and every case can be driven at an exact instant.
 */
export class MouseInputFilter {
  private pending = '';
  /** Arrival time of each held byte — one entry per character of {@link pending}. */
  private pendingAt: number[] = [];

  /** Feed a chunk; get the events it contained and the keyboard input to pass on. */
  push(chunk: string, now: number = Date.now()): { events: MouseEvent[]; rest: string } {
    const combined = this.pending + chunk;
    // A held fragment is always a suffix of the text we parsed, so its arrival times are the tail of
    // this array — exactly, unless a whole mouse report was removed from between the held bytes and
    // the end, which shifts the tail and lends a held byte a LATER timestamp than its own. These
    // values never decrease, so the only consequence is an Escape delivered late rather than early,
    // and none of it can lose one.
    const combinedAt = [...this.pendingAt, ...new Array<number>(chunk.length).fill(now)];
    const { events, rest } = parseMouseReports(combined);
    this.pending = '';
    this.pendingAt = [];

    const partial = PARTIAL_SEQUENCE.exec(rest);
    if (partial && partial[0].length <= MAX_PARTIAL) {
      this.pending = partial[0];
      this.pendingAt = combinedAt.slice(combinedAt.length - partial[0].length);
      return { events, rest: rest.slice(0, partial.index) };
    }
    return { events, rest };
  }

  /**
   * When the oldest held byte stops being worth waiting on and has to be delivered as the Escape
   * key, or `undefined` when nothing ambiguous is held.
   */
  get escapeDeadline(): number | undefined {
    if (!AMBIGUOUS_ESCAPE.test(this.pending)) return undefined;
    return this.pendingAt[0] + ESCAPE_HOLD_MS;
  }

  /**
   * Hand back the oldest held `ESC` if its window has closed, or `''` if it has not.
   *
   * Exactly one byte, never the whole buffer: an ambiguous hold is at most `ESC ESC`, and releasing
   * both together would present two presses to Ink as the single keypress `ESC ESC`. The survivor
   * keeps its own arrival time, so a key held down goes on repeating at the keyboard's rate rather
   * than at this module's.
   */
  releaseExpiredEscape(now: number = Date.now()): string {
    const deadline = this.escapeDeadline;
    if (deadline === undefined || now < deadline) return '';
    this.pending = this.pending.slice(1);
    this.pendingAt = this.pendingAt.slice(1);
    return '\x1b';
  }

  /** Release anything held back — used on teardown so buffered bytes are not silently swallowed. */
  flush(): string {
    const held = this.pending;
    this.pending = '';
    this.pendingAt = [];
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
  // Ink sets its encoding on the PROXY, so the real stdin keeps handing us raw bytes. Decoding each
  // chunk independently would corrupt any multi-byte character split across a chunk boundary — an
  // emoji or a CJK character typed at the prompt would arrive as replacement characters. The
  // decoder holds the incomplete tail until its remaining bytes turn up.
  const decoder = new StringDecoder('utf8');

  // TUI-C62 — the timer that turns a held `ESC` into the Escape key. It is armed from whatever the
  // filter is holding rather than from the chunk that just arrived, so a fragment that grew, shrank
  // or completed in the meantime cannot leave a stale release scheduled behind it.
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;

  const clearEscapeTimer = () => {
    if (escapeTimer === undefined) return;
    clearTimeout(escapeTimer);
    escapeTimer = undefined;
  };

  const armEscapeTimer = () => {
    clearEscapeTimer();
    if (disposed) return;
    const deadline = filter.escapeDeadline;
    if (deadline === undefined) return;
    escapeTimer = setTimeout(releaseHeldEscape, Math.max(0, deadline - Date.now()));
    // A byte we are waiting on is never a reason to keep the process alive.
    escapeTimer.unref();
  };

  function releaseHeldEscape() {
    escapeTimer = undefined;
    const released = filter.releaseExpiredEscape(Date.now());
    if (released.length > 0) proxy.write(released);
    // A second held `ESC` (a key being held down) gets its own window from here, which is what
    // keeps one write per press instead of one per window.
    armEscapeTimer();
  }

  const onData = (chunk: Buffer | string) => {
    const { events, rest } = filter.push(
      typeof chunk === 'string' ? chunk : decoder.write(chunk),
      Date.now()
    );
    // Forward the keyboard remainder FIRST so ordinary typing is never delayed behind a handler,
    // then deliver the events. Order only matters when a chunk carries both, which is rare, but
    // typing should never be the thing that waits.
    if (rest.length > 0) proxy.write(rest);
    for (const event of events) onMouse(event);
    armEscapeTimer();
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
      clearEscapeTimer();
      source.off('data', onData);
      const held = filter.flush();
      if (held.length > 0) proxy.write(held);
    },
  };
}
