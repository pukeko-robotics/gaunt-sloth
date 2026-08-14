import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';

/**
 * [[TUI-C67]] PTY e2e: **a gated call that is not a shell command is announced as what it is.**
 *
 * Every other approval case in this suite drives `run_shell_command`, so all of them would still
 * pass with the prompt hardcoding *the agent wants to run a shell command* — which is precisely the
 * sentence EXT-80 made false for the most common prompt at `manual` and `write`. This file is the
 * case that can tell the difference: the scripted model asks for `write_file` at the `manual` rung,
 * the gate escalates it for the rung's own reason, and the prompt is read off a real terminal.
 *
 * The whole seam is real — no `GTH_TUI_E2E_FIXTURE`, so the actual GthAgentRunner →
 * GthLangChainAgent → createAgent graph runs, with only the model scripted (see
 * `fixtures/approval-tool.gsloth.config.mjs`) so the run stays hermetic and key-free.
 *
 * **The call is always refused**, so the write never executes: this is a test about the question,
 * not about the answer, and refusing leaves nothing behind in the working directory the session
 * ran in.
 */

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const toolConfig = path.resolve(e2eDir, 'fixtures', 'approval-tool.gsloth.config.mjs');
/**
 * Where the refused `write_file` would really have landed — **the session's working directory, not
 * the fixtures directory.**
 *
 * The tool resolves a relative path against `getCurrentWorkDir()`, which is
 * `process.env.INIT_CWD ?? process.cwd()`, and that is also the only entry in the filesystem
 * toolkit's `allowedDirectories`. The project dir (this file's `fixtures/`, since a `-c <path>`
 * config makes its own folder the project) governs config-relative artifacts and has no say here.
 *
 * So the location depends on how the suite was started, and both spellings are covered: under
 * `pnpm run it-tui`, pnpm sets `INIT_CWD` to the invocation dir and it survives both the runner's
 * env pass-through and `realAgentEnv` below, so the file would land at the repo root; started
 * directly with no `INIT_CWD`, it lands in this folder. Asserting against `fixtures/` instead
 * asserts nothing at all — the tool under test cannot reach that path, so the check passes whether
 * or not the refusal was honoured.
 */
const neverWritten = path.resolve(
  process.env.INIT_CWD ?? e2eDir,
  'approval-tool-e2e-never-written.txt'
);

/** Child env for the REAL-agent session — the same shape `approval.tui.test.ts` uses. */
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

test.describe('gth code TUI — [[TUI-C67]] a gated non-shell tool call names the tool', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-approval-tool-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', toolConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('a gated write_file call is announced as the write_file tool, never as a shell command', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('write it');
    await expect(terminal.getByText('> write it')).toBeVisible();
    terminal.submit();

    // The ruled `tool` sentence, verbatim. Deliberately generic — naming the CLASS of action is
    // TUI-C83's node — but it names the right tool, which is what was wrong before.
    await expect(terminal.getByText('The agent wants to use the write_file tool')).toBeVisible();
    await expect(terminal.getByText('[o]nce', { strict: false })).toBeVisible();
    // ...and the regression itself: the words that used to open this prompt are nowhere on it.
    await expect(
      terminal.getByText('The agent wants to run a shell command', { strict: false })
    ).not.toBeVisible();

    // Refuse. The write never runs, and the model observes the rejection and concludes.
    terminal.write('n');
    await expect(
      terminal.getByText('approval-tool-final-answer-marker', { strict: false })
    ).toBeVisible();
    // The refusal was honoured: the file the tool asked to write does not exist. This is the only
    // assertion here that observes the ANSWER rather than the question, and it is pointed at the
    // path the tool would really have used (see `neverWritten`).
    expect(fs.existsSync(neverWritten)).toBe(false);
  });
});
