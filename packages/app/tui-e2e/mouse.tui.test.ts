import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

/** See `chat.tui.test.ts` for why `CI` is deleted rather than blanked. */
const envFor = (
  fixtureName: string,
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
  return { ...env, ...extra };
};

/** An SGR mouse report, exactly as a terminal emits one. Coordinates are 1-based on the wire. */
const mouseReport = (button: number, column: number, row: number, final: 'M' | 'm' = 'M') =>
  `\x1b[<${button};${column};${row}${final}`;

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

  test('a report split across two writes is still not typed into the prompt', async ({
    terminal,
  }) => {
    // The chunk-boundary case, end to end: the halves must not surface as text.
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('\x1b[<0;12');
    terminal.write(';8M');
    terminal.write('split');

    await expect(terminal.getByText('> split')).toBeVisible();
    const view = terminal.serialize().view;
    expect(view).not.toContain('0;12');
    expect(view).not.toContain('[<');
  });

  test('a report split right after the CSI introducer is still not typed', async ({ terminal }) => {
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
  });

  test('an ordinary escape sequence is not mangled into the prompt', async ({ terminal }) => {
    // The filter holds back a trailing `ESC[` so a split report can be reassembled. An arrow key
    // shares that prefix and is NOT a mouse report, so it must still reach Ink intact: the cursor
    // moves and nothing like `[D` shows up as text. One arrow, sent on its own — Ink coalesces
    // keystrokes written together into a single input event and drops the rest.
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('abc');
    await expect(terminal.getByText('> abc')).toBeVisible();
    terminal.keyLeft();
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
