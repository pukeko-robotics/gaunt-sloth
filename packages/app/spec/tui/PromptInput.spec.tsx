import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import { PromptInput } from '#src/tui/components/PromptInput.js';
import { SlashCommandMenu } from '#src/tui/components/SlashCommandMenu.js';
import {
  createCommandRegistry,
  type SlashCommand,
} from '@gaunt-sloth/agent/modules/slashCommands.js';

/**
 * Every key below is the RAW BYTE SEQUENCE a terminal sends, decoded by Ink's own parser on the way
 * in — never a hand-built key object. A synthesised `{meta: true, input: 'b'}` proves the handler
 * reacts to a decoding that no terminal has to produce; these prove the whole path, and they are
 * the same bytes on every platform of the unit matrix.
 */
const DOWN = '\x1b[B'; // Down arrow CSI sequence
const UP = '\x1b[A'; // Up arrow CSI sequence
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const ENTER = '\r';
const TAB = '\t';
const ESC = '\x1b';
const BACKSPACE = '\x7f';
/** Readline's own word motion — and what Terminal.app and Ghostty send for Option+←/→. */
const META_B = '\x1bb';
const META_F = '\x1bf';
/** The xterm/Konsole spelling of Ctrl+←/→ (CSI 1 ; 5 D|C — modifier 5 is Ctrl). */
const CTRL_LEFT = '\x1b[1;5D';
const CTRL_RIGHT = '\x1b[1;5C';
/** Konsole's spelling of Alt+←/→ (modifier 3 is Alt/Meta) — a third distinct encoding. */
const META_LEFT = '\x1b[1;3D';
const META_RIGHT = '\x1b[1;3C';
const CTRL_A = '\x01';
const CTRL_E = '\x05';
const HOME = '\x1b[H';
const END = '\x1b[F';
/** <App>'s transcript-scroll keys — the prompt must leave these alone. */
const CTRL_HOME = '\x1b[1;5H';
const CTRL_END = '\x1b[1;5F';
// Bracketed-paste markers (TUI-C24): the terminal wraps pasted content between these.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const paste = (body: string): string => PASTE_START + body + PASTE_END;

const tick = () => new Promise((r) => setTimeout(r, 20));

/** The `  > ` the first row of the buffer is drawn after; continuation rows use `  … `. */
const PROMPT = '  > ';
/** Reverse video on — how the prompt draws its caret (Ink moves no hardware cursor). */
const INVERSE_ON = '\x1b[7m';

/**
 * Paint the frames in colour for the duration of a describe.
 *
 * The caret is an ANSI attribute, so it only exists in the frame while colour is on: at level 0
 * `chalk.inverse` is the identity function and there is nothing to read. Captured inside the hook
 * rather than at module scope, where it would record the level at IMPORT time and hand back a value
 * the other describes never ran under.
 */
function paintsAnsi(): void {
  let previousChalkLevel: typeof chalk.level;
  beforeAll(() => {
    previousChalkLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousChalkLevel;
  });
}

/** The prompt's own rows of the frame: `  > ` first, then one `  … ` row per continuation line. */
function promptRows(frame: string): string[] {
  return frame.split('\n').filter((row) => /^ {2}[>…]/.test(stripAnsi(row)));
}

/**
 * Where the prompt draws its caret, as a row of the buffer and an offset into that row's text.
 *
 * The editor renders the character under the caret in reverse video rather than moving a hardware
 * cursor, so that run is the only observable of a position the component never exposes. `null`
 * means no caret was drawn at all — a real answer worth distinguishing from a wrong position.
 */
function caretIn(frame: string): { row: number; column: number } | null {
  const rows = promptRows(frame);
  for (let row = 0; row < rows.length; row += 1) {
    const at = rows[row].indexOf(INVERSE_ON);
    if (at === -1) continue;
    return { row, column: stripAnsi(rows[row].slice(0, at)).length - PROMPT.length };
  }
  return null;
}

/**
 * The message as the screen shows it, prefixes stripped and rows rejoined with `\n`.
 *
 * Trailing whitespace is dropped per row: with the escapes gone, the inverse space the caret is
 * drawn as at end-of-line is indistinguishable from a space the user typed.
 */
function bufferIn(frame: string): string {
  return promptRows(frame)
    .map((row) => stripAnsi(row).slice(PROMPT.length).replace(/\s+$/, ''))
    .join('\n');
}

/** Type each character as its own input event, the way a person produces them. */
const typeSlowly = async (stdin: { write: (data: string) => void }, text: string) => {
  for (const character of text) {
    stdin.write(character);
    await tick();
  }
};

describe('tui <SlashCommandMenu> (TUI-C10 render)', () => {
  const commands: SlashCommand[] = [
    { name: 'help', description: 'List available slash commands', run: () => ({}) },
    { name: 'status', description: 'Show session status (mode, model, turns)', run: () => ({}) },
  ];

  it('renders each command name with its description and marks the selected row', () => {
    const { lastFrame } = render(<SlashCommandMenu commands={commands} selectedIndex={1} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('List available slash commands');
    expect(frame).toContain('/status');
    expect(frame).toContain('Show session status (mode, model, turns)');
    // The highlighted row carries the ❯ marker (status is index 1).
    expect(frame).toMatch(/❯ \/status/);
  });

  it('renders nothing when there are no matching commands', () => {
    const { lastFrame } = render(<SlashCommandMenu commands={[]} selectedIndex={0} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });
});

describe('tui <PromptInput> slash-command menu (TUI-C10 interaction)', () => {
  it('opens the menu listing every command when a bare "/" is typed', async () => {
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={vi.fn()} commands={createCommandRegistry()} />
    );
    stdin.write('/');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('/status');
    expect(frame).toContain('/model');
    expect(frame).toContain('/verbose');
    expect(frame).toContain('/exit');
    expect(frame).toContain('/quit');
  });

  it('filters to matching commands as more of the name is typed', async () => {
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={vi.fn()} commands={createCommandRegistry()} />
    );
    stdin.write('/de'); // matches: debug, debug-dump
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/debug');
    expect(frame).toContain('/debug-dump');
    expect(frame).not.toContain('/help');
    expect(frame).not.toContain('/clear');
  });

  it('surfaces extension-registered commands automatically (no hardcoded list)', async () => {
    const registry = createCommandRegistry();
    registry.push({ name: 'ping', description: 'extension command', run: () => ({}) });
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={registry} />);
    stdin.write('/pi');
    await tick();
    expect(lastFrame() ?? '').toContain('/ping');
    expect(lastFrame() ?? '').toContain('extension command');
  });

  it('Enter dispatches the highlighted command (arrow-navigated)', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/de'); // matches: debug, debug-dump
    await tick();
    stdin.write(DOWN); // highlight -> debug-dump
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('/debug-dump');
  });

  it('Enter on the first match dispatches it (partial input resolves to the full command)', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/de');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/debug');
  });

  it('arrow keys wrap around the match list', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    // Prefix matches first (debug, debug-dump), then the looser substring match (moDEl).
    stdin.write('/de'); // [debug, debug-dump, model]
    await tick();
    stdin.write(UP); // wrap from 0 -> last (model)
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/model');
  });

  it('Tab completes the highlighted command (adds a trailing space) and closes the menu', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/de');
    await tick();
    stdin.write(DOWN); // -> debug-dump
    await tick();
    stdin.write(TAB);
    await tick();
    const frame = lastFrame() ?? '';
    // The menu is gone (the completion added a trailing space, which closes it).
    expect(frame).toContain('/debug-dump');
    expect(frame).not.toMatch(/❯/);
    expect(onSubmit).not.toHaveBeenCalled(); // Tab completes, it does not dispatch
    // Prove the trailing space really landed: Enter submits "/debug-dump " verbatim (menu closed).
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/debug-dump ');
  });

  it('Esc dismisses the menu without clearing the input; typing reopens it', async () => {
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={vi.fn()} commands={createCommandRegistry()} />
    );
    stdin.write('/mo');
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯/);
    stdin.write(ESC);
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);
    // Input preserved, and typing more reopens the menu.
    stdin.write('d');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/model');
  });

  it('a fully-typed command with no menu (space in it) submits verbatim', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/status now'); // has a space -> menu closed
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/status now');
  });

  it('plain (non-slash) input never shows the menu and submits as typed', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('hello');
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });
});

describe('tui <PromptInput> multiline paste (TUI-C24)', () => {
  it('buffers a multiline paste without submitting; a later Enter submits the whole value', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write(paste('line one\nline two\nline three'));
    await tick();
    // The embedded newlines must NOT trigger submit mid-paste (the core bug this fixes).
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two\nline three');
  });

  it('assembles a paste whose markers are split across two stdin chunks', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write(PASTE_START + 'alpha\nbe'); // start marker + partial body
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('ta\ngamma' + PASTE_END); // rest of body + end marker
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('alpha\nbeta\ngamma');
  });

  it('appends a paste after already-typed text (mixed typed + pasted)', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('note: ');
    await tick();
    stdin.write(paste('first\nsecond'));
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('note: first\nsecond');
  });

  it('normalizes CRLF / CR in the pasted payload to LF', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write(paste('a\r\nb\rc'));
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('a\nb\nc');
  });

  it('a multiline paste that starts with "/" does not open the slash menu and does not submit', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write(paste('/status\nsomething'));
    await tick();
    // The newline is whitespace, so this is not a bare-slash menu query.
    expect(lastFrame() ?? '').not.toMatch(/❯/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // TUI-C25 — a paste lands where the caret is. Appending to the end was the previous shape, and it
  // was correct only because nothing could move the caret off the end; now that something can, a
  // paste that ignored it would drop the payload somewhere the user was not looking.
  it('inserts a paste AT THE CARET, not at the end of the buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('ab');
    await tick();
    stdin.write(LEFT); // caret between `a` and `b`
    await tick();
    stdin.write(paste('XY'));
    await tick();
    stdin.write(ENTER);
    await tick();
    // Appended, this reads `abXY`.
    expect(onSubmit).toHaveBeenCalledWith('aXYb');
  });
});

/**
 * TUI-C25 — the prompt is a line editor now, and this is what it draws.
 *
 * Every case in the blocks below drives the component with the RAW BYTES a terminal sends and reads
 * the caret back out of the rendered frame. That is deliberate on both sides: a hand-built key
 * object can satisfy a handler on a decoding no terminal produces, and the caret is a position the
 * component never exposes, so the reverse-video run is the only honest observable of it.
 */
describe('tui <PromptEditor> rendering (TUI-C25)', () => {
  paintsAnsi();

  it('draws an empty buffer as the prompt and a caret, exactly as before', async () => {
    const { lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(bufferIn(frame)).toBe('');
    expect(caretIn(frame)).toEqual({ row: 0, column: 0 });
    // The caret at end-of-line is an inverse SPACE — there is no character to invert.
    expect(frame).toContain(`${INVERSE_ON} `);
    expect(stripAnsi(frame).trimEnd()).toBe(PROMPT.trimEnd());
  });

  it('prefixes every continuation row with a dim marker the same width as the prompt', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('alpha');
    await tick();
    stdin.write('\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write('gamma');
    await tick();

    const rows = promptRows(lastFrame() ?? '').map((row) => stripAnsi(row));
    expect(rows).toHaveLength(2);
    expect(rows[0].startsWith('  > alpha')).toBe(true);
    // Four columns wide, like `  > `, so the text of both rows starts in the same column.
    expect(rows[1].startsWith('  … gamma')).toBe(true);
    expect(rows[1].indexOf('gamma')).toBe(rows[0].indexOf('alpha'));
  });

  it('draws the caret on its own row and nowhere else', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('alpha');
    await tick();
    stdin.write('\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write('gamma');
    await tick();

    const withCaret = promptRows(lastFrame() ?? '').filter((row) => row.includes(INVERSE_ON));
    expect(withCaret).toHaveLength(1);
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 1, column: 5 });

    stdin.write(UP);
    await tick();
    expect(promptRows(lastFrame() ?? '').filter((r) => r.includes(INVERSE_ON))).toHaveLength(1);
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 5 });
  });

  it('inverts the WHOLE code point under the caret, so an emoji is not split', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('a😀');
    await tick();
    stdin.write(LEFT); // onto the emoji, which is two UTF-16 units
    await tick();

    const frame = lastFrame() ?? '';
    // Inverting one code unit renders two pieces of garbage instead of the character.
    expect(frame).toContain(`${INVERSE_ON}😀`);
    expect(bufferIn(frame)).toBe('a😀');
  });
});

/**
 * TUI-C25 — word motion, once per spelling, from the bytes each terminal actually sends.
 *
 * All three ship and none is a fallback for another: `Meta+B`/`Meta+F` is readline's own and what
 * Terminal.app and Ghostty send for `Option+←/→`, `Ctrl+←/→` is the xterm/Konsole spelling, and
 * `Meta+←/→` is a third spelling Konsole sends for `Alt+←/→`. Two steps per case, because one step
 * is satisfied by any motion that happens to move in the right direction.
 */
describe('tui <PromptEditor> word motion (TUI-C25)', () => {
  paintsAnsi();

  const WORD_LEFT: ReadonlyArray<readonly [string, string]> = [
    ['Meta+B', META_B],
    ['Ctrl+Left', CTRL_LEFT],
    ['Meta+Left', META_LEFT],
  ];
  const WORD_RIGHT: ReadonlyArray<readonly [string, string]> = [
    ['Meta+F', META_F],
    ['Ctrl+Right', CTRL_RIGHT],
    ['Meta+Right', META_RIGHT],
  ];

  it.each(WORD_LEFT)('%s walks left a word at a time', async (_name, sequence) => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('alpha beta');
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 10 });

    stdin.write(sequence);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 6 }); // start of `beta`

    stdin.write(sequence);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 }); // start of `alpha`
  });

  it.each(WORD_RIGHT)('%s walks right a word at a time', async (_name, sequence) => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('alpha beta');
    await tick();
    stdin.write(CTRL_A); // back to the start of the line (its own case below)
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 });

    stdin.write(sequence);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 5 }); // just past `alpha`

    stdin.write(sequence);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 10 }); // just past `beta`
  });

  it('crosses between the lines of a multi-line buffer', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('alpha beta');
    await tick();
    stdin.write('\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write('gamma delta');
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 1, column: 11 });

    stdin.write(META_B);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 1, column: 6 }); // start of `delta`
    stdin.write(META_B);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 1, column: 0 }); // start of `gamma`
    // A newline is just another separator to word motion, so the next step lands on the row above.
    stdin.write(META_B);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 6 }); // start of `beta`
  });
});

describe('tui <PromptEditor> line motion (TUI-C25)', () => {
  paintsAnsi();

  /** A line long enough that word motion would be a poor way to cross it, still inside 100 cols. */
  const LONG_LINE = 'the quick brown fox jumps over the lazy dog and keeps going';

  it.each([
    ['Ctrl+A', CTRL_A],
    ['Home', HOME],
  ])('%s goes to the start of a long single line', async (_name, sequence) => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write(LONG_LINE);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: LONG_LINE.length });

    stdin.write(sequence);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 });
  });

  it.each([
    ['Ctrl+E', CTRL_E],
    ['End', END],
  ])('%s goes to the end of a long single line', async (_name, sequence) => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write(LONG_LINE);
    await tick();
    stdin.write(CTRL_A);
    await tick();

    stdin.write(sequence);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: LONG_LINE.length });
  });

  it('goes to the ends of the caret OWN line, not of the whole buffer', async () => {
    // The stated v1 narrowing: there is no buffer-start/buffer-end binding.
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('alpha beta');
    await tick();
    stdin.write('\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write('gamma delta');
    await tick();

    stdin.write(CTRL_A);
    await tick();
    // Row 1, column 0 — NOT the start of the buffer, which would read {row: 0, column: 0}.
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 1, column: 0 });

    stdin.write(UP);
    await tick();
    stdin.write(CTRL_E);
    await tick();
    // End of the FIRST line, not of the buffer (which would read {row: 1, column: 11}).
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 10 });
  });

  it('leaves Ctrl+Home and Ctrl+End alone — they scroll the transcript', async () => {
    // <App> binds the Ctrl forms to scrolling. Claiming the bare keys and only the bare keys is
    // what keeps both bindings working; a Home handler that ignored the modifier would eat these.
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('alpha beta');
    await tick();
    stdin.write(CTRL_A);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 });

    stdin.write(CTRL_END);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 });

    stdin.write(CTRL_E);
    await tick();
    stdin.write(CTRL_HOME);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 10 });
  });

  it('moves and deletes one character at a time', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('abc');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write(LEFT);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 1 });
    stdin.write(RIGHT);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 2 });

    stdin.write(BACKSPACE);
    await tick();
    expect(bufferIn(lastFrame() ?? '')).toBe('ac');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 1 });
  });
});

/**
 * TUI-C25 scope item (5) — who owns Up/Down at the prompt.
 *
 * There are exactly TWO claimants, and one case here per claimant. Input-history recall is not
 * implemented at this prompt and is not built by this node, so the buffer's own no-op on a
 * single-line entry has nothing behind it to fall through to — which is the third case.
 */
describe('tui <PromptEditor> Up/Down arbitration (TUI-C25)', () => {
  paintsAnsi();

  it('gives Up/Down to the slash menu while it is open, and the buffer does not move', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/de'); // [debug, debug-dump, model]
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 3 });

    stdin.write(UP); // wrap from the first match to the last
    await tick();
    // The highlight moved…
    expect(lastFrame() ?? '').toMatch(/❯ \/model/);
    // …and neither the text nor the caret did.
    expect(bufferIn(lastFrame() ?? '')).toBe('/de');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 3 });

    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/model');
  });

  it('gives Up/Down to the buffer on a multi-line entry, with no menu involved', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('alpha');
    await tick();
    stdin.write('\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write('gamma');
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 1, column: 5 });

    stdin.write(UP);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 5 });
    stdin.write(DOWN);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 1, column: 5 });

    expect(lastFrame() ?? '').not.toMatch(/❯/);
    expect(bufferIn(lastFrame() ?? '')).toBe('alpha\ngamma');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does nothing at all on an empty single-line buffer', async () => {
    // The state a session spends most of its time in. Nothing is waiting behind the buffer here:
    // no history recall exists at this prompt, so "the caret cannot move" is the whole answer.
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    await tick();
    stdin.write(UP);
    await tick();
    stdin.write(DOWN);
    await tick();

    expect(bufferIn(lastFrame() ?? '')).toBe('');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 });
    expect(promptRows(lastFrame() ?? '')).toHaveLength(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('tui <PromptEditor> multi-line entry (TUI-C25)', () => {
  paintsAnsi();

  it('carries the line on after a trailing backslash and submits both lines as one message', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('line one');
    await tick();
    stdin.write('\\');
    await tick();
    stdin.write(ENTER);
    await tick();

    // The first Enter continued rather than submitted, and the second row is on screen.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? '')).toContain('  … ');
    expect(bufferIn(lastFrame() ?? '')).toBe('line one\n');

    stdin.write('line two');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();

    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
    // …and the prompt cleared back to a single empty row.
    expect(promptRows(lastFrame() ?? '')).toHaveLength(1);
    expect(bufferIn(lastFrame() ?? '')).toBe('');
  });

  it('never opens the slash menu on a buffer that has a newline in it', async () => {
    // `slashMenuQuery` matches `/` then non-whitespace to the end of the input, and `\n` is
    // whitespace — so a continued message beginning with `/` is not a command query.
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/status');
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯/);

    stdin.write('\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);

    stdin.write('/help');
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);

    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/status\n/help');
  });
});

/**
 * TUI-C25 / TUI-C48 / TUI-C78 — a chord belongs to whoever bound it, never to the buffer.
 *
 * This is the class the retired `ControlChordSentinel` stood in front of: `ink-text-input`'s insert
 * branch was the fall-through for every chord it did not itself claim, so `Ctrl+T` typed a `t` into
 * whatever the user was writing. The editor's insert branch refuses ctrl AND meta, which removes
 * the ctrl half (TUI-C48) and the meta half (TUI-C78, where `Option+←/→` typed a literal `b`/`f`)
 * at the same time — for the prompt buffer, by construction rather than by a component standing
 * guard in front of another one.
 *
 * The shapes that make these discriminate: an ODD number of chords, and one input event per
 * character afterwards. A burst written as one event lands correctly even on a broken editor.
 */
describe('tui <PromptEditor> control and meta chords (TUI-C25)', () => {
  paintsAnsi();

  /** Chords this prompt binds nothing to — every one of them reachable by reflex. */
  const UNBOUND_CHORDS: ReadonlyArray<readonly [string, string]> = [
    ['Ctrl+K', '\x0b'],
    ['Ctrl+R', '\x12'],
    ['Ctrl+T', '\x14'],
    ['Ctrl+U', '\x15'],
    ['Ctrl+W', '\x17'],
    ['Meta+T', '\x1bt'],
    ['Meta+D', '\x1bd'],
    ['Meta+U', '\x1bu'],
  ];

  it.each(UNBOUND_CHORDS)(
    'keeps %s out of the buffer, leaves the caret where it was, and types on in order',
    async (_name, chord) => {
      const onSubmit = vi.fn();
      const { stdin, lastFrame } = render(
        <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
      );
      await typeSlowly(stdin, 'draft');
      expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 5 });

      stdin.write(chord);
      await tick();
      expect(bufferIn(lastFrame() ?? ''), 'the chord typed its letter').toBe('draft');
      expect(caretIn(lastFrame() ?? ''), 'the chord moved the caret').toEqual({
        row: 0,
        column: 5,
      });

      await typeSlowly(stdin, 'more');
      stdin.write(ENTER);
      await tick();
      expect(onSubmit).toHaveBeenCalledWith('draftmore');
    }
  );

  it('still types the same letters when they arrive without a modifier', async () => {
    // The control for the cases above: a guard that swallowed the LETTER rather than the chord
    // would satisfy every one of them while making the keyboard useless.
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    await typeSlowly(stdin, 'draft');
    await typeSlowly(stdin, 'tduw');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('drafttduw');
  });

  it('keeps a chord out of the buffer when the caret is mid-message', async () => {
    // The case the retired remount got wrong: repairing the text input's offset returned the caret
    // to the end of the buffer, which would undo the very motions this node adds.
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    await typeSlowly(stdin, 'draft');
    stdin.write(LEFT);
    await tick();
    stdin.write(LEFT);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 3 });

    stdin.write('\x14'); // Ctrl+T
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 3 });

    await typeSlowly(stdin, 'X');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('draXft');
  });
});

/**
 * TUI-C61 / TUI-C25 — every key spelling ships on every platform, unconditionally.
 *
 * The three word-motion spellings were measured on real terminals and each belongs to a terminal
 * family rather than to an operating system, so a `process.platform` branch could only ever be
 * wrong on a combination nobody tested. Cheap to pin, and it stops the branch reappearing as an
 * apparently-reasonable "fix" for a terminal that sends one of the other two.
 */
describe('tui prompt editor — no platform branch (TUI-C25)', () => {
  const sourceOf = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

  it.each([
    ['the editor component', '../../src/tui/components/PromptEditor.tsx'],
    ['the pure model', '../../src/tui/lineEditor.ts'],
  ])('decides nothing from the operating system in %s', (_what, relative) => {
    const source = sourceOf(relative);
    expect(source).not.toMatch(/process\s*\.\s*platform/);
    expect(source).not.toMatch(/\bos\s*\.\s*platform\s*\(/);
    expect(source).not.toMatch(/from 'node:os'/);
  });
});
