import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { PromptInput } from '#src/tui/components/PromptInput.js';
import { PromptEditor } from '#src/tui/components/PromptEditor.js';
import { SlashCommandMenu } from '#src/tui/components/SlashCommandMenu.js';
import { moveWordLeft, moveWordRight, type EditorState } from '#src/tui/lineEditor.js';
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
/** Forward delete (CSI 3 ~), and its second spelling as a bare control byte. */
const DELETE = '\x1b[3~';
const CTRL_D = '\x04';
/** Backward word delete: `Option+⌫` where Option sends Meta, and the chord every keyboard has. */
const ALT_BACKSPACE = '\x1b\x7f';
const CTRL_W = '\x17';
/**
 * Forward word delete. `Ctrl+Delete` is the xterm modifier-5 form; the two `Alt+Delete` forms are
 * distinct encodings that Ink's parser converges on one key — modifier 3 in the bitmask, and a
 * doubled leading escape — so both are written out and asserted apart.
 */
const CTRL_DELETE = '\x1b[3;5~';
const ALT_DELETE = '\x1b[3;3~';
const ALT_DELETE_DOUBLE_ESC = '\x1b\x1b[3~';
/** Kill to the end / to the start of the line, and put the last kill back. */
const CTRL_K = '\x0b';
const CTRL_U = '\x15';
const CTRL_Y = '\x19';
/** Ctrl+J — the linefeed byte, which is a literal newline at this prompt. */
const CTRL_J = '\n';
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
 * TUI-C79 — deleting a character, in the direction the key names.
 *
 * `Delete` deleting FORWARD reverses TUI-C25, where it was left as a second `Backspace`. The three
 * keys are driven from ONE caret in one case on purpose: a deletion wired to the wrong direction
 * satisfies any case that presses a single key and counts what is left.
 */
describe('tui <PromptEditor> forward and backward deletion (TUI-C79)', () => {
  paintsAnsi();

  it('Delete and Ctrl+D go forward while Backspace goes back, from the same caret', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('abcd');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write(LEFT);
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 2 });

    // Forward: the character AFTER the caret goes, and the caret does not move.
    stdin.write(DELETE);
    await tick();
    expect(bufferIn(lastFrame() ?? '')).toBe('abd');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 2 });

    // The second spelling of the same action.
    stdin.write(CTRL_D);
    await tick();
    expect(bufferIn(lastFrame() ?? '')).toBe('ab');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 2 });

    // …and backward is still backward: the character BEFORE the caret, which then follows it.
    stdin.write(BACKSPACE);
    await tick();
    expect(bufferIn(lastFrame() ?? '')).toBe('a');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 1 });
  });

  it('Ctrl+D on an EMPTY buffer does nothing, and never ends the session', async () => {
    // readline's EOF convention is declined here deliberately: Ctrl+C carries a buffer-dependent
    // exit rule, and a second exit key with a different one is exactly the confusion to avoid. At
    // this level "the session is still running" is "the prompt still takes input"; the pty suite
    // asserts the process itself survives.
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    await tick();
    stdin.write(CTRL_D);
    await tick();
    expect(bufferIn(lastFrame() ?? '')).toBe('');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 });

    await typeSlowly(stdin, 'hi');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });
});

/**
 * TUI-C79 — word deletion removes exactly the span the matching motion traverses.
 *
 * Stated in terms of `moveWordLeft`/`moveWordRight` rather than against a literal, because the claim
 * is that the deletion and the motion cannot drift apart; the literal is asserted beside it so a
 * reader can see what that means. Driven at `<PromptEditor>` so the buffer can be an exact fixture —
 * the KEY is still the raw bytes a terminal sends, through Ink's own parser.
 */
describe('tui <PromptEditor> word deletion takes the motion span (TUI-C79)', () => {
  const TWO_LINES = 'alpha beta\ngamma delta';
  /** The caret at the very end of the second line. */
  const atEnd: EditorState = { value: TWO_LINES, cursor: TWO_LINES.length };
  /** Just after the newline — a backward kill from here has to cross the line boundary. */
  const atLineStart: EditorState = { value: TWO_LINES, cursor: 11 };
  /** At the end of the first line — a forward kill from here has to cross it. */
  const atLineEnd: EditorState = { value: TWO_LINES, cursor: 10 };

  /**
   * Press `sequence` at `state` and hand back the kill the editor asked its parent to apply.
   *
   * It answers WHICH verb a key triggers and over WHAT span, and only that. It cannot say the kill
   * was computed against the authoritative buffer rather than the rendered prop, because it invokes
   * the captured updater with the very object it passed as `state` — so `onKill(killWordLeft)` and
   * `onKill(() => killWordLeft(state))` are indistinguishable from here, by construction. That
   * property is pinned in 'keystrokes sharing one stdin chunk', which is the only place it can be:
   * it takes two keystrokes in ONE `stdin.write` for the two to diverge at all.
   */
  const killWith = async (
    sequence: string,
    state: EditorState
  ): Promise<{ state: EditorState; killed: string }> => {
    const onKill = vi.fn();
    const { stdin } = render(
      <PromptEditor
        state={state}
        onChange={vi.fn()}
        onKill={onKill}
        onYank={vi.fn()}
        onEnter={vi.fn()}
        menuActive={false}
      />
    );
    stdin.write(sequence);
    await tick();
    expect(onKill).toHaveBeenCalledTimes(1);
    return onKill.mock.calls[0][0](state);
  };

  const BACKWARD: ReadonlyArray<readonly [string, string]> = [
    ['Alt+Backspace', ALT_BACKSPACE],
    ['Ctrl+W', CTRL_W],
  ];
  /**
   * The three forward spellings. The two `Alt+Delete` encodings are listed and asserted SEPARATELY
   * because their convergence — Ink reads `meta` off the modifier bitmask and, independently, off a
   * doubled leading escape — is the claim being made, and either one alone would leave it unproven.
   */
  const FORWARD: ReadonlyArray<readonly [string, string]> = [
    ['Ctrl+Delete', CTRL_DELETE],
    ['Alt+Delete (CSI modifier 3)', ALT_DELETE],
    ['Alt+Delete (doubled escape)', ALT_DELETE_DOUBLE_ESC],
  ];

  it.each(BACKWARD)('%s removes what word motion would have moved back over', async (_n, seq) => {
    for (const state of [atEnd, atLineStart]) {
      const target = moveWordLeft(state).cursor;
      expect(await killWith(seq, state)).toEqual({
        state: {
          value: state.value.slice(0, target) + state.value.slice(state.cursor),
          cursor: target,
        },
        killed: state.value.slice(target, state.cursor),
      });
    }
    // The same thing said as literals: one word off the end, and — from the start of the second
    // line — a kill that takes the newline with it rather than stopping at the boundary.
    expect(await killWith(seq, atEnd)).toEqual({
      state: { value: 'alpha beta\ngamma ', cursor: 17 },
      killed: 'delta',
    });
    expect(await killWith(seq, atLineStart)).toEqual({
      state: { value: 'alpha gamma delta', cursor: 6 },
      killed: 'beta\n',
    });
  });

  it.each(FORWARD)('%s removes what word motion would have moved on over', async (_n, seq) => {
    for (const state of [atLineEnd, { value: TWO_LINES, cursor: 0 }]) {
      const target = moveWordRight(state).cursor;
      expect(await killWith(seq, state)).toEqual({
        state: {
          value: state.value.slice(0, state.cursor) + state.value.slice(target),
          cursor: state.cursor,
        },
        killed: state.value.slice(state.cursor, target),
      });
    }
    expect(await killWith(seq, { value: TWO_LINES, cursor: 0 })).toEqual({
      state: { value: ' beta\ngamma delta', cursor: 0 },
      killed: 'alpha',
    });
    expect(await killWith(seq, atLineEnd)).toEqual({
      state: { value: 'alpha beta delta', cursor: 10 },
      killed: '\ngamma',
    });
  });

  it('Alt+Backspace and Ctrl+W AGREE on a punctuated token — one action, not two', async () => {
    // Where TUI-C79's decision is visible. bash binds Ctrl+W to `unix-word-rubout`, which would take
    // the whole of `foo.bar/baz`; zsh binds it to `backward-kill-word`, which takes `baz`. The
    // shells disagree, so this prompt matches its own word motion instead, on both spellings.
    const token: EditorState = { value: 'edit foo.bar/baz', cursor: 16 };
    const byAltBackspace = await killWith(ALT_BACKSPACE, token);
    const byCtrlW = await killWith(CTRL_W, token);
    expect(byAltBackspace).toEqual(byCtrlW);
    expect(byAltBackspace).toEqual({
      state: { value: 'edit foo.bar/', cursor: 13 },
      killed: 'baz',
    });
  });
});

/**
 * TUI-C79 — `Ctrl+K` and `Ctrl+U` are `Ctrl+E` and `Ctrl+A` with the text removed.
 *
 * Both are scoped to the caret's own LOGICAL line, exactly as those motions are, so the cases are
 * written on a real two-row buffer: only a rendered second row can say whether a kill stopped at the
 * line's edge or ran on through the whole message.
 */
describe('tui <PromptEditor> killing to the ends of the line (TUI-C79)', () => {
  paintsAnsi();

  /** `alpha beta` / `gamma delta` as two logical lines, caret left in the middle of the FIRST. */
  const midFirstLine = async () => {
    const onSubmit = vi.fn();
    const harness = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    harness.stdin.write('alpha beta');
    await tick();
    harness.stdin.write('\\');
    await tick();
    harness.stdin.write(ENTER);
    await tick();
    harness.stdin.write('gamma delta');
    await tick();
    harness.stdin.write(UP);
    await tick();
    harness.stdin.write(META_B); // onto the start of `beta`
    await tick();
    expect(caretIn(harness.lastFrame() ?? '')).toEqual({ row: 0, column: 6 });
    return { ...harness, onSubmit };
  };

  it('Ctrl+K stops at the end of its own line, leaving the line below intact', async () => {
    const { stdin, lastFrame, onSubmit } = await midFirstLine();
    stdin.write(CTRL_K);
    await tick();

    const rows = promptRows(lastFrame() ?? '').map((row) => stripAnsi(row));
    expect(rows).toHaveLength(2);
    expect(rows[1].startsWith('  … gamma delta')).toBe(true);
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 6 });

    stdin.write(ENTER);
    await tick();
    // The trailing space survives, and the newline was never eaten — a kill that ran past the end
    // of the line would submit `alpha ` alone, or `alpha gamma delta`.
    expect(onSubmit).toHaveBeenCalledWith('alpha \ngamma delta');
  });

  it('Ctrl+U kills to the line START, leaving the text after the caret alone', async () => {
    const { stdin, lastFrame, onSubmit } = await midFirstLine();
    stdin.write(CTRL_U);
    await tick();

    const rows = promptRows(lastFrame() ?? '').map((row) => stripAnsi(row));
    expect(rows).toHaveLength(2);
    // `beta` is still there: this is kill-to-start, not zsh's kill-whole-line, which would leave an
    // empty first row and read `\ngamma delta`.
    expect(rows[0].startsWith('  > beta')).toBe(true);
    expect(rows[1].startsWith('  … gamma delta')).toBe(true);
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 });

    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('beta\ngamma delta');
  });
});

/**
 * TUI-C79 — the one-slot kill store, and why it is not separable from the verbs that fill it.
 *
 * `Ctrl+U` on a composed message removes it in one keystroke and this prompt has no undo of any
 * kind. The slot is what makes that recoverable — so what has to be pinned is not "Ctrl+Y pastes
 * something" (true of any slot that is merely never empty) but WHICH text it holds: only the four
 * killing verbs write it, and a kill that removed nothing does not.
 */
describe('tui <PromptEditor> the kill slot and Ctrl+Y (TUI-C79)', () => {
  paintsAnsi();

  it('puts the killed text back', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('hello world');
    await tick();
    stdin.write(CTRL_W);
    await tick();
    expect(bufferIn(lastFrame() ?? '')).toBe('hello');

    stdin.write(CTRL_Y);
    await tick();
    expect(bufferIn(lastFrame() ?? '')).toBe('hello world');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello world');
  });

  it('holds the MOST RECENT kill, not the first one of the session', async () => {
    // One kill cannot tell a one-slot store from a write-once one, and a write-once store is the
    // shape a guard against clobbering is most likely to be mis-written into: the first kill of the
    // session would then be the only text `Ctrl+Y` could ever produce, for the rest of the session.
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('alpha beta gamma');
    await tick();
    stdin.write(CTRL_W); // slot: `gamma`
    await tick();
    stdin.write(CTRL_W); // slot: `beta ` — the newer kill replaces it
    await tick();
    stdin.write(CTRL_Y);
    await tick();
    stdin.write(ENTER);
    await tick();
    // A slot that kept the FIRST kill submits `alpha gamma` here.
    expect(onSubmit).toHaveBeenCalledWith('alpha beta ');
  });

  it('puts it back AT THE CARET, not at the end of the buffer', async () => {
    // Every other yank in this suite happens with the caret already at the end of the buffer, where
    // "at the caret" and "appended" are the same string — so the promise the node, the UX guidelines
    // and the code comment all make is only visible from a caret that has been moved off the end.
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('hello world');
    await tick();
    stdin.write(CTRL_W); // slot: `world`, buffer `hello `
    await tick();
    stdin.write(CTRL_A); // …and the caret to the start of the line, off the end of the buffer
    await tick();
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 });

    stdin.write(CTRL_Y);
    await tick();
    // Appended instead, this reads `hello world` with the caret left at column 11.
    expect(bufferIn(lastFrame() ?? '')).toBe('worldhello');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 5 });
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('worldhello ');
  });

  it('is NOT written by an ordinary Backspace', async () => {
    // The case that fails if the slot is shared with ordinary deletion: the Backspace here removes
    // the space `Ctrl+W` left behind, so a slot fed by every deletion holds `' '` and the yank
    // produces `hello ` instead of putting the killed word back.
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('hello world');
    await tick();
    stdin.write(CTRL_W); // slot: `world`
    await tick();
    stdin.write(BACKSPACE); // removes the space; must leave the slot alone
    await tick();
    stdin.write(CTRL_Y);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('helloworld');
  });

  it('is not clobbered by a kill that removed nothing', async () => {
    // `Ctrl+K` at the end of the line takes no text. Storing that as an empty kill would destroy a
    // yank the user still wanted, silently and with nothing on screen to show it.
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('hello world');
    await tick();
    stdin.write(CTRL_W); // slot: `world`
    await tick();
    stdin.write(CTRL_K); // end of line — nothing to kill
    await tick();
    stdin.write(CTRL_Y);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello world');
  });

  it('inserts nothing when nothing has been killed yet', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('abc');
    await tick();
    stdin.write(CTRL_Y);
    await tick();
    expect(bufferIn(lastFrame() ?? '')).toBe('abc');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 3 });
  });
});

/**
 * TUI-C79 item (6) — `Ctrl+J` inserts a literal newline.
 *
 * **A REGRESSION test: it already passes against the build that existed before this node**, and that
 * is the reason it is here rather than a reason to leave it out. `Ctrl+J` works by FALLING PAST every
 * branch of the editor's `useInput` into the insert branch — the byte is `\n`, which Ink parses as
 * `{name: 'enter'}`, which is not `key.return` and is not one of the keys whose `input` gets blanked,
 * so the event arrives carrying `'\n'` and no modifier. Nothing in the component would otherwise say
 * the key exists, so the next narrowing of those guards removes a documented key and no other test
 * notices. Do not delete this as redundant with the backslash cases: they exercise a different
 * branch, and this is the only thing pinning the fall-through.
 */
describe('tui <PromptEditor> Ctrl+J is the newline key (TUI-C79)', () => {
  paintsAnsi();

  it('draws the same continuation row as `\\` + Enter, and Enter still submits', async () => {
    const onSubmit = vi.fn();
    const byCtrlJ = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    byCtrlJ.stdin.write('line one');
    await tick();
    byCtrlJ.stdin.write(CTRL_J);
    await tick();
    byCtrlJ.stdin.write('line two');
    await tick();

    // The same message built the documented way, in its own render, as the comparison.
    const byBackslash = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    byBackslash.stdin.write('line one');
    await tick();
    byBackslash.stdin.write('\\');
    await tick();
    byBackslash.stdin.write(ENTER);
    await tick();
    byBackslash.stdin.write('line two');
    await tick();

    // Indistinguishable — prefixes, alignment and caret included, not merely "a second row exists".
    expect(promptRows(byCtrlJ.lastFrame() ?? '')).toEqual(
      promptRows(byBackslash.lastFrame() ?? '')
    );
    expect(stripAnsi(byCtrlJ.lastFrame() ?? '')).toContain('  … line two');
    expect(onSubmit).not.toHaveBeenCalled();

    // …and `\r` still submits, in this same case, so the two keys cannot be confused for each other.
    byCtrlJ.stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
  });

  it('splits the line at the caret, wherever the caret happens to be', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('abcd');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write(CTRL_J);
    await tick();

    expect(promptRows(lastFrame() ?? '')).toHaveLength(2);
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 1, column: 0 });
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ab\ncd');
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

  // Integration-level, and it cannot discriminate the guard on its own — say so rather than let a
  // reader take it for more than it is. `menuActive` implies `slashMenuQuery(value) !== null`, which
  // implies a buffer with no whitespace in it, hence one logical line, on which `moveLineUp` and
  // `moveLineDown` change neither the value nor the caret. Deleting the guard leaves this green.
  // The case that fails without it drives <PromptEditor> directly, on a buffer <PromptInput> could
  // never hold with the menu open — see 'the menuActive contract' below.
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
    // EXACTLY once. Without the editor's `menuActive` guard on Enter it would submit the typed
    // `/de` as well, and `toHaveBeenCalledWith` alone is satisfied by the second of two calls.
    expect(onSubmit).toHaveBeenCalledTimes(1);
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
 * What makes these discriminate is that characters are typed AFTER the chord, one input event each:
 * a chord that reached the buffer shows up as a stray letter, and a chord that disturbed the caret
 * shows up in where those characters land. Asserting only the buffer immediately after the chord
 * would miss the second half entirely.
 */
describe('tui <PromptEditor> control and meta chords (TUI-C25)', () => {
  paintsAnsi();

  /**
   * Chords this prompt binds nothing to — every one of them reachable by reflex.
   *
   * `Meta+D` is here on purpose rather than by omission: it is readline's `kill-word` and it is
   * cleanly bindable, and TUI-C79 declined it because forward word deletion already has a spelling
   * for every keyboard (`Alt+Delete` and `Ctrl+Delete`). The prompt's own chords —
   * `Ctrl+D`/`W`/`K`/`U`/`Y` and the two arrow chords — belong in the cases that assert what they
   * do, not here.
   */
  const UNBOUND_CHORDS: ReadonlyArray<readonly [string, string]> = [
    ['Ctrl+R', '\x12'],
    ['Ctrl+T', '\x14'],
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

  it('refuses a chord on every press, not only the first (chord, type, chord, type)', async () => {
    // The interleaved shape. A guard that fired once — a flag set rather than a condition tested —
    // satisfies every single-chord case above and every case that types only before its second
    // chord, while the second chord behaves exactly as an unguarded first one does. Both the caret
    // read and the submitted value below are taken AFTER a second chord with characters following.
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    await typeSlowly(stdin, 'ab');
    stdin.write('\x14'); // Ctrl+T
    await tick();
    expect(caretIn(lastFrame() ?? ''), 'the first chord moved the caret').toEqual({
      row: 0,
      column: 2,
    });

    await typeSlowly(stdin, 'cd');
    stdin.write('\x14');
    await tick();
    expect(caretIn(lastFrame() ?? ''), 'the second chord moved the caret').toEqual({
      row: 0,
      column: 4,
    });

    await typeSlowly(stdin, 'ef');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('abcdef');
  });

  it('leaves an EMPTY buffer empty, and types the next characters in order', async () => {
    // The state a session spends most of its time in, and the one place a caret cannot be nudged
    // backwards — so an editor that mishandled the chord fails here by typing rather than by
    // misplacing, which is a different symptom from every case above.
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('\x14'); // Ctrl+T
    await tick();
    expect(bufferIn(lastFrame() ?? '')).toBe('');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 0 });

    await typeSlowly(stdin, 'hi');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });
});

/**
 * TUI-C25 — two keystrokes that arrive in ONE stdin chunk.
 *
 * Ink splits a chunk into several key events and dispatches them synchronously, so every handler
 * after the first still closes over the React state from before its predecessor's edit. An editor
 * that computed from that state would throw the predecessor's work away — and the first row below
 * is the one that reaches users, because Ink deliberately splits repeated backspace bytes into
 * separate events precisely because HOLDING the key sends them in one chunk.
 *
 * Every case here writes the whole burst as a SINGLE `stdin.write`. That is the entire point: typed
 * one keystroke per write, with a tick between, all three pass on an editor that has this defect —
 * which is why the rest of the suite, written that way, cannot see it.
 */
describe('tui <PromptEditor> keystrokes sharing one stdin chunk (TUI-C25)', () => {
  paintsAnsi();

  it('applies EVERY backspace of a held key, not just the first', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('abcdef');
    await tick();
    stdin.write(BACKSPACE + BACKSPACE + BACKSPACE);
    await tick();
    // Computing from the rendered state, this reads `abcde` — one deletion out of three.
    expect(bufferIn(lastFrame() ?? '')).toBe('abc');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 3 });
  });

  it('keeps a motion that shares its chunk with the character typed after it', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('alpha beta');
    await tick();
    stdin.write(META_B + 'X');
    await tick();
    // The motion lost, this reads `alpha betaX`.
    expect(bufferIn(lastFrame() ?? '')).toBe('alpha Xbeta');
  });

  it('keeps ALL of several motions that share a chunk with the character after them', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('abcdef');
    await tick();
    stdin.write(LEFT + LEFT + LEFT + 'Z');
    await tick();
    // Every motion lost, this reads `abcdefZ`; only the last one honoured, `abcdeZf`.
    expect(bufferIn(lastFrame() ?? '')).toBe('abcZdef');
  });

  // Enter is in this class too, and it is the sharpest instance of it: a held Backspace RELEASED
  // INTO Enter is what a person typing produces, and if Enter decides from the rendered state the
  // corrected text is on screen, the UNcorrected text is sent, and the buffer clears — so nothing
  // survives to show it happened.
  it('submits the text as it stands after a backspace that shared Enter chunk', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('abcdef');
    await tick();
    stdin.write(BACKSPACE + ENTER);
    await tick();
    // Deciding from the rendered state, this submits `abcdef` — the text the user just corrected.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('abcde');
  });

  it('submits the text as it stands after a HELD backspace released into Enter', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('abcdef');
    await tick();
    stdin.write(BACKSPACE + BACKSPACE + BACKSPACE + ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('abc');
  });

  // TUI-C79 — a KILL is in this class too, and it is the sharpest instance after Enter: the killed
  // text is not only applied to the buffer, it is STORED, so a kill computed from the render puts
  // text the user has already changed into the one slot `Ctrl+Y` reads back. Nothing on screen says
  // the slot is stale, and it stays stale until the next kill.
  it('kills the word the buffer holds after a backspace that shared its chunk', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('alpha beta');
    await tick();
    // `Alt+Backspace` rather than `Ctrl+W`, and that is forced: Ink's input parser splits a run of
    // plain bytes only at backspace bytes, so `\x7f\x17\x19` would arrive as `\x7f` and then the
    // two-byte string `\x17\x19`, which parses as no key at all. `\x1b\x7f` is an escape sequence,
    // which the parser always cuts out on its own, so all three keys land as three events here.
    //
    // The YANK is what makes the defect observable. Both wirings leave the same buffer after the
    // kill (`alpha ` either way); they differ only in the text they STORED — `bet` against `beta` —
    // and the slot has no other window onto it.
    stdin.write(BACKSPACE + ALT_BACKSPACE + CTRL_Y);
    await tick();
    // Computing the kill from the rendered prop, the backspace is thrown away, `beta` is killed and
    // stored, and the yank puts it back whole — so this reads `alpha beta`, the text just corrected.
    expect(bufferIn(lastFrame() ?? '')).toBe('alpha bet');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 9 });
  });

  it('yanks at the caret the keystroke before it in the same chunk left', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('hello world');
    await tick();
    stdin.write(CTRL_W); // slot: `world`, buffer `hello `, in a chunk of its own
    await tick();
    stdin.write(BACKSPACE + CTRL_Y);
    await tick();
    // Inserting into the rendered state, the yank does not see the backspace that shared its chunk
    // and reads `hello world` — the space back, and the caret one column past where it belongs.
    expect(bufferIn(lastFrame() ?? '')).toBe('helloworld');
    expect(caretIn(lastFrame() ?? '')).toEqual({ row: 0, column: 10 });
  });

  it('decides CONTINUE vs submit from the caret a motion in the same chunk left', async () => {
    // The other half of Enter's decision, and it fails the other way round: with the caret read
    // from the render this sees `c` before it and submits `ab\c`, instead of seeing the backslash
    // the motion moved onto and carrying the line on.
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} commands={[]} />);
    stdin.write('ab\\c');
    await tick();
    stdin.write(LEFT + ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(bufferIn(lastFrame() ?? '')).toBe('ab\nc');
  });
});

/**
 * TUI-C25 — the menu's transient state belongs to an EDIT, not to a string.
 *
 * Esc's dismissal and the highlighted row are both scoped to the query they were made against, and
 * the obvious way to say that — key them on the buffer text — is wrong, because an edit can return
 * the buffer to a value it has already held. Then a dismissal made in one message suppresses the
 * menu for that same query in a later one, and a highlight the user has typed past comes back. The
 * edit serial cannot repeat, so it cannot resurrect.
 *
 * Every case here edits BACK into a query the buffer has already been at, which is exactly what the
 * rest of the menu suite never does — those all drive one query forward.
 */
describe('tui <PromptInput> the menu never resurrects a dismissal or a highlight (TUI-C25)', () => {
  it('reopens for a query typed again in a LATER message, after Esc dismissed it in an earlier one', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/de');
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯/);

    stdin.write(ESC); // dismissed for THIS query, in THIS message
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);

    stdin.write(ENTER); // …which sends it, and the buffer is a fresh one from here
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/de');

    // The same query again, in the next message. A dismissal keyed on the text silently suppresses
    // the menu here, and the user has no way to ask for it back except to type something else.
    stdin.write('/de');
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯/);
  });

  it('keeps the menu open when a Backspace returns the buffer to an earlier query', async () => {
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={vi.fn()} commands={createCommandRegistry()} />
    );
    stdin.write('/de');
    await tick();
    stdin.write(ESC);
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);

    stdin.write('b'); // `/deb` — a query the dismissal never applied to, so the menu returns
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯/);

    stdin.write(BACKSPACE); // back to `/de` — the dismissal must NOT come back with it
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯/);
  });

  it('does not restore a stale highlight when a Backspace returns to an earlier query', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/de'); // [debug, debug-dump, model]
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯ \/model/);

    stdin.write('b'); // `/deb` — a new query, so the highlight starts at the top again
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯ \/debug/);

    stdin.write(BACKSPACE); // back to `/de`
    await tick();
    stdin.write(ENTER);
    await tick();
    // Keyed on the text, the highlight jumps back to `/model` and Enter dispatches THAT.
    expect(onSubmit).toHaveBeenCalledWith('/debug');
  });

  it('still dismisses on Esc, survives a caret move, and reopens on the next edit', async () => {
    // The path that must keep working, and the reason the key is an edit serial rather than a reset
    // on every keystroke: a motion is not an edit, so Esc survives one.
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={vi.fn()} commands={createCommandRegistry()} />
    );
    stdin.write('/de');
    await tick();
    stdin.write(ESC);
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);

    stdin.write(LEFT);
    await tick();
    expect(lastFrame() ?? '', 'a caret move re-opened a dismissed menu').not.toMatch(/❯/);
    stdin.write(RIGHT);
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);

    stdin.write('b'); // an edit, and the menu comes back
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯/);
  });
});

/**
 * TUI-C25 — the `menuActive` prop is a contract, and this is the case that holds it.
 *
 * It has to be driven at the component rather than through `<PromptInput>`: the menu is open only
 * while the buffer holds a bare `/`-query, which by definition has no whitespace in it and is
 * therefore one logical line — on which Up/Down are no-ops anyway. So the integration case cannot
 * fail if the guard is deleted, and this one drives the editor directly with a multi-line buffer
 * the parent could never pair with an open menu.
 */
describe('tui <PromptEditor> the menuActive contract (TUI-C25)', () => {
  paintsAnsi();

  /** A two-line buffer with the caret at the end, where Up/Down and Enter all have work to do. */
  const twoLines: EditorState = { value: 'alpha\ngamma', cursor: 11 };

  it('ignores Up/Down while the menu owns them, on a buffer where they WOULD move', async () => {
    const onChange = vi.fn();
    const { stdin, rerender } = render(
      <PromptEditor
        state={twoLines}
        onChange={onChange}
        onKill={vi.fn()}
        onYank={vi.fn()}
        onEnter={vi.fn()}
        menuActive
      />
    );
    stdin.write(UP);
    await tick();
    stdin.write(DOWN);
    await tick();
    expect(onChange).not.toHaveBeenCalled();

    // The control, and the half that makes the negative mean something: the same keys on the same
    // buffer with the menu closed do move the caret, one logical line up.
    rerender(
      <PromptEditor
        state={twoLines}
        onChange={onChange}
        onKill={vi.fn()}
        onYank={vi.fn()}
        onEnter={vi.fn()}
        menuActive={false}
      />
    );
    stdin.write(UP);
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0](twoLines)).toEqual({
      value: 'alpha\ngamma',
      cursor: 5,
      desiredColumn: 5,
    });
  });

  it('ignores Enter while the menu owns it — it is not even reported', async () => {
    const onChange = vi.fn();
    const onEnter = vi.fn();
    const { stdin, rerender } = render(
      <PromptEditor
        state={twoLines}
        onChange={onChange}
        onKill={vi.fn()}
        onYank={vi.fn()}
        onEnter={onEnter}
        menuActive
      />
    );
    stdin.write(ENTER);
    await tick();
    expect(onEnter).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <PromptEditor
        state={twoLines}
        onChange={onChange}
        onKill={vi.fn()}
        onYank={vi.fn()}
        onEnter={onEnter}
        menuActive={false}
      />
    );
    stdin.write(ENTER);
    await tick();
    expect(onEnter).toHaveBeenCalledTimes(1);
    // Reported, not interpreted: the editor says Enter happened and hands over no decision with it.
    expect(onEnter).toHaveBeenCalledWith();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still edits and moves within a line while the menu is open', async () => {
    // The control for the two cases above at the level they are written: `menuActive` stands the
    // editor down from exactly two keys, and a guard that stood it down from the keyboard would
    // satisfy both negatives while making the menu impossible to type a query into.
    const onChange = vi.fn();
    const { stdin } = render(
      <PromptEditor
        state={twoLines}
        onChange={onChange}
        onKill={vi.fn()}
        onYank={vi.fn()}
        onEnter={vi.fn()}
        menuActive
      />
    );
    stdin.write('x');
    await tick();
    expect(onChange.mock.calls[0][0](twoLines)).toEqual({ value: 'alpha\ngammax', cursor: 12 });

    stdin.write(LEFT);
    await tick();
    expect(onChange.mock.calls[1][0](twoLines)).toEqual({ value: 'alpha\ngamma', cursor: 10 });
  });
});

/**
 * TUI-C25 — a logical line the TERMINAL has to break across visual rows.
 *
 * Ink gives every child of a row `Box` a default `flexShrink: 1`, so when the text overflows, Yoga
 * shrinks the `  > ` prefix along with it: the prefix loses its trailing space, row 0's text starts
 * one column left of its own wrapped continuation, and the text is handed more columns than the row
 * has — leaving Ink to emit a row WIDER than the terminal, which the terminal then hard-wraps
 * mid-word into a stray row. Four columns is the alignment this component promises, and the promise
 * is only interesting on the rows where it was being broken.
 *
 * The width is pinned by the case rather than inherited from the harness, so what "too long" means
 * is stated here and cannot drift.
 */
describe('tui <PromptEditor> a line the terminal has to wrap (TUI-C25)', () => {
  /**
   * The width these cases are written against.
   *
   * The prompt must be rendered as Ink's ROOT, sized from the harness's own stdout, because that is
   * where the defect lives: wrapping the component in a fixed-width `<Box>` changes how Yoga
   * measures the text and the prefix stops being shrunk at all — a pinned container would make
   * every assertion below pass with the defect fully present. `ink-testing-library` hardcodes 100
   * columns, and the first case proves it rather than trusting it, so a library that changed the
   * number fails loudly instead of quietly un-wrapping the fixture.
   */
  const HARNESS_COLUMNS = 100;
  /** 146 characters — wider than the 96 the text gets at `HARNESS_COLUMNS`, so it must wrap. */
  const LONG_LINE =
    'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike ' +
    'november oscar papa quebec romeo sierra tango uniform victor whiskey';

  it('renders at the width these cases assume', () => {
    const { lastFrame } = render(
      <Box>
        <Text>{'x'.repeat(HARNESS_COLUMNS * 3)}</Text>
      </Box>
    );
    const rows = stripAnsi(lastFrame() ?? '').split('\n');
    expect(Math.max(...rows.map((row) => row.length))).toBe(HARNESS_COLUMNS);
  });

  it('keeps the whole 4-column prompt prefix and never draws past the terminal width', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write(LONG_LINE);
    await tick();
    const rows = stripAnsi(lastFrame() ?? '').split('\n');

    // It genuinely wrapped. Without this the assertions below all hold on a single short row and
    // the case quietly stops testing the thing it is named for.
    expect(rows.length).toBeGreaterThan(1);
    // The prefix keeps its trailing space — squeezed to `  >`, the text starts a column early and
    // no longer lines up with its own continuation.
    expect(rows[0].startsWith(PROMPT)).toBe(true);
    // …and no row runs past the terminal. A row one column too wide is what leaves the TERMINAL to
    // hard-wrap it mid-word, orphaning a character onto a row of its own.
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(HARNESS_COLUMNS);
    // Every wrapped row starts at the prompt's own text column, so the line reads as one block.
    for (const row of rows.slice(1)) expect(row.startsWith(' '.repeat(PROMPT.length))).toBe(true);
  });

  it('keeps the continuation prefix at 4 columns when a LATER line is the one that wraps', async () => {
    // The `  … ` prefix is the same shape and shrinks the same way, so a multi-line message whose
    // second line is the long one has to be stated separately from the row-0 case.
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={[]} />);
    stdin.write('short first');
    await tick();
    stdin.write('\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(LONG_LINE);
    await tick();
    const rows = stripAnsi(lastFrame() ?? '').split('\n');

    expect(rows[0].startsWith(`${PROMPT}short first`)).toBe(true);
    expect(rows[1].startsWith('  … ')).toBe(true);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(HARNESS_COLUMNS);
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
