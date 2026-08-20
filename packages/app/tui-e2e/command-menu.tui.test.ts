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

/**
 * TUI-C51 — reaching the slash menu with an unfinished message in the buffer, at a real terminal.
 *
 * **Only the terminal can say this.** How `Ctrl+G` is encoded on the wire is a terminal-level fact,
 * and ConPTY on Windows parses and re-encodes input rather than passing raw bytes through — so the
 * unit suite, which drives Ink's parser with exactly the bytes it wrote, cannot observe the
 * difference. `terminal.write('\x07')` here is a raw pty write, which is what makes these cells a
 * statement about the chord rather than about the handler.
 *
 * **What no PTY harness can prove is EMISSION** — whether a given terminal sends `0x07` when a
 * human presses `Ctrl+G` at all. That is a per-terminal hand-check and lives in the spike's
 * readings table (`_spikes/2026-08-06-ctrl-slash-terminal-emission/readings.md`); nothing below
 * claims it.
 *
 * `Ctrl+/` (`0x1f`) is deliberately NOT written here. It emits nothing whatever on macOS, so a cell
 * written for it would be exercising a byte no user of this platform can produce; the byte's
 * handling — and, more importantly, that it never reaches a text buffer — is asserted through Ink's
 * own decode in `spec/tui/keyGuards.spec.tsx` and `spec/tui/PromptInput.spec.tsx`, both of which
 * run on the Windows cells of the unit matrix.
 *
 * The message is carried on ACROSS the chord one character at a time, waiting for each to be drawn
 * before writing the next, for the reason the Ctrl+T cell states: a burst written as one event
 * arrives as a single input event and lands in one step, testing neither the chord's letter nor the
 * caret. The chord itself is pressed an ODD number of times, because it OPENS rather than toggles
 * and an even count would let a binding that does nothing at all pass (TUI-C58).
 */
test.describe('gth chat TUI — the slash menu over an unfinished message (greeting fixture)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('greeting.json'),
    columns: 100,
    rows: 30,
  });

  const DRAFT = 'please refactor the fo';

  test('Ctrl+G opens the menu over the draft, and the draft is untouched underneath', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write(DRAFT);
    await expect(terminal.getByText(`> ${DRAFT}`)).toBeVisible();
    // Nothing about this buffer can open the menu the typed way: it does not start with `/` and it
    // holds spaces. `❯` is the menu's own cursor, and it is not on screen.
    await expect(terminal.getByText('❯')).not.toBeVisible();

    terminal.write('\x07'); // Ctrl+G
    await expect(terminal.getByText('❯')).toBeVisible();
    await expect(terminal.getByText('/status')).toBeVisible();
    // The chord's letter did not join the message — `draftg` is what an unguarded insert produces.
    await expect(terminal.getByText(`> ${DRAFT}`)).toBeVisible();
    await expect(terminal.getByText(`> ${DRAFT}g`)).not.toBeVisible();

    // Filtering types into the MENU's own query row, which is drawn between the matches and the
    // prompt. The message keeps its own row, unchanged, the whole way.
    const filter = 'stat';
    for (let i = 0; i < filter.length; i++) {
      terminal.write(filter[i]);
      await expect(terminal.getByText(`/ ${filter.slice(0, i + 1)}`)).toBeVisible();
      await expect(terminal.getByText(`> ${DRAFT}`)).toBeVisible();
    }
    await expect(terminal.getByText(`> ${DRAFT}stat`)).not.toBeVisible();

    // Enter runs the highlighted command — and hands the message back.
    terminal.submit();
    await expect(terminal.getByText('Session status')).toBeVisible();
    await expect(terminal.getByText(`> ${DRAFT}`)).toBeVisible();
    await expect(terminal.getByText('❯')).not.toBeVisible();
    // No turn ran: a command was dispatched, not the message.
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).toBeVisible();

    // The editor has the keyboard back, and what is finally sent is what was written.
    const rest = 'rmatter';
    for (let i = 0; i < rest.length; i++) {
      terminal.write(rest[i]);
      await expect(terminal.getByText(`> ${DRAFT}${rest.slice(0, i + 1)}`)).toBeVisible();
    }
    terminal.submit();
    await expect(terminal.getByText(`You › ${DRAFT}rmatter`)).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
  });

  test('Esc closes the menu and leaves the message exactly as it was', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write(DRAFT);
    await expect(terminal.getByText(`> ${DRAFT}`)).toBeVisible();

    terminal.write('\x07'); // Ctrl+G
    await expect(terminal.getByText('❯')).toBeVisible();
    terminal.write('s');
    await expect(terminal.getByText('/ s')).toBeVisible();

    terminal.write('\x1b'); // Esc
    await expect(terminal.getByText('❯')).not.toBeVisible();
    await expect(terminal.getByText(`> ${DRAFT}`)).toBeVisible();
    // The query row went with the menu; nothing of what was typed into it stayed behind.
    await expect(terminal.getByText(`> ${DRAFT}s`)).not.toBeVisible();

    // …and the message is still the live buffer, not a picture of one.
    terminal.write('o');
    await expect(terminal.getByText(`> ${DRAFT}o`)).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText(`You › ${DRAFT}o`)).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
  });
});
