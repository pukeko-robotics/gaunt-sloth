import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import type { Terminal } from '@microsoft/tui-test';
import { removeTmpHome } from './fixtures/tmpHome.mjs';

/**
 * [[TUI-C68]] PTY e2e: **the §6.1 attack banner**, in a real `gth code` session driven by a
 * scripted rater that always answers `attack`.
 *
 * Every requirement in §1 is a PTY requirement, and the node says so for a reason a unit spec
 * cannot argue with: what a keystroke *does* is only observable where the keystroke exists. The
 * suite runs the whole seam for real — `GthAgentRunner` rates the command, halts, calls the banner
 * callback, and the answer goes back through the graph — with `GTH_TUI_E2E_FIXTURE` unset, so
 * nothing here is a fixture agent standing in for the runner.
 *
 * **Suspension is asserted by ordering.** The command's OUTPUT marker (`attack-out-marker`,
 * deliberately not a substring of the command as displayed) must not appear until the phrase is
 * typed — so "the banner blocked the run" is a fact about the screen rather than an inference.
 *
 * **This is the one suite that deliberately grants**, which is why the fixture's command is `echo`
 * and nothing else.
 */

const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const attackConfig = path.resolve(e2eDir, 'fixtures', 'attack.gsloth.config.mjs');
const attackReadlineConfig = path.resolve(e2eDir, 'fixtures', 'attack-readline.gsloth.config.mjs');

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

/** The banner's title row — the one line that says this screen is up at all. */
const BANNER_TITLE = 'RUN HALTED';

/**
 * The banner's buffer **on the Ink surface**, as it reads on screen: `AttackBanner.tsx` paints the
 * label and what has been typed as ONE string, so they share a row.
 *
 * Anchored on the prompt label rather than searching for the typed text loose: a one-letter buffer
 * matches somewhere on almost any screen, so a loose search would be satisfied without the key ever
 * having reached the banner — and it is used as the sync point before Enter is sent, which would
 * then make the commit racy. It is a literal here on purpose: a change to the shared copy must come
 * with a change to the e2e that asserts it.
 *
 * The plain surface lays the same two strings out differently; see {@link expectAnswerBelowLabel}.
 */
const buffer = (typed: string): string => `Your answer: ${typed}`;

/**
 * The terminal's own rows, with `serialize()`'s framing box stripped, so an assertion can be about
 * the COLUMN a string sits in rather than merely about it being somewhere on screen. That is the
 * only way to state the framing guarantee: forged chrome is not absent from the screen — the rater
 * is allowed to write whatever it likes — it is prevented from reaching column 0.
 */
const screenRows = (terminal: Terminal): string[] =>
  terminal
    .serialize()
    .view.split('\n')
    .slice(1, -1)
    .map((line) => line.replace(/^│/, '').replace(/│$/, ''));

/**
 * The answer label, alone on its row, as the plain surface prints it.
 *
 * The shared copy is `'Your answer: '` with a trailing space — the Ink surface concatenates the
 * buffer onto it. `serialize()` does not keep trailing blanks, so the constant is written without
 * one and compared against a `trimEnd()`ed row.
 */
const ANSWER_LABEL = 'Your answer:';

/**
 * Is the typed answer sitting at column 0 of the row directly BELOW the label?
 *
 * **Scanned from the end.** This surface scrolls rather than repainting, so an earlier turn's label
 * is still on the screen; anchoring on the first match lets a stale row satisfy the check while the
 * current one is still empty — the same measured cross-platform race the one-turn-per-test rule
 * below exists for.
 */
const answerIsBelowLabel = (rows: string[], typed: string): boolean => {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trimEnd() !== ANSWER_LABEL) continue;
    return (rows[i + 1] ?? '').startsWith(typed);
  }
  return false;
};

/**
 * Wait until the plain surface shows the answer in the TWO-ROW layout it has: the label alone on
 * one row, the typed text at column 0 of the next.
 *
 * [[EXT-105]] moved every line of the dialog onto one stream, which means this surface prints the
 * label itself and hands readline an empty prompt — so the echo begins at column 0 of the following
 * row instead of continuing the label's. Asserted as ADJACENCY, and as precisely as {@link buffer}
 * asserts the Ink surface's one-row shape: a row that IS the label, and the answer at the start of
 * the row under it. Both halves are load-bearing — `getByText('run anyway')` would be satisfied by
 * the banner's own instruction row telling the human what to type, so a loose search could pass
 * with the keystrokes never having reached the program, and this is the sync point before Enter.
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

test.describe('gth code TUI — [[TUI-C68]] §6.1 the banner appears and says what it must', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-attack-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', attackConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * The banner's content, and that the run is genuinely blocked behind it.
   *
   * Matched a word or a short fragment at a time, never a long phrase: `getByText` searches one
   * rendered line and a pty wraps at the pane width wherever the copy happens to reach it, so a
   * phrase straddling that break fails on layout while the copy is perfectly correct.
   */
  test('halts on the banner, unconditionally irreversible, and nothing has run', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();

    await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();
    // §2 — the irreversibility line, on a halt whose rating said `attack` and nothing else.
    await expect(terminal.getByText('IRREVERSIBLE', { strict: false })).toBeVisible();
    // §2 — the gate's own sentence about what `attack` means, so the verdict survives no colour.
    await expect(terminal.getByText('STRUCTURE', { strict: false })).toBeVisible();
    // §1 — the phrase is named, and the rung called bypass is not offered as the way through.
    await expect(terminal.getByText('and press Enter', { strict: false })).toBeVisible();
    await expect(terminal.getByText('bypass', { strict: false })).not.toBeVisible();
    // §1 — and this surface's own abort keys are advertised, each with the consequence it actually
    // carries: `q`/`Esc` hand the session back, Ctrl+C ends it. Asserted as two short literals the
    // test owns rather than against the exported constant — comparing a rendered line to the very
    // string that produced it passes for any value of it, including the empty one — and short
    // because a long phrase straddling the pane wrap fails on layout while the copy is correct.
    await expect(
      terminal.getByText('q or Esc return to the session', { strict: false })
    ).toBeVisible();
    await expect(terminal.getByText('Ctrl+C exits gth', { strict: false })).toBeVisible();
    // It is NOT the approval dialog: that dialog's own question is nowhere on this screen. (The
    // approval MENU strings are unusable as a negative here — the fixture's rater reason contains a
    // forged copy of them on purpose, which is the next assertion's subject.)
    await expect(
      terminal.getByText('The agent wants to run a shell command', { strict: false })
    ).not.toBeVisible();

    // §2 — the rater's own words are model-authored text, and the fixture's carry a carriage return
    // and a forged approval menu. Both are FRAMED: the CR is on screen as a printable escape rather
    // than having walked the cursor back over the chrome, and — the property that matters — no row
    // of the forgery reaches column 0, where this screen's own lines live.
    await expect(
      terminal.getByText('attack-reason-overwrite-marker', { strict: false })
    ).toBeVisible();
    for (const row of screenRows(terminal)) {
      expect(row.trimEnd()).not.toMatch(/^Approve\?/);
    }

    // ...and the run is suspended: the command has produced nothing.
    await expect(terminal.getByText('attack-out-marker', { strict: false })).not.toBeVisible();
  });
});

test.describe('gth code TUI — [[TUI-C68]] §1 the phrase runs exactly one command', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-attack-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', attackConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * The one way through, and the three "never"s stated where a user could see them broken: the
   * status bar still names the rung the session started on, and the next turn's identical command
   * is halted again — which a session-scoped grant would have made impossible, since the allow-list
   * is consulted before the rater.
   */
  test('typing the phrase runs the command; the same command is halted again next turn', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();

    // Type the phrase — echoed, so the human commits something they can see — then Enter as its own
    // keystroke. A `write` immediately followed by `submit` lets Ink parse the text and the return
    // out of one stdin chunk, and the two would arrive as a single input event.
    terminal.write('run anyway');
    await expect(terminal.getByText(buffer('run anyway'), { strict: false })).toBeVisible();
    terminal.submit();

    // It ran, once, and the notice says what was granted.
    await expect(terminal.getByText('attack-out-marker', { strict: false })).toBeVisible();
    await expect(terminal.getByText('Running a command', { strict: false })).toBeVisible();
    await expect(terminal.getByText('attack-final-answer-marker', { strict: false })).toBeVisible();
    await expect(terminal.getByText('turns: 1', { strict: false })).toBeVisible();

    // §3 — the rung is untouched. `assisted` is what the fixture starts on and what the badge must
    // still say; a grant that had switched the session would read here.
    await expect(terminal.getByText('Assisted', { strict: false })).toBeVisible();

    // §3 — and nothing was remembered: the identical command is rated and halted all over again.
    terminal.write('run it again');
    await expect(terminal.getByText('> run it again')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();
    terminal.submit(); // bare Enter — stop, and end the turn cleanly
    await expect(terminal.getByText('Run halted', { strict: false })).toBeVisible();
  });
});

test.describe('gth code TUI — [[TUI-C68]] §1 everything that is not the phrase stops', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-attack-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', attackConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * **The property this node is about.** An approval prompt grants only on an offered key and
   * treats everything else as a rejection; a text buffer inverts that by accumulating keystrokes.
   * Each case here is a buffer that is not the phrase, committed with Enter, and each must stop the
   * run once — no re-prompt, no second attempt, no execution.
   *
   * `run anyw` is the case that discriminates: a handler matching on a prefix passes the grant test
   * above and dies only here.
   */
  for (const [name, typed] of [
    ['a bare Enter', ''],
    ['a prefix of the phrase', 'run anyw'],
    ['the leading token alone', 'run'],
    ['the phrase with more after it', 'run anyway please'],
    ['the phrase run together', 'RUNANYWAY'],
    ['an approval-menu key', 'a'],
    ['a stray letter', 'b'],
    ['an initial', 'y'],
  ] as const) {
    test(`stops on ${name}`, async ({ terminal }) => {
      await expect(terminal.getByText('ready to code')).toBeVisible();

      terminal.write('run it');
      await expect(terminal.getByText('> run it')).toBeVisible();
      terminal.submit();
      await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();

      if (typed) {
        terminal.write(typed);
        await expect(terminal.getByText(buffer(typed), { strict: false })).toBeVisible();
      }
      terminal.submit();

      // One shot: the run ends with the halt rather than the banner asking again.
      await expect(terminal.getByText('Run halted', { strict: false })).toBeVisible();
      await expect(terminal.getByText(BANNER_TITLE, { strict: false })).not.toBeVisible();
      await expect(terminal.getByText('attack-out-marker', { strict: false })).not.toBeVisible();
    });
  }
});

test.describe('gth code TUI — [[TUI-C68]] §1 aborting from inside a partly typed buffer', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-attack-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', attackConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * Someone who starts typing and thinks better of it must not be trapped. Both keys are pressed
   * with the phrase already half typed — "aborts before entry" is the easy half and not what the
   * requirement is about — and the buffer is confirmed on screen first, so the abort is proven to
   * have happened *from inside* it.
   */
  for (const [name, press] of [
    ['q', (terminal: Terminal) => terminal.write('q')],
    ['Esc', (terminal: Terminal) => terminal.keyEscape()],
  ] as const) {
    test(`${name} aborts with text already typed`, async ({ terminal }) => {
      await expect(terminal.getByText('ready to code')).toBeVisible();

      terminal.write('run it');
      await expect(terminal.getByText('> run it')).toBeVisible();
      terminal.submit();
      await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();

      terminal.write('run any');
      await expect(terminal.getByText(buffer('run any'), { strict: false })).toBeVisible();
      press(terminal);

      await expect(terminal.getByText('Run halted', { strict: false })).toBeVisible();
      await expect(terminal.getByText(BANNER_TITLE, { strict: false })).not.toBeVisible();
      await expect(terminal.getByText('attack-out-marker', { strict: false })).not.toBeVisible();
    });
  }

  /**
   * Ctrl+C is the third abort, and it is a blunter one: it ends the SESSION rather than only the
   * run. That is still an abort in the only sense that matters here — the command does not run —
   * and it is asserted as what actually happens rather than as a graceful in-session stop.
   *
   * TUI-C79 made the key `<App>`'s rather than Ink's, and this is where the promise on the banner's
   * own controls line (`Ctrl+C exits gth`) is measured against a real process. The ladder answers a
   * modal state by leaving, ahead of the banner's branch — which refuses to buffer a chord and
   * returns, so a Ctrl+C arriving there would be a silent no-op, taking away the escape a cornered
   * user reaches for first. This case is what fails if that ever changes.
   */
  test('Ctrl+C aborts with text already typed, by ending the session', async ({ terminal }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();

    terminal.write('run any');
    await expect(terminal.getByText(buffer('run any'), { strict: false })).toBeVisible();
    terminal.write(String.fromCodePoint(0x03));

    expect(await waitForExit(terminal)).not.toBeNull();
    await expect(terminal.getByText('attack-out-marker', { strict: false })).not.toBeVisible();
  });
});

test.describe('gth chat readline — [[TUI-C68]] §5 the banner on the plain surface', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-attack-home-'));

  test.use({
    // No `--tui`: the fixture config turns it off, so this is the readline session.
    program: { file: 'node', args: [cli, 'code', '-c', attackReadlineConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * The other surface, driven the way a person drives it. `rl.question` reads a whole LINE in
   * cooked mode, so there is no keystroke to intercept: a near miss is text that is not the phrase
   * and stops the run like anything else.
   *
   * Each write waits for its own echo before the next is sent. This surface interleaves the halt's
   * message, its own retry question and the next prompt on one scrolling screen, and a write that
   * arrives while the previous one is still being echoed lands split across two prompts.
   *
   * **ONE TURN PER TEST, and that is load-bearing rather than tidiness.** This surface SCROLLS
   * rather than repainting, so a previous turn's banner is still on the screen — and a wait for the
   * banner title is then satisfied by the OLD one, letting the next write land before the new
   * banner exists at all. The write goes to whatever is reading at that moment and the phrase never
   * reaches the buffer. That is measured, not hypothetical: these two turns in one test passed on
   * Linux and failed 3 of 3 retries on BOTH macOS and Windows, and the terminal dump showed the
   * phrase echoed above a banner that had not yet been painted. The Ink surface has no such hazard
   * because it repaints, which is why the two-turn cell above can stay one test — and that cell is
   * also where *"the same command is halted again next turn"* is proven, since the runner re-rates
   * every turn and that is surface-independent.
   *
   * A wait that can be satisfied by an EARLIER turn's output is the same defect class as an
   * assertion that cannot fail: it does not check what it names, and it fails as a race somewhere
   * slower rather than where it was written.
   *
   * Both tests assert the banner is up BEFORE asserting an outcome — otherwise "a near miss stops
   * the run" would pass on a surface where the banner never appeared at all.
   */
  test('shows the banner, stops on a near miss, and offers the retry', async ({ terminal }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();
    await expect(terminal.getByText('IRREVERSIBLE', { strict: false })).toBeVisible();
    await expect(terminal.getByText('Your answer', { strict: false })).toBeVisible();
    await expect(terminal.getByText('attack-out-marker', { strict: false })).not.toBeVisible();

    // A near miss stops the run: the halt lands, and this surface then asks whether to retry.
    terminal.write('run anyw');
    await expectAnswerBelowLabel(terminal, 'run anyw');
    terminal.submit();
    await expect(terminal.getByText('Run halted', { strict: false })).toBeVisible();
    await expect(terminal.getByText('attack-out-marker', { strict: false })).not.toBeVisible();

    // Decline the retry so the session returns to its ordinary prompt.
    await expect(
      terminal.getByText('try again with the same prompt', { strict: false })
    ).toBeVisible();
    terminal.write('n');
    terminal.submit();
    await expect(terminal.getByText('Skipping to next prompt', { strict: false })).toBeVisible();
  });

  test('runs the command when the phrase is typed exactly', async ({ terminal }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText(BANNER_TITLE, { strict: false })).toBeVisible();
    // The answer label, not just the headline — same reason as the sibling test above, which
    // already waits for it: the dialog arrives one `display()` row at a time and a keystroke echoes
    // at wherever the cursor has reached, so typing against the banner title races the rows below
    // it and the echo can land in the middle of them, where it stays.
    await expect(terminal.getByText(ANSWER_LABEL, { strict: false })).toBeVisible();
    await expect(terminal.getByText('attack-out-marker', { strict: false })).not.toBeVisible();

    terminal.write('run anyway');
    await expectAnswerBelowLabel(terminal, 'run anyway');
    terminal.submit();
    await expect(terminal.getByText('attack-out-marker', { strict: false })).toBeVisible();
    // The grant NOTICE, not only the grant's side effect. It is one of the lines [[EXT-105]] moved
    // onto the dialog's stream, and the marker above would still appear if it had been lost — so
    // without this the only PTY proof of the notice is the Ink surface's. Matched as a short
    // fragment because the sentence is long enough for the pty to wrap it.
    await expect(terminal.getByText('Running this ONE command', { strict: false })).toBeVisible();
  });
});
