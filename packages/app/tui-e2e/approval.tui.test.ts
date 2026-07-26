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

test.describe('gth code TUI — EXT-52/CFG-27 rung switching restores prompting (regression guard)', () => {
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

  // The exact live finding EXT-52 fixes: the session approval switch used to be a placebo on lean.
  // Switching the rung must silence the prompt; switching back must bring it BACK.
  //
  // CFG-27 re-point: the switch is now `/approvals <rung>`. `/auto-approve` and `/bypass-approve`
  // went with the three-mode vocabulary that named them, so the two halves are `/approvals bypass`
  // (silences) and `/approvals write` (restores). The assertions state what each rung actually
  // does rather than being softened into something that would pass either way.
  test('/approvals bypass silences the prompt; /approvals write brings it back', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('/approvals bypass');
    await expect(terminal.getByText('> /approvals bypass')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Approvals: Bypass')).toBeVisible();
    // The notice must state that the auto-rater is skipped too, not just the prompt...
    await expect(
      terminal.getByText('without asking and without rating', { strict: false })
    ).toBeVisible();
    // ...and it cites only the deny list — §8.1 forbids user-facing copy leaning on the floor.
    await expect(terminal.getByText('deny list', { strict: false })).toBeVisible();
    // The status bar carries the warn-styled rung badge, in §10's display spelling.
    await expect(terminal.getByText('⚡ Bypass', { strict: false })).toBeVisible();

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

    // Flip back to `write`: the rung that gates the shell and consults no model, so every command
    // comes to the human.
    terminal.write('/approvals write');
    await expect(terminal.getByText('> /approvals write')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Approvals: Write')).toBeVisible();

    // Turn 2: the per-command prompt is BACK (not a placebo). Reject to finish cleanly — pressing
    // [a]/always here would write shell-allowlist.json into the tracked fixtures dir.
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
