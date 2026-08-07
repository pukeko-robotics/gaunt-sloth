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

/**
 * Windows has no POSIX signals: `process.kill` there terminates the target outright, so nothing
 * the process would have done on its way out can be observed. The cases gated on this measure the
 * platform's signal delivery rather than our code when run there — the Ctrl+C case below covers
 * the same restore on every platform. Same gating shape, and the same reason, as
 * `mouse.tui.test.ts`.
 */
const SIGNALS_REACH_THE_PROGRAM = os.platform() !== 'win32';

/**
 * The pid of the program tui-test spawned in the pty.
 *
 * The harness spawns the program directly (no shell in between), so this is the `gth` process
 * itself and a signal sent to it is the signal a user's Ctrl+C or `kill` would deliver. The pty
 * handle is private to the harness and there is no public accessor, so this reaches for it and
 * throws rather than degrading quietly if a harness upgrade moves it — a silently-undeliverable
 * signal would leave the tests below passing while proving nothing.
 */
const programPid = (terminal: Terminal): number => {
  const pid = (terminal as unknown as { _pty?: { pid?: number } })._pty?.pid;
  if (typeof pid !== 'number') {
    throw new Error('tui-test no longer exposes the pty pid; the signal tests cannot send one');
  }
  return pid;
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

/**
 * The terminal's own rows, with `serialize()`'s framing box stripped.
 *
 * `serialize().view` wraps the viewport in a box, so row 0 and the last row are border art and each
 * real row arrives as `│<cells>│`. Index 0 of what this returns is screen row 0.
 */
const screenRows = (terminal: Terminal): string[] =>
  terminal
    .serialize()
    .view.split('\n')
    .slice(1, -1)
    .map((line) => line.replace(/^│/, '').replace(/│$/, ''));

/**
 * Wait for the repaint that follows a resize, then return the screen.
 *
 * A resize is asynchronous end to end — SIGWINCH, Ink's relayout, React's re-render — so reading
 * the buffer straight after `terminal.resize()` reads the pre-resize frame. Polling on the row
 * count alone would NOT do: `serialize()` reports the terminal's height whatever the app painted,
 * so a frame left at its old height would satisfy it while sitting several rows short of the floor.
 * The condition polled for is therefore the dock actually reaching the last row — and when it never
 * does, this throws instead of letting the assertions below run against a half-resized screen.
 */
async function screenAfterResize(terminal: Terminal, rows: number): Promise<string[]> {
  const deadline = Date.now() + 15_000;
  let current: string[] = [];
  while (Date.now() < deadline) {
    current = screenRows(terminal);
    if (current.length === rows && /^─+$/.test((current[rows - 1] ?? '').trim())) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `the dock never reached row ${rows - 1} of a ${rows}-row terminal ` +
      `(frame was ${current.length} rows, last row ${JSON.stringify(current[current.length - 1])})`
  );
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

  // (1b) TUI-C33 -> the ASCII-art launch banner paints above the ready message on arrival, and
  // clears once the first exchange is underway (it is an intro, not a permanent fixture). The
  // glyphs are asserted from a real terminal because that is the only place the art's rendering
  // (and its ANSI/width handling) is actually exercised.
  test('paints the ASCII-art launch banner and drops it after the first turn', async ({
    terminal,
  }) => {
    // The face's bottom row (a bare `██████` matches two of its rows, which trips strict mode)
    // and the GAUNT SLOTH wordmark.
    await expect(terminal.getByText('▀██████████▀')).toBeVisible();
    await expect(terminal.getByText('┗┛┗┻┗┻┛┗┗')).toBeVisible();
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    // TUI-C36 — the padding, read off the painted cells: a blank row above and below the block,
    // and one column of left margin on the art. A real terminal is the only place this is
    // observable end-to-end (the Ink component can render a padding row that measures zero-high).
    // `serialize()` frames the viewport in a box, so each row arrives as `│<cells>│`.
    const lines = terminal
      .serialize()
      .view.split('\n')
      .map((line) => line.replace(/^│/, '').replace(/│$/, ''));
    const top = lines.findIndex((line) => line.includes('▄█▀▀▀▀▀▀▀▀█▄'));
    const bottom = lines.findIndex((line) => line.includes('▀██████████▀'));
    expect(top).toBeGreaterThan(0);
    expect(lines[top - 1].trim()).toBe('');
    expect(lines[bottom + 1].trim()).toBe('');
    // Three leading columns: the one-column margin plus the art's own two.
    expect(lines[top].startsWith('   ▄█')).toBe(true);
    expect(lines[bottom].startsWith('   ▀█')).toBe(true);

    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
    await expect(terminal.getByText('┗┛┗┻┗┻┛┗┗')).not.toBeVisible();
  });

  // (2) type a prompt -> the tool-call line and streamed assistant text appear.
  test('streams a tool call and assistant text after a prompt', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    // Type, confirm the echo, then send Enter separately — Ink coalesces a "text\r"
    // single write into one input event, so the return must be its own keystroke.
    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('read_file')).toBeVisible();
    await expect(terminal.getByText('fixture agent')).toBeVisible();
    // After the turn the prompt returns to the ready state, with the turn counter bumped.
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
  });

  // TUI-C48 — Ctrl+T at a real terminal, with a half-written message in the prompt.
  //
  // Both halves of this only exist end to end. `ink-text-input` claims one control chord and TYPES
  // the letter of every other, and how a chord is decoded at all is a terminal-level fact — ConPTY
  // reports keys differently from a POSIX pty, and a unit spec drives a fake stdin with exactly the
  // bytes it wrote, so it cannot observe that difference. This is therefore the only place the
  // "a control chord never reaches the buffer" guarantee is checked on Windows.
  //
  // The toggle is exercised IDLE, which is the state it was refused in until this node: it is now
  // bound in every state, because paging back over the conversation to read an earlier turn's
  // arguments and results is exactly when nothing is running.
  test('Ctrl+T toggles tool detail while idle and never lands in the prompt', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('draft');
    await expect(terminal.getByText('> draft')).toBeVisible();

    terminal.write('\x14'); // Ctrl+T
    await expect(terminal.getByText('Tool details: on')).toBeVisible();
    // The letter did not join the message being written. `draftt` is what an unguarded text input
    // produces, so it is the assertion that states the difference.
    await expect(terminal.getByText('> draftt')).not.toBeVisible();
    await expect(terminal.getByText('> draft')).toBeVisible();

    // The same key folds it back, so this is a toggle rather than a one-way reveal.
    terminal.write('\x14');
    await expect(terminal.getByText('Tool details: off')).toBeVisible();
    await expect(terminal.getByText('> draftt')).not.toBeVisible();

    // …and the buffer is still submittable, unchanged.
    terminal.submit();
    await expect(terminal.getByText('You › draft')).toBeVisible();
  });

  // Ink repaints on SIGWINCH and the frame stays addressable after a reflow, and streaming still
  // works at the new size. TUI-C48 added the half that matters now: the dock has to end up on the
  // NEW bottom row. Ink recalculates its layout on a resize but does not re-render React, so a
  // height captured once at mount survives the reflow and leaves the dock floating N rows above
  // the floor — visible to a user, invisible to any assertion that only checks text.
  test('reflows on terminal resize and keeps the dock on the NEW bottom row', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    expect(screenRows(terminal)).toHaveLength(30);

    terminal.resize(60, 20);
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).toBeVisible();
    // The closing rule reaching row 19 is what `screenAfterResize` polls for and throws on, so it
    // is already proven here and re-asserting it would only add an assertion that cannot fail.
    // What is left to check is where the rest of the dock landed relative to it.
    const shrunk = await screenAfterResize(terminal, 20);
    expect(shrunk[17]).toContain('>');
    expect(shrunk[16]).toContain('chat  ·  turns: 0  ·  ready');

    // Growing back must move the dock down again, not leave it stranded mid-screen.
    terminal.resize(100, 34);
    const grown = await screenAfterResize(terminal, 34);
    expect(grown[30]).toContain('chat  ·  turns: 0  ·  ready');

    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('fixture agent')).toBeVisible();
    // …and streaming at the new size still lands against the dock, not somewhere above it.
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
    const streamed = screenRows(terminal);
    expect(streamed[33].trim()).toMatch(/^─+$/);
    expect(streamed[28]).toContain('Hello from the fixture agent.');
  });

  // TUI-C48 — the node's central claim, asserted at the only level that can prove it. Ink renders
  // inline by default, so "the dock is at the bottom" is a property of the TERMINAL, not of the
  // component tree: only a real pty of a known size can say which row anything landed on.
  test('pins the dock to the terminal floor, with the conversation growing up from it', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    const rows = screenRows(terminal);
    // The frame fills the 30-row terminal this describe configures.
    expect(rows).toHaveLength(30);
    // The dock's closing rule is the LAST row of the screen, and the four dock rows above it are
    // in their fixed order. Inline rendering put every one of these directly under the banner,
    // around row 8 of 30, with 20 blank rows below — which is the bug this node exists to fix.
    expect(rows[29].trim()).toMatch(/^─+$/);
    expect(rows[28]).toContain("Type 'exit'");
    expect(rows[27]).toContain('>');
    expect(rows[26]).toContain('chat  ·  turns: 0  ·  ready');
    expect(rows[25].trim()).toMatch(/^─+$/);
    // Above the dock the conversation region is padded at the TOP: the intro sits against the
    // dock, and the empty screen is above it rather than below.
    expect(rows[24]).toContain('ready to chat');
    expect(rows[0].trim()).toBe('');

    // One exchange later the newest output is still the row immediately above the dock.
    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    const after = screenRows(terminal);
    expect(after).toHaveLength(30);
    expect(after[29].trim()).toMatch(/^─+$/);
    expect(after[26]).toContain('chat  ·  turns: 1  ·  ready');
    expect(after[24]).toContain('Hello from the fixture agent.');
    expect(after[0].trim()).toBe('');
  });

  // TUI-C48 — the alternate screen is entered on launch and the terminal is handed back on exit.
  // Ink owns both halves; this is the assertion that we actually asked for it, taken from outside
  // the process. Without the alternate screen the dock would still be painted on the primary
  // buffer after exit and the text below would still be found.
  test('hands the terminal back on exit, leaving none of the dock behind', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    terminal.write('exit');
    await expect(terminal.getByText('> exit')).toBeVisible();
    terminal.submit();
    const result = await waitForExit(terminal);
    expect(result?.exitCode).toBe(0);

    // The alternate buffer is discarded with everything that was drawn on it.
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).not.toBeVisible();
    await expect(terminal.getByText('Hello from the fixture agent.')).not.toBeVisible();
    await expect(terminal.getByText("Type 'exit'")).not.toBeVisible();
  });

  // TUI-C48 — the exit paths the user does not type.
  //
  // The restore is entirely Ink's, so the risk this guards is not that Ink stops working: it is
  // that OUR code grows an exit path of its own that runs first. A `process.on('SIGINT')` handler
  // anywhere in the session that called `process.exit()` ahead of Ink's own hook would leave the
  // user staring at their shell prompt inside the alternate buffer, with the conversation gone and
  // the screen they started from never coming back. Nothing else in the suite would notice.
  //
  // The assertions are deliberately the same three as the `exit`-command test above, because that
  // shape is known to discriminate: with the alternate screen off, the dock is still painted on the
  // primary buffer after the process is gone and each of them fails.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    test.when(
      SIGNALS_REACH_THE_PROGRAM,
      `hands the terminal back when the session is killed by ${signal}`,
      async ({ terminal }) => {
        await expect(terminal.getByText('ready to chat')).toBeVisible();
        terminal.write('hello');
        await expect(terminal.getByText('> hello')).toBeVisible();
        terminal.submit();
        await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

        process.kill(programPid(terminal), signal);
        expect(await waitForExit(terminal)).not.toBeNull();

        await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).not.toBeVisible();
        await expect(terminal.getByText('Hello from the fixture agent.')).not.toBeVisible();
        await expect(terminal.getByText("Type 'exit'")).not.toBeVisible();
      }
    );
  }

  // Ctrl+C is not a signal here — the terminal is in raw mode, so the byte reaches Ink and Ink
  // unmounts — but it is how most sessions actually end, and it runs on every platform including
  // the one where the signal cases above cannot.
  test('hands the terminal back on Ctrl+C', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    terminal.write('\x03');
    expect(await waitForExit(terminal)).not.toBeNull();

    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).not.toBeVisible();
    await expect(terminal.getByText('Hello from the fixture agent.')).not.toBeVisible();
    await expect(terminal.getByText("Type 'exit'")).not.toBeVisible();
  });

  // (4) `exit` -> the app unmounts and the process terminates cleanly (raw mode restored).
  test('exits cleanly on the exit command', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('fixture agent')).toBeVisible();
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
  // and the tool call shows a collapsed summary line with inline params plus the TUI-C30
  // greyed result preview (the head of the result is now visible WITHOUT expanding).
  test('renders markdown and a collapsed tool-call summary with inline preview', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();

    // Tool-call summary line (collapsed): name + inline shortened params (TUI-C30).
    await expect(terminal.getByText('read_file(path=NOTES.md)')).toBeVisible();
    // Markdown list bullet renders (proves the markdown path ran, not raw "- ").
    await expect(terminal.getByText('first item')).toBeVisible();
    await expect(terminal.getByText('second item')).toBeVisible();
    await expect(terminal.getByText('Summary')).toBeVisible();
    // The turn completed and returned to ready.
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
    // TUI-C30 (deliberate change from the original collapsed-hides-body assertion): the first
    // lines of the result now PREVIEW inline while collapsed. Beyond-cap hiding is asserted by
    // the tool-preview fixture below.
    await expect(terminal.getByText('secret-tool-result-body')).toBeVisible();
    // Fenced code survives the commit-time render: the body is on screen indented, the fence
    // markers are consumed, and the language tag is inlaid in the top rule. The unit spec owns
    // the "body carries no dim/grey SGR" half; this proves the fence path actually paints in a
    // real terminal, on every OS in the matrix.
    await expect(terminal.getByText('  const fenced = 1;')).toBeVisible();
    await expect(terminal.getByText('── js ─')).toBeVisible();
    await expect(terminal.getByText('```')).not.toBeVisible();
  });
});

test.describe('gth chat TUI — live tool output in the managed frame (tool-output fixture, TUI-C17)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('tool-output.json'),
    columns: 100,
    rows: 30,
  });

  // A custom/dev tool's streamed stdout arrives as `tool_output` events and renders INSIDE the
  // tool-call panel (folded into the view-model), not as raw out-of-order stdout above the
  // message. TUI-C30 (deliberate change): collapsed panels now PREVIEW the first output lines
  // inline as greyed text, while the "Executing" notice stays expanded-only chrome; after
  // /verbose (GS2-8 rename of /tools) the next turn additionally shows the routed notice in
  // the managed frame.
  test('folds streamed tool output into the tool panel instead of leaking raw stdout', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    // Turn 1 (collapsed default): summary with inline params + the live-output preview
    // (TUI-C30 — previously the body was hidden until expanded); the notice stays hidden.
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('run_shell_command(command=ls -la)')).toBeVisible();
    await expect(terminal.getByText('Listed the files.')).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();
    await expect(terminal.getByText('live-output-marker-line')).toBeVisible();
    await expect(terminal.getByText('Executing run_shell_command')).not.toBeVisible();

    // Expand tool detail (GS2-8: /verbose, formerly /tools), then run turn 2: the routed
    // notice + child stdout render in-panel.
    terminal.write('/verbose');
    await expect(terminal.getByText('> /verbose')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Tool details: on')).toBeVisible();

    terminal.write('again');
    await expect(terminal.getByText('> again')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Executing run_shell_command: ls -la')).toBeVisible();
    await expect(terminal.getByText('live-output-marker-line')).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 2  ·  ready')).toBeVisible();
  });
});

test.describe('gth chat TUI — TUI-C30 tool preview + diff (tool-preview fixture)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('tool-preview.json'),
    columns: 100,
    rows: 40,
  });

  // The TUI-C30 acceptance surface, end-to-end in a real PTY: a collapsed call shows
  // `name(shortened-params)` + up to the canonical 10 greyed output lines with an overflow
  // marker (beyond-cap lines stay hidden), and an edit_file call renders as an add/remove diff
  // derived from its args instead of a raw args/output dump.
  test('shows inline params, the capped 10-line preview and an edit_file diff', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    // Turn 1: read_file with a 12-line result — preview head + overflow marker, cap enforced.
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('read_file(path=notes/example.txt)')).toBeVisible();
    await expect(terminal.getByText('preview-line-01')).toBeVisible();
    await expect(terminal.getByText('preview-line-10')).toBeVisible();
    await expect(terminal.getByText('(+2 more lines)')).toBeVisible();
    await expect(terminal.getByText('preview-line-12')).not.toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    // Turn 2: edit_file renders the change as a diff (removed then added), params inline
    // (the summary elides the edits payload with a trailing `, …`).
    terminal.write('next');
    await expect(terminal.getByText('> next')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('edit_file(path=src/answer.ts,')).toBeVisible();
    await expect(terminal.getByText('- const answer = 41;')).toBeVisible();
    await expect(terminal.getByText('+ const answer = 42;')).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 2  ·  ready')).toBeVisible();
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
    await expect(terminal.getByText('streaming')).toBeVisible();
    terminal.keyEscape();
    await expect(terminal.getByText('Interrupted')).toBeVisible();
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
    await expect(terminal.getByText('line-30')).not.toBeVisible();

    // Open search (`/`) then type "30": the sole match is the body line "line-30".
    terminal.write('/');
    await expect(terminal.getByText('type to search')).toBeVisible();
    terminal.write('3');
    terminal.write('0');

    // The viewport jumped to the match (query echo is only "30"), and the indicator reads 1/1.
    await expect(terminal.getByText('line-30')).toBeVisible();
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
    await expect(terminal.getByText('Debug dump written — secrets redacted')).toBeVisible();
    // The softened redacted-body line.
    await expect(
      terminal.getByText(
        'Secrets were redacted (API keys, tokens and auth headers replaced with <redacted>).'
      )
    ).toBeVisible();
    // The printed archive path sits under the tmp home we set, not the real home directory —
    // proof the HOME/USERPROFILE override actually took effect (cross-platform).
    await expect(terminal.getByText(tmpHome)).toBeVisible();

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
      terminal.getByText('Debug dump written — UNSANITIZED, review before sharing')
    ).toBeVisible();
    // The loud sensitive-data warning body.
    await expect(
      terminal.getByText('it may include secrets: API keys, tokens, file contents, env vars.')
    ).toBeVisible();
    // Archive path under the tmp home — cross-platform override proof.
    await expect(terminal.getByText(tmpHome)).toBeVisible();

    // Filesystem assertion: the raw archive was actually written.
    const dumpsDir = path.join(tmpHome, '.gsloth', 'debug-dumps');
    const entries = fs.readdirSync(dumpsDir);
    expect(entries.length).toBe(1);
    const archiveDir = path.join(dumpsDir, entries[0]);
    const transcriptJson = fs.readFileSync(path.join(archiveDir, 'transcript.json'), 'utf8');
    expect(transcriptJson).toContain('hello');
  });
});

/**
 * TUI-C48 ↔ CFG-37 — the persistent opt-out, in a real terminal, from the config file to the
 * surface that actually runs.
 *
 * This is the seam neither node covers on its own. CFG-37 made `tui: false` a real per-user and
 * per-project preference and proves it reaches the dispatcher's decision; TUI-C48 is what makes
 * that decision matter, because the surface it declines now takes over the whole screen and takes
 * the conversation with it when it goes. What a user opting out is buying is exactly that: a
 * session that stays in their scrollback. So the assertion is the terminal's, not a mock's — the
 * session's output is still on screen after the process has exited, which cannot be true of a
 * session that ran in the alternate buffer.
 *
 * Both directions are here on purpose, in the same harness and off the same real config loader. A
 * negative on its own ("the dock never appeared") is satisfied by a session that failed to start
 * at all; the control is what shows the harness can see the difference.
 */
function projectWithConfig(config: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-tui-config-'));
  // A `.git` dir stops the up-tree config walk here, so discovery can never escape into the repo
  // this suite runs from.
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.gsloth.config.json'),
    JSON.stringify({ llm: { type: 'openai', model: 'gpt-4o-mini' }, ...config })
  );
  return root;
}

/**
 * The env for a config-driven run: the project dir the config lives in, a home of its own so no
 * real global config can steer the case, and a placeholder key.
 *
 * The key is set rather than inherited, and it is deliberately a dummy: the readline session
 * builds its provider at startup but contacts nothing until a prompt is submitted, and no test
 * here submits one. Inheriting the developer's real key would put it in the process env of a
 * session whose whole point is that it is hermetic.
 */
const configRunEnv = (root: string): Record<string, string | undefined> => ({
  ...envFor('greeting.json'),
  HOME: root,
  USERPROFILE: root,
  INIT_CWD: root,
  OPENAI_API_KEY: 'not-a-real-key-nothing-is-sent',
});

test.describe('gth chat — a config file that turns the TUI off (CFG-37 seam)', () => {
  const root = projectWithConfig({ tui: false });

  test.use({
    // No `--tui` flag: the config file is the only thing deciding which surface starts.
    program: { file: 'node', args: [cli, 'chat'] },
    env: configRunEnv(root),
    columns: 100,
    rows: 30,
  });

  test.afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('runs the readline session and leaves it in the terminal after exit', async ({
    terminal,
  }) => {
    // The run header is the readline surface writing straight to stdout. The TUI never prints it
    // there — it routes those lines into the notice surface inside the frame — so seeing it is
    // what says which surface started.
    await expect(terminal.getByText('Workdir:')).toBeVisible();
    await expect(terminal.getByText('Gaunt Sloth is ready to chat')).toBeVisible();
    // …and the full-screen dock is not on the screen at all.
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).not.toBeVisible();

    terminal.write('exit');
    await expect(terminal.getByText('> exit')).toBeVisible();
    terminal.submit();
    expect(await waitForExit(terminal)).not.toBeNull();

    // The session is still there after the process is gone. A session that had entered the
    // alternate screen would have taken all of this with it — which is precisely what the
    // opt-out exists to avoid, and what the assertion above cannot prove on its own.
    await expect(terminal.getByText('Gaunt Sloth is ready to chat')).toBeVisible();
  });
});

test.describe('gth chat — the same config with the TUI left to its default (CFG-37 seam control)', () => {
  const root = projectWithConfig({});

  test.use({
    program: { file: 'node', args: [cli, 'chat'] },
    env: configRunEnv(root),
    columns: 100,
    rows: 30,
  });

  test.afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('takes the full screen, and hands it back leaving nothing behind', async ({ terminal }) => {
    // Same config, same loader, same launch — only the `tui` key is absent, and the full-screen
    // dock is what starts. The status bar is the discriminator: it exists on this surface only.
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).toBeVisible();

    terminal.write('exit');
    await expect(terminal.getByText('> exit')).toBeVisible();
    terminal.submit();
    expect(await waitForExit(terminal)).not.toBeNull();

    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).not.toBeVisible();
    await expect(terminal.getByText('Gaunt Sloth is ready to chat')).not.toBeVisible();
  });
});

/**
 * TUI-C48 — scrolling the conversation, in a real terminal.
 *
 * The alternate screen has no scrollback of its own, so a line that leaves the top of the region
 * is genuinely gone unless the TUI brings it back. That is exactly the property a unit render
 * cannot check: `renderToString` has no terminal, no key encoding and no viewport. Here the pty is
 * 120x40, the fixture answers with eighty numbered lines, and the assertions name a specific line
 * that must be on screen and a specific line that must not — so the DISTANCE scrolled is asserted,
 * not merely that something moved.
 */
test.describe('gth chat TUI — scrolling the conversation (scroll fixture, TUI-C48)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('scroll.json'),
    columns: 120,
    rows: 40,
  });

  /** Answer one prompt with the fixture's eighty numbered lines and wait for the last of them. */
  async function longAnswer(terminal: Terminal): Promise<void> {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('scroll-line-080')).toBeVisible();
  }

  test('PageUp brings back lines that left the top of the screen, and Ctrl+End returns', async ({
    terminal,
  }) => {
    await longAnswer(terminal);

    // The region is 35 rows of a 40-row terminal, so the answer's tail is what is on screen and
    // line 012 is well above it — thirty-odd rows above, which is what makes the page assertion
    // below a statement about distance.
    await expect(terminal.getByText('scroll-line-012')).not.toBeVisible();

    terminal.write('\x1b[5~');
    // One page is the region less a row of overlap, so line 012 comes into view and the last line
    // of the answer leaves it. Both halves: "line 012 is visible" alone would pass for any scroll
    // far enough, and "line 080 is gone" alone would pass for any scroll at all.
    await expect(terminal.getByText('scroll-line-012')).toBeVisible();
    await expect(terminal.getByText('scroll-line-080')).not.toBeVisible();

    terminal.write('\x1b[1;5F');
    await expect(terminal.getByText('scroll-line-080')).toBeVisible();
    await expect(terminal.getByText('scroll-line-012')).not.toBeVisible();
  });

  test('the wheel scrolls three lines a notch, and Esc returns to the newest output', async ({
    terminal,
  }) => {
    await longAnswer(terminal);
    await expect(terminal.getByText('scroll-line-037')).not.toBeVisible();

    // Three SGR wheel-up reports (button 64) at an arbitrary cell: nine rows, which is exactly
    // enough to bring line 037 in and not enough to have reached line 030. A notch of any other
    // size fails one of the two.
    for (let notch = 0; notch < 3; notch++) terminal.write('\x1b[<64;20;10M');
    await expect(terminal.getByText('scroll-line-037')).toBeVisible();
    await expect(terminal.getByText('scroll-line-030')).not.toBeVisible();

    terminal.write('\x1b');
    await expect(terminal.getByText('scroll-line-080')).toBeVisible();
    await expect(terminal.getByText('scroll-line-037')).not.toBeVisible();
  });
});
