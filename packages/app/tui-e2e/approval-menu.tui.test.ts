import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import { SHELL_ALLOWLIST_FILE, SHELL_DENYLIST_FILE } from '@gaunt-sloth/core/constants.js';

/**
 * [[TUI-C26]] task 2 PTY e2e: **the escalation menu, and how severe the escalation looks, on a real
 * terminal.**
 *
 * A component test can say what string Ink built. Only this can say what a human is looking at:
 * which rows are flush-left where the dialog's own chrome lives, which controls are on the menu
 * line, and whether two different verdicts actually produce two different screens. The node says
 * repeatedly that these requirements are proven on the PTY harness rather than by reading, and the
 * reason is exactly that.
 *
 * The fixture runs the REAL runner (no `GTH_TUI_E2E_FIXTURE`) on the **`auto`** rung with a scripted
 * rater, so the negotiation, the §4.2 grant clamp and the rating all happen for real.
 *
 * **No test here approves anything.** The only sticky answer any of them gives is `[d]`, and since
 * [[EXT-107]] that one WRITES: a refused call is saved to the project's deny file, which for this
 * run is the tracked fixtures dir. So the suite removes both project files around itself.
 *
 * **Cleaning up before as well as after is the half that matters**, and a persisted refusal is why.
 * A run killed mid-suite leaves the file behind, and the entry it holds refuses the very command the
 * next run's first case is about — so the case fails at the escalation that never comes, reading
 * exactly like a broken dialog rather than like a leaked fixture.
 */

const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const menuConfig = path.resolve(e2eDir, 'fixtures', 'approval-menu.gsloth.config.mjs');

const realAgentEnv = (tmpHome: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  delete env.GTH_TUI_E2E_FIXTURE;
  env.TERM = 'xterm-256color';
  env.HOME = tmpHome;
  env.USERPROFILE = tmpHome;
  return env;
};

/** The terminal's own cell rows, as strings. This is the screen, not the string Ink emitted. */
const screenRows = (terminal: { getBuffer(): string[][] }): string[] =>
  terminal.getBuffer().map((row) => row.join('').replace(/\s+$/u, ''));

/** Assert that some row on the terminal BEGINS with `text` — where the dialog's own chrome lives. */
const atColumnZero = (terminal: { getBuffer(): string[][] }, text: string): void => {
  expect(screenRows(terminal).filter((row) => row.startsWith(text)).length).toBeGreaterThan(0);
};

/** Assert that no row on the terminal begins with `text`. */
const notAtColumnZero = (terminal: { getBuffer(): string[][] }, text: string): void => {
  expect(screenRows(terminal).filter((row) => row.startsWith(text))).toEqual([]);
};

/** The menu line the dialog actually offered, or undefined. */
const menuLine = (terminal: { getBuffer(): string[][] }): string | undefined =>
  screenRows(terminal).find((row) => row.startsWith('Approve?'));

/**
 * The project files a sticky answer writes, named by the CONSTANTS the product resolves them
 * through rather than by a copy of the strings — a renamed constant has to move this too, and a
 * cleanup that silently stopped matching would look exactly like no cleanup at all.
 */
const projectStoreFiles = [SHELL_DENYLIST_FILE, SHELL_ALLOWLIST_FILE].map((file) =>
  path.resolve(e2eDir, 'fixtures', file)
);

const clearProjectStores = (): void => {
  for (const file of projectStoreFiles) fs.rmSync(file, { force: true });
};

const menuSuite = (config: string): void => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-menu-'));
  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', config] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 50,
  });
  test.beforeAll(clearProjectStores);
  test.afterAll(() => {
    clearProjectStores();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });
};

test.describe('approval menu — a negotiated destructive escalation', () => {
  menuSuite(menuConfig);

  /**
   * §3 — **every round renders, not just the last.** The node's whole argument for showing the
   * negotiation is that *the agent proposed the same command three times unchanged* is the most
   * important thing on the screen; a screen showing the final attempt asks the human to rule on a
   * command when the decision they have is about an argument.
   *
   * §5.4's two voices are asserted structurally here rather than by colour: `getBuffer()` returns
   * cells, not styles, so the PTY can prove WHICH rows are on screen and in what order, and the
   * component test proves which colour each one carries.
   */
  test('shows all three rounds in order, both voices, and the full menu with [d]eny always', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();
    terminal.write('run it menu-negotiate');
    await expect(terminal.getByText('> run it menu-negotiate')).toBeVisible();
    terminal.submit();

    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();
    // The exchange reached its terminus and the human is being shown all of it.
    await expect(
      terminal.getByText('argued with the auto-rater 3 times', { strict: false })
    ).toBeVisible();
    const rows = screenRows(terminal);
    const at = (text: string): number => rows.findIndex((row) => row.includes(text));
    for (const round of [1, 2, 3]) {
      expect(at(`Round ${round}`)).toBeGreaterThan(-1);
    }
    // In order — "all three appear" would hold just as well for a jumble.
    expect(at('Round 1')).toBeLessThan(at('Round 2'));
    expect(at('Round 2')).toBeLessThan(at('Round 3'));
    // [[TUI-C75]] — **the labels over those rounds, on a real terminal.** Round 3 IS the rating
    // being escalated (`recordRejection` appends before either bound is tested), so it is named as
    // the pending request rather than printed as a third prior attempt; round 1 was rated with the
    // transcript empty, which §5.1 makes a command-only rating, so the justification under it is
    // marked as one the rater was never shown and its answer says what it answered. Round 2 is the
    // plain shape and is what stops the markers being read as decoration on every row.
    expect(at('Round 1: echo menu-negotiate-marker')).toBeGreaterThan(-1);
    expect(at('Round 2: echo menu-negotiate-marker')).toBeGreaterThan(-1);
    expect(at('Round 3 (this request): echo menu-negotiate-marker')).toBeGreaterThan(-1);
    expect(
      at('agent justified (not shown to the rater): menu-justification-marker round 1')
    ).toBeGreaterThan(-1);
    for (const round of [2, 3]) {
      expect(at(`agent justified: menu-justification-marker round ${round}`)).toBeGreaterThan(-1);
    }
    // Both voices are on the screen, and the rater's answer is its own row rather than folded into
    // the agent's.
    expect(
      rows.filter((row) => /rater answered(?: \([^)]*\))?: destructive/u.test(row)).length
    ).toBe(3);
    expect(rows.filter((row) => row.includes('rater answered (on the command alone)')).length).toBe(
      1
    );

    // §2 — the severity is said in WORDS, and they are the destructive ones.
    atColumnZero(terminal, '⚠ Auto-rater (destructive):');
    await expect(
      terminal.getByText('undoing it is possible from inside this session', {
        strict: false,
      })
    ).toBeVisible();
    // ...and not the catastrophic ones, so this screen could not be mistaken for the other.
    expect(rows.join('\n')).not.toContain('OUTSIDE this session');

    // §1 — the whole menu, in one row, exactly as a human reads it.
    expect(menuLine(terminal)).toBe(
      'Approve?  [o]nce   [s]ession   [a]lways   [N]o   [d]eny always'
    );
    // §6 — and it says what the refusal would record, framed inside the gutter like everything else
    // model-authored, with the label as the dialog's own flush-left line.
    atColumnZero(terminal, '[d] will refuse this exact call, and save it to this project:');
    await expect(
      terminal.getByText('1 │ echo menu-negotiate-marker', { strict: false })
    ).toBeVisible();
    atColumnZero(terminal, '    recorded as:');
    notAtColumnZero(terminal, 'echo menu-negotiate-marker');

    // [[EXT-107]] — answering it says exactly what happened, which is now a project file, and names
    // the way back out of it. A saved refusal the user cannot find is the one failure mode
    // persisting it introduces, so the control that lifts it is named where the refusal is made.
    terminal.write('d');
    await expect(terminal.getByText('Command refused and saved')).toBeVisible();
    await expect(terminal.getByText('saved to this project', { strict: false })).toBeVisible();
    await expect(terminal.getByText('/approvals undeny', { strict: false })).toBeVisible();
    // The command never ran: the marker it would have printed is not on the screen.
    //
    // [[EXT-137]] — asserted on COLUMN ZERO rather than on the marker being absent outright. The
    // request block is committed to the conversation and stays there after the answer, so the
    // command is still quoted on the screen — inside the gutter, indented, as the record of what
    // was asked. What the command's own OUTPUT would look like is the bare marker beginning a row,
    // and nothing in the record can produce that.
    notAtColumnZero(terminal, 'menu-negotiate-marker');
  });
});

test.describe('approval menu — a catastrophic escalation', () => {
  menuSuite(menuConfig);

  /**
   * §1.3 — the reduced menu. §4.2 withdraws `always approve` and the session-scoped approve for a
   * `catastrophic` outcome, and says nothing about refusals — so `[d]eny always` stays, which is the
   * whole point of the reduction: the human keeps a way to say *never this*, and loses only the ways
   * to say *always this*.
   *
   * The command here RESOLVES statically, so the grant is withdrawn by the verdict rather than by
   * the command's shape. Without that, the reduced menu would prove nothing this file does not
   * already have a case for.
   */
  test('withdraws every sticky approve, keeps [d]eny always, and says what catastrophic means', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();
    terminal.write('run it menu-catastrophic');
    await expect(terminal.getByText('> run it menu-catastrophic')).toBeVisible();
    terminal.submit();

    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();

    // §2.1 — a different glyph and a different SENTENCE, so a reader with no colour is still told.
    atColumnZero(terminal, '⛔ Auto-rater (catastrophic):');
    await expect(terminal.getByText('OUTSIDE this session', { strict: false })).toBeVisible();
    const rows = screenRows(terminal);
    expect(rows.join('\n')).not.toContain('undoing it is possible from inside this session');
    // The reason is still the RATER's, said so and framed.
    atColumnZero(terminal, "    the rater's own words:");
    await expect(
      terminal.getByText('1 │ this cannot be undone from inside the session', { strict: false })
    ).toBeVisible();

    // §1.3 — the reduced menu, as one row.
    expect(menuLine(terminal)).toBe('Approve?  [o]nce   [N]o   [d]eny always');
    // The withdrawn controls are ABSENT, not disabled — and so is the line describing what they
    // would have stored.
    await expect(terminal.getByText('[s]ession', { strict: false })).not.toBeVisible();
    await expect(terminal.getByText('will remember', { strict: false })).not.toBeVisible();
    // ...while the refusal is offered and named.
    atColumnZero(terminal, '[d] will refuse this exact call, and save it to this project:');

    // A catastrophic verdict is escalated with no rounds at all (§4.2), so nothing draws a heading
    // over an argument that never happened.
    expect(rows.join('\n')).not.toContain('argued with the auto-rater');

    terminal.write('n');
    await expect(terminal.getByText('rejected by you', { strict: false })).toBeVisible();
  });
});
