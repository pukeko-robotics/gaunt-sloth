import { beforeEach, describe, expect, it, vi } from 'vitest';
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

    it('splits at the very first byte of the sequence', () => {
      expect(filter.push('\x1b[<').rest).toBe('');
      expect(filter.push('0;1;1M').events).toHaveLength(1);
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
});
