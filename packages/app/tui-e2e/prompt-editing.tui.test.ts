import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

/**
 * Build the child env. Program mode does NOT merge process.env, so we spread it in full.
 * `CI` is deleted rather than blanked: Ink's CI detection keys off the presence of the key, so
 * `CI=""` would force the non-interactive renderer and the frame would never paint.
 */
const envFor = (fixtureName: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
  return env;
};

/** The harness terminal, derived from the public `test` signature so no deep import is needed. */
type Term = Parameters<Parameters<typeof test>[1]>[0]['terminal'];

/** A buffer cell, in the coordinates `serialize().shifts` keys use. */
type Cell = { x: number; y: number };

/**
 * Where the prompt's caret is on screen.
 *
 * The prompt draws no real terminal cursor — it renders the character under the caret in reverse
 * video instead (an empty cell when the caret is at the end of a line), so `terminal.getCursor()`
 * reports where Ink left the hardware cursor and does NOT follow the caret. The reverse-video run
 * is therefore the only observable of it, and `serialize()` exposes it: `shifts` records attribute
 * transitions between adjacent cells, so the first cell whose entry turns `inverse` on is the caret.
 *
 * This needs colour ON, because reverse video is an attribute: `applyTuiColour` clamps
 * `chalk.level` to 0 when the ladder says no colour, which turns `chalk.inverse` into the identity
 * function and erases the caret entirely. `envFor` keeps the colour variables away from the app for
 * that reason, and the throw names the cause so a run that loses colour some other way is diagnosed
 * in one read rather than read as a broken prompt.
 */
const promptCursorCell = (terminal: Term): Cell => {
  const { shifts } = terminal.serialize();
  for (const [key, shift] of shifts.entries()) {
    if (shift.inverse) {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    }
  }
  throw new Error(
    'no reverse-video cell in the terminal: the prompt caret is not being rendered at all — ' +
      'colour is most likely off (NO_COLOR / FORCE_COLOR=0 reaching the app)'
  );
};

/**
 * Block until a keystroke that only moves the caret has actually been processed.
 *
 * Writes to the pty are bytes, not keystrokes, and two written back to back can be delivered in a
 * single read. Ink parses both from the one chunk and dispatches them synchronously, so the second
 * key's handler still closes over the React state from before the first — a character typed
 * straight after a motion is inserted at the caret's OLD offset and the motion's effect is lost.
 * Waiting on the motion's rendered effect makes the separation a fact rather than a bet on
 * scheduling, which is what a loaded runner does not honour.
 *
 * The deadline is a failure bound, not a settling delay: the loop exits as soon as the caret moves,
 * and the bound exists only so a lost keystroke reports what it was waiting for.
 */
const awaitPromptCursorMovedFrom = async (terminal: Term, from: Cell): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    let seen: Cell | undefined;
    try {
      seen = promptCursorCell(terminal);
    } catch {
      seen = undefined;
    }
    if (seen && (seen.x !== from.x || seen.y !== from.y)) return;
    if (Date.now() >= deadline) {
      const where = seen ? `${seen.x},${seen.y}` : 'nowhere';
      throw new Error(
        `prompt caret never moved from ${from.x},${from.y} within 5s — still at ${where}; ` +
          'the motion keypress was not processed'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * The terminal's own rows, with `serialize()`'s framing box stripped — index 0 is screen row 0.
 *
 * Used here only to ask which ROW a piece of text landed on, which is the one question a wrapped
 * line makes interesting and the one no unit render can answer.
 */
const screenRows = (terminal: Term): string[] =>
  terminal
    .serialize()
    .view.split('\n')
    .slice(1, -1)
    .map((line) => line.replace(/^│/, '').replace(/│$/, ''));

/** The screen row `text` appears on. Throws rather than returning -1, so a miss names itself. */
const rowContaining = (terminal: Term, text: string): number => {
  const row = screenRows(terminal).findIndex((line) => line.includes(text));
  if (row === -1) throw new Error(`no screen row contains ${JSON.stringify(text)}`);
  return row;
};

/**
 * A single logical line long enough that the terminal must break it across visual rows.
 *
 * The describes below set `columns` explicitly, so the threshold is known rather than inherited:
 * the prompt spends 4 columns on its `  > ` prefix, leaving 96 for the text at 100 columns. This is
 * 146 characters, so it wraps whatever the word boundaries do with it — and each case below proves
 * the wrap happened rather than assuming it, because a line that quietly stopped wrapping would
 * leave the case passing while testing nothing it was written for.
 */
const LONG_LINE =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike ' +
  'november oscar papa quebec romeo sierra tango uniform victor whiskey';

/**
 * TUI-C25 — editing the message, at a real terminal.
 *
 * The unit suite drives Ink's parser with the bytes it wrote, which is what makes it a statement
 * about the editor. It cannot be a statement about the terminal: how a key is encoded on the wire,
 * and whether the pty delivers it intact, is a terminal-level fact — and ConPTY on Windows parses
 * and re-encodes input rather than passing raw bytes through. So the keys here are sent as the
 * bytes a terminal sends, through a real pty, on every platform of the matrix.
 */
test.describe('gth chat TUI — editing the message at the prompt (greeting fixture)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('greeting.json'),
    columns: 100,
    rows: 30,
  });

  // The node's acceptance case: a trailing backslash carries the message onto a second line, and
  // the whole thing arrives as ONE submission. Both halves need saying — "two lines are visible"
  // is satisfied by a prompt that submitted the first one and is now showing the second.
  test('a trailing backslash continues the message, and both lines send as one', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('line one');
    await expect(terminal.getByText('> line one')).toBeVisible();
    terminal.write('\\');
    await expect(terminal.getByText('> line one\\')).toBeVisible();
    terminal.submit();

    // The continuation row is on screen, aligned under the prompt's text — and no turn ran, which
    // is what says this Enter continued rather than submitted.
    await expect(terminal.getByText('…')).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).toBeVisible();

    terminal.write('line two');
    await expect(terminal.getByText('… line two')).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).toBeVisible();

    terminal.submit();
    // One turn, carrying both lines.
    await expect(terminal.getByText('You › line one')).toBeVisible();
    await expect(terminal.getByText('line two')).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
  });

  // Word motion, in the spelling macOS Terminal.app and Ghostty send for Option+← and a readline
  // user types directly. The typed `X` is the assertion: it lands where the motion left the caret.
  test('Meta+B jumps back a word, and the next character lands there', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('alpha beta');
    await expect(terminal.getByText('> alpha beta')).toBeVisible();

    const before = promptCursorCell(terminal);
    terminal.write('\x1bb'); // Meta+B → the start of `beta`
    await awaitPromptCursorMovedFrom(terminal, before);
    terminal.write('X');

    await expect(terminal.getByText('> alpha Xbeta')).toBeVisible();
    // Unmoved, the character appends; and the chord itself must never be typed as a letter.
    await expect(terminal.getByText('> alpha betaX')).not.toBeVisible();
    await expect(terminal.getByText('> alpha betab')).not.toBeVisible();
  });

  // Line motion, in the spelling every terminal sends the same way (a bare control byte).
  test('Ctrl+A goes to the start of the line, and typing inserts there', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('beta');
    await expect(terminal.getByText('> beta')).toBeVisible();

    const before = promptCursorCell(terminal);
    terminal.write('\x01'); // Ctrl+A → the start of the line
    await awaitPromptCursorMovedFrom(terminal, before);
    terminal.write('alpha ');

    await expect(terminal.getByText('> alpha beta')).toBeVisible();
    await expect(terminal.getByText('> betaalpha')).not.toBeVisible();
  });

  /**
   * Build `first` + `\` + Enter + `second` at the prompt, leaving the caret at the end of the
   * second logical line. The continuation itself is asserted by the first case in this file; here it
   * is the fixture the cross-line cases need.
   */
  const continueOnto = async (terminal: Term, first: string, second: string): Promise<void> => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write(first);
    await expect(terminal.getByText(`> ${first}`)).toBeVisible();
    terminal.write('\\');
    await expect(terminal.getByText(`> ${first}\\`)).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('…')).toBeVisible();
    terminal.write(second);
    await expect(terminal.getByText(`… ${second}`)).toBeVisible();
  };

  // Up/Down over the rows of a real multi-line buffer — the acceptance clause that only exists once
  // there IS a second row on screen. Asserted twice over: the caret changes SCREEN ROW (which is the
  // pty's own statement), and the character typed afterwards lands on the row it moved to.
  test('Up and Down move the caret between the rows of a multi-line message', async ({
    terminal,
  }) => {
    await continueOnto(terminal, 'line one', 'line two');

    const onSecondRow = promptCursorCell(terminal);
    terminal.write('\x1b[A'); // Up
    await awaitPromptCursorMovedFrom(terminal, onSecondRow);
    const onFirstRow = promptCursorCell(terminal);
    // One row up, same column — both lines are the same length, so the sticky column has nothing
    // to clamp and any horizontal drift would be the editor losing the caret rather than moving it.
    expect(onFirstRow.y).toBe(onSecondRow.y - 1);
    expect(onFirstRow.x).toBe(onSecondRow.x);

    terminal.write('X');
    await expect(terminal.getByText('> line oneX')).toBeVisible();
    await expect(terminal.getByText('… line two')).toBeVisible();

    // …and back down. The insert cleared the sticky column, so Down returns to the end of the
    // second line rather than to the column the caret started from.
    const afterInsert = promptCursorCell(terminal);
    terminal.write('\x1b[B'); // Down
    await awaitPromptCursorMovedFrom(terminal, afterInsert);
    expect(promptCursorCell(terminal).y).toBe(afterInsert.y + 1);

    terminal.write('Y');
    await expect(terminal.getByText('… line twoY')).toBeVisible();
    await expect(terminal.getByText('> line oneX')).toBeVisible();
  });

  // Word motion on a multi-line buffer: the caret is on the second row and stays there, landing on
  // the start of that row's last word.
  test('Meta+B jumps back a word on the second row of a multi-line message', async ({
    terminal,
  }) => {
    await continueOnto(terminal, 'alpha beta', 'gamma delta');

    const before = promptCursorCell(terminal);
    terminal.write('\x1bb'); // Meta+B → the start of `delta`
    await awaitPromptCursorMovedFrom(terminal, before);
    expect(promptCursorCell(terminal).y).toBe(before.y);
    terminal.write('X');

    await expect(terminal.getByText('… gamma Xdelta')).toBeVisible();
    await expect(terminal.getByText('… gamma deltaX')).not.toBeVisible();
    // The row above is untouched — the motion stayed inside the line it started on.
    await expect(terminal.getByText('> alpha beta')).toBeVisible();
  });

  // Line motion on a multi-line buffer, and the v1 narrowing that goes with it: Ctrl+A is the start
  // of the caret's OWN logical line, not of the whole message. Only a rendered second row can say
  // which of the two it did.
  test('Ctrl+A goes to the start of the caret own row, not of the whole message', async ({
    terminal,
  }) => {
    await continueOnto(terminal, 'alpha beta', 'gamma delta');

    const before = promptCursorCell(terminal);
    terminal.write('\x01'); // Ctrl+A
    await awaitPromptCursorMovedFrom(terminal, before);
    // Still on the second row: a jump to the buffer start would have moved the caret up one.
    expect(promptCursorCell(terminal).y).toBe(before.y);
    terminal.write('Z');

    await expect(terminal.getByText('… Zgamma delta')).toBeVisible();
    // The reading this case exists to exclude.
    await expect(terminal.getByText('> Zalpha beta')).not.toBeVisible();
    await expect(terminal.getByText('> alpha beta')).toBeVisible();
  });

  // Word motion on a line the TERMINAL has broken across rows. The wrap is the whole point: to the
  // model this is one logical line, and the only place that difference is observable is a pty.
  test('Meta+B jumps back a word on a long wrapped single line', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write(LONG_LINE);
    await expect(terminal.getByText('whiskey')).toBeVisible();
    // The line really is wrapped: its first and last words are on different screen rows.
    expect(rowContaining(terminal, 'whiskey')).toBeGreaterThan(rowContaining(terminal, 'alpha'));

    const before = promptCursorCell(terminal);
    terminal.write('\x1bb'); // Meta+B → the start of `whiskey`
    await awaitPromptCursorMovedFrom(terminal, before);
    terminal.write('X');

    await expect(terminal.getByText('Xwhiskey')).toBeVisible();
    await expect(terminal.getByText('whiskeyX')).not.toBeVisible();
  });

  // Line motion across a wrap, which is the case the narrowing makes load-bearing: Up/Down do
  // nothing on a wrapped line because it is ONE logical line, so Ctrl+A is how a user gets back to
  // its start — and here it demonstrably crosses the visual row boundary to do it.
  test('Ctrl+A crosses the wrap to the start of a long single line', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write(LONG_LINE);
    await expect(terminal.getByText('whiskey')).toBeVisible();
    expect(rowContaining(terminal, 'whiskey')).toBeGreaterThan(rowContaining(terminal, 'alpha'));

    const before = promptCursorCell(terminal);
    terminal.write('\x01'); // Ctrl+A
    await awaitPromptCursorMovedFrom(terminal, before);
    // Up a screen row: the caret was on the wrapped tail and is now on the row the line starts on.
    expect(promptCursorCell(terminal).y).toBeLessThan(before.y);
    terminal.write('Z');

    await expect(terminal.getByText('> Zalpha')).toBeVisible();
    await expect(terminal.getByText('whiskeyZ')).not.toBeVisible();
  });
});
