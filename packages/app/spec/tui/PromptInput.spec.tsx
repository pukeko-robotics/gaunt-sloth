import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const DOWN = '\x1b[B'; // Down arrow CSI sequence
const UP = '\x1b[A'; // Up arrow CSI sequence
const ENTER = '\r';
const TAB = '\t';
const ESC = '\x1b';
// Bracketed-paste markers (TUI-C24): the terminal wraps pasted content between these.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const paste = (body: string): string => PASTE_START + body + PASTE_END;

const tick = () => new Promise((r) => setTimeout(r, 20));

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
});

/** The `  > ` prompt the value is drawn after. */
const PROMPT = '  > ';
/** Reverse video on — how the prompt cursor is drawn (`ink-text-input` draws no hardware cursor). */
const INVERSE_ON = '\x1b[7m';

/**
 * Where the prompt draws its cursor, as an offset into the typed value — `null` if it draws none.
 *
 * The text input renders the character under its internal offset in reverse video instead of moving
 * a hardware cursor, so that run is the ONLY observable of an offset the component never exposes.
 * An offset past the end of the value matches no character and produces no run at all, which is why
 * `null` is a real answer here rather than a parse failure.
 */
function cursorOffsetIn(frame: string): number | null {
  const start = frame.indexOf(INVERSE_ON);
  if (start === -1) return null;
  return stripAnsi(frame.slice(0, start)).length - PROMPT.length;
}

/**
 * TUI-C48 — control chords belong to whoever bound them, not to the buffer, and the text input's
 * cursor has to survive one.
 *
 * `ink-text-input` claims only Ctrl+C and **types** every other control chord: Ink reports Ctrl+T
 * as the letter `t` with `key.ctrl`. So this is a whole class reached by reflex — `Ctrl+A`, `Ctrl+E`,
 * `Ctrl+U`, `Ctrl+W`, `Ctrl+K` are what a terminal user's fingers do at any prompt — and not one
 * keybinding a reader chose to press.
 *
 * **Two shapes here are load-bearing, and a case that drops either stops discriminating.**
 *
 * - **An ODD number of chords.** The text input commits its cursor offset before asking whether the
 *   value may change, so a refused chord leaves the offset one past the value. The next chord's own
 *   clamp (offset > value length → value length) repairs it, so an EVEN number of chords self-heals
 *   and asserts nothing.
 * - **One input event per character afterwards.** A single write of `more` arrives as one event with
 *   `input.length === 4`, takes the clamp branch in one step and lands correctly. Typed as four
 *   events — which is what a person does — each one inserts at the stale offset.
 */
describe('tui <PromptInput> control chords (TUI-C48)', () => {
  // The cursor is an ANSI attribute, so it only exists in the frame while colour is on: at level 0
  // `chalk.inverse` is the identity function and there is nothing to read. Without this the cursor
  // assertions below would pass on a prompt drawing no cursor at all.
  // Captured inside the hook, not at module scope: at module scope it would record the level at
  // IMPORT time and hand back a value the describes above this one never ran under.
  let previousChalkLevel: typeof chalk.level;
  beforeAll(() => {
    previousChalkLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousChalkLevel;
  });

  const CTRL_T = '\x14';

  /** The readline chords a terminal user presses without thinking, plus the one the app binds. */
  const REFLEX_CHORDS: ReadonlyArray<readonly [string, string]> = [
    ['Ctrl+A', '\x01'],
    ['Ctrl+E', '\x05'],
    ['Ctrl+K', '\x0b'],
    ['Ctrl+R', '\x12'],
    ['Ctrl+T', CTRL_T],
    ['Ctrl+U', '\x15'],
    ['Ctrl+W', '\x17'],
  ];

  /** Type each character as its own input event, the way a person produces them. */
  const typeSlowly = async (stdin: { write: (data: string) => void }, text: string) => {
    for (const character of text) {
      stdin.write(character);
      await tick();
    }
  };

  it.each(REFLEX_CHORDS)(
    'keeps %s out of the buffer, and everything typed after it still lands in order',
    async (_name, chord) => {
      const onSubmit = vi.fn();
      const { stdin } = render(
        <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
      );
      await typeSlowly(stdin, 'draft');
      stdin.write(chord);
      await tick();
      await typeSlowly(stdin, 'more');
      stdin.write(ENTER);
      await tick();
      // Unguarded this submits 'drafttmore'; guarded only at onChange it submits 'draftorem',
      // because the four later characters each insert one position early.
      expect(onSubmit).toHaveBeenCalledWith('draftmore');
    }
  );

  it('still draws its cursor after a chord, and the cursor keeps up with what is typed', async () => {
    // The cursor is the VISIBLE half of the same defect: it is drawn as the reverse-video cell at
    // the input's internal offset, so an offset past the end of the value matches no character and
    // the prompt loses its cursor entirely with nothing to say why. Asserting the submitted value
    // alone would leave that symptom unpinned.
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    await typeSlowly(stdin, 'draft');
    expect(cursorOffsetIn(lastFrame() ?? '')).toBe(5);

    stdin.write(CTRL_T);
    await tick();
    expect(cursorOffsetIn(lastFrame() ?? ''), 'the chord erased the cursor').toBe(5);

    await typeSlowly(stdin, 'mo');
    expect(cursorOffsetIn(lastFrame() ?? '')).toBe(7);
  });

  it('leaves an EMPTY buffer empty, and types the next characters in order', async () => {
    // The state a user is in most often, and a different code path: with nothing typed the input's
    // own clamp fires on the very next character, which lands the stale offset at the START of the
    // buffer rather than past its end.
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write(CTRL_T);
    await tick();
    await typeSlowly(stdin, 'hi');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });

  it('still types the same letters when they arrive without the control modifier', async () => {
    // The control for the cases above: a guard that swallowed the letter outright, rather than the
    // chord, would satisfy them while making the keyboard useless.
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    await typeSlowly(stdin, 'draft');
    await typeSlowly(stdin, 'tr');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('drafttr');
  });

  /**
   * The declared cost of the remount, pinned so it is a decision rather than a surprise.
   *
   * A chord pressed with the cursor part-way through the buffer returns it to the end. The buffer
   * itself is intact and the move is on screen, so it is recoverable with the arrow keys — but it
   * is a move the user did not ask for, and it is what a remount buys the value with.
   *
   * [[TUI-C25]] builds the real line editor and binds Ctrl+A/Ctrl+E to line start/end, so it owns
   * the cursor and will make this case wrong. When it does, this failing is "update me", not a
   * regression: the expectation to write then is `draXft`.
   */
  it('returns the cursor to the end of the buffer when a chord arrives mid-string', async () => {
    const LEFT = '\x1b[D';
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    await typeSlowly(stdin, 'draft');
    stdin.write(LEFT);
    await tick();
    stdin.write(LEFT);
    await tick();
    expect(cursorOffsetIn(lastFrame() ?? '')).toBe(3);

    stdin.write(CTRL_T);
    await tick();
    expect(cursorOffsetIn(lastFrame() ?? '')).toBe(5);

    await typeSlowly(stdin, 'X');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('draftX');
  });
});
