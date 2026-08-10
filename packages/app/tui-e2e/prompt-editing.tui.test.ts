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
});
