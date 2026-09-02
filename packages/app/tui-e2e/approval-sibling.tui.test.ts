import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import { removeTmpHome, settleSessionsAfterEach } from './fixtures/tmpHome.mjs';

// [[GS2-20]] Every session below opens a database inside its throwaway HOME, and the harness's
// kill does not wait for the process to die. Settle each session before any afterAll removes the
// directory it was writing into. File-scoped: one call covers every describe in this file.
settleSessionsAfterEach(test);

/**
 * [[TUI-C100]] PTY e2e: **a call held at the approval gate must not render as done.**
 *
 * Read off a real terminal, because that is where the claim is made. A row saying `✓ … [done]` one
 * line above `Approve? [o]nce …` invites two readings and both are harmful — approve carelessly
 * because it evidently already happened, or deny and believe the damage is already done — and it is
 * the one thing this screen must never get wrong.
 *
 * The round is two calls in one assistant message, and what that shape actually establishes is
 * **measured here rather than assumed**: the HITL middleware suspends the whole round before any of
 * its calls is dispatched, so the granted `list_directory` has not run either while the prompt is
 * open. Both rows are therefore unfinished at that moment, and neither may claim otherwise — which
 * makes this the stronger case, not a weaker one: a build that ended calls per round would tick
 * two rows here, and a build that ended nothing would leave both stuck, which the approval case
 * below is what catches.
 *
 * The whole seam is real: no `GTH_TUI_E2E_FIXTURE`, so the actual GthAgentRunner →
 * GthLangChainAgent → createAgent graph runs, with only the model scripted
 * (`fixtures/approval-sibling.gsloth.config.mjs`) so the run stays hermetic and key-free.
 *
 * **The command is always refused**, so nothing is executed; its output marker is asserted absent
 * throughout, which is the independent check that the row's claim and the world agree.
 */

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const siblingConfig = path.resolve(e2eDir, 'fixtures', 'approval-sibling.gsloth.config.mjs');

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

/** The terminal's own cell rows, as strings. This is the screen, not the string Ink emitted. */
const screenRows = (terminal: { getBuffer(): string[][] }): string[] =>
  terminal.getBuffer().map((row) => row.join(''));

/**
 * The tool-panel rows for one call — matched on `name(`, which the call line always has and the
 * approval dialog's prose ("… via run_shell_command") never does, so the dialog cannot be mistaken
 * for the row it is asking about.
 */
const toolRowsFor = (terminal: { getBuffer(): string[][] }, name: string): string[] =>
  screenRows(terminal).filter((row) => row.includes(`${name}(`));

/** Screen row index of the first line containing `needle`, or -1. Top of the terminal is 0. */
const rowIndexOf = (terminal: { getBuffer(): string[][] }, needle: string): number =>
  screenRows(terminal).findIndex((row) => row.includes(needle));

test.describe('gth code TUI — [[TUI-C100]] a gated call with a returning sibling', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-approval-sibling-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', siblingConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  test('does not claim the gated call is done while the prompt is open, and shows its real outcome after', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('list and run');
    await expect(terminal.getByText('> list and run')).toBeVisible();
    terminal.submit();

    // The prompt is open, so a human is being asked about the shell call right now.
    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();
    await expect(terminal.getByText('[o]nce', { strict: false })).toBeVisible();

    // The gated call claims nothing: neither the tick nor the word, anywhere on its row.
    const shellRows = toolRowsFor(terminal, 'run_shell_command');
    expect(shellRows.length).toBeGreaterThan(0);
    expect(shellRows.filter((row) => row.includes('[done]'))).toEqual([]);
    expect(shellRows.filter((row) => row.includes('✓'))).toEqual([]);
    // And it is drawn as what it is: not finished.
    expect(shellRows.filter((row) => row.includes('[running]')).length).toBeGreaterThan(0);

    // **Nor does its sibling**, and that is measured rather than assumed: the HITL middleware
    // suspends the WHOLE round before any of its calls is dispatched, so the granted listing has
    // not run either at this moment — its row carries no output and must not carry a tick.
    const readRows = toolRowsFor(terminal, 'list_directory');
    expect(readRows.length).toBeGreaterThan(0);
    expect(readRows.filter((row) => row.includes('[done]'))).toEqual([]);
    expect(readRows.filter((row) => row.includes('[running]')).length).toBeGreaterThan(0);

    // The world agrees with the row: the command has not executed.
    await expect(
      terminal.getByText('approval-sibling-out-marker', { strict: false })
    ).not.toBeVisible();

    // Refuse it. The refused call is already distinct today (✗ / error, with the refusal text), and
    // that must stay true — the fix is about the window BEFORE a result, not about the result.
    terminal.write('n');
    await expect(terminal.getByText('rejected by you', { strict: false })).toBeVisible();
    await expect(
      terminal.getByText('approval-sibling-final-answer-marker', { strict: false })
    ).toBeVisible();

    const settledShellRows = toolRowsFor(terminal, 'run_shell_command');
    expect(settledShellRows.filter((row) => row.includes('[error]')).length).toBeGreaterThan(0);
    expect(settledShellRows.filter((row) => row.includes('[done]'))).toEqual([]);
    await expect(
      terminal.getByText('approval-sibling-out-marker', { strict: false })
    ).not.toBeVisible();

    // **And the sibling the refusal took down with it.** Rejecting any call in a round makes the
    // HITL middleware jump straight back to the model, so the tool node is skipped entirely and the
    // granted listing is never dispatched either — it produces no output and no result. A row that
    // ticks it *done* tells the human a directory was read because they refused a clone, which is
    // the same false claim the refused row is no longer allowed to make.
    const settledReadRows = toolRowsFor(terminal, 'list_directory');
    expect(settledReadRows.length).toBeGreaterThan(0);
    expect(settledReadRows.filter((row) => row.includes('[done]'))).toEqual([]);
    expect(settledReadRows.filter((row) => row.includes('✓'))).toEqual([]);
  });
});

test.describe('gth code TUI — [[TUI-C100]] the approved gated call still reaches done', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-approval-sibling-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', siblingConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * The other half of the same claim, and the one an over-eager fix breaks: a call that is never
   * ended is as wrong as one ended too early, it just fails quietly — the row would sit at
   * *running* for the rest of the session with the command's output printed underneath it.
   *
   * This is also where the word `done` is proved to still be reachable at all, since at the moment
   * the prompt is open no row on the screen is entitled to it.
   */
  test('after [o]nce the gated call executes and its row settles on done', async ({ terminal }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('list and run');
    await expect(terminal.getByText('> list and run')).toBeVisible();
    terminal.submit();

    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();

    terminal.write('o');
    await expect(terminal.getByText('Command approved (once)')).toBeVisible();
    await expect(
      terminal.getByText('approval-sibling-out-marker', { strict: false })
    ).toBeVisible();
    await expect(
      terminal.getByText('approval-sibling-final-answer-marker', { strict: false })
    ).toBeVisible();

    const shellRows = toolRowsFor(terminal, 'run_shell_command');
    expect(shellRows.filter((row) => row.includes('[done]')).length).toBeGreaterThan(0);
    // And the granted sibling, which the same resume dispatched, settles too.
    const readRows = toolRowsFor(terminal, 'list_directory');
    expect(readRows.filter((row) => row.includes('[done]')).length).toBeGreaterThan(0);
  });
});

test.describe('gth code TUI — [[TUI-C99]] a mid-turn gate reads in the order it happened', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-approval-sibling-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'code', '--tui', '-c', siblingConfig] },
    env: realAgentEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  /**
   * Read off the real terminal, because placement is the whole claim and a unit render cannot see
   * the frame the human is looking at.
   *
   * The round already did work before the question — the listing is on screen — so a request drawn
   * above it says the question preceded work that in fact preceded the question. Afterwards the
   * command runs, and the row order has to survive that too: its output belongs under the decision
   * about it, not above.
   */
  test('the request sits below the work that preceded it, and the outcome sits on the call', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('list and run');
    await expect(terminal.getByText('> list and run')).toBeVisible();
    terminal.submit();

    await expect(
      terminal.getByText('The agent wants to run a shell command via run_shell_command')
    ).toBeVisible();
    await expect(terminal.getByText('[o]nce', { strict: false })).toBeVisible();

    // While the question is open the request block is BELOW both rows of the turn it interrupted.
    const listingRow = rowIndexOf(terminal, 'list_directory(');
    const gatedRow = rowIndexOf(terminal, 'run_shell_command(');
    const requestRow = rowIndexOf(terminal, 'Gaunt Sloth is asking about this call');
    expect(listingRow).toBeGreaterThanOrEqual(0);
    expect(gatedRow).toBeGreaterThan(listingRow);
    expect(requestRow).toBeGreaterThan(gatedRow);

    terminal.write('o');
    await expect(
      terminal.getByText('approval-sibling-final-answer-marker', { strict: false })
    ).toBeVisible();
    await expect(
      terminal.getByText('approval-sibling-out-marker', { strict: false })
    ).toBeVisible();

    // The decision is one line on the gated call's own row, under it — and the command's own
    // output, produced after the answer, is under that rather than over it.
    const settledGatedRow = rowIndexOf(terminal, 'run_shell_command(');
    const outcomeRow = rowIndexOf(terminal, 'approved by you');
    const outputRow = rowIndexOf(terminal, 'approval-sibling-out-marker');
    const answerRow = rowIndexOf(terminal, 'approval-sibling-final-answer-marker');
    expect(settledGatedRow).toBeGreaterThanOrEqual(0);
    expect(outcomeRow).toBeGreaterThan(settledGatedRow);
    expect(outputRow).toBeGreaterThan(outcomeRow);
    expect(answerRow).toBeGreaterThan(outcomeRow);

    // And the request block no longer stands in the conversation: what is left is the one line,
    // with the detail behind Ctrl+T.
    await expect(
      terminal.getByText('Gaunt Sloth is asking about this call', { strict: false })
    ).not.toBeVisible();
    await expect(terminal.getByText('Ctrl+T for the request', { strict: false })).toBeVisible();
  });
});
