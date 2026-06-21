import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import type { Terminal } from '@microsoft/tui-test';

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

/**
 * Build the child env. Program mode does NOT merge process.env, so we spread it in full.
 * Crucially we *delete* `CI` rather than blanking it: Ink's CI detection keys off the
 * presence of the `CI` key (not its value), so `CI=""` would force Ink's non-interactive
 * renderer and the frame would never paint. `--tui` then forces the TUI past any other gate.
 */
const envFor = (fixtureName: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
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

test.describe('gth chat TUI — greeting fixture', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('greeting.json'),
    columns: 100,
    rows: 30,
  });

  // (1) launch -> a real Ink frame paints (banner, prompt, status bar all visible).
  test('launches and paints the ready frame', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).toBeVisible();
    await expect(terminal.getByText('>')).toBeVisible();
  });

  // (2) type a prompt -> the tool-call line and streamed assistant text appear.
  test('streams a tool call and assistant text after a prompt', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    // Type, confirm the echo, then send Enter separately — Ink coalesces a "text\r"
    // single write into one input event, so the return must be its own keystroke.
    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('read_file', { full: true })).toBeVisible();
    await expect(terminal.getByText('fixture agent', { full: true })).toBeVisible();
    // After the turn the prompt returns to the ready state, with the turn counter bumped.
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
  });

  // Spike check: Ink repaints on SIGWINCH and the frame stays addressable after a reflow,
  // and streaming still works at the new size.
  test('reflows on terminal resize and keeps streaming', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.resize(60, 20);
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).toBeVisible();
    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('fixture agent', { full: true })).toBeVisible();
  });

  // (4) `exit` -> the app unmounts and the process terminates cleanly (raw mode restored).
  test('exits cleanly on the exit command', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('fixture agent', { full: true })).toBeVisible();
    terminal.write('exit');
    await expect(terminal.getByText('> exit')).toBeVisible();
    terminal.submit();
    const result = await waitForExit(terminal);
    expect(result).not.toBeNull();
    expect(result?.exitCode).toBe(0);
  });
});

test.describe('gth chat TUI — markdown + collapsible tool calls (markdown fixture)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('markdown.json'),
    columns: 100,
    rows: 30,
  });

  // Assistant markdown is rendered as terminal formatting once the turn completes: the
  // heading text and list bullets appear (the bullet glyph proves markdown was applied),
  // and the tool call shows as a collapsed summary line with its result body hidden.
  test('renders markdown and a collapsed tool-call summary', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();

    // Tool-call summary line (collapsed): name + status, but NOT the result body.
    await expect(terminal.getByText('read_file', { full: true })).toBeVisible();
    // Markdown list bullet renders (proves the markdown path ran, not raw "- ").
    await expect(terminal.getByText('first item', { full: true })).toBeVisible();
    await expect(terminal.getByText('second item', { full: true })).toBeVisible();
    await expect(terminal.getByText('Summary', { full: true })).toBeVisible();
    // The turn completed and returned to ready.
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
    // The collapsed tool call hides its result body in the readable transcript.
    await expect(terminal.getByText('secret-tool-result-body')).not.toBeVisible();
  });
});

test.describe('gth chat TUI — slow fixture (interrupt)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('slow.json'),
    columns: 100,
    rows: 30,
  });

  // (3) Esc mid-stream -> the run aborts and the interrupt is surfaced in the transcript.
  test('Esc interrupts an in-flight turn', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();
    // The status bar shows the running spinner + interrupt hint while streaming.
    await expect(terminal.getByText('Thinking')).toBeVisible();
    await expect(terminal.getByText('streaming', { full: true })).toBeVisible();
    terminal.keyEscape();
    await expect(terminal.getByText('Interrupted', { full: true })).toBeVisible();
    // ...and the app recovers to the ready prompt rather than crashing.
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
  });
});
