import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import stripAnsi from 'strip-ansi';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

/**
 * TUI-C92 — the registry the frame is built with: twenty-five synthetic commands carrying long
 * descriptions, ahead of the real ones. Synthetic so the arithmetic below is a function of a
 * number this file owns rather than of how many commands the registry happens to hold on the day;
 * long so that, let wrap, several of them would take two rows at 100 columns and three at 80 —
 * the shape that made a cap on entries no bound on rows. The real registry follows so `/debug`
 * still opens the panel in the cell that needs it.
 *
 * Hoisted, because the mock factory runs before this module's body does.
 */
const { SYNTHETIC_COUNT, REAL_COUNT_HOLDER } = vi.hoisted(() => ({
  SYNTHETIC_COUNT: 25,
  REAL_COUNT_HOLDER: { count: 0 },
}));

vi.mock('@gaunt-sloth/agent/modules/slashCommands.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@gaunt-sloth/agent/modules/slashCommands.js')>();
  const long =
    'takes the whole of the argument after it and hands it to the agent as the focus of the ' +
    'summary it writes, keeping the last few messages word for word';
  const synthetic = Array.from({ length: SYNTHETIC_COUNT }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return {
      name: `cmd-${n}`,
      description: `${long} (${n})`,
      run: () => ({ notice: { title: `ran cmd-${n}`, lines: [] } }),
    };
  });
  return {
    ...actual,
    createCommandRegistry: () => {
      const real = actual.createCommandRegistry();
      REAL_COUNT_HOLDER.count = real.length;
      return [...synthetic, ...real];
    },
  };
});

/** Every command the menu can list with an empty query. */
const total = (): number => SYNTHETIC_COUNT + REAL_COUNT_HOLDER.count;

/**
 * A stdout that reports a terminal SIZE, which `ink-testing-library`'s does not. The bound is a
 * function of the terminal height, so a spec that cannot vary the height would pass on a menu
 * that ignored it. The same shape as `AppFullScreen.spec.tsx`'s.
 */
class SizedStdout extends EventEmitter {
  frames: string[] = [];
  constructor(
    public columns: number,
    public rows: number
  ) {
    super();
  }
  write = (frame: string) => {
    this.frames.push(frame);
  };
  lastFrame = () => this.frames[this.frames.length - 1];
}

/** A stdin the spec can type into; Ink reads through `readable` + `read()`, not `data` alone. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
  write = (data: string) => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
}

const idleAgent: TuiAgent = {
  async *runTurn(): AsyncGenerator<AgentStreamEvent> {},
};

const baseProps = {
  agent: idleAgent,
  mode: 'chat',
  modelDisplayName: 'test-model',
  readyMessage: 'ready to chat',
  // Short, so the hint row is one row at every width used here.
  exitMessage: "Type 'exit' to leave",
};

function renderAt(columns: number, rows: number, node: React.ReactElement) {
  const stdout = new SizedStdout(columns, rows);
  const stdin = new FakeStdin();
  const instance = inkRender(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { stdout, stdin, unmount: instance.unmount };
}

const frameRows = (stdout: SizedStdout): string[] =>
  (stdout.lastFrame() ?? '').split('\n').map((row) => stripAnsi(row));

/** Indices of the menu's rows in the frame: an entry, or an `↑ / ↓ N more` affordance. */
const menuRowIndices = (rows: string[]): number[] =>
  rows.flatMap((row, i) => (/^(❯| ) \/[a-z]|^ {2}[↑↓] \d+ more$/.test(row) ? [i] : []));

const DOWN = '\x1b[B';
const ENTER = '\r';
const CTRL_G = '\x07';
const DRAFT = 'please refactor the fo';

/** One key at a time, each given a moment to be handled, the way a person produces them. */
async function press(stdin: FakeStdin, key: string, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The dock around the prompt block is seven rows — blank · rule · status · air · prompt block ·
 * air · hint · rule — and the conversation keeps three. What the prompt block has is the rest;
 * the editor takes one row per row of the draft, and the chord door's query row one more.
 */
const DOCK_CHROME_ROWS = 7;
const TRANSCRIPT_MIN_ROWS = 3;
/** The prompt's first row counts up from the bottom: prompt · air · hint · rule. */
const PROMPT_ROW_FROM_BOTTOM = 4;

/**
 * TUI-C92 — the node's own assertion, at the two sizes that matter: the PTY gate's 30 rows and the
 * 24-row default. Every cell reads the frame as rows and asserts the prompt row directly — that is
 * the point of the node, and the assertion TUI-C51's test had to filter its way around.
 */
describe('<App> bounds the slash menu to the terminal (TUI-C92)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    [100, 30],
    [80, 24],
  ])(
    'typed door at %ix%i: the prompt row stays in frame under a scrolling menu',
    async (columns, rows) => {
      const { stdout, stdin, unmount } = renderAt(columns, rows, <App {...baseProps} />);
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

      stdin.write('/');
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

      let lines = frameRows(stdout);
      // The frame is exactly the terminal: nothing scrolled off the top.
      expect(lines).toHaveLength(rows);
      // The prompt row, with what was typed, in the frame's bottom rows.
      expect(lines[rows - PROMPT_ROW_FROM_BOTTOM]).toMatch(/^ {2}> \//);
      // The menu occupies its bound, no more: the terminal less the dock's chrome, the
      // conversation's floor and the prompt's one row.
      const bound = rows - DOCK_CHROME_ROWS - TRANSCRIPT_MIN_ROWS - 1;
      let menu = menuRowIndices(lines);
      expect(menu).toHaveLength(bound);
      // …and it sits below the conversation's floor and the dock's opening rows.
      expect(menu[0]).toBeGreaterThanOrEqual(TRANSCRIPT_MIN_ROWS + 4);
      // The affordance names what is hidden: the bound less the one row it takes itself.
      const shown = bound - 1;
      expect(lines[menu[menu.length - 1]]).toBe(`  ↓ ${total() - shown} more`);
      expect(lines.join('\n')).not.toMatch(/↑ \d+ more/);
      // Every entry is one row: the last visible entry is the one the arithmetic says.
      expect(lines[menu[menu.length - 2]]).toMatch(
        new RegExp(`^ {2}/cmd-${String(shown).padStart(2, '0')}`)
      );

      // Down past the window's edge scrolls: the highlight is visible and both counts moved.
      await press(stdin, DOWN, shown);
      const highlighted = `cmd-${String(shown + 1).padStart(2, '0')}`;
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`❯ /${highlighted}`));
      lines = frameRows(stdout);
      expect(lines).toHaveLength(rows);
      menu = menuRowIndices(lines);
      expect(menu).toHaveLength(bound);
      // Two affordances now, so the window holds two entries fewer than the bound.
      const window = bound - 2;
      const above = shown + 1 - window;
      expect(lines[menu[0]]).toBe(`  ↑ ${above} more`);
      expect(lines[menu[menu.length - 1]]).toBe(`  ↓ ${total() - above - window} more`);
      expect(lines[rows - PROMPT_ROW_FROM_BOTTOM]).toMatch(/^ {2}> \//);

      // Enter runs the highlighted command, not the first one.
      stdin.write(ENTER);
      await vi.waitFor(() => expect(stdout.frames.join('\n')).toContain(`ran ${highlighted}`));
      expect(stdout.frames.join('\n')).not.toContain('ran cmd-01');

      unmount();
    }
  );

  it.each([
    [100, 30],
    [80, 24],
  ])(
    'chord door at %ix%i: the draft stays in frame under a scrolling menu',
    async (columns, rows) => {
      const { stdout, stdin, unmount } = renderAt(columns, rows, <App {...baseProps} />);
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

      stdin.write(DRAFT);
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`> ${DRAFT}`));
      stdin.write(CTRL_G);
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

      let lines = frameRows(stdout);
      expect(lines).toHaveLength(rows);
      // The draft, on the prompt row, in the frame's bottom rows — the assertion TUI-C51 could not
      // make with an unfiltered menu. Trimmed: the caret at the end of the draft is an inverse
      // space, and this harness trims a row's trailing whitespace.
      expect(lines[rows - PROMPT_ROW_FROM_BOTTOM].trimEnd()).toBe(`  > ${DRAFT}`);
      // The query row directly above it, outside the menu's bound.
      expect(lines[rows - PROMPT_ROW_FROM_BOTTOM - 1]).toMatch(/^ {2}\/ *$/);
      // The bound: one row less than the typed door's, for the query row.
      const bound = rows - DOCK_CHROME_ROWS - TRANSCRIPT_MIN_ROWS - 1 - 1;
      let menu = menuRowIndices(lines);
      expect(menu).toHaveLength(bound);
      expect(menu[0]).toBeGreaterThanOrEqual(TRANSCRIPT_MIN_ROWS + 4);
      const shown = bound - 1;
      expect(lines[menu[menu.length - 1]]).toBe(`  ↓ ${total() - shown} more`);
      expect(lines.join('\n')).not.toMatch(/↑ \d+ more/);

      await press(stdin, DOWN, shown);
      const highlighted = `cmd-${String(shown + 1).padStart(2, '0')}`;
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`❯ /${highlighted}`));
      lines = frameRows(stdout);
      expect(lines).toHaveLength(rows);
      menu = menuRowIndices(lines);
      expect(menu).toHaveLength(bound);
      const window = bound - 2;
      const above = shown + 1 - window;
      expect(lines[menu[0]]).toBe(`  ↑ ${above} more`);
      expect(lines[menu[menu.length - 1]]).toBe(`  ↓ ${total() - above - window} more`);
      expect(lines[rows - PROMPT_ROW_FROM_BOTTOM].trimEnd()).toBe(`  > ${DRAFT}`);

      // Enter runs the highlighted command, and the draft comes back beneath the notice.
      stdin.write(ENTER);
      await vi.waitFor(() => expect(stdout.frames.join('\n')).toContain(`ran ${highlighted}`));
      expect(stdout.frames.join('\n')).not.toContain('ran cmd-01');
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`> ${DRAFT}`));
      expect(frameRows(stdout)).toHaveLength(rows);

      unmount();
    }
  );

  it('takes a wrapped draft out of the menu, not out of the frame (80x24)', async () => {
    // An unbroken run so the row count is a pure function of the width: 160 cells plus the caret
    // cell at the end wrap to three rows at the 76 columns the prompt's prefix leaves.
    const columns = 80;
    const rows = 24;
    const draft = 'x'.repeat(160);
    const draftRows = 3;
    const { stdout, stdin, unmount } = renderAt(columns, rows, <App {...baseProps} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    stdin.write(draft);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> xxx'));
    stdin.write(CTRL_G);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

    const lines = frameRows(stdout);
    expect(lines).toHaveLength(rows);
    // The draft's three rows end on the prompt's row: its first row is two above. One logical
    // line, so the wrapped rows continue at the text's column rather than with a `…` prefix.
    const last = rows - PROMPT_ROW_FROM_BOTTOM;
    expect(lines[last - draftRows + 1]).toMatch(/^ {2}> x+$/);
    expect(lines[last - 1]).toMatch(/^ {4}x+$/);
    expect(lines[last].trimEnd()).toMatch(/^ {4}x+$/);
    expect(lines[last - draftRows]).toMatch(/^ {2}\/ *$/);
    // The menu paid for the two extra rows.
    const bound = rows - DOCK_CHROME_ROWS - TRANSCRIPT_MIN_ROWS - draftRows - 1;
    const menu = menuRowIndices(lines);
    expect(menu).toHaveLength(bound);
    expect(lines[menu[menu.length - 1]]).toBe(`  ↓ ${total() - (bound - 1)} more`);

    unmount();
  });

  it('counts an open debug panel against the menu, so panel and menu still fit (80x24)', async () => {
    const { stdout, stdin, unmount } = renderAt(80, 24, <App {...baseProps} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    stdin.write('/debug');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> /debug'));
    stdin.write(ENTER);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Subagents'));

    stdin.write('/');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));
    const lines = frameRows(stdout);
    expect(lines).toHaveLength(24);
    expect(lines[24 - PROMPT_ROW_FROM_BOTTOM]).toMatch(/^ {2}> \//);
    // The panel is thirteen rows; with the seven of chrome and one for the prompt only three are
    // left, and the conversation's floor is what gives — the menu keeps its one-row minimum.
    expect(menuRowIndices(lines)).toHaveLength(1);
    expect(lines.join('\n')).toContain('Subagents');

    unmount();
  });
});
