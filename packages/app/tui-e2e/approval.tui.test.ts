import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';

/**
 * EXT-52 PTY e2e: the per-command shell-approval prompt on the LEAN (default) backend, in a real
 * `gth code --tui` session. Unlike the fixture-agent suites (chat.tui.test.ts), these run the REAL
 * GthAgentRunner → GthLangChainAgent → createAgent graph: GTH_TUI_E2E_FIXTURE is NOT set; instead
 * the config (`fixtures/approval.gsloth.config.mjs`) supplies a scripted tool-calling model, so the
 * run stays hermetic and key-free while the whole approval seam — humanInTheLoopMiddleware
 * interrupt → runner decideToolApproval → TUI <ApprovalPrompt> → resume — is exercised for real.
 *
 * Before EXT-52 the lean backend had no HITL middleware: the command below would have executed
 * with NO prompt (and `/auto-approve` was a placebo). Suspension is asserted by ordering: the
 * command's OUTPUT marker ('approval-out-marker' — deliberately not a substring of the command
 * text) must not appear until the approval is answered.
 */

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const approvalConfig = path.resolve(e2eDir, 'fixtures', 'approval.gsloth.config.mjs');

/**
 * Child env for the REAL-agent session: full process.env with `CI` deleted (Ink keys off the
 * presence of the key), TERM forced, NO GTH_TUI_E2E_FIXTURE (that env var would swap in the canned
 * fixture agent and bypass the runner entirely), and HOME/USERPROFILE pointed at a throwaway dir
 * so the developer's/CI's global `~/.gsloth` config cannot leak into the hermetic session
 * (os.homedir() reads HOME on POSIX and USERPROFILE on Windows — override both).
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

test.describe('gth code TUI — EXT-52 lean shell approval prompt (real agent, scripted model)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-approval-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', approvalConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // Approve once ([o]): the gated command SUSPENDS on the approval prompt (no output yet), then
  // executes after the grant and the turn concludes.
  test('a gated run_shell_command suspends on the approval prompt and runs after [o]nce', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();

    // The approval prompt surfaced with the pending command...
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();
    await expect(terminal.getByText('[o]nce', { strict: false })).toBeVisible();
    // ...and the graph is SUSPENDED: the command has not produced its output marker yet.
    await expect(
      terminal.getByText('approval-out-marker', { full: true, strict: false })
    ).not.toBeVisible();

    // Grant once.
    terminal.write('o');
    await expect(terminal.getByText('Command approved (once)')).toBeVisible();

    // The resumed run executed the command (its OUTPUT marker appears) and concluded.
    await expect(
      terminal.getByText('approval-out-marker', { full: true, strict: false })
    ).toBeVisible();
    await expect(
      terminal.getByText('approval-final-answer-marker', { strict: false })
    ).toBeVisible();
    // The status bar also carries the model segment ('code · model: scripted-e2e · turns: …').
    await expect(terminal.getByText('turns: 1  ·  ready', { strict: false })).toBeVisible();
  });
});

test.describe('gth code TUI — EXT-52 reject keeps the command from running', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-approval-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', approvalConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('rejecting the approval prompt: the command never executes, the agent is told, the turn concludes', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();

    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();

    // Anything but o/s/a/y is a fail-closed reject.
    terminal.write('n');
    await expect(terminal.getByText('Command rejected')).toBeVisible();

    // The model observed the rejection ToolMessage and concluded; the command NEVER ran.
    await expect(
      terminal.getByText('approval-final-answer-marker', { strict: false })
    ).toBeVisible();
    await expect(terminal.getByText('turns: 1  ·  ready', { strict: false })).toBeVisible();
    await expect(
      terminal.getByText('approval-out-marker', { full: true, strict: false })
    ).not.toBeVisible();
  });
});

test.describe('gth code TUI — EXT-52 /auto-approve off restores prompting (regression guard)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-approval-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', approvalConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // The exact live finding EXT-52 fixes: `/auto-approve on|off` used to be a placebo on lean.
  // ON must silence the prompt (command runs immediately); OFF must bring the prompt BACK.
  test('/auto-approve on silences the prompt; /auto-approve off brings it back', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('/auto-approve on');
    await expect(terminal.getByText('> /auto-approve on')).toBeVisible();
    terminal.submit();
    await expect(
      terminal.getByText('Auto-approve ON — shell commands run without asking')
    ).toBeVisible();

    // Turn 1: NO approval prompt — the command executes straight away.
    terminal.write('run it');
    await expect(terminal.getByText('> run it')).toBeVisible();
    terminal.submit();
    await expect(
      terminal.getByText('approval-out-marker', { full: true, strict: false })
    ).toBeVisible();
    await expect(terminal.getByText('turns: 1  ·  ready', { strict: false })).toBeVisible();
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).not.toBeVisible();

    // Flip it back OFF.
    terminal.write('/auto-approve off');
    await expect(terminal.getByText('> /auto-approve off')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Auto-approve OFF — approvals required')).toBeVisible();

    // Turn 2: the per-command prompt is BACK (not a placebo). Reject to finish cleanly.
    terminal.write('run it again');
    await expect(terminal.getByText('> run it again')).toBeVisible();
    terminal.submit();
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();
    terminal.write('n');
    await expect(terminal.getByText('Command rejected')).toBeVisible();
    await expect(terminal.getByText('turns: 2  ·  ready', { strict: false })).toBeVisible();
  });
});
