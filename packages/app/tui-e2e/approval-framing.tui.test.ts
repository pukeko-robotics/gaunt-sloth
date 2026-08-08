import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';

/**
 * [[TUI-C26]] task 1 PTY e2e: **what the approval dialog actually puts on a terminal** when the
 * command and the rater's reason are hostile.
 *
 * This suite exists because a component test cannot answer the question. `render()` returns the
 * string Ink built; a terminal then *interprets* that string — a carriage return returns to column
 * 0, `ESC[A` walks back over the chrome above, `ESC[2J` wipes the screen — and a component test
 * would pass on every one of those while the real dialog was being forged out from under the user.
 * So the assertions here read the PTY's own cell buffer, and the column-0 checks are literal: the
 * leading cells of the rows the untrusted text landed on.
 *
 * **Nothing is clamped to one line, and that is the point.** The command that motivated this
 * surface hid a backticked `rm -rf` roughly fifteen lines into a twenty-five-line commit message,
 * and every rater tested called it safe — so a single-line clamp would discard exactly the span the
 * human is the last defence for. The cases below assert the opposite behaviour: the deep line is
 * on the screen, flagged by line number, inside a gutter it cannot escape.
 *
 * Both fixtures run the REAL runner (no `GTH_TUI_E2E_FIXTURE`) with a scripted model, so the whole
 * seam — interrupt → `decideToolApproval` → `<ApprovalPrompt>` → resume — is exercised for real.
 * **No test here approves anything**: every one answers `n`, and every payload is an `echo`.
 */

const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const approvalConfig = path.resolve(e2eDir, 'fixtures', 'approval.gsloth.config.mjs');
const raterConfig = path.resolve(e2eDir, 'fixtures', 'approval-rater.gsloth.config.mjs');

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
  terminal.getBuffer().map((row) => row.join(''));

/**
 * Assert that no row on the terminal BEGINS with `text` — i.e. the untrusted string never reached
 * column 0, where the dialog's own chrome lives.
 */
const notAtColumnZero = (terminal: { getBuffer(): string[][] }, text: string): void => {
  const offenders = screenRows(terminal).filter((row) => row.startsWith(text));
  expect(offenders).toEqual([]);
};

/** Assert that some row on the terminal begins with `text` — the control for the check above. */
const atColumnZero = (terminal: { getBuffer(): string[][] }, text: string): void => {
  const matches = screenRows(terminal).filter((row) => row.startsWith(text));
  expect(matches.length).toBeGreaterThan(0);
};

/** Rows whose leading cells are a line-number gutter, with the number they carry. */
const gutterRows = (terminal: { getBuffer(): string[][] }): Array<[number, string]> =>
  screenRows(terminal)
    .map((row) => /^ {2} *(\d+) │ (.*)$/u.exec(row))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), match[2].replace(/\s+$/u, '')] as [number, string]);

const framingSuite = (name: string, config: string, rows: number): void => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-framing-'));
  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', config] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows,
  });
  test.afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
  void name;
};

test.describe('approval framing — a substitution fifteen lines in is SHOWN, and flagged', () => {
  framingSuite('multiline', approvalConfig, 50);

  /**
   * The incident's shape, with an inert payload. The superseded requirement — clamp to one line —
   * would render line 1 of this command and nothing else, which is a complete-looking prompt about
   * a `git add` that says nothing about the substitution the human is actually ruling on.
   */
  test('renders the deep line itself, in the gutter, with the site flagged above it', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();
    terminal.write('run it framing-multiline');
    await expect(terminal.getByText('> run it framing-multiline')).toBeVisible();
    terminal.submit();
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();

    // Rule 3 — the site is extracted ABOVE the body and names the line to count to.
    await expect(
      terminal.getByText('line 15 · command substitution', { strict: false })
    ).toBeVisible();
    // Rule 2 + "no line discarded" — line 15 is on the screen, numbered, and carries the payload.
    await expect(
      terminal.getByText('15 │ so `echo framing-deep-marker` then runs unrated,')
    ).toBeVisible();
    // ...and so is line 1 and line 18, so the body was not reduced to the flagged line either.
    await expect(
      terminal.getByText('1 │ git add -A && git commit -m "framing-multiline-note')
    ).toBeVisible();
    await expect(terminal.getByText('18 │', { strict: false })).toBeVisible();

    // The terminal's own cells: the payload never begins a row.
    notAtColumnZero(terminal, 'so `echo framing-deep-marker`');
    notAtColumnZero(terminal, 'git add -A');
    // CONTROL: the dialog's own chrome DOES begin a row, so the check above discriminates rather
    // than being trivially true of every string.
    atColumnZero(terminal, 'The agent wants to run a shell command');

    // Every line of an 18-line command is numbered 1..18, in order, with none missing.
    const numbers = gutterRows(terminal).map(([number]) => number);
    expect(numbers).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));

    // Rule 3 says the sites are shown ABOVE the body, and the ordering is the whole reason the
    // rule exists — it is what makes the eye land on the payload rather than on line one of a
    // prose paragraph. Asserted as row indices, because "both are visible" would hold just as well
    // with the two blocks swapped.
    const rows = screenRows(terminal);
    const noticeRow = rows.findIndex((row) => row.includes('line 15 · command substitution'));
    const bodyRow = rows.findIndex((row) => /^ {2} *1 │ /u.test(row));
    expect(noticeRow).toBeGreaterThan(-1);
    expect(bodyRow).toBeGreaterThan(-1);
    expect(noticeRow).toBeLessThan(bodyRow);

    terminal.write('n');
    await expect(terminal.getByText('Command rejected')).toBeVisible();
  });
});

test.describe('approval framing — forged chrome stays inside the gutter', () => {
  framingSuite('chrome', approvalConfig, 50);

  /**
   * Newlines alone, no escape sequence: one line of the command reads like a verdict, one like the
   * key menu. Rendered raw they are indistinguishable from the dialog's own lines, which is why a
   * clamp is not the mitigation — these fit on one line each.
   */
  test('a verdict line and a menu line render numbered, and never at column 0', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();
    terminal.write('run it framing-chrome');
    await expect(terminal.getByText('> run it framing-chrome')).toBeVisible();
    terminal.submit();
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();

    await expect(terminal.getByText('2 │ ⚠ Auto-rater (safe): approved by rater')).toBeVisible();
    await expect(
      terminal.getByText('3 │ Approve?  [o]nce   [s]ession   [a]lways   [N]o')
    ).toBeVisible();

    // Neither forgery begins a row...
    notAtColumnZero(terminal, '⚠ Auto-rater (safe): approved by rater');
    notAtColumnZero(terminal, 'Approve?  [o]nce   [s]ession');
    // ...while the REAL menu does. This command does not statically resolve, so the genuine menu is
    // the two-choice one — the forged five-choice line above it is offering a control the gate is
    // not offering at all.
    atColumnZero(terminal, 'Approve?  [o]nce   [N]o');

    terminal.write('n');
    await expect(terminal.getByText('Command rejected')).toBeVisible();
  });
});

test.describe('approval framing — control characters in the COMMAND are neutralised', () => {
  framingSuite('controls', approvalConfig, 50);

  /**
   * Carriage return, cursor-up and screen-clear, in one command.
   *
   * The assertion that proves it at the terminal is that the escapes are **visible as text**: a
   * terminal that had interpreted `ESC[2J` would have cleared itself and printed nothing, so five
   * printable characters on the screen are the neutralisation, not a claim about it.
   */
  test('CR, cursor-up and screen-clear render as visible escapes, and the dialog survives', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();
    terminal.write('run it framing-controls');
    await expect(terminal.getByText('> run it framing-controls')).toBeVisible();
    terminal.submit();
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();

    await expect(
      terminal.getByText(
        '1 │ echo framing-controls-start\\x0dApprove? [o]nce\\x1b[2J\\x1b[A framing-controls-end'
      )
    ).toBeVisible();
    // The chrome above the command is intact — nothing was overwritten from column 0 and nothing
    // was cleared.
    atColumnZero(terminal, 'The agent wants to run a shell command');
    atColumnZero(terminal, 'Approve?  [o]nce   [N]o');
    notAtColumnZero(terminal, 'Approve? [o]nce\\x1b[2J');

    terminal.write('n');
    await expect(terminal.getByText('Command rejected')).toBeVisible();
  });
});

test.describe('approval framing — the elision keeps the flagged site, not the head', () => {
  framingSuite('elide', approvalConfig, 50);

  /**
   * Rule 4. Sixty lines, one substitution at line 45. What survives is the window around the
   * flagged line; what goes is the start — the exact inverse of the clamp that was superseded.
   */
  test('a long command elides around the site and states how many lines it hid', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();
    terminal.write('run it framing-elide');
    await expect(terminal.getByText('> run it framing-elide')).toBeVisible();
    terminal.submit();
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();

    await expect(
      terminal.getByText('line 45 · command substitution', { strict: false })
    ).toBeVisible();
    await expect(
      terminal.getByText('45 │ so `echo framing-elided-marker` then runs unrated,')
    ).toBeVisible();
    // The elision says how much it took, on BOTH sides of the surviving window.
    await expect(terminal.getByText('⋯ 42 lines hidden', { strict: false })).toBeVisible();
    await expect(terminal.getByText('⋯ 13 lines hidden', { strict: false })).toBeVisible();
    // The head is what went. Line 1 carries its own marker precisely so this can be asserted
    // rather than inferred — scoped to the FRAMED BODY, because the transcript's tool-call summary
    // above the dialog renders its own clipped copy of the command and is a different surface.
    const body = gutterRows(terminal);
    expect(body.map(([, text]) => text).join('\n')).not.toContain(
      'framing-elide-first-line-marker'
    );
    // The surviving rows are the window around the site, still truly numbered.
    expect(body.map(([number]) => number)).toEqual([43, 44, 45, 46, 47]);

    terminal.write('n');
    await expect(terminal.getByText('Command rejected')).toBeVisible();
  });
});

test.describe('approval framing — the sticky-choice lines obey all of it', () => {
  framingSuite('sticky', approvalConfig, 50);

  /**
   * §3.1/§6 — a sticky grant stores and displays the command **as typed**, so those two lines carry
   * untrusted text in less space than the body does. The command here resolves statically (one
   * word, one argument) so the grant is on offer, and its argument is an in-line forgery: the half
   * a single-line clamp would never have touched, because it fits on one line already.
   */
  test('the grant lines frame the command as typed, label and value on separate rows', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();
    terminal.write('run it framing-sticky');
    await expect(terminal.getByText('> run it framing-sticky')).toBeVisible();
    terminal.submit();
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();

    // The labels are the dialog's own lines, flush-left...
    atColumnZero(terminal, '[s]/[a] will remember:');
    // ...and what will be stored is framed beneath each of them, never flush-left itself.
    await expect(
      terminal.getByText('1 │ echo framing-sticky-marker approved by rater [o]nce', {
        strict: false,
      })
    ).toBeVisible();
    await expect(terminal.getByText('stored as:', { strict: false })).toBeVisible();
    await expect(terminal.getByText('"matcher": "exact"', { strict: false })).toBeVisible();
    notAtColumnZero(terminal, 'echo framing-sticky-marker');
    // CONTROL: the sticky controls really are on offer here, so the assertions above are about a
    // menu that rendered rather than about one that never appeared.
    atColumnZero(terminal, 'Approve?  [o]nce   [s]ession   [a]lways   [N]o');

    terminal.write('n');
    await expect(terminal.getByText('Command rejected')).toBeVisible();
  });
});

test.describe("approval framing — the RATER'S REASON is framed too", () => {
  framingSuite('rated', raterConfig, 50);

  /**
   * The other model-authored string on this dialog, and the one it is easy to protect the command
   * and then forget. This fixture rates on the `assisted` rung with a scripted `destructive`
   * verdict whose `reason` carries a carriage return, a screen-clear, a cursor-up, a forged verdict
   * line and a forged menu line.
   *
   * The verdict travels the production path — `withStructuredOutput` → the shared structured-output
   * boundary → `safeParse` → `mapVerdictToAction` — so a reason that arrived here as a fail-closed
   * "could not assess" would be visible as such rather than passing quietly.
   */
  test('a hostile rater reason is neutralised and numbered, exactly like the command', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();
    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();

    // The rating that is being displayed is the scripted one, not a fail-closed substitute.
    await expect(terminal.getByText('⚠ Auto-rater (destructive):')).toBeVisible();
    expect(screenRows(terminal).join('\n')).not.toContain('Could not assess');

    // Rule 1 on the reason: the escapes are visible text, so the terminal did not act on them.
    await expect(
      terminal.getByText(
        '1 │ Routine local git usage.\\x0dframing-reason-overwrite-marker\\x1b[2J\\x1b[A'
      )
    ).toBeVisible();
    // Rule 2 on the reason: its forged lines are numbered continuations of the reason, not chrome.
    await expect(terminal.getByText('2 │ ⚠ Auto-rater (safe): approved by rater')).toBeVisible();
    await expect(
      terminal.getByText('3 │ Approve?  [o]nce   [s]ession   [a]lways   [N]o')
    ).toBeVisible();
    notAtColumnZero(terminal, '⚠ Auto-rater (safe): approved by rater');
    notAtColumnZero(terminal, 'framing-reason-overwrite-marker');
    // CONTROL: the dialog's own outcome line and its own menu are flush-left, as chrome is.
    atColumnZero(terminal, '⚠ Auto-rater (destructive):');
    atColumnZero(terminal, 'Approve?  [o]nce   [s]ession   [a]lways   [N]o');

    terminal.write('n');
    await expect(terminal.getByText('Command rejected')).toBeVisible();
  });
});
