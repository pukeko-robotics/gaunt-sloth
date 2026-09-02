import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import type { Terminal } from '@microsoft/tui-test';
import {
  FORGED_MENU,
  FORGED_VERDICT,
  STOP_COMMAND,
  STOP_REASON,
} from './fixtures/stopFixtures.mjs';
import { removeTmpHome } from './fixtures/tmpHome.mjs';

/**
 * [[TUI-C71]] PTY e2e: **what a run-ending approvals stop puts on the terminal.**
 *
 * The two stop errors compose their message out of the command the agent proposed and the rater's
 * own words, and that message used to be printed as a plain line — on the Ink TUI as one dim
 * `<Text>`, on the readline surface as one interpolated string. On an `attack` verdict that is the
 * *worst* text in the system by construction: the rater judged the command's own structure to
 * evidence deception or obfuscation, so the string most likely to have been built to forge terminal
 * output was the one string reaching the screen with none of [[TUI-C26]]'s defence around it.
 *
 * **Only a terminal can rule on this, which is why the node insisted on it.** A unit spec can
 * assert what a string contains; it cannot see a carriage return walk the cursor back over the row
 * above, and it cannot see which COLUMN a line landed in. Every assertion below is about the
 * screen.
 *
 * The three cells are the three surfaces a stop can reach: the Ink TUI and the readline session
 * both wire an approval callback, so they see §4.2's halt; `NonInteractiveEscalationError` is
 * thrown exactly where no callback is wired, so `gth exec` is the only way to it.
 *
 * `STOP_COMMAND` and `STOP_REASON` are imported rather than transcribed: the fixture builds every
 * invisible character from an explicit code point, and a copy typed here would be the one thing a
 * test about invisible characters must not rely on.
 */

const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const haltConfig = path.resolve(e2eDir, 'fixtures', 'stop-halt.gsloth.config.mjs');
const haltReadlineConfig = path.resolve(e2eDir, 'fixtures', 'stop-halt-readline.gsloth.config.mjs');
const escalateConfig = path.resolve(e2eDir, 'fixtures', 'stop-escalate.gsloth.config.mjs');

/**
 * Child env for the REAL-agent session: `CI` deleted (Ink keys off the presence of the key), TERM
 * forced, no `GTH_TUI_E2E_FIXTURE` (that would swap in the canned fixture agent and bypass the
 * runner), and HOME/USERPROFILE pointed at a throwaway dir so a global `~/.gsloth` cannot steer a
 * hermetic session (`os.homedir()` reads HOME on POSIX and USERPROFILE on Windows).
 */
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

/**
 * The terminal's own rows, with `serialize()`'s framing box stripped, so an assertion can be about
 * the COLUMN a string sits in rather than merely about it being somewhere on screen. That is the
 * only way to state the framing guarantee: forged chrome is not absent from the screen — the model
 * is allowed to write whatever it likes — it is prevented from reaching column 0.
 */
const screenRows = (terminal: Terminal): string[] =>
  terminal
    .serialize()
    .view.split('\n')
    .slice(1, -1)
    .map((line) => line.replace(/^│/, '').replace(/│$/, ''));

/**
 * The answer label, alone on its row, as the plain surface prints it. The shared copy carries a
 * trailing space (the Ink surface concatenates the buffer onto it) and `serialize()` does not keep
 * trailing blanks, so this is written without one and compared against a `trimEnd()`ed row.
 */
const ANSWER_LABEL = 'Your answer:';

/**
 * Is the typed answer at column 0 of the row directly BELOW the label? Scanned from the end,
 * because this surface scrolls rather than repainting and an earlier turn's label is still on the
 * screen — anchoring on the first match would let a stale row satisfy the check.
 */
const answerIsBelowLabel = (rows: string[], typed: string): boolean => {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trimEnd() !== ANSWER_LABEL) continue;
    return (rows[i + 1] ?? '').startsWith(typed);
  }
  return false;
};

/**
 * Wait until the plain surface shows the answer in its two-row layout.
 *
 * [[EXT-105]] moved every line of the dialog onto one stream, so this surface prints the label
 * itself and hands readline an empty prompt — the echo begins at column 0 of the row below rather
 * than continuing the label's. Asserted as adjacency rather than by searching for the typed text
 * loose: the banner's own instruction row contains the phrase, so a loose search could be satisfied
 * while the keystrokes never reached the program, and this is the sync point before Enter.
 */
async function expectAnswerBelowLabel(
  terminal: Terminal,
  typed: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let rows = screenRows(terminal);
  while (!answerIsBelowLabel(rows, typed)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `the answer never reached its two-row layout within ${timeoutMs}ms.\n` +
          `expected a row equal to ${JSON.stringify(ANSWER_LABEL)}, with ` +
          `${JSON.stringify(typed)} at column 0 of the row below it.\n` +
          `screen:\n${rows.map((row, i) => `  ${i}: ${JSON.stringify(row)}`).join('\n')}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    rows = screenRows(terminal);
  }
}

/**
 * The stop message's own rows: everything from its first sentence downward.
 *
 * **Anchored, and that is load-bearing rather than tidy.** The §6.1 banner renders the same command
 * and the same reason, framed, just before the stop — and on the readline surface it is still on
 * the screen afterwards, because that surface scrolls instead of repainting. An assertion over the
 * whole screen would therefore be satisfiable by the BANNER's framing while the stop message
 * underneath it was still raw, which is exactly the defect this node exists to close. Anchoring on
 * the stop's own first line is what makes each assertion below about the rows this node changed.
 */
const rowsFromStop = (terminal: Terminal, anchor: string): string[] => {
  const rows = screenRows(terminal);
  const index = rows.findIndex((row) => row.includes(anchor));
  // The stop message has to be on the screen for anything below to be ruling on it.
  expect(index).toBeGreaterThan(-1);
  return rows.slice(index);
};

/**
 * The property the whole node is about: the model may write what it likes, and none of it may sit
 * flush-left where this surface's own lines live.
 */
const expectNoForgedChromeAtColumnZero = (rows: string[]): void => {
  for (const row of rows) {
    expect(row.trimEnd()).not.toMatch(/^Approve\?/);
    expect(row.trimEnd()).not.toMatch(/^⚠ Auto-rater/);
  }
};

/**
 * The forgery really is on the screen — so the assertion above is ruling on something rather than
 * passing over an empty set — and every row carrying it is **inside the renderer's gutter**.
 *
 * Asserting the gutter rather than merely a leading space is what makes this test able to fail for
 * the right reason. Neutralisation alone already indents the whole thing under a `Command:` label,
 * so a leading-space check stays green on a message that was never framed; what it would miss is
 * the case the gutter exists for — one neutralised line long enough for the TERMINAL to wrap it,
 * whose continuation starts at column 0 carrying whatever the attacker put at that offset.
 */
const GUTTERED = /^ +(?:\d+ │|┊|⋯|line \d+ ·) /;
const expectForgeryPresentButGuttered = (rows: string[]): void => {
  const forged = rows.filter((row) => row.includes(FORGED_MENU) || row.includes(FORGED_VERDICT));
  expect(forged.filter((row) => row.includes(FORGED_MENU)).length).toBeGreaterThan(0);
  expect(forged.filter((row) => row.includes(FORGED_VERDICT)).length).toBeGreaterThan(0);
  for (const row of forged) {
    expect(row).toMatch(GUTTERED);
  }
};

/**
 * The extracted-site notice, which the composing command in the fixture is what produces.
 *
 * Asserted rather than left to chance because it is the shape most easily lost: `framing.ts` calls
 * the site row **the one place untrusted text renders outside the gutter**, bounded by two clips
 * instead. A fixture whose command did not compose would never render it, so the row the renderer
 * treats as its most delicate would be the one row this suite never looked at. It is admitted by
 * `GUTTERED` above for that reason — it is a legitimate shape, not an escape from the rule.
 */
const expectSiteNoticeRendered = (rows: string[]): void => {
  expect(rows.some((row) => row.includes('the gate could not statically resolve'))).toBe(true);
  const siteRows = rows.filter((row) => /^ +line \d+ · composition/.test(row));
  expect(siteRows.length).toBeGreaterThan(0);
  // Inset like everything else untrusted, and bounded by the terminal it was budgeted against.
  for (const row of siteRows) expect(row.trimEnd().length).toBeLessThanOrEqual(120);
};

/**
 * The escapes, on screen, as the printable text `core/shell/framing` renders them.
 *
 * A carriage return that is still a carriage return does not show up as a wrong character — it
 * shows up as the row above having been overwritten, which no `getByText` can see. Finding the
 * escape is how "it was neutralised" is stated as something a terminal can be asked.
 */
const expectControlsRenderedInert = (rows: string[]): void => {
  const joined = rows.join('\n');
  expect(joined).toContain('\\x0d'); // the carriage return
  expect(joined).toContain('\\x1b[2J'); // the screen-clear
  expect(joined).toContain('\\x1b[A'); // the cursor-up
};

/** The gutter, which is what keeps every one of those rows off column 0. */
const expectGutter = (rows: string[]): void => {
  expect(rows.some((row) => /^\s+\d+ │ /.test(row))).toBe(true);
};

/** The banner's title — the screen the halt is answered from. */
const BANNER_TITLE = 'RUN HALTED';
/** The halt message's own first sentence, and this suite's anchor for it. */
const HALT_ANCHOR = 'Run halted: the auto-rater';
/** The §6.2 message's own first sentence. */
const ESCALATION_ANCHOR = 'Approval required, but this session has no one to ask.';

/**
 * The halt message's LAST part, and what every assertion here waits for before reading the screen.
 *
 * **Waiting on the first row would be a race, not a shortcut.** The readline surface writes one
 * `display()` call per row, so the fifteen framed rows arrive as fifteen separate PTY writes after
 * the sentence that opens the message — and a slice taken on the opening row would be reading a
 * message still in flight. It would pass on a fast Linux runner and fail on a slower cell as
 * "`\x0d` is not on the screen", which reads as a production regression rather than as the wait it
 * is. The parts are printed in order, so the closing part being on screen is the whole of it being
 * on screen.
 */
const HALT_LAST_PART = 'not negotiable';

/**
 * Waits for the process to end. The §6.2 message is the last thing `gth exec` prints before it
 * exits non-zero, so the exit — not a string — is the honest signal that all of it has landed.
 */
async function waitForExit(
  terminal: Terminal,
  timeoutMs = 15_000
): Promise<{ exitCode: number; signal?: number } | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (terminal.exitResult != null) return terminal.exitResult;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

test.describe('gth code TUI — [[TUI-C71]] the halt message is framed in the transcript', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-stop-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', haltConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * A bare Enter is a REFUSAL, and it is the answer the node measured: the user who just declined a
   * command the rater called hostile is the one who was shown a fabricated approval prompt, painted
   * by us, one row under the banner that had been carefully framed.
   */
  test('after a stop, nothing model-authored reaches column 0', async ({ terminal }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();

    terminal.submit(); // bare Enter — refuse, which ends the run and prints the halt
    await expect(terminal.getByText('Run halted', { strict: false })).toBeVisible();
    await expect(terminal.getByText(BANNER_TITLE, { strict: false })).not.toBeVisible();
    // The message's LAST part, so the screen is read once the whole of it has arrived.
    await expect(terminal.getByText(HALT_LAST_PART, { strict: false })).toBeVisible();

    const rows = rowsFromStop(terminal, HALT_ANCHOR);
    expectControlsRenderedInert(rows);
    expectGutter(rows);
    expectForgeryPresentButGuttered(rows);
    expectNoForgedChromeAtColumnZero(rows);
    expectSiteNoticeRendered(rows);
    // The rater's own words are on the screen too, and framed like the command: it is the string
    // easiest to protect the command and then forget.
    expect(rows.join('\n')).toContain('stop-reason-marker');
    // ...and nothing ran.
    await expect(terminal.getByText('stop-command-marker', { strict: false })).toBeVisible();
    expect(rows.join('\n')).not.toContain('stop-command-tail\n');
  });
});

test.describe('gth code readline — [[TUI-C71]] the halt message is framed on the plain surface', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-stop-home-'));

  test.use({
    // No `--tui`: the fixture config turns it off, so this is the readline session.
    program: { file: 'node', args: [cli, 'code', '-c', haltReadlineConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * ONE TURN PER TEST — this surface scrolls rather than repainting, so a wait for a banner can be
   * satisfied by an earlier turn's, and the next write then lands before the new banner exists.
   * (Measured by the [[TUI-C68]] suite: two turns in one test passed on Linux and failed 3 of 3
   * retries on both macOS and Windows.)
   */
  test('after a near miss, nothing model-authored reaches column 0', async ({ terminal }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();
    // **Wait for the LAST row of the dialog, not its headline, before typing.** The banner title is
    // the first of many rows this surface emits one `display()` call at a time, and the echo of a
    // keystroke lands wherever the cursor has got to — so typing against the headline races the
    // rest of the dialog, and on a slow runner the answer is echoed into the middle of the framed
    // rows and can never migrate down to where the assertion below looks for it. The answer label
    // is the last thing printed before the read, and it is emitted from exactly one place in
    // production, so waiting on it cannot be satisfied early.
    await expect(terminal.getByText(ANSWER_LABEL, { strict: false })).toBeVisible();

    // A near miss: not the phrase, so the run stops. `rl.question` reads a whole line here, so
    // there is no keystroke to intercept — this is text that simply is not the phrase.
    terminal.write('run anyw');
    await expectAnswerBelowLabel(terminal, 'run anyw');
    terminal.submit();
    await expect(terminal.getByText('Run halted', { strict: false })).toBeVisible();
    // **This surface writes one row per `display()` call**, so the framed rows arrive as separate
    // PTY writes after the opening sentence. Wait for the message's LAST part before reading the
    // screen, or the slice below is taken mid-flight.
    await expect(terminal.getByText(HALT_LAST_PART, { strict: false })).toBeVisible();

    const rows = rowsFromStop(terminal, HALT_ANCHOR);
    expectControlsRenderedInert(rows);
    expectGutter(rows);
    expectForgeryPresentButGuttered(rows);
    expectNoForgedChromeAtColumnZero(rows);
    expectSiteNoticeRendered(rows);
    expect(rows.join('\n')).toContain('stop-reason-marker');
  });
});

test.describe('gth exec — [[TUI-C71]] §6.2, the message that is all anyone sees', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-stop-home-'));

  test.use({
    program: {
      file: 'node',
      args: [cli, 'exec', '-m', 'run the command', '-c', escalateConfig],
    },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 50,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * The worse of the two sites. This message interpolates the command, the rating, the rater's
   * reason **and the whole §5 negotiation transcript** — and its own docblock says it is the only
   * thing a person sees on this path, which is both why it carries so much untrusted material and
   * why nothing else would catch what it prints.
   *
   * The transcript is asserted explicitly because it is the field the node names as the one most
   * likely to be forgotten: it arrives as a multi-row block whose line structure belongs to the
   * negotiation renderer, so it is the one part that a neutraliser applied naively would either
   * mangle or skip.
   */
  test('renders every untrusted field of a non-interactive escalation inert', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Approval required', { strict: false })).toBeVisible();
    // The message is the last thing this command prints before it exits non-zero, and it arrives
    // as one `displayError` call per row. The EXIT is therefore the honest signal that all of it
    // has landed — a string wait would be satisfied by a message still being written.
    expect(await waitForExit(terminal)).not.toBeNull();

    const rows = rowsFromStop(terminal, ESCALATION_ANCHOR);
    const joined = rows.join('\n');

    // The command, the rating and the rater's reason.
    expect(joined).toContain('stop-command-marker');
    expect(joined).toContain('destructive');
    expect(joined).toContain('stop-reason-marker');
    // The §5 transcript: the agent argued, and both its justification and the rater's answer are
    // on the screen — not just the last attempt.
    expect(joined).toContain('The agent argued with the auto-rater');
    expect(joined).toContain('Round 1');
    expect(joined).toContain('rater answered');
    expect(joined).toContain('stop-justification-marker');
    // ...and none of it can pretend to be ours.
    expectControlsRenderedInert(rows);
    expectGutter(rows);
    expectForgeryPresentButGuttered(rows);
    expectNoForgedChromeAtColumnZero(rows);
    expectSiteNoticeRendered(rows);
    // The fixture really is hostile — a fixture that quietly lost its payload would make every
    // assertion above pass over nothing.
    expect(STOP_COMMAND).toContain(FORGED_MENU);
    expect(STOP_REASON).toContain(FORGED_VERDICT);
  });
});
