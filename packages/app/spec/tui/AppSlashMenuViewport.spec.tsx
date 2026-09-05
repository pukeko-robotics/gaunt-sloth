import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import stripAnsi from 'strip-ansi';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { LiveNegotiationRound } from '@gaunt-sloth/core/core/shell/negotiation.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';
import { negotiationPanelRows } from '#src/tui/components/NegotiationPanel.js';
import { TUI_HINT_SUFFIX } from '#src/tui/keyBindings.js';
import { CHAT_SESSION_CONFIG, CODE_SESSION_CONFIG } from '#src/modules/sessionConfigs.js';

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

/**
 * The fixture-shaped props: no provider, no approvals surface, a short hint. The cells that use
 * these are about the MENU's arithmetic; the cells under "with the props a real session passes"
 * are the ones that hold the dock's chrome to its count.
 */
const baseProps = {
  agent: idleAgent,
  mode: 'chat',
  modelDisplayName: 'test-model',
  readyMessage: 'ready to chat',
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
 * Where the dock's opening rows land when the conversation keeps exactly its floor: the blank row
 * on the floor's row, then the rule, then the status bar, then the row of air. A panel that sits
 * above the rule (the checklist, the negotiation) shifts all four; one that sits between the rule
 * and the status bar (the advisory, the MCP failure) shifts the last two.
 */
const DOCK_BLANK_ROW = TRANSCRIPT_MIN_ROWS;
const DOCK_RULE_ROW = TRANSCRIPT_MIN_ROWS + 1;
const STATUS_ROW = TRANSCRIPT_MIN_ROWS + 2;
const AIR_ROW = TRANSCRIPT_MIN_ROWS + 3;
const FIRST_MENU_ROW = TRANSCRIPT_MIN_ROWS + 4;

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
      // The frame is always exactly the terminal: the frame box is `height={terminalRows}` and
      // Ink clamps a taller frame by dropping its top rows (`AppFullScreen.spec.tsx` pins that),
      // so this cannot see an overflow. It pins the clamp; the LIVE assertion is the prompt-row
      // one below, which is what fails when the menu takes rows it does not have.
      expect(lines).toHaveLength(rows);
      // The prompt row, with what was typed, in the frame's bottom rows.
      expect(lines[rows - PROMPT_ROW_FROM_BOTTOM]).toMatch(/^ {2}> \//);
      // The menu occupies its bound, no more: the terminal less the dock's chrome, the
      // conversation's floor and the prompt's one row.
      const bound = rows - DOCK_CHROME_ROWS - TRANSCRIPT_MIN_ROWS - 1;
      let menu = menuRowIndices(lines);
      expect(menu).toHaveLength(bound);
      // …and it sits below the conversation's floor and the dock's opening rows.
      expect(menu[0]).toBeGreaterThanOrEqual(FIRST_MENU_ROW);
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
      expect(menu[0]).toBeGreaterThanOrEqual(FIRST_MENU_ROW);
      const shown = bound - 1;
      expect(lines[menu[menu.length - 1]]).toBe(`  ↓ ${total() - shown} more`);
      expect(lines.join('\n')).not.toMatch(/↑ \d+ more/);

      await press(stdin, DOWN, shown);
      const highlighted = `cmd-${String(shown + 1).padStart(2, '0')}`;
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`❯ /${highlighted}`));
      lines = frameRows(stdout);
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
      expect(frameRows(stdout)[rows - PROMPT_ROW_FROM_BOTTOM].trimEnd()).toBe(`  > ${DRAFT}`);

      unmount();
    }
  );

  it('takes a wrapped draft out of the menu, not out of the frame (80x24)', async () => {
    // An unbroken run, sized to pin the prefix width and the caret cell: seventy-six cells fill
    // the seventy-six columns the four-column prefix leaves, and the caret drawn after them as an
    // inverse space is the one cell that starts a second row. One column more of width, or a
    // caret not counted, and the count says one row where the render draws two.
    const columns = 80;
    const rows = 24;
    const draft = 'x'.repeat(76);
    const draftRows = 2;
    const { stdout, stdin, unmount } = renderAt(columns, rows, <App {...baseProps} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    stdin.write(draft);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> xxx'));
    stdin.write(CTRL_G);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

    const lines = frameRows(stdout);
    // The draft's two rows end on the prompt's row: its first row is one above, filled to the
    // edge, and the second holds only the caret (an inverse space this harness trims away). One
    // logical line, so the wrapped row continues at the text's column, with no `…` prefix.
    const last = rows - PROMPT_ROW_FROM_BOTTOM;
    expect(lines[last - 1]).toBe(`  > ${draft}`);
    expect(lines[last].trimEnd()).toBe('');
    expect(lines[last - draftRows]).toMatch(/^ {2}\/ *$/);
    // The menu paid for the extra row.
    const bound = rows - DOCK_CHROME_ROWS - TRANSCRIPT_MIN_ROWS - draftRows - 1;
    const menu = menuRowIndices(lines);
    expect(menu).toHaveLength(bound);
    expect(lines[menu[menu.length - 1]]).toBe(`  ↓ ${total() - (bound - 1)} more`);

    unmount();
  });

  it('counts a word-wrapped draft as Ink draws it, not as its width divides (80x24)', async () => {
    // Three words of thirty-nine cells: 119 cells, which a division by the 76-column width calls
    // two rows. Ink breaks at spaces, so the second word cannot follow the first on its row and
    // the draft takes three. The menu has to pay for the third, or the dock grows by a row and
    // takes it from the conversation's floor.
    const columns = 80;
    const rows = 24;
    const words = ['a'.repeat(39), 'b'.repeat(39), 'c'.repeat(39)];
    const draft = words.join(' ');
    const draftRows = 3;
    const { stdout, stdin, unmount } = renderAt(columns, rows, <App {...baseProps} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    stdin.write(draft);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> aaa'));
    stdin.write(CTRL_G);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

    const lines = frameRows(stdout);
    const last = rows - PROMPT_ROW_FROM_BOTTOM;
    expect(lines[last - 2].trimEnd()).toBe(`  > ${words[0]}`);
    expect(lines[last - 1].trimEnd()).toBe(`    ${words[1]}`);
    expect(lines[last].trimEnd()).toBe(`    ${words[2]}`);
    expect(lines[last - draftRows]).toMatch(/^ {2}\/ *$/);
    const bound = rows - DOCK_CHROME_ROWS - TRANSCRIPT_MIN_ROWS - draftRows - 1;
    const menu = menuRowIndices(lines);
    expect(menu).toHaveLength(bound);
    expect(menu[0]).toBe(FIRST_MENU_ROW);
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
    expect(lines[24 - PROMPT_ROW_FROM_BOTTOM]).toMatch(/^ {2}> \//);
    // The panel is thirteen rows; with the seven of chrome and one for the prompt only three are
    // left, and the conversation's floor is what gives — the menu keeps its one-row minimum.
    expect(menuRowIndices(lines)).toHaveLength(1);
    expect(lines.join('\n')).toContain('Subagents');

    unmount();
  });
});

/**
 * TUI-C92 — **the budget's chrome count, held to the props a real session passes.**
 *
 * `tuiSessionModule.tsx` hands `<App>` the config's model id and provider, the runner's resolved
 * approvals, and the session config's exit message. With those the status bar is 102 cells before
 * anything is dropped and the code session's hint row is 88, so at 80 columns — the node's own
 * named size — both would wrap, and each wrapped row would come out of the conversation's floor
 * with the budget none the wiser. The cells below assert the bar and the hint are ONE row each and
 * the floor is exactly kept, with the model, the approvals badge and the real exit message in
 * place: a fixture that leaves them out cannot see this.
 *
 * The exit messages are imported from the session configs, never copied, so a longer row lands
 * here rather than on someone's screen.
 */
describe('<App> keeps the dock to its counted rows with the props a real session passes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** A real id, 26 cells, so the bar overflows at 100 columns too, not only at 80. */
  const REAL_MODEL = 'claude-sonnet-4-5-20250929';

  const realProps = (config: typeof CHAT_SESSION_CONFIG) => ({
    agent: idleAgent,
    mode: config.mode,
    modelDisplayName: REAL_MODEL,
    modelProviderType: 'anthropic',
    initialApprovals: { rung: 'assisted' as const },
    readyMessage: config.readyMessage,
    exitMessage: config.exitMessage,
  });

  /** The bar's row, by width: the provider goes at both, the rater profile at both, and at 80 the badge truncates. */
  const STATUS_ROW_AT: Record<number, string> = {
    100: `  ·  model: ${REAL_MODEL}  ·  turns: 0  ·  ready  ·  approvals: Assisted`,
    80: `  ·  model: ${REAL_MODEL}  ·  turns: 0  ·  ready  ·  approvals…`,
  };

  it.each([
    ['chat', 80, 24, CHAT_SESSION_CONFIG],
    ['code', 80, 24, CODE_SESSION_CONFIG],
    ['chat', 100, 30, CHAT_SESSION_CONFIG],
    ['code', 100, 30, CODE_SESSION_CONFIG],
  ])('%s session at %ix%i', async (_name, columns, rows, config) => {
    const { stdout, stdin, unmount } = renderAt(columns, rows, <App {...realProps(config)} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('turns:'));

    stdin.write(DRAFT);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`> ${DRAFT}`));
    stdin.write(CTRL_G);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

    const lines = frameRows(stdout);

    // The conversation keeps exactly its floor: the dock opens on the floor's own row.
    expect(lines.slice(0, TRANSCRIPT_MIN_ROWS).join('\n')).toContain('Gaunt Sloth is ready');
    expect(lines[DOCK_BLANK_ROW]).toBe('');
    expect(lines[DOCK_RULE_ROW]).toMatch(/^─+$/);

    // The status bar is exactly one row: found by its `turns:` text, and the row after it is the
    // row of air, not more status text.
    expect(lines[STATUS_ROW]).toBe(`${config.mode}${STATUS_ROW_AT[columns]}`);
    expect(lines[STATUS_ROW]).not.toContain('anthropic');
    expect(lines[STATUS_ROW]).not.toContain('auto-rater');
    expect(lines[AIR_ROW]).toBe('');
    expect(lines.filter((row) => row.includes('turns:'))).toHaveLength(1);

    // The hint is one row: the real exit message plus the scroll note, truncated with `…` when
    // the two do not fit, so the closing rule is still the last row and the prompt still sits
    // four from the bottom.
    const hint = `${config.exitMessage.trim()}${TUI_HINT_SUFFIX}`;
    const hintRow = lines[rows - 2];
    if (hint.length <= columns) {
      expect(hintRow).toBe(hint);
    } else {
      expect(hintRow).toBe(`${hint.slice(0, columns - 1)}…`);
    }
    expect(hintRow.startsWith("Type 'exit' to leave")).toBe(true);
    expect(lines[rows - 1]).toMatch(/^─+$/);

    // The prompt row with the draft, four from the bottom; the query row above it.
    expect(lines[rows - PROMPT_ROW_FROM_BOTTOM].trimEnd()).toBe(`  > ${DRAFT}`);
    expect(lines[rows - PROMPT_ROW_FROM_BOTTOM - 1]).toMatch(/^ {2}\/ *$/);

    // The menu rows are what the budget predicts, starting right under the row of air.
    const bound = rows - DOCK_CHROME_ROWS - TRANSCRIPT_MIN_ROWS - 1 - 1;
    const menu = menuRowIndices(lines);
    expect(menu).toHaveLength(bound);
    expect(menu[0]).toBe(FIRST_MENU_ROW);
    expect(lines[menu[menu.length - 1]]).toBe(`  ↓ ${total() - (bound - 1)} more`);

    unmount();
  });

  it('truncates the code session hint at 80 columns from the end of the scroll note', () => {
    // Named so a later reader does not "fix" the row back to wrapping: the row is 88 cells, and
    // what the `…` replaces is the tail of TUI_HINT_SUFFIX — the exit instruction survives.
    const hint = `${CODE_SESSION_CONFIG.exitMessage.trim()}${TUI_HINT_SUFFIX}`;
    expect(hint).toHaveLength(88);
    expect(hint.endsWith(TUI_HINT_SUFFIX)).toBe(true);
    expect(`${hint.slice(0, 79)}…`).toBe(
      "Type 'exit' to leave the code session · /help for commands · PgUp/PgDn to scrol…"
    );
  });
});

/**
 * TUI-C92 — **every optional term of the budget has a cell.** The budget subtracts the rows of
 * whichever dock panels are drawn — the advisory bar, the MCP-failure bar, the checklist, the
 * negotiation — each counted by the module that draws it. A term with no cell is a term that can
 * silently be dropped, or drift from its render, and the menu then takes the panel's rows from
 * the conversation's floor. So each panel is mounted, the menu opened, and the first menu row
 * asserted EXACTLY: the floor, the panel's rows, and the dock's opening rows, and not one fewer.
 */
describe('<App> counts every optional dock panel against the menu', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const columns = 80;
  const rows = 24;

  /**
   * The rows above the first menu row when the conversation keeps its floor: a panel that sits
   * between the rule and the status bar (`aboveRule: false`) or above the dock's blank row.
   */
  function assertMenuBelowPanel(lines: string[], panelRows: number, panelText: string) {
    expect(lines[rows - PROMPT_ROW_FROM_BOTTOM]).toMatch(/^ {2}> \//);
    const bound = rows - DOCK_CHROME_ROWS - TRANSCRIPT_MIN_ROWS - panelRows - 1;
    const menu = menuRowIndices(lines);
    expect(menu).toHaveLength(bound);
    expect(menu[0]).toBe(FIRST_MENU_ROW + panelRows);
    expect(lines[menu[menu.length - 1]]).toBe(`  ↓ ${total() - (bound - 1)} more`);
    expect(lines.join('\n')).toContain(panelText);
  }

  it('the advisory bar (TUI-C19), one row between the rule and the status bar', async () => {
    const { stdout, stdin, unmount } = renderAt(
      columns,
      rows,
      <App {...baseProps} advisories={['config has problems']} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    stdin.write('/');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

    const lines = frameRows(stdout);
    expect(lines[DOCK_RULE_ROW]).toMatch(/^─+$/);
    expect(lines[DOCK_RULE_ROW + 1]).toContain('Your config has problems');
    expect(lines[DOCK_RULE_ROW + 2]).toContain('turns:');
    assertMenuBelowPanel(lines, 1, 'Your config has problems');

    unmount();
  });

  it('the MCP-failure bar, one row between the rule and the status bar', async () => {
    const { stdout, stdin, unmount } = renderAt(
      columns,
      rows,
      <App
        {...baseProps}
        mcpFailures={[{ server: 'some-server', error: 'connect ECONNREFUSED' }]}
      />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    stdin.write('/');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

    const lines = frameRows(stdout);
    expect(lines[DOCK_RULE_ROW]).toMatch(/^─+$/);
    // Eighty-four cells with one server: one row by construction, truncated at the row's end,
    // with the server name and the `/debug` pointer both still on it.
    expect(lines[DOCK_RULE_ROW + 1]).toBe(
      '⚠ MCP server unavailable: some-server · type /debug and open the MCP tab for de…'
    );
    expect(lines[DOCK_RULE_ROW + 1]).toHaveLength(columns);
    expect(lines[DOCK_RULE_ROW + 2]).toContain('turns:');
    assertMenuBelowPanel(lines, 1, 'some-server');

    unmount();
  });

  it('the pinned checklist panel, its header and one row per item, above the dock', async () => {
    // The agent `AppFullScreen.spec.tsx` uses: a three-item checklist left pinned in the dock.
    const checklistAgent: TuiAgent = {
      async *runTurn(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'planning' };
        yield { type: 'tool_start', id: 'c1', name: 'gth_checklist' };
        yield {
          type: 'tool_args',
          id: 'c1',
          delta: JSON.stringify({
            items: [
              { content: 'Inspect planets.html', status: 'completed' },
              { content: 'Design kingdoms.html', status: 'in_progress' },
              { content: 'Verify output', status: 'pending' },
            ],
          }),
        };
        yield { type: 'tool_end', id: 'c1' };
      },
    };
    const { stdout, stdin, unmount } = renderAt(
      columns,
      rows,
      <App {...baseProps} agent={checklistAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    stdin.write('go');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> go'));
    stdin.write(ENTER);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Verify output'));

    stdin.write('/');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

    const lines = frameRows(stdout);
    // The header and three items, on the floor's row; then the dock's blank row and rule.
    const panelRows = 1 + 3;
    expect(lines[TRANSCRIPT_MIN_ROWS]).toContain('Checklist');
    expect(lines[TRANSCRIPT_MIN_ROWS + 3]).toContain('Verify output');
    expect(lines[DOCK_BLANK_ROW + panelRows]).toBe('');
    expect(lines[DOCK_RULE_ROW + panelRows]).toMatch(/^─+$/);
    expect(lines[STATUS_ROW + panelRows]).toContain('turns:');
    assertMenuBelowPanel(lines, panelRows, 'Verify output');

    unmount();
  });

  it('the negotiation panel (TUI-C69), one row per row of the exchange, above the dock', async () => {
    // The round `NegotiationPanel.spec.tsx` draws, bridged in the way the session module does.
    const round = {
      round: {
        command: 'git reset --hard origin/main',
        justification: 'the user asked to wipe today’s commits',
        outcome: 'destructive' as const,
        reason: 'discards every unpushed commit, not only today’s',
      },
      position: 0,
    } as LiveNegotiationRound;
    let emit: ((event: LiveNegotiationRound | null) => void) | undefined;
    const { stdout, stdin, unmount } = renderAt(
      columns,
      rows,
      <App
        {...baseProps}
        subscribeNegotiation={(cb) => {
          emit = cb;
          return () => {};
        }}
      />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await vi.waitFor(() => expect(emit).toBeDefined());
    emit!(round);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Round 1'));

    stdin.write('/');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯ /cmd-01'));

    const lines = frameRows(stdout);
    // The rows the renderer says the exchange takes at this width, and that many rows drawn.
    const panelRows = negotiationPanelRows([round], columns);
    expect(panelRows).toBeGreaterThan(0);
    expect(lines.slice(TRANSCRIPT_MIN_ROWS, TRANSCRIPT_MIN_ROWS + panelRows).join('\n')).toContain(
      'Round 1'
    );
    expect(lines[DOCK_BLANK_ROW + panelRows]).toBe('');
    expect(lines[DOCK_RULE_ROW + panelRows]).toMatch(/^─+$/);
    expect(lines[STATUS_ROW + panelRows]).toContain('turns:');
    assertMenuBelowPanel(lines, panelRows, 'Round 1');

    unmount();
  });
});
