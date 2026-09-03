import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import { removeTmpHome, settleSessionsAfterEach } from './fixtures/tmpHome.mjs';

// [[GS2-20]] — see chat.tui.test.ts: settle each session before the throwaway directories go.
settleSessionsAfterEach(test);

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);
const readlineConfig = fixture('stop-halt-readline.gsloth.config.mjs');

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
