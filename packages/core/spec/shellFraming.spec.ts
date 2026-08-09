import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FRAME_MAX_LINES,
  findUnresolvableSites,
  frameUntrustedCommand,
  frameUntrustedText,
  frameWidthFor,
  MIN_CONTENT_WIDTH,
  MIN_FRAME_WIDTH,
  narrowTerminalNotice,
  neutralizeToOneLine,
  neutralizeUntrustedText,
  wrapToWidth,
} from '#src/core/shell/framing.js';
import { displayWidth, maxDisplayWidth } from '#src/utils/displayWidth.js';

/**
 * [[TUI-C26]] task 1 — the framed render of untrusted text.
 *
 * **Every adversarial input here is built from explicit code points, never typed.** A rule about
 * invisible characters must not depend on one surviving an editor, a diff, a copy-paste or a
 * reviewer's terminal; `cp(0x1b)` says exactly what is being fed in and cannot be silently lost.
 */
const cp = (codePoint: number): string => String.fromCodePoint(codePoint);

const NUL = cp(0x00);
const BEL = cp(0x07);
const TAB = cp(0x09);
const LF = cp(0x0a);
const CR = cp(0x0d);
const ESC = cp(0x1b);
const DEL = cp(0x7f);
/** The one-byte C1 CSI — an escape introducer that carries no `ESC` byte to match on. */
const CSI = cp(0x9b);
/** Right-to-left override: reorders what a reader sees without hiding anything from a parser. */
const RLO = cp(0x202e);
const ZERO_WIDTH_SPACE = cp(0x200b);

/** The gutter every body row must carry: indent, line number, separator, then the untrusted text. */
const GUTTER = /^ {2} *\d+ │ /u;
/** The gutter a wrapped continuation row carries — no number, because it is not a new line. */
const CONTINUATION = /^ {2} +┊ /u;
/** The renderer's own elision row. */
const ELISION = /^ {2} +⋯ \d+ lines? hidden$/u;

describe('shell/framing — rule 1: control characters and ANSI are neutralised unconditionally', () => {
  it.each([
    ['NUL', NUL, '\\x00'],
    ['BEL', BEL, '\\x07'],
    ['TAB', TAB, '\\x09'],
    ['CR', CR, '\\x0d'],
    ['ESC', ESC, '\\x1b'],
    ['DEL', DEL, '\\x7f'],
    ['C1 CSI', CSI, '\\x9b'],
    ['right-to-left override', RLO, '\\u202e'],
    ['zero-width space', ZERO_WIDTH_SPACE, '\\u200b'],
  ])('replaces %s with a visible, printable escape', (_name, character, escaped) => {
    const out = neutralizeUntrustedText(`a${character}b`);
    expect(out).toBe(`a${escaped}b`);
    // The raw code point is GONE, not merely accompanied by its escape.
    expect(out.includes(character)).toBe(false);
  });

  it('kills an ANSI sequence by its introducer, without parsing the sequence', () => {
    // Cursor-up, screen-clear and a colour run: each is inert the moment its ESC is escaped, and
    // what is left on screen is a faithful statement of what the string contained.
    expect(neutralizeUntrustedText(`${ESC}[A`)).toBe('\\x1b[A');
    expect(neutralizeUntrustedText(`${ESC}[2J`)).toBe('\\x1b[2J');
    expect(neutralizeUntrustedText(`${CSI}31mred`)).toBe('\\x9b31mred');
  });

  it('CONTROL: leaves ordinary printable text exactly as written', () => {
    const command = 'git commit --amend -F ./msg.txt && npm test -- --run "a b"';
    expect(neutralizeUntrustedText(command)).toBe(command);
  });

  it('neutralises before collapsing whitespace, which is what `\\s` alone misses', () => {
    // JavaScript's `\s` covers LF and CR and covers neither ESC nor the C1 range, so a collapse
    // without neutralisation leaves a screen-clear intact on a line that merely looks tidy.
    //
    // Neutralising FIRST also means a line break survives as a visible `\x0a` rather than being
    // folded into a space: the result is still one line, and it additionally tells the reader that
    // the value they are looking at was multi-line to begin with.
    expect(neutralizeToOneLine(`clean${LF}up${ESC}[2J`)).toBe('clean\\x0aup\\x1b[2J');
    expect(neutralizeToOneLine(`  padded  ${CR}  `)).toBe('padded \\x0d');
  });

  it('applies to the rater reason, not only to the command', () => {
    const framed = frameUntrustedText(`Looks routine.${ESC}[2J${CR}`, { width: 80 });
    expect(framed.lines.join('\n')).toContain('\\x1b[2J');
    expect(framed.lines.join('\n')).toContain('\\x0d');
    expect(framed.lines.join('\n')).not.toContain(ESC);
    expect(framed.lines.join('\n')).not.toContain(CR);
  });
});

describe('shell/framing — rule 2: a renderer-owned gutter, and no line discarded', () => {
  it('renders every line in the gutter and none of it at column 0', () => {
    const command = ['echo one', 'echo two', 'echo three'].join(LF);
    const framed = frameUntrustedCommand(command, { width: 80 });
    expect(framed.lines).toHaveLength(3);
    for (const line of framed.lines) expect(line).toMatch(GUTTER);
    expect(framed.lines[0]).toBe('  1 │ echo one');
    expect(framed.lines[2]).toBe('  3 │ echo three');
  });

  it('a line that reads like this dialog’s own chrome is numbered, not flush-left', () => {
    // The two forgeries that need no escape sequence at all: a verdict line and a key menu.
    const command = [
      'echo start',
      '⚠ Auto-rater (safe): approved by rater',
      'Approve?  [o]nce   [s]ession   [a]lways   [N]o',
    ].join(LF);
    const framed = frameUntrustedCommand(command, { width: 100 });
    expect(framed.lines[1]).toBe('  2 │ ⚠ Auto-rater (safe): approved by rater');
    expect(framed.lines[2]).toBe('  3 │ Approve?  [o]nce   [s]ession   [a]lways   [N]o');
    for (const line of framed.lines)
      expect(line.startsWith('⚠') || line.startsWith('A')).toBe(false);
  });

  it('a bare CR is made visible rather than being read as a line break', () => {
    // Treating it as a break would hide that a cursor-to-column-0 overwrite was ever attempted.
    const framed = frameUntrustedCommand(`echo hi${CR}Approve? [o]nce`, { width: 80 });
    expect(framed.lines).toEqual(['  1 │ echo hi\\x0dApprove? [o]nce']);
  });

  it('CRLF is one line break, and a single trailing break is not a numbered empty line', () => {
    const framed = frameUntrustedCommand(`echo one${CR}${LF}echo two${LF}`, { width: 80 });
    expect(framed.lines).toEqual(['  1 │ echo one', '  2 │ echo two']);
  });

  it('wraps a long line itself, gutter on every row, so the terminal never wraps it to column 0', () => {
    const framed = frameUntrustedText('x'.repeat(60), { width: 30 });
    expect(framed.lines.length).toBeGreaterThan(1);
    expect(framed.lines[0]).toMatch(GUTTER);
    for (const line of framed.lines.slice(1)) expect(line).toMatch(CONTINUATION);
    for (const line of framed.lines) expect(line.length).toBeLessThanOrEqual(30);
    // Nothing is lost to the wrap — the row contents reassemble the input.
    expect(framed.lines.map((line) => line.slice(6)).join('')).toBe('x'.repeat(60));
  });

  it('measures wide glyphs by display width, so a CJK line still fits its budget', () => {
    // Two columns per ideograph: counted by `.length` this row would measure as fitting and then
    // wrap back to column 0 on the terminal, which is the failure the gutter exists to prevent.
    const framed = frameUntrustedText('。'.repeat(20), { width: 24 });
    for (const line of framed.lines) {
      expect(line.replace(/[。]/gu, '..').length).toBeLessThanOrEqual(24);
    }
    expect(framed.lines.length).toBeGreaterThan(1);
  });

  it('keeps every line of a long command when it fits the budget — nothing is clamped away', () => {
    const command = Array.from({ length: DEFAULT_FRAME_MAX_LINES }, (_, i) => `echo ${i + 1}`).join(
      LF
    );
    const framed = frameUntrustedCommand(command, { width: 80 });
    expect(framed.lines).toHaveLength(DEFAULT_FRAME_MAX_LINES);
    expect(framed.lines.some((line) => ELISION.test(line))).toBe(false);
  });
});

describe('shell/framing — rule 3: the decision-relevant sites are extracted, with line numbers', () => {
  it('finds command substitutions and composition boundaries, and says where', () => {
    const sites = findUnresolvableSites(
      ['a $(b) c', 'd && e', 'f || g', 'h ; i', 'j | k'].join(LF)
    );
    expect(sites.map((site) => [site.line, site.kind, site.token])).toEqual([
      [1, 'command substitution', '$('],
      [2, 'composition', '&&'],
      [3, 'composition', '||'],
      [4, 'composition', ';'],
      [5, 'composition', '|'],
    ]);
  });

  it('reads `||` as ONE boundary rather than two pipes', () => {
    expect(findUnresolvableSites('a || b').map((site) => site.token)).toEqual(['||']);
  });

  it('is deliberately NOT quote-aware — the incident hid its payload inside double quotes', () => {
    // A shell-accurate scanner would skip a substitution inside single quotes and would have to be
    // right about every quoting rule to stay safe. Over-reporting costs a notice line.
    const sites = findUnresolvableSites(`git commit -m "note \`echo payload\` end"`);
    expect(sites.filter((site) => site.kind === 'command substitution').length).toBeGreaterThan(0);
    expect(findUnresolvableSites(`echo 'a $(b)'`).map((site) => site.token)).toContain('$(');
  });

  it('CONTROL: a command with neither reports nothing, and renders no notices', () => {
    expect(findUnresolvableSites('npm test -- --run')).toEqual([]);
    expect(frameUntrustedCommand('npm test -- --run', { width: 80 }).notices).toEqual([]);
  });

  it('lists each site ABOVE the body, naming the line the reader can count to', () => {
    // The shape that matters: an ordinary-looking commit whose substitution sits fifteen lines in.
    const lines = Array.from({ length: 18 }, (_, i) => `prose line ${i + 1} of the message`);
    lines[0] = 'git add -A && git commit -m "a note';
    lines[14] = 'so `echo deep-payload` then runs unrated,';
    const framed = frameUntrustedCommand(lines.join(LF), { width: 100 });

    expect(framed.notices[0]).toContain('the gate could not statically resolve');
    expect(framed.notices.join('\n')).toContain('line 15 · command substitution `');
    expect(framed.notices.join('\n')).toContain('line 1 · composition &&');
    // ...and line 15 is on the screen, in the gutter, not truncated away.
    expect(framed.lines).toContain('  15 │ so `echo deep-payload` then runs unrated,');
  });

  it('bounds the excerpt-bearing notice rows by the terminal, even on a narrow one', () => {
    // The one row here that carries untrusted text OUTSIDE the gutter. Its excerpt budget has a
    // floor, so without a second clip the floor wins on a narrow terminal, the row overruns, and
    // the surface wraps it — putting excerpt bytes at column 0.
    //
    // The `$(` label is the long one (39 columns), so it is what actually drives the budget below
    // its floor; a `&&`-only command at these widths never reaches the floor and would pass with
    // the second clip removed.
    const command = `echo $(id) && echo ${'a'.repeat(200)}`;
    for (const width of [40, 30, 24]) {
      const framed = frameUntrustedCommand(command, { width });
      const siteRows = framed.notices.filter((line) => line.trimStart().startsWith('line '));
      expect(siteRows.length).toBeGreaterThan(0);
      for (const row of siteRows) expect(row.length).toBeLessThanOrEqual(width);
    }
  });

  it('caps the listed sites and says how many more there are', () => {
    const framed = frameUntrustedCommand(
      Array.from({ length: 12 }, (_, i) => `step ${i + 1} ; next`).join(LF),
      { width: 100 }
    );
    expect(framed.sites).toHaveLength(12);
    expect(framed.notices.join('\n')).toContain('and 4 further flagged sites');
  });
});

describe('shell/framing — rule 4: elide AROUND the flagged sites, and say how much', () => {
  const longCommand = (siteLine: number, total: number): string =>
    Array.from({ length: total }, (_, i) =>
      i + 1 === siteLine ? 'so `echo deep-payload` runs' : `ordinary prose line ${i + 1}`
    ).join(LF);

  it('keeps the flagged line and elides the run before it — never a head clamp', () => {
    const framed = frameUntrustedCommand(longCommand(45, 60), { width: 100, maxLines: 20 });
    expect(framed.lines).toContain('  45 │ so `echo deep-payload` runs');
    // The START is what went, which is the precise inverse of the superseded single-line clamp.
    expect(framed.lines.some((line) => line.includes('│ ordinary prose line 1 '))).toBe(false);
    expect(framed.lines[0]).toMatch(ELISION);
    expect(framed.lines[0]).toContain('42 lines hidden');
  });

  it('states the elision on BOTH sides, with real counts', () => {
    const framed = frameUntrustedCommand(longCommand(45, 60), { width: 100, maxLines: 20 });
    const elisions = framed.lines.filter((line) => ELISION.test(line));
    expect(elisions).toHaveLength(2);
    expect(elisions[1]).toContain('13 lines hidden');
  });

  it('says when the elision itself hid a flagged site', () => {
    // Wide enough for the whole sentence: every row is now bounded by the width it was given, so a
    // width that cannot hold this sentence would clip it and the assertion below would be about
    // where the clip landed rather than about what the renderer says.
    const framed = frameUntrustedCommand(
      Array.from({ length: 60 }, (_, i) => `step ${i + 1} ; next`).join(LF),
      { width: 120, maxLines: 20 }
    );
    expect(framed.notices.join('\n')).toContain('40 flagged sites sit on');
    expect(framed.notices.join('\n')).toContain('too long to show in full');
  });

  it('text with no flagged site keeps its head and states what it dropped', () => {
    const framed = frameUntrustedText(
      Array.from({ length: 30 }, (_, i) => `reason line ${i + 1}`).join(LF),
      { width: 80, maxLines: 20 }
    );
    // The number column is as wide as the largest line number, so a 30-line block right-aligns to 2.
    expect(framed.lines[0]).toBe('   1 │ reason line 1');
    expect(framed.lines[framed.lines.length - 1]).toContain('10 lines hidden');
  });
});

/**
 * The column-0 guarantee rests on every emitted row fitting the width it was given — and "fitting"
 * is not one number. An East-Asian **Ambiguous** character is one cell on most terminals and two on
 * a terminal configured for a CJK locale, and that is a setting this process cannot read. The
 * gutter separators are Ambiguous, and so is a great deal of what untrusted text can be built from.
 *
 * So each row is measured with BOTH rulers here. A suite that measured only the repo's default
 * narrow policy would be green on a renderer that overruns every row by one column on the other
 * kind of terminal — which is a wrapped row, and a wrapped row is attacker-chosen bytes at column 0.
 */
describe('shell/framing — every row fits under EITHER ambiguous-width policy', () => {
  /** A hostile command built from `filler`: flagged sites, lines long enough to wrap, and elision. */
  const hostile = (filler: string): string =>
    Array.from({ length: 60 }, (_, index) =>
      index === 44
        ? `so \`echo ${filler.repeat(20)}\` runs`
        : `${filler.repeat(30)} ; line ${index + 1}`
    ).join(LF);

  const rowsOf = (filler: string, width: number): string[] => {
    const framed = frameUntrustedCommand(hostile(filler), { width });
    // The notices are rows on the same screen as the body and are asserted with it: they carry the
    // untrusted excerpts, which is the one place untrusted text is rendered outside the gutter.
    return [...framed.notices, ...framed.lines];
  };

  it.each([
    ['plain ASCII', 'x', false],
    ['East-Asian AMBIGUOUS characters, which a CJK-configured terminal draws WIDE', 'α', true],
    ['Cyrillic, also Ambiguous', 'я', true],
    ['box-drawing, the class the gutter itself is made of', '■', true],
    ['genuinely WIDE CJK, which both policies already measure at two columns', '漢', false],
    ['an emoji cluster, the widest thing a single grapheme can be', '👍🏽', false],
  ])('holds for content made of %s', (_name, filler, isAmbiguous) => {
    for (const width of [79, 40, MIN_FRAME_WIDTH]) {
      const rows = rowsOf(filler, width);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // The repo's own policy...
        expect(displayWidth(row)).toBeLessThanOrEqual(width);
        // ...and the terminal that disagrees with it. This is the assertion the finding lives in.
        expect(maxDisplayWidth(row)).toBeLessThanOrEqual(width);
      }
      // CONTROL: each fixture is the width class its name claims. The Ambiguous ones are the cases
      // the finding lives in — content whose own column count changes with the terminal's setting —
      // and without this pin a fixture could quietly stop being Ambiguous and leave the block green
      // while testing nothing but ASCII. Measured on the CONTENT, not on a row: every row carries
      // the Ambiguous gutter separator, so a row-level comparison is true whatever the content is.
      expect(maxDisplayWidth(filler) > displayWidth(filler)).toBe(isAmbiguous);
    }
  });

  /**
   * The gutter's own separator is Ambiguous, so a body row's prefix is five columns on one terminal
   * and six on another. Budgeting it as a constant is what made every row overrun by one; this pins
   * that the budget is taken from the widest reading of the prefix rather than from its narrowest.
   */
  it('budgets the gutter at its WIDEST reading, so an all-ASCII row is short rather than over', () => {
    const [row] = frameUntrustedCommand('x'.repeat(400), { width: 40 }).lines;
    expect(row).toMatch(GUTTER);
    expect(maxDisplayWidth(row)).toBeLessThanOrEqual(40);
    // Under-fill is the price and it is bounded: exactly the one column the Ambiguous separator
    // might take. Anything more would mean the budget had drifted away from the real prefix.
    expect(displayWidth(row)).toBeGreaterThanOrEqual(39);
  });
});

/**
 * A grapheme cluster is not bounded to two columns. Display width sums **additively** across a run
 * of Hangul leading jamo, and across the trailing spacing marks of an Indic or halfwidth-kana
 * cluster, so a single cluster can measure arbitrarily many columns — and none of those code points
 * is a control or format character, so the neutraliser leaves them exactly as written.
 *
 * A cluster wider than the entire content budget cannot be cut to fit, so the wrap either escapes it
 * or emits it raw on one unbounded row that the terminal wraps back to column 0. This is not a
 * contrived width: forty leading jamo are one eighty-column cluster, and an ordinary eighty-column
 * terminal leaves a budget of seventy-two.
 */
describe('shell/framing — a grapheme cluster wider than the whole content budget', () => {
  /** Forty U+1100 HANGUL CHOSEONG KIYEOK — ONE cluster, eighty columns. */
  const OVER_WIDE_CLUSTER = cp(0x1100).repeat(40);
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

  it('escapes it, rather than emitting a row the terminal would wrap to column 0', () => {
    const width = frameWidthFor(80);
    const framed = frameUntrustedCommand(`echo ${OVER_WIDE_CLUSTER} ; rm -rf /`, { width });
    const rows = [...framed.notices, ...framed.lines];

    // CONTROLS, and the reason this case reaches the branch at all. Both are properties of
    // `Intl.Segmenter` and `string-width` rather than of this module, so a dependency bump could
    // quietly stop the payload being over-wide and leave every assertion below green while testing
    // nothing. Pinned here so that goes red instead of silent.
    expect([...segmenter.segment(OVER_WIDE_CLUSTER)]).toHaveLength(1);
    expect(maxDisplayWidth(OVER_WIDE_CLUSTER)).toBeGreaterThan(width);
    // And it is not the neutraliser that makes this safe: the payload reaches the wrap untouched.
    expect(neutralizeUntrustedText(OVER_WIDE_CLUSTER)).toBe(OVER_WIDE_CLUSTER);

    // The property the branch exists for. Emitted raw, this input renders a ninety-seven-column
    // row into a seventy-nine-column frame — which the terminal wraps, putting attacker-chosen
    // bytes flush left. Asserted under both policies, like every other row this module returns.
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(width);
      expect(maxDisplayWidth(row)).toBeLessThanOrEqual(width);
    }
    // Every body row still carries a renderer-owned prefix: the escapes are shown INSIDE the
    // gutter, which is the whole point of escaping them rather than letting the row run long.
    const prefixed = new RegExp(`${GUTTER.source}|${CONTINUATION.source}|${ELISION.source}`, 'u');
    for (const line of framed.lines) expect(line).toMatch(prefixed);

    // Shown, not discarded: the cluster comes back as the printable escapes of its code points, and
    // the rest of the command is still on screen for the human to rule on.
    expect(framed.lines.some((line) => line.includes('\\u1100'))).toBe(true);
    expect(framed.lines.some((line) => line.includes(cp(0x1100)))).toBe(false);
    expect(framed.lines.some((line) => line.includes('; rm -rf /'))).toBe(true);
  });

  /**
   * The escape branch advances only while the budget can hold at least one escape character. At a
   * budget of zero it re-escapes the backslashes it just wrote and the row grows without bound, so
   * the wrap floors its own budget instead of trusting the caller for it. `frame` floors the
   * content width too, which is exactly why this width is unreachable through the public entry
   * points — and why the guarantee has to be pinned on the function that states it.
   */
  it('floors its own budget, so a degenerate width terminates instead of escaping forever', () => {
    // FIRST, and deliberately so. A budget of one still terminates unclamped, so this assertion
    // catches a removed floor in milliseconds and names it — the rows come back at the content
    // floor's width rather than at the one column that was asked for. It has to run before the
    // width-zero call below, because a termination property cannot be pinned without calling the
    // function, an unclamped call at width zero never returns, and a synchronous loop is the one
    // failure a test timeout cannot interrupt: it would hang the suite instead of failing it.
    const narrow = wrapToWidth(OVER_WIDE_CLUSTER, 1);
    expect(Math.max(...narrow.map(maxDisplayWidth))).toBe(MIN_CONTENT_WIDTH);

    // The degenerate widths themselves. Unclamped, `sliceToMaxWidth` can return nothing at all, so
    // the escape branch re-escapes the backslashes it has just written and `rest` grows without
    // bound.
    const rows = wrapToWidth(OVER_WIDE_CLUSTER, 0);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(1000);
    for (const row of rows) {
      expect(row.length).toBeGreaterThan(0);
      expect(maxDisplayWidth(row)).toBeLessThanOrEqual(MIN_CONTENT_WIDTH);
    }
    // A floor, not a special case for zero.
    expect(wrapToWidth(OVER_WIDE_CLUSTER, -10)).toEqual(rows);
    // CONTROL: the floor does not reach up and change a budget the caller legitimately asked for,
    // so this pins the clamp rather than merely pinning that some width was used.
    expect(wrapToWidth('x'.repeat(20), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10)]);
  });
});

/**
 * Below {@link MIN_FRAME_WIDTH} the frame is deliberately wider than the terminal — the gutter would
 * otherwise eat the row and hide the payload — so the terminal wraps it and untrusted text reaches
 * column 0. The trade is defensible; taking it silently is not, because a dialog that has stopped
 * guaranteeing anything still looks exactly like one that has not.
 */
describe('shell/framing — a terminal too narrow to frame says so', () => {
  it('resolves the same width for both surfaces, holding one column back', () => {
    expect(frameWidthFor(80)).toBe(79);
    expect(frameWidthFor(120)).toBe(119);
    // Unknown columns (a pipe, a test, no TTY) is the documented default, not a narrow terminal.
    expect(frameWidthFor(undefined)).toBe(79);
  });

  it('floors the width, so the frame stays readable on a terminal that cannot hold it', () => {
    expect(frameWidthFor(15)).toBe(MIN_FRAME_WIDTH);
    expect(frameWidthFor(1)).toBe(MIN_FRAME_WIDTH);
  });

  it('says so on screen exactly when the frame no longer fits the terminal', () => {
    const notice = narrowTerminalNotice(15);
    expect(notice).toBeDefined();
    // It names the CONSEQUENCE — that text below can reach the left edge — rather than the number,
    // because the number is not what the reader has to decide about.
    expect(notice).toContain('left edge');
    // It carries no line break of its own: the surfaces paint it as one row and let the terminal
    // wrap it. On a terminal this narrow it costs a few rows however it is worded, which is why
    // every word it does not need is another row of chrome between the reader and the command.
    expect(notice).not.toContain('\n');
  });

  it('stays silent on a terminal that fits, and on one that never reported a width', () => {
    expect(narrowTerminalNotice(80)).toBeUndefined();
    expect(narrowTerminalNotice(21)).toBeUndefined();
    // The unknown-columns path frames at the default and must not cry narrow: every non-TTY caller
    // would otherwise carry a warning about a terminal that does not exist.
    expect(narrowTerminalNotice(undefined)).toBeUndefined();
    // CONTROL: the boundary really is where it is claimed to be, so the assertions above are about
    // the threshold and not about the notice being unreachable.
    expect(narrowTerminalNotice(20)).toBeDefined();
  });
});

/**
 * The renderer's own rows carry no untrusted text, so their overrun wraps into an untidy screen
 * rather than a forgeable one. They are bounded anyway: a block that bounds the attacker's rows and
 * not its own is bounded by coincidence, and the next row written here inherits the coincidence.
 */
describe("shell/framing — the renderer's OWN rows are bounded too", () => {
  /** The header rows of a framed command: everything above the per-site list. */
  const headerRows = (notices: readonly string[]): string[] => {
    const first = notices.findIndex((row) => row.trimStart().startsWith('line '));
    return notices.slice(0, first === -1 ? notices.length : first);
  };

  /**
   * [[TUI-C26]] task 2 §4 — **the renderer's own prose WRAPS; it does not clip.**
   *
   * The header is ninety columns long and a standard terminal is eighty, so clipping truncated it
   * to `…numbered in the c…` — the sentence that explains what the numbers below mean, cut off
   * exactly where it explains itself, at the commonest width there is. Nothing untrusted is on
   * these rows, so a continuation of one cannot be forged and wrapping costs nothing.
   */
  it('wraps its notice header instead of truncating the sentence that explains the numbers', () => {
    const framed = frameUntrustedCommand('echo a && echo b ; echo c', { width: 30 });
    const header = headerRows(framed.notices);
    // More than one row: the sentence did not fit, and it was not thrown away to make it fit.
    expect(header.length).toBeGreaterThan(1);
    for (const row of header) {
      expect(maxDisplayWidth(row)).toBeLessThanOrEqual(30);
      expect(displayWidth(row)).toBeLessThanOrEqual(30);
      // Nothing was dropped, so no row carries the clip marker.
      expect(row.endsWith('…')).toBe(false);
    }
    // **The whole sentence survives, word for word.** Asserted against the unbounded rendering
    // rather than against a copy of the sentence here, so this cannot pass by agreeing with a
    // paraphrase of itself, and a future rewording does not need editing in two places.
    const whole = frameUntrustedCommand('echo a && echo b ; echo c', { width: 400 }).notices[0];
    expect(header.map((row) => row.trim()).join(' ')).toBe(whole);
    // CONTROL: that sentence really is wider than this terminal, so the wrap is the thing under
    // test rather than a no-op the renderer would have satisfied anyway.
    expect(maxDisplayWidth(whole)).toBeGreaterThan(30);
    // ...and it is the header, not some other row.
    expect(header[0].startsWith('⚠ 2 sites the gate')).toBe(true);
  });

  /**
   * The trap the reviewer named, asserted rather than trusted: `notices[]` holds the renderer's own
   * prose **and** the site rows carrying the untrusted excerpt — the one place untrusted text is
   * rendered outside the gutter. A wrap applied to the array as a whole would hand the excerpt a
   * continuation row, putting attacker-chosen bytes at a column the reader reads as the gate's.
   *
   * So at a width where BOTH would overflow, the prose wraps and the excerpt clips.
   */
  it('clips the untrusted excerpt row while wrapping the prose around it', () => {
    const marker = 'PAYLOAD-'.repeat(12);
    const framed = frameUntrustedCommand(`echo one && echo ${marker}`, { width: 60 });
    const siteRows = framed.notices.filter((row) => row.trimStart().startsWith('line '));
    expect(siteRows.length).toBeGreaterThan(0);
    for (const row of siteRows) {
      expect(maxDisplayWidth(row)).toBeLessThanOrEqual(60);
      // Every site row still begins with its own label — none of them is a continuation of the one
      // above, which is what a wrap over the array would have produced.
      expect(/^ {4}line \d+ · /u.test(row)).toBe(true);
    }
    // The excerpt was cut, not carried onto another row: the marker appears once, truncated.
    const excerptRow = siteRows.find((row) => row.includes('PAYLOAD-'));
    expect(excerptRow).toBeDefined();
    expect(excerptRow!.endsWith('…')).toBe(true);
    expect(framed.notices.filter((row) => row.includes('PAYLOAD-')).length).toBe(1);
    // CONTROL: the prose on the same screen DID wrap, so this test is about the difference between
    // the two kinds of row rather than about a renderer that wraps nothing.
    expect(headerRows(framed.notices).length).toBeGreaterThan(1);
  });

  /**
   * The other two renderer-owned prose rows, which live in the same array and take the same rule.
   * Ten sites over the listing cap, and an elision that hides some of them, is what produces both
   * at once.
   */
  /**
   * [[TUI-C26]] task 2 — `maxRows` bounds what a screen actually has, which `maxLines` cannot.
   *
   * Measured on the PTY: the escalation menu's sticky blocks carry the command as typed, so an
   * eighteen-line command printed itself in its own frame, again under the sticky label, and a
   * third time inside the JSON entry — and the menu ended up below the bottom of a fifty-row
   * terminal. `maxLines` did not help, because the JSON entry is ONE logical line however many rows
   * it wraps to.
   */
  it('bounds a block by ROWS when asked, and says how many it dropped', () => {
    const command = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join(LF);
    const framed = frameUntrustedText(command, { width: 80, maxRows: 4 });
    expect(framed.lines).toHaveLength(4);
    expect(framed.lines.slice(0, 3)).toEqual(['   1 │ line 1', '   2 │ line 2', '   3 │ line 3']);
    expect(framed.lines[3]).toContain('15 more rows hidden');

    // The case `maxLines` cannot reach: ONE logical line, wrapped over many rows.
    const single = frameUntrustedText('x'.repeat(2000), { width: 40, maxRows: 3 });
    expect(single.lines).toHaveLength(3);
    expect(single.lines[2]).toMatch(/\d+ more rows hidden$/u);
    // CONTROL: unbounded, the same input is far taller — so the bound is what shortened it.
    expect(frameUntrustedText('x'.repeat(2000), { width: 40 }).lines.length).toBeGreaterThan(3);
    // ...and the same input under a LINE budget is not shortened at all, which is the distinction.
    expect(frameUntrustedText('x'.repeat(2000), { width: 40, maxLines: 3 }).lines.length).toBe(
      frameUntrustedText('x'.repeat(2000), { width: 40 }).lines.length
    );
  });

  it('leaves a block that already fits its row budget untouched', () => {
    const framed = frameUntrustedText('npm test', { width: 80, maxRows: 4 });
    expect(framed.lines).toEqual(['  1 │ npm test']);
  });

  it('wraps the further-sites and hidden-sites rows too', () => {
    const command = Array.from({ length: 40 }, (_, index) => `echo ${index} ; echo tail`).join(LF);
    const framed = frameUntrustedCommand(command, { width: 34, maxLines: 6 });
    const further = framed.notices.filter((row) => row.includes('further flagged'));
    const hidden = framed.notices.filter((row) => row.includes('the elision below hid'));
    expect(further.length).toBeGreaterThan(0);
    expect(hidden.length).toBeGreaterThan(0);
    for (const row of framed.notices) {
      expect(maxDisplayWidth(row)).toBeLessThanOrEqual(34);
      expect(displayWidth(row)).toBeLessThanOrEqual(34);
    }
    // Both sentences are complete: each wrapped across rows rather than losing its tail.
    const joined = framed.notices.map((row) => row.trim()).join(' ');
    expect(joined).toContain('further flagged sites, up to line 40.');
    expect(joined).toContain('this command is too long to show in full.');
  });

  it('clips its elision row to the terminal', () => {
    const framed = frameUntrustedText(
      Array.from({ length: 1200 }, (_, index) => `reason line ${index + 1}`).join(LF),
      { width: MIN_FRAME_WIDTH, maxLines: 5 }
    );
    const elisions = framed.lines.filter((line) => line.includes('hidden') || line.includes('⋯'));
    expect(elisions.length).toBeGreaterThan(0);
    for (const row of elisions) expect(maxDisplayWidth(row)).toBeLessThanOrEqual(MIN_FRAME_WIDTH);
  });
});
