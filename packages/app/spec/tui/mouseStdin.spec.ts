import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

import { createMouseStdin, MouseInputFilter } from '#src/tui/mouseStdin.js';
import type { MouseEvent } from '#src/tui/mouseParser.js';

const report = (button: number, column: number, row: number, final: 'M' | 'm' = 'M') =>
  `\x1b[<${button};${column};${row}${final}`;

describe('MouseInputFilter', () => {
  let filter: MouseInputFilter;

  beforeEach(() => {
    vi.resetAllMocks();
    filter = new MouseInputFilter();
  });

  it('passes ordinary typing straight through', () => {
    expect(filter.push('hello')).toEqual({ events: [], rest: 'hello' });
  });

  it('removes a whole report from the keyboard stream', () => {
    const { events, rest } = filter.push(`a${report(0, 3, 3)}b`);
    expect(events).toHaveLength(1);
    expect(rest).toBe('ab');
  });

  describe('reports split across chunk boundaries', () => {
    // The failure this prevents is user-visible and obvious: half a report leaks into the prompt
    // and the click silently does nothing.
    it('holds back a partial report and completes it on the next chunk', () => {
      const first = filter.push('\x1b[<0;10');
      expect(first).toEqual({ events: [], rest: '' });

      const second = filter.push(';4M');
      expect(second.rest).toBe('');
      expect(second.events[0]).toMatchObject({ type: 'press', column: 9, row: 3 });
    });

    it('splits after the report marker', () => {
      expect(filter.push('\x1b[<').rest).toBe('');
      expect(filter.push('0;1;1M').events).toHaveLength(1);
    });

    it('splits immediately after the CSI introducer', () => {
      // The boundary that used to leak: releasing `ESC[` leaves the next chunk starting at
      // `<0;10;10M`, which no longer looks like a report and gets typed into the prompt verbatim.
      expect(filter.push('\x1b[').rest).toBe('');
      const next = filter.push('<0;10;10M');
      expect(next.rest).toBe('');
      expect(next.events[0]).toMatchObject({ type: 'press', column: 9, row: 9 });
    });

    it('lets a split arrow key through unchanged rather than eating it', () => {
      // `ESC[` is held because it cannot be a complete keypress, but it must be released intact the
      // moment the next chunk shows it was never a mouse report.
      expect(filter.push('\x1b[').rest).toBe('');
      expect(filter.push('A')).toEqual({ events: [], rest: '\x1b[A' });
    });

    it('passes a whole arrow key straight through without holding it', () => {
      expect(filter.push('\x1b[A')).toEqual({ events: [], rest: '\x1b[A' });
    });

    it('keeps the typing that preceded the partial report', () => {
      expect(filter.push('hi\x1b[<0;1')).toEqual({ events: [], rest: 'hi' });
      expect(filter.push(';1M').events).toHaveLength(1);
    });

    it('releases text that is too long to ever become a report, rather than buffering forever', () => {
      const junk = '\x1b[<' + '9'.repeat(60);
      expect(filter.push(junk).rest).toBe(junk);
    });

    it('flush returns held-back bytes so teardown does not silently swallow them', () => {
      filter.push('\x1b[<0;10');
      expect(filter.flush()).toBe('\x1b[<0;10');
      expect(filter.flush()).toBe('');
    });
  });

  /**
   * TUI-C62 — a meta-prefixed key delivered in two reads.
   *
   * Every case here states an instant explicitly, so the mechanism is decided by arithmetic on
   * values the test supplies rather than by anything elapsing. The numbers are the measured ones:
   * a split continuation lands within about a millisecond, keyboard auto-repeat is 83 ms, and a
   * deliberate human repeat cannot get below about 160 ms.
   */
  describe('a trailing Escape, held until it is unambiguous', () => {
    it('holds a lone trailing Escape rather than letting it reach the app', () => {
      // Released here, Ink reads it as the Escape KEY and `<App>` aborts the running turn — which is
      // the defect, because the very next read makes it the meta prefix of Option+↑.
      expect(filter.push('\x1b', 0)).toEqual({ events: [], rest: '' });
      expect(filter.escapeDeadline).toBe(100);
    });

    it('coalesces the split halves of Option+↑ into one meta-modified arrow', () => {
      expect(filter.push('\x1b', 0).rest).toBe('');
      // The continuation as Terminal.app delivers it: measured at 0-1 ms behind the prefix.
      expect(filter.push('\x1b[A', 1)).toEqual({ events: [], rest: '\x1b\x1b[A' });
      // Nothing is left waiting, so no Escape can arrive late either.
      expect(filter.escapeDeadline).toBeUndefined();
    });

    it('coalesces a three-way split, holding from the OUTER escape', () => {
      // The boundary that leaks if the hold starts at `ESC[` instead of at the meta prefix.
      expect(filter.push('\x1b', 0).rest).toBe('');
      expect(filter.push('\x1b[', 1).rest).toBe('');
      expect(filter.push('A', 2).rest).toBe('\x1b\x1b[A');
    });

    it('coalesces a split meta-letter, which is how word motions are spelled', () => {
      // `ESC b` is Option+← on Terminal.app and the readline chord everywhere.
      expect(filter.push('\x1b', 0).rest).toBe('');
      expect(filter.push('b', 1).rest).toBe('\x1bb');
    });

    it('releases the Escape once the window closes, and not a moment before', () => {
      filter.push('\x1b', 0);
      expect(filter.releaseExpiredEscape(99)).toBe('');
      expect(filter.releaseExpiredEscape(100)).toBe('\x1b');
      // Handed on exactly once: a second release would double every Escape the user pressed.
      expect(filter.escapeDeadline).toBeUndefined();
      expect(filter.releaseExpiredEscape(1000)).toBe('');
    });

    it('holds ESC ESC, because it is a legitimate prefix of a meta-arrow', () => {
      // 83 ms is the auto-repeat interval, so a held Escape lands twice inside ONE 100 ms window.
      filter.push('\x1b', 0);
      expect(filter.push('\x1b', 83)).toEqual({ events: [], rest: '' });
      expect(filter.escapeDeadline).toBe(100);
    });

    it('repeats when Escape is held: one release per press, at the keyboard rate', () => {
      // The regression a naive hold-back introduces — waiting for a `[A` that never comes and then
      // emitting ONE Escape where the user pressed two. Each byte keeps its own arrival time, so
      // the second release is 83 ms after the first, not 100 ms after it.
      filter.push('\x1b', 0);
      filter.push('\x1b', 83);

      expect(filter.releaseExpiredEscape(100)).toBe('\x1b');
      expect(filter.escapeDeadline).toBe(183);
      expect(filter.releaseExpiredEscape(182)).toBe('');
      expect(filter.releaseExpiredEscape(183)).toBe('\x1b');

      filter.push('\x1b', 166);
      expect(filter.escapeDeadline).toBe(266);
    });

    it('still coalesces when the repeat turns out to be a meta-arrow after all', () => {
      filter.push('\x1b', 0);
      filter.push('\x1b', 1);
      expect(filter.push('[A', 2).rest).toBe('\x1b\x1b[A');
      expect(filter.escapeDeadline).toBeUndefined();
    });

    it('releases two Escapes arriving in ONE read as two keypresses', () => {
      // Their gap is unmeasurable — the timing evidence is gone before the bytes reach us — so the
      // only question is how many presses they represent, and releasing them together would present
      // two as one.
      expect(filter.push('\x1b\x1b', 0).rest).toBe('');
      expect(filter.releaseExpiredEscape(100)).toBe('\x1b');
      expect(filter.escapeDeadline).toBe(100);
      expect(filter.releaseExpiredEscape(100)).toBe('\x1b');
      expect(filter.escapeDeadline).toBeUndefined();
    });

    it('keeps the typing that preceded a held Escape', () => {
      expect(filter.push('hi\x1b', 0).rest).toBe('hi');
      expect(filter.releaseExpiredEscape(100)).toBe('\x1b');
    });

    it('gives a partial mouse report no escape deadline, so it is never typed after a timeout', () => {
      // Past `ESC[` the leading byte has committed to being an introducer: it cannot be the Escape
      // key, so there is nothing for a timer to disambiguate and releasing it would type garbage.
      filter.push('\x1b[<0;10', 0);
      expect(filter.escapeDeadline).toBeUndefined();
      filter.flush();

      filter.push('\x1b[', 0);
      expect(filter.escapeDeadline).toBeUndefined();
    });

    it('gives a complete key no deadline at all', () => {
      expect(filter.push('\x1b\x1b[A', 0).rest).toBe('\x1b\x1b[A');
      expect(filter.escapeDeadline).toBeUndefined();
      expect(filter.push('\x1bb', 0).rest).toBe('\x1bb');
      expect(filter.escapeDeadline).toBeUndefined();
    });

    it('flush releases a held Escape so teardown does not swallow it', () => {
      filter.push('\x1b', 0);
      expect(filter.flush()).toBe('\x1b');
      expect(filter.escapeDeadline).toBeUndefined();
    });
  });
});

describe('createMouseStdin', () => {
  /** A fake TTY stdin: a PassThrough plus the terminal surface Ink actually touches. */
  function fakeStdin() {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    stream.setRawMode = vi.fn().mockReturnValue(stream);
    stream.ref = vi.fn().mockReturnValue(stream);
    stream.unref = vi.fn().mockReturnValue(stream);
    return stream;
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('forwards keyboard input to the proxy Ink reads', async () => {
    const source = fakeStdin();
    const { stdin } = createMouseStdin(source, vi.fn());
    stdin.setEncoding('utf8');

    source.write('typed');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdin.read()).toBe('typed');
  });

  it('keeps mouse reports away from Ink entirely', async () => {
    // This is the regression the whole module exists for: unfiltered, this text is inserted into
    // the prompt and the user watches `<0;5;5M` appear in what they were writing.
    const source = fakeStdin();
    const events: MouseEvent[] = [];
    const { stdin } = createMouseStdin(source, (event) => void events.push(event));
    stdin.setEncoding('utf8');

    source.write(report(0, 5, 5));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdin.read()).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'press', column: 4, row: 4 });
  });

  it('splits a chunk carrying both, delivering each to the right consumer', async () => {
    const source = fakeStdin();
    const events: MouseEvent[] = [];
    const { stdin } = createMouseStdin(source, (event) => void events.push(event));
    stdin.setEncoding('utf8');

    source.write(`ab${report(0, 1, 1)}cd`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdin.read()).toBe('abcd');
    expect(events).toHaveLength(1);
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    // Ink sets its encoding on the proxy, so the real stdin hands us raw bytes. Decoding each chunk
    // independently would turn a split emoji into replacement characters in the user's prompt.
    const source = fakeStdin();
    const { stdin } = createMouseStdin(source, vi.fn());
    stdin.setEncoding('utf8');

    const emoji = Buffer.from('🦥', 'utf8');
    source.write(emoji.subarray(0, 2));
    source.write(emoji.subarray(2));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdin.read()).toBe('🦥');
  });

  it('does not corrupt multi-byte input that arrives alongside a mouse report', async () => {
    const source = fakeStdin();
    const events: MouseEvent[] = [];
    const { stdin } = createMouseStdin(source, (event) => void events.push(event));
    stdin.setEncoding('utf8');

    source.write(Buffer.from(`日本${report(0, 1, 1)}語`, 'utf8'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdin.read()).toBe('日本語');
    expect(events).toHaveLength(1);
  });

  it('delegates isTTY, setRawMode, ref and unref to the real stdin', () => {
    // Raw mode and the process reference count belong to the real descriptor; faking them on a
    // pipe would leave the terminal cooked and swallow every keystroke.
    const source = fakeStdin();
    const { stdin } = createMouseStdin(source, vi.fn());

    expect(stdin.isTTY).toBe(true);
    stdin.setRawMode(true);
    stdin.ref();
    stdin.unref();

    expect(source.setRawMode).toHaveBeenCalledWith(true);
    expect(source.ref).toHaveBeenCalled();
    expect(source.unref).toHaveBeenCalled();
  });

  it('stops forwarding after dispose', async () => {
    const source = fakeStdin();
    const onMouse = vi.fn();
    const handle = createMouseStdin(source, onMouse);
    handle.stdin.setEncoding('utf8');

    handle.dispose();
    source.write('after');
    await new Promise((resolve) => setImmediate(resolve));

    expect(handle.stdin.read()).toBeNull();
    expect(onMouse).not.toHaveBeenCalled();
  });

  it('is safe to dispose twice', () => {
    const handle = createMouseStdin(fakeStdin(), vi.fn());
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
  });

  /**
   * TUI-C62 — the same mechanism at the seam Ink actually reads, where "no Escape reaches the app"
   * is a statement about bytes rather than about a decoded key object.
   *
   * The clock is driven, never waited on. `setImmediate` is left real so the stream itself still
   * runs, and only `setTimeout`/`Date` are under the test's control — so every instant below is
   * exact and nothing here can flake on a loaded machine.
   */
  describe('a trailing Escape held upstream of Ink', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Let the proxy stream deliver, without letting the escape timer move. */
    const deliver = () => new Promise((resolve) => setImmediate(resolve));

    it('gives Ink nothing until a split Option+↑ is whole again', async () => {
      // The defect, at the seam that causes it: Terminal.app sends `Option+↑` as ESC then ESC[A, and
      // 6 of 7 presses split. Released on its own, that leading ESC is the Escape KEY to Ink and
      // `<App>` aborts the running turn.
      const source = fakeStdin();
      const { stdin } = createMouseStdin(source, vi.fn());
      stdin.setEncoding('utf8');

      source.write('\x1b');
      await deliver();
      expect(stdin.read()).toBeNull();

      source.write('\x1b[A');
      await deliver();
      // Whole, and in ONE read, which is what makes Ink decode it as the meta-modified arrow rather
      // than as an Escape followed by a plain arrow.
      expect(stdin.read()).toBe('\x1b\x1b[A');
    });

    it('delivers a genuine Escape once the window closes', async () => {
      const source = fakeStdin();
      const { stdin } = createMouseStdin(source, vi.fn());
      stdin.setEncoding('utf8');

      source.write('\x1b');
      await deliver();
      vi.advanceTimersByTime(99);
      await deliver();
      expect(stdin.read()).toBeNull();

      vi.advanceTimersByTime(1);
      await deliver();
      expect(stdin.read()).toBe('\x1b');
    });

    it('repeats when Escape is held down, one keypress per press', async () => {
      // 100 ms is ABOVE the 83 ms auto-repeat interval, so both presses are held at once. Read
      // between the releases: a single read of `\x1b\x1b` would be ONE Escape to Ink, which is the
      // regression a buffer-at-a-time hold-back introduces.
      const source = fakeStdin();
      const { stdin } = createMouseStdin(source, vi.fn());
      stdin.setEncoding('utf8');

      source.write('\x1b');
      await deliver();
      vi.advanceTimersByTime(83);
      source.write('\x1b');
      await deliver();
      expect(stdin.read()).toBeNull();

      vi.advanceTimersByTime(17); // t = 100: the first press's window closes
      await deliver();
      expect(stdin.read()).toBe('\x1b');

      vi.advanceTimersByTime(82); // t = 182: the second is still its own press, not yet due
      await deliver();
      expect(stdin.read()).toBeNull();

      vi.advanceTimersByTime(1); // t = 183, i.e. 83 ms after the first — the keyboard's rate
      await deliver();
      expect(stdin.read()).toBe('\x1b');
    });

    it('hands over a held Escape on dispose rather than swallowing it', async () => {
      const source = fakeStdin();
      const handle = createMouseStdin(source, vi.fn());
      handle.stdin.setEncoding('utf8');

      source.write('\x1b');
      await deliver();
      handle.dispose();
      await deliver();

      expect(handle.stdin.read()).toBe('\x1b');
    });
  });
});
