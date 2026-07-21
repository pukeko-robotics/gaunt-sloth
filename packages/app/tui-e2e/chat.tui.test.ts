import fs from 'node:fs';
import os from 'node:os';
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

test.describe('gth chat TUI — debug pane `/` search (search fixture, TUI-C21)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('search.json'),
    columns: 100,
    rows: 30,
  });

  // `/` in a FOCUSED debug pane runs a less-style search over the tab's lines and jumps the
  // viewport to a match that was clipped below the 8-row fold — the real integration jump.
  test('searches the focused pane and scrolls the viewport to a match below the fold', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();
    // Turn completes (the subagent tree is captured for the panel).
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    // Open the debug panel and focus it (Tab). The panel opens on the Subagents tab.
    terminal.write('/debug');
    await expect(terminal.getByText('> /debug')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Subagents')).toBeVisible();
    terminal.write('\t'); // Tab → focus the pane
    await expect(terminal.getByText('Tab: section')).toBeVisible();

    // "line-30" is below the 8-row viewport fold before searching.
    await expect(terminal.getByText('line-30', { full: true })).not.toBeVisible();

    // Open search (`/`) then type "30": the sole match is the body line "line-30".
    terminal.write('/');
    await expect(terminal.getByText('type to search')).toBeVisible();
    terminal.write('3');
    terminal.write('0');

    // The viewport jumped to the match (query echo is only "30"), and the indicator reads 1/1.
    await expect(terminal.getByText('line-30', { full: true })).toBeVisible();
    await expect(terminal.getByText('1/1')).toBeVisible();
  });
});

// Hermetic home dir for the /debug-dump blocks (QA-6): writeDebugDump()'s ensureGlobalGslothDir()
// resolves its archive path via `resolve(homedir(), '.gsloth')`. Node's os.homedir() is
// PLATFORM-SPLIT about which env var it honours — `$HOME` on POSIX, `%USERPROFILE%` on Windows
// (libuv uv_os_homedir) — so redirecting the archive off the real developer/CI home requires
// overriding BOTH. Setting the one that doesn't apply is harmless on each platform. Overriding
// only HOME (the original QA-6 code) left os.homedir() pointing at the real profile on Windows,
// which was TUI-C28's Windows-only failure (printed-path + fs assertions read the wrong dir);
// it stayed masked until the GS2-47 title assertion below was corrected. Each describe gets its
// OWN tmp home so the two blocks can run in parallel and each assert exactly one archive.
const homeEnv = (tmpHome: string): Record<string, string | undefined> => ({
  HOME: tmpHome,
  USERPROFILE: tmpHome,
});

test.describe('gth chat TUI — /debug-dump default: redacted (GS2-46/GS2-47, greeting fixture)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: { ...envFor('greeting.json'), ...homeEnv(tmpHome) },
    // Wide enough that "Archive: <tmpHome>/.gsloth/debug-dumps/<timestamp>" never line-wraps.
    // The archive path is one unbroken token (no spaces) and tui-test's getByText joins buffer
    // rows with no separator, so a mid-token wrap would otherwise split the match across rows.
    columns: 240,
    rows: 30,
  });

  test.afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // GS2-47 flipped `/debug-dump` to REDACT by default. Exercises the real archive-write path (not
  // the fixture's "unavailable" fallback): run one turn so there's a non-empty transcript, then
  // /debug-dump, and assert both the softened redacted notice and the actual files written to disk.
  test('writes a redacted archive by default and prints its path + notice', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    terminal.write('/debug-dump');
    await expect(terminal.getByText('> /debug-dump')).toBeVisible();
    terminal.submit();

    // Notice title for the default (redacted) path (debugDumpNotice, slashCommands.ts).
    await expect(
      terminal.getByText('Debug dump written — secrets redacted', { full: true })
    ).toBeVisible();
    // The softened redacted-body line.
    await expect(
      terminal.getByText(
        'Secrets were redacted (API keys, tokens and auth headers replaced with <redacted>).',
        { full: true }
      )
    ).toBeVisible();
    // The printed archive path sits under the tmp home we set, not the real home directory —
    // proof the HOME/USERPROFILE override actually took effect (cross-platform).
    await expect(terminal.getByText(tmpHome, { full: true })).toBeVisible();

    // Filesystem assertion: prove the write actually happened, not just the UI text.
    const dumpsDir = path.join(tmpHome, '.gsloth', 'debug-dumps');
    const entries = fs.readdirSync(dumpsDir);
    expect(entries.length).toBe(1);
    const archiveDir = path.join(dumpsDir, entries[0]);

    // transcript.json/env.json carry real content from this turn (non-empty).
    for (const file of ['transcript.json', 'env.json']) {
      const contents = fs.readFileSync(path.join(archiveDir, file), 'utf8');
      expect(contents.length).toBeGreaterThan(0);
    }
    // debug-log.txt is written unconditionally, but its ring buffer (debugUtils.ts) is only
    // populated by debugLog() calls inside the real GthAgentRunner/GthAbstractAgent code paths —
    // which this fixture-driven session never runs (createFixtureTuiAgent replays canned events
    // instead of exercising the real agent). So it legitimately exists but is empty here; just
    // assert it was written and is readable text, not that it's non-empty.
    expect(typeof fs.readFileSync(path.join(archiveDir, 'debug-log.txt'), 'utf8')).toBe('string');
    // transcript.json actually reflects this session's turn (`hello` is user text, not a redacted
    // secret value) — not just non-empty boilerplate.
    const transcriptJson = fs.readFileSync(path.join(archiveDir, 'transcript.json'), 'utf8');
    expect(transcriptJson).toContain('hello');
  });
});

test.describe('gth chat TUI — /debug-dump --unsafe-no-redact: loud UNSANITIZED warning (GS2-47)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-home-'));

  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: { ...envFor('greeting.json'), ...homeEnv(tmpHome) },
    columns: 240,
    rows: 30,
  });

  test.afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // The opt-out path a human relies on: `--unsafe-no-redact` writes a RAW archive and MUST surface
  // the loud, impossible-to-miss "may include secrets" warning (debugDumpNotice's warn branch).
  test('writes a raw archive and prints the loud UNSANITIZED warning on --unsafe-no-redact', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    terminal.write('/debug-dump --unsafe-no-redact');
    await expect(terminal.getByText('> /debug-dump --unsafe-no-redact')).toBeVisible();
    terminal.submit();

    // Notice title — stable substring, skipping the leading emoji (debugDumpNotice, slashCommands.ts).
    await expect(
      terminal.getByText('Debug dump written — UNSANITIZED, review before sharing', { full: true })
    ).toBeVisible();
    // The loud sensitive-data warning body.
    await expect(
      terminal.getByText('it may include secrets: API keys, tokens, file contents, env vars.', {
        full: true,
      })
    ).toBeVisible();
    // Archive path under the tmp home — cross-platform override proof.
    await expect(terminal.getByText(tmpHome, { full: true })).toBeVisible();

    // Filesystem assertion: the raw archive was actually written.
    const dumpsDir = path.join(tmpHome, '.gsloth', 'debug-dumps');
    const entries = fs.readdirSync(dumpsDir);
    expect(entries.length).toBe(1);
    const archiveDir = path.join(dumpsDir, entries[0]);
    const transcriptJson = fs.readFileSync(path.join(archiveDir, 'transcript.json'), 'utf8');
    expect(transcriptJson).toContain('hello');
  });
});
