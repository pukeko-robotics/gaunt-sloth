/**
 * TUI-C37 — pure, React-free tokenizer for SGR mouse reports.
 *
 * Ink 7.1.1 reads no mouse at all, so unlike bracketed paste (where Ink owns the protocol and
 * `pasteParser.ts` only normalizes the payload) the whole decoding job is ours. The division of
 * labour is the same though: this file is a pure function over strings, so every button, modifier
 * and malformed-input case is unit-testable without a terminal.
 *
 * **The wire format.** In SGR mode (`ESC[?1006h`) a report is `ESC[<b;x;yM` for a press and
 * `ESC[<b;x;ym` for a release — the FINAL BYTE, not the button bits, is what distinguishes them,
 * which is the whole reason SGR is worth enabling over the legacy X10 encoding it replaces. `x` and
 * `y` are 1-based columns and rows; this module converts them to the 0-based coordinates the
 * hit-region math uses, because doing it once here is what stops every consumer from getting it
 * wrong in its own way.
 *
 * **`b` is a bitfield, not a button number.** Low bits 0-1 give the button, and bits 2-4 carry the
 * modifiers, so `b` must be masked rather than compared:
 *
 * | bit | meaning                                              |
 * |-----|------------------------------------------------------|
 * | 0-1 | button: 0 left, 1 middle, 2 right, 3 none/release    |
 * | 2   | Shift                                                |
 * | 3   | Meta / Alt                                           |
 * | 4   | Ctrl                                                 |
 * | 5   | motion (a drag, i.e. movement with a button held)     |
 * | 6   | wheel — buttons 64/65 are wheel up/down, not clicks   |
 *
 * **Anything unrecognized must be dropped, never forwarded.** A half-received or malformed report
 * that fell through to Ink's `useInput` would be injected into the prompt buffer as literal text —
 * the user sees `<35;10;4M` appear in what they are typing. {@link parseMouseReports} therefore
 * returns the non-mouse remainder separately, so the caller can pass ordinary keystrokes on and
 * discard only the mouse bytes.
 */

/** What happened, decoded from the button bitfield and the report's final byte. */
export type MouseEventType = 'press' | 'release' | 'drag' | 'wheel';

/** Which button, for press/release/drag. Wheel events report `none`. */
export type MouseButton = 'left' | 'middle' | 'right' | 'none';

/** Wheel direction; only set on `wheel` events. */
export type WheelDirection = 'up' | 'down';

/** One decoded mouse report, in 0-based terminal cell coordinates. */
export interface MouseEvent {
  type: MouseEventType;
  button: MouseButton;
  /** 0-based column (the wire format is 1-based; converted here, once). */
  column: number;
  /** 0-based row (the wire format is 1-based; converted here, once). */
  row: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  /** Present only on `wheel` events. */
  wheel?: WheelDirection;
}

/**
 * An SGR mouse report. Deliberately anchored with `\x1b\[<` and a `[Mm]` terminator, and the numeric
 * groups are bounded so a long digit run cannot make this scan pathologically.
 */
const SGR_REPORT = /\x1b\[<(\d{1,5});(\d{1,5});(\d{1,5})([Mm])/;

/** Bit 5 — movement with a button held. */
const MOTION_BIT = 32;
/** Bit 6 — the wheel flag; with it set the low bits select the direction, not a button. */
const WHEEL_BIT = 64;

const BUTTONS: MouseButton[] = ['left', 'middle', 'right', 'none'];

/** Decode one already-matched report into a {@link MouseEvent}. */
function decode(b: number, x: number, y: number, final: string): MouseEvent {
  const wheel = (b & WHEEL_BIT) !== 0;
  const motion = (b & MOTION_BIT) !== 0;
  // Release is signalled by the final byte `m`. A wheel report always arrives as `M` and has no
  // release, so it is classified before the release test.
  const type: MouseEventType = wheel
    ? 'wheel'
    : final === 'm'
      ? 'release'
      : motion
        ? 'drag'
        : 'press';
  return {
    type,
    button: wheel ? 'none' : BUTTONS[b & 0b11],
    // 1-based on the wire → 0-based here. Clamped at 0 because a terminal that reports a 0
    // coordinate (some do, out of spec) must not produce a negative cell.
    column: Math.max(0, x - 1),
    row: Math.max(0, y - 1),
    shift: (b & 4) !== 0,
    meta: (b & 8) !== 0,
    ctrl: (b & 16) !== 0,
    ...(wheel ? { wheel: (b & 0b11) === 1 ? ('down' as const) : ('up' as const) } : {}),
  };
}

/** What {@link parseMouseReports} extracted from one chunk of stdin. */
export interface ParsedMouseInput {
  /** Every decoded report, in the order it appeared. */
  events: MouseEvent[];
  /**
   * The input with all mouse reports removed — the bytes that are genuinely keyboard input and
   * must still reach Ink. Empty when the chunk was nothing but mouse traffic.
   */
  rest: string;
}

/**
 * Extract every SGR mouse report from a chunk of terminal input.
 *
 * Returns the decoded events plus the non-mouse remainder. A chunk with no reports comes back as
 * `{ events: [], rest: input }` — unchanged, so wiring this in front of the keyboard path costs
 * ordinary typing nothing.
 *
 * Malformed sequences are left in `rest` rather than guessed at: a truncated report is far more
 * likely to be a chunk boundary than a corrupt terminal, and inventing an event at a made-up
 * coordinate would fire a click somewhere the user never clicked.
 */
export function parseMouseReports(input: string): ParsedMouseInput {
  // Fast path: the overwhelmingly common case is a chunk with no mouse bytes in it at all.
  if (!input.includes('\x1b[<')) return { events: [], rest: input };

  const events: MouseEvent[] = [];
  let rest = '';
  let remaining = input;

  for (;;) {
    const match = SGR_REPORT.exec(remaining);
    if (!match) {
      rest += remaining;
      break;
    }
    const [whole, b, x, y, final] = match;
    rest += remaining.slice(0, match.index);
    // Guard the numeric conversion: the pattern bounds the digit count, so these always parse, but
    // a nonsensically large coordinate is dropped rather than turned into an absurd cell.
    const button = Number(b);
    const column = Number(x);
    const row = Number(y);
    if (Number.isFinite(button) && Number.isFinite(column) && Number.isFinite(row)) {
      events.push(decode(button, column, row, final));
    }
    remaining = remaining.slice(match.index + whole.length);
  }

  return { events, rest };
}
