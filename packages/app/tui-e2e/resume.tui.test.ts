import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import { removeTmpHome, settleSessionsAfterEach } from './fixtures/tmpHome.mjs';
import {
  LOOKUP_PROMPT,
  NOTHING_MARKER,
  RECALL_MARKER,
} from './fixtures/resume-recall.gsloth.config.mjs';

// [[GS2-20]] — see chat.tui.test.ts: settle each session before the throwaway directories go.
settleSessionsAfterEach(test);

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);
const readlineConfig = fixture('stop-halt-readline.gsloth.config.mjs');
const recallConfig = fixture('resume-recall.gsloth.config.mjs');

/** Same construction as chat.tui.test.ts: `CI` deleted, not blanked, so Ink paints a real frame. */
const fixtureEnv = (fixtureName: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
  return env;
};

/**
 * Same construction as approval-stop.tui.test.ts: a REAL session (no fixture agent) with HOME and
 * USERPROFILE pointed at a throwaway dir, so the history store this session opens is its own and
 * the developer's real `~/.gsloth/history.db` is never read or written.
 */
const realSessionEnv = (tmpHome: string): Record<string, string | undefined> => {
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
 * GS2-20 — `/resume` end to end in the real TUI: parse → dispatch → the App's effect → the notice
 * on screen. The fixture agent has no conversation store behind it, so both forms of the command
 * reach the "unavailable" notice, which is the fail-soft path this surface owns; the store-backed
 * paths are asserted in-process against a real store (`AppResume.spec.tsx`,
 * `interactiveSessionModule.resume.spec.ts`) and the refusal sentence is proved on a real session
 * below.
 */
test.describe('gth chat TUI — /resume (greeting fixture, GS2-20)', () => {
  // 80 rows, like the TUI-C63 cell: /help is taller than a 40-row screen and the command list is its
  // first half, which would scroll off before the assertion looked.
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: fixtureEnv('greeting.json'),
    columns: 120,
    rows: 80,
  });

  test('/help lists /resume, and /status says nothing is being recorded here', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('/help');
    await expect(terminal.getByText('> /help')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('/resume — Pick up a saved conversation')).toBeVisible();

    terminal.write('/status');
    await expect(terminal.getByText('> /status')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Conversation: not being recorded')).toBeVisible();
  });

  test('with no store behind the session, /resume and /resume <id> both say so and change nothing', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('/resume');
    await expect(terminal.getByText('> /resume')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Resume unavailable')).toBeVisible();
    await expect(terminal.getByText('Nothing was changed.')).toBeVisible();

    terminal.write('/resume 7');
    await expect(terminal.getByText('> /resume 7')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Resume unavailable', { strict: false })).toBeVisible();
    // Neither became a turn, and neither left the prompt busy.
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).toBeVisible();
  });
});

/**
 * GS2-20 — `--resume <id>` on a REAL session, refused: the id names no conversation in the store
 * this throwaway HOME holds, so the readline session prints the refusal and leaves. This is the
 * whole boot path — config, the checkpointer opening the store, the lookup, the sentence — with
 * nothing swapped in.
 */
test.describe('gth code readline — --resume refused on a real session (GS2-20)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-resume-home-'));

  test.use({
    // No `--tui`: the fixture config turns it off, so this is the readline session.
    program: { file: 'node', args: [cli, 'code', '--resume', '999', '-c', readlineConfig] },
    env: realSessionEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  test('names the unknown id and where to find a real one, and starts no session', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('No conversation #999', { strict: false })).toBeVisible();
    await expect(terminal.getByText('gth history list', { strict: false })).toBeVisible();
    await expect(terminal.getByText('ready to code')).not.toBeVisible();
  });
});

/**
 * GS2-20 — **ruling 1 across two processes, end to end.** The first session is a real `gth code`
 * run whose model calls a real shell tool; it exits, taking its checkpointer with it. The second
 * is a real `--resume` into the conversation the first one recorded, and its model answers out of
 * the graph state it is handed — so the marker only the tool produced appears on the screen
 * because the checkpoint carried the tool RESULT across, which is precisely what a replay of the
 * recorded text could not do (a replay would carry `looked-it-up-marker`, not the value).
 *
 * The first session is seeded with `spawnSync` rather than a second terminal: the PTY harness
 * gives a describe one program, and the point of the seed is only that a real process wrote a real
 * store. It is asserted to have worked, so a broken seed fails as itself rather than as a resume
 * that could not find its conversation.
 */
test.describe('gth code readline — --resume carries the tool result across processes (GS2-20)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-resume-recall-home-'));

  test.use({
    // Conversation #1: the first row in a store that did not exist a moment ago.
    program: { file: 'node', args: [cli, 'code', '--resume', '1', '-c', recallConfig] },
    env: realSessionEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.beforeAll(() => {
    // Session one: one turn, ending at EOF on the pipe. `--nopipe` keeps the CLI from swallowing
    // stdin as a piped prompt, so the readline session reads it as typing.
    const seed = spawnSync('node', [cli, 'code', '--nopipe', '-c', recallConfig], {
      input: `${LOOKUP_PROMPT}\n`,
      encoding: 'utf8',
      cwd: e2eDir,
      env: { ...realSessionEnv(tmpHome) } as NodeJS.ProcessEnv,
    });
    const output = `${seed.stdout ?? ''}${seed.stderr ?? ''}`;
    // The tool ran and the model concluded, so the graph state under the recorded thread holds the
    // tool result. (The seeding process ends on a closed pipe, so its exit code says nothing.)
    if (!output.includes('looked-it-up-marker') || !output.includes(RECALL_MARKER)) {
      throw new Error(`the seeding session did not record a tool result:\n${output}`);
    }
    if (!fs.existsSync(path.join(tmpHome, '.gsloth', 'history.db'))) {
      throw new Error('the seeding session wrote no history store');
    }
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  test('the resumed session answers from the first session tool result, not from the replayed text', async ({
    terminal,
  }) => {
    // The banner names the conversation the second process re-entered, and the recorded turn is
    // replayed — text only, which is why the assertion below is about a value the text lacks.
    await expect(terminal.getByText('Resumed conversation #1', { strict: false })).toBeVisible();
    await expect(
      terminal.getByText('1 turn recorded under gth code', { strict: false })
    ).toBeVisible();
    await expect(terminal.getByText('looked-it-up-marker', { strict: false })).toBeVisible();
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('what was the code');
    await expect(terminal.getByText('> what was the code')).toBeVisible();
    terminal.submit();

    // The model reports the tool result it can see in state. A fresh thread would have answered
    // `recall:NOTHING-IN-STATE`, and the tool is not called again — nothing here can produce this
    // string except the checkpoint the first process left.
    await expect(terminal.getByText(`recall:`, { strict: false })).toBeVisible();
    await expect(terminal.getByText(RECALL_MARKER, { strict: false })).toBeVisible();
    await expect(terminal.getByText(NOTHING_MARKER, { strict: false })).not.toBeVisible();
  });
});
