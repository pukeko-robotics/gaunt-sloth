import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';

/**
 * Windows ConPTY parses and re-encodes input escape sequences rather than passing raw bytes to the
 * application, so a test cannot hand it half a mouse report and have the other half arrive: the
 * incomplete first write is swallowed and the remainder is delivered as literal text. That makes
 * the two split-simulation tests below a measurement of the harness rather than of our code on this
 * platform, so they run only where the PTY is byte-transparent.
 *
 * The behaviour they cover is NOT untested on Windows — the chunk-boundary cases are asserted
 * deterministically in `spec/tui/mouseStdin.spec.ts`, which runs on both Windows cells of the unit
 * matrix. Only the terminal-level restatement is conditional. Every other test in this file,
 * including whole reports, drags, wheel and the `/mouse` command, runs everywhere.
 */
const PTY_PASSES_RAW_BYTES = os.platform() !== 'win32';

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

/**
 * See `chat.tui.test.ts` for why `CI` is deleted rather than blanked.
 *
 * The colour variables are dropped for the same reason `TERM` is pinned: the terminal environment
 * the app sees has to be the harness's, not whatever shell launched the run. They matter here
 * because the prompt's cursor is drawn as reverse video, so an inherited `NO_COLOR` would clamp
 * `chalk.level` to 0 and erase it. Deleted rather than blanked — an empty string is a value the
 * colour ladder would honour.
 */
const envFor = (
  fixtureName: string,
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
  return { ...env, ...extra };
};

/** An SGR mouse report, exactly as a terminal emits one. Coordinates are 1-based on the wire. */
const mouseReport = (button: number, column: number, row: number, final: 'M' | 'm' = 'M') =>
  `\x1b[<${button};${column};${row}${final}`;

/** The harness terminal, derived from the public `test` signature so no deep import is needed. */
type Term = Parameters<Parameters<typeof test>[1]>[0]['terminal'];

/** A buffer cell, in the coordinates `serialize().shifts` keys use. */
type Cell = { x: number; y: number };

/**
 * Where the prompt's own text cursor is.
 *
 * `ink-text-input` draws no real terminal cursor — it renders the character under the cursor in
 * reverse video instead (an empty cell past the end of the value when the cursor is at the end), so
 * `terminal.getCursor()` reports the position Ink left the hardware cursor in and does NOT move when
 * the prompt cursor does. The reverse-video run is therefore the only observable of the prompt's
 * cursor, and `serialize()` exposes it: `shifts` records attribute transitions between adjacent
 * cells, so the first cell whose entry turns `inverse` on is where the cursor is drawn.
 *
 * This is the one place in the suite that needs colour to be ON, because reverse video is an
 * attribute: `applyTuiColour` clamps `chalk.level` to 0 when the ladder says no colour, which turns
 * `chalk.inverse` into the identity function and erases the cursor entirely. `envFor` keeps the
 * colour variables away from the app for that reason, and the throw below names the cause so that a
 * run which loses colour some other way is diagnosed in one read rather than read as a broken prompt.
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
    'no reverse-video cell in the terminal: the prompt cursor is not being rendered at all — ' +
      'colour is most likely off (NO_COLOR / FORCE_COLOR=0 reaching the app), or the cursor was ' +
      'walked left past the start of the prompt, which leaves ink-text-input at offset -1 and ' +
      'renders no cursor at all (its guard tests the pre-move offset, not the next one)'
  );
};

/**
 * Block until the prompt cursor has actually moved one cell left, i.e. until the app has processed
 * a left-arrow keypress.
 *
 * Writes to the pty are not keystrokes; they are bytes, and two written back to back can be
 * delivered to the app in a single read. Ink then parses both from the one chunk and dispatches them
 * synchronously, so the second key's handler still closes over the React state from before the first
 * — a character typed straight after an arrow is inserted at the cursor's OLD offset and the arrow's
 * effect is lost. Waiting on the arrow's rendered effect makes the separation a fact rather than a
 * bet on scheduling, which is what a loaded runner does not honour.
 *
 * The deadline is a failure bound, not a settling delay: the loop exits as soon as the cursor moves
 * (measured in milliseconds), and the bound exists only so a lost arrow reports what it was waiting
 * for instead of dying in the next matcher's timeout.
 */
const awaitPromptCursorMovedLeftFrom = async (terminal: Term, from: Cell): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    let seen: Cell | undefined;
    try {
      seen = promptCursorCell(terminal);
    } catch {
      seen = undefined;
    }
    if (seen && seen.y === from.y && seen.x === from.x - 1) return;
    if (Date.now() >= deadline) {
      const where = seen ? `${seen.x},${seen.y}` : 'nowhere';
      throw new Error(
        `prompt cursor never moved left of ${from.x},${from.y} within 5s — still at ${where}; ` +
          `the left-arrow keypress was not processed`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * TUI-C37 — mouse input at the terminal level.
 *
 * The unit suite proves the tokenizer and the hit-region math. What only a real PTY can prove is
 * the thing a user would actually hit: that mouse bytes arriving on stdin do not end up typed into
 * the prompt. Ink treats anything it receives as keystrokes, so without the stdin filter a click
 * writes `<0;20;10M` into whatever the user was composing.
 */
test.describe('gth chat TUI — mouse input (greeting fixture)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('greeting.json'),
    columns: 100,
    rows: 30,
  });

  test('a click never leaks escape bytes into the prompt', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    // A full press/release pair, the way a terminal sends a real click.
    terminal.write(mouseReport(0, 20, 10));
    terminal.write(mouseReport(0, 20, 10, 'm'));
    // Then type: if the reports had leaked into the buffer, this text would be preceded by them.
    terminal.write('hello');

    await expect(terminal.getByText('> hello')).toBeVisible();
    const view = terminal.serialize().view;
    expect(view).not.toContain('0;20;10');
    expect(view).not.toContain('[<');
  });

  test('a drag does not corrupt the prompt either', async ({ terminal }) => {
    // Dragging to select text is the single most common thing a user does with the mouse in a
    // terminal, so it is the most likely way for a parser gap to become visible.
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write(mouseReport(0, 5, 5));
    terminal.write(mouseReport(32, 6, 5));
    terminal.write(mouseReport(32, 7, 5));
    terminal.write(mouseReport(0, 8, 5, 'm'));
    terminal.write('typed');

    await expect(terminal.getByText('> typed')).toBeVisible();
    expect(terminal.serialize().view).not.toContain('[<');
  });

  test('a wheel scroll does not corrupt the prompt', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write(mouseReport(64, 10, 10));
    terminal.write(mouseReport(65, 10, 10));
    terminal.write('wheel');

    await expect(terminal.getByText('> wheel')).toBeVisible();
    expect(terminal.serialize().view).not.toContain('[<');
  });

  test.when(
    PTY_PASSES_RAW_BYTES,
    'a report split across two writes is still not typed into the prompt',
    async ({ terminal }) => {
      // The chunk-boundary case, end to end: the halves must not surface as text.
      await expect(terminal.getByText('ready to chat')).toBeVisible();

      terminal.write('\x1b[<0;12');
      terminal.write(';8M');
      terminal.write('split');

      await expect(terminal.getByText('> split')).toBeVisible();
      const view = terminal.serialize().view;
      expect(view).not.toContain('0;12');
      expect(view).not.toContain('[<');
    }
  );

  test.when(
    PTY_PASSES_RAW_BYTES,
    'a report split right after the CSI introducer is still not typed',
    async ({ terminal }) => {
      // The nastier boundary: the split falls between `ESC[` and `<`, so the second half no longer
      // looks like a report at all and would be inserted into the prompt verbatim.
      await expect(terminal.getByText('ready to chat')).toBeVisible();

      terminal.write('\x1b[');
      terminal.write('<0;14;9M');
      terminal.write('csi');

      await expect(terminal.getByText('> csi')).toBeVisible();
      const view = terminal.serialize().view;
      expect(view).not.toContain('0;14');
      expect(view).not.toContain('<0;');
    }
  );

  test('an ordinary escape sequence is not mangled into the prompt', async ({ terminal }) => {
    // The filter holds back a trailing `ESC[` so a split report can be reassembled. An arrow key
    // shares that prefix and is NOT a mouse report, so it must still reach Ink intact: the cursor
    // moves and nothing like `[D` shows up as text. The arrow must be delivered on its own, so the
    // `d` is only written once the arrow's effect is on screen (see the helper for why).
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('abc');
    await expect(terminal.getByText('> abc')).toBeVisible();
    const cursorBeforeArrow = promptCursorCell(terminal);
    terminal.keyLeft();
    await awaitPromptCursorMovedLeftFrom(terminal, cursorBeforeArrow);
    terminal.write('d');

    await expect(terminal.getByText('> abdc')).toBeVisible();
    expect(terminal.serialize().view).not.toContain('[D');
  });

  test('typing and Enter still work normally with mouse on', async ({ terminal }) => {
    // The keyboard model must be untouched — mouse is additive or it is a regression.
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();

    await expect(terminal.getByText('fixture agent', { full: true })).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
  });

  test('/mouse off reports the state and keeps the session usable', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('/mouse off');
    await expect(terminal.getByText('> /mouse off')).toBeVisible();
    terminal.submit();

    await expect(terminal.getByText('Mouse off')).toBeVisible();
    terminal.write('after');
    await expect(terminal.getByText('> after')).toBeVisible();
  });

  test('/mouse on names the selection escape hatch', async ({ terminal }) => {
    // Mouse is on by default, so the copy a user needs is the one explaining how to select text.
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('/mouse on');
    await expect(terminal.getByText('> /mouse on')).toBeVisible();
    terminal.submit();

    await expect(terminal.getByText('Mouse on')).toBeVisible();
    await expect(terminal.getByText('hold Shift')).toBeVisible();
  });
});

test.describe('gth chat TUI — mouse disabled by GTH_NO_MOUSE', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('greeting.json', { GTH_NO_MOUSE: '1' }),
    columns: 100,
    rows: 30,
  });

  test('starts cleanly and reports mouse off, with the escape hatch needing no config file', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('/mouse');
    await expect(terminal.getByText('> /mouse')).toBeVisible();
    terminal.submit();

    // With reporting never enabled the session starts in the off state, so a bare toggle turns it
    // ON — which is the observable proof that GTH_NO_MOUSE was honoured at startup.
    await expect(terminal.getByText('Mouse on')).toBeVisible();
  });
});
