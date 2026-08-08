import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FRAME_MAX_LINES,
  findUnresolvableSites,
  frameUntrustedCommand,
  frameUntrustedText,
  neutralizeToOneLine,
  neutralizeUntrustedText,
} from '#src/core/shell/framing.js';

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
    const framed = frameUntrustedCommand(
      Array.from({ length: 60 }, (_, i) => `step ${i + 1} ; next`).join(LF),
      { width: 100, maxLines: 20 }
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
