import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import type { Terminal } from '@microsoft/tui-test';

const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

/** See `chat.tui.test.ts` for why `CI` is deleted rather than blanked. */
const envFor = (fixtureName: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
  return env;
};

/**
 * Row 3 of the resting face. Every one of the four animations replaces this line, so its
 * disappearance is the single assertion that means "some animation is playing" without the test
 * having to know which one the random pick chose.
 */
const RESTING_ROW_3 = '▀▄▀▀ ██████ ▀▀▄▀';
/** Row 1 of the resting face — used to find the block on screen. */
const RESTING_ROW_1 = '▄█▀▀▀▀▀▀▀▀█▄';

/** The rows of the viewport, unwrapped from `serialize()`'s box border. */
const viewRows = (terminal: Terminal): string[] =>
  terminal
    .serialize()
    .view.split('\n')
    .map((line) => line.replace(/^│/, '').replace(/│$/, ''));

/**
 * TUI-C40 — clicking the launch banner plays an animation.
 *
 * The frames, the sequences and the click routing each have their own unit specs. What only a real
 * terminal proves is the whole path: a genuine SGR mouse report, written to a pty by something that
 * is not our code, reaches a hit region measured against a live Ink frame and changes what is
 * painted. It also doubles as the end-to-end proof that the TUI-C37 layer works at all.
 */
test.describe('gth chat TUI — clickable launch banner (greeting fixture)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('greeting.json'),
    columns: 100,
    rows: 30,
  });

  test('a click on the banner changes the art', async ({ terminal }) => {
    await expect(terminal.getByText(RESTING_ROW_3)).toBeVisible();

    // Find the block on screen and click its middle row. Coordinates on the wire are 1-based.
    const rows = viewRows(terminal);
    const top = rows.findIndex((line) => line.includes(RESTING_ROW_1));
    expect(top).toBeGreaterThan(-1);
    const clickRow = top + 3; // 0-based screen row of the face's third art line
    terminal.write(`\x1b[<0;6;${clickRow + 1}M`);
    terminal.write(`\x1b[<0;6;${clickRow + 1}m`);

    // Whichever of the four was picked, the resting line is gone while it plays.
    await expect(terminal.getByText(RESTING_ROW_3)).not.toBeVisible();
  });

  test('the art settles back to the resting face on its own', async ({ terminal }) => {
    await expect(terminal.getByText(RESTING_ROW_3)).toBeVisible();

    const rows = viewRows(terminal);
    const clickRow = rows.findIndex((line) => line.includes(RESTING_ROW_1)) + 3;
    terminal.write(`\x1b[<0;6;${clickRow + 1}M`);
    terminal.write(`\x1b[<0;6;${clickRow + 1}m`);

    await expect(terminal.getByText(RESTING_ROW_3)).not.toBeVisible();
    // No animation loops: every one ends on the resting face and stays there.
    await expect(terminal.getByText(RESTING_ROW_3)).toBeVisible();
  });

  test('a plain launch never animates on its own', async ({ terminal }) => {
    // The constraint that protects every non-interactive run: nothing is on a timer, so the banner
    // that paints at launch is the banner that stays until something is clicked.
    await expect(terminal.getByText(RESTING_ROW_3)).toBeVisible();
    const first = viewRows(terminal).find((line) => line.includes(RESTING_ROW_3));

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(viewRows(terminal).find((line) => line.includes(RESTING_ROW_3))).toBe(first);
  });

  test('a click away from the banner leaves the art alone', async ({ terminal }) => {
    await expect(terminal.getByText(RESTING_ROW_3)).toBeVisible();

    // The status bar, well below the banner.
    const rows = viewRows(terminal);
    const statusRow = rows.findIndex((line) => line.includes('turns: 0'));
    expect(statusRow).toBeGreaterThan(-1);
    terminal.write(`\x1b[<0;6;${statusRow + 1}M`);
    terminal.write(`\x1b[<0;6;${statusRow + 1}m`);

    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(terminal.getByText(RESTING_ROW_3)).toBeVisible();
  });

  test('typing still works after clicking the banner', async ({ terminal }) => {
    await expect(terminal.getByText(RESTING_ROW_3)).toBeVisible();

    const rows = viewRows(terminal);
    const clickRow = rows.findIndex((line) => line.includes(RESTING_ROW_1)) + 3;
    terminal.write(`\x1b[<0;6;${clickRow + 1}M`);
    terminal.write(`\x1b[<0;6;${clickRow + 1}m`);
    terminal.write('hello');

    await expect(terminal.getByText('> hello')).toBeVisible();
  });
});
