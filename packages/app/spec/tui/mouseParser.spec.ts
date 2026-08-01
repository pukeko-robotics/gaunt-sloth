import { describe, expect, it } from 'vitest';

import { parseMouseReports } from '#src/tui/mouseParser.js';

/** Build an SGR report the way a terminal writes one. Coordinates are 1-based on the wire. */
const report = (button: number, column: number, row: number, final: 'M' | 'm' = 'M') =>
  `\x1b[<${button};${column};${row}${final}`;

describe('parseMouseReports', () => {
  describe('buttons', () => {
    it('decodes a left press, converting the 1-based wire coordinates to 0-based cells', () => {
      const { events } = parseMouseReports(report(0, 10, 4));
      expect(events).toEqual([
        {
          type: 'press',
          button: 'left',
          column: 9,
          row: 3,
          shift: false,
          meta: false,
          ctrl: false,
        },
      ]);
    });

    it('decodes middle and right presses from the low two bits', () => {
      expect(parseMouseReports(report(1, 1, 1)).events[0].button).toBe('middle');
      expect(parseMouseReports(report(2, 1, 1)).events[0].button).toBe('right');
    });

    it('treats the final byte as what distinguishes a release, not the button bits', () => {
      // The same button value with `m` instead of `M` — this is the whole point of SGR mode.
      expect(parseMouseReports(report(0, 5, 5, 'm')).events[0].type).toBe('release');
      expect(parseMouseReports(report(0, 5, 5, 'M')).events[0].type).toBe('press');
    });
  });

  describe('modifiers', () => {
    it('decodes shift, meta and ctrl from bits 2-4 rather than comparing the whole field', () => {
      // 0 (left) + 4 (shift) + 8 (meta) + 16 (ctrl) = 28. A naive equality check on the button
      // number would call this an unknown button and drop a perfectly good click.
      const { events } = parseMouseReports(report(28, 3, 3));
      expect(events[0]).toMatchObject({
        type: 'press',
        button: 'left',
        shift: true,
        meta: true,
        ctrl: true,
      });
    });

    it('reads a shifted right-click as right, not as some other button', () => {
      expect(parseMouseReports(report(2 + 4, 1, 1)).events[0]).toMatchObject({
        button: 'right',
        shift: true,
      });
    });
  });

  describe('drag and wheel', () => {
    it('classifies motion-with-button-held as a drag', () => {
      expect(parseMouseReports(report(32, 8, 2)).events[0].type).toBe('drag');
    });

    it('decodes wheel up and down as wheel events, not as button clicks', () => {
      const up = parseMouseReports(report(64, 1, 1)).events[0];
      const down = parseMouseReports(report(65, 1, 1)).events[0];
      expect(up).toMatchObject({ type: 'wheel', wheel: 'up', button: 'none' });
      expect(down).toMatchObject({ type: 'wheel', wheel: 'down', button: 'none' });
    });

    it('keeps modifiers on wheel events', () => {
      expect(parseMouseReports(report(64 + 16, 1, 1)).events[0]).toMatchObject({
        type: 'wheel',
        wheel: 'up',
        ctrl: true,
      });
    });
  });

  describe('separating mouse bytes from keyboard input', () => {
    it('returns ordinary typing untouched with no events', () => {
      expect(parseMouseReports('hello')).toEqual({ events: [], rest: 'hello' });
    });

    it('leaves ordinary escape sequences (arrow keys) alone', () => {
      expect(parseMouseReports('\x1b[A')).toEqual({ events: [], rest: '\x1b[A' });
    });

    it('extracts the report and hands back the surrounding typing', () => {
      const { events, rest } = parseMouseReports(`ab${report(0, 2, 2)}cd`);
      expect(events).toHaveLength(1);
      expect(rest).toBe('abcd');
    });

    it('decodes several reports from one chunk, in order', () => {
      const { events, rest } = parseMouseReports(report(0, 1, 1) + report(0, 2, 2, 'm'));
      expect(events.map((e) => e.type)).toEqual(['press', 'release']);
      expect(rest).toBe('');
    });
  });

  describe('malformed input', () => {
    // The failure that matters: anything not decoded must stay in `rest` for the keyboard path, and
    // must never be invented into an event at a coordinate the user never clicked.
    it('leaves a truncated report in rest rather than guessing at it', () => {
      const partial = '\x1b[<0;10';
      expect(parseMouseReports(partial)).toEqual({ events: [], rest: partial });
    });

    it('leaves a report with a missing terminator in rest', () => {
      const broken = '\x1b[<0;10;4';
      expect(parseMouseReports(broken)).toEqual({ events: [], rest: broken });
    });

    it('leaves a non-numeric report in rest', () => {
      const broken = '\x1b[<a;b;cM';
      expect(parseMouseReports(broken)).toEqual({ events: [], rest: broken });
    });

    it('clamps a zero coordinate to cell 0 rather than producing a negative cell', () => {
      expect(parseMouseReports(report(0, 0, 0)).events[0]).toMatchObject({ column: 0, row: 0 });
    });

    it('still finds a valid report after a malformed one', () => {
      const { events, rest } = parseMouseReports(`\x1b[<0;10${report(0, 4, 4)}`);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ column: 3, row: 3 });
      expect(rest).toBe('\x1b[<0;10');
    });
  });
});
