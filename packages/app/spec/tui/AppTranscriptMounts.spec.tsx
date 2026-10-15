import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import type { TurnViewModel } from '#src/tui/viewModel.js';

/**
 * TUI-C48 — how much of the conversation `<App>` actually mounts, counted rather than looked at.
 *
 * This is the half of the size wiring that leaves no mark on the screen. The region pins its
 * content to the bottom and clips the overflow, so mounting four screenfuls looks exactly like
 * mounting one — the surplus is drawn and thrown away. The only symptom is several times the
 * render work per frame, which is the budget this node exists to defend, so the count IS the
 * assertion. `AppFullScreen.spec` covers the opposite error (too few items, a blank band).
 *
 * The counter replaces `LiveTurn`, the leaf a committed assistant turn renders, so it measures the
 * real component lifecycle of the real viewport with no probe added to production code. Effect
 * deps are empty so it counts component instances rather than prop churn.
 */
const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('#src/tui/components/LiveTurn.js', async () => {
  const react = await import('react');
  const ink = await import('ink');
  const { turnText } = await import('#src/tui/viewModel.js');
  return {
    LiveTurn: ({ turn }: { turn: TurnViewModel }) => {
      react.useEffect(() => {
        lifecycle.mounts += 1;
        return () => {
          lifecycle.unmounts += 1;
        };
      }, []);
      return react.createElement(ink.Text, null, turnText(turn));
    },
    ReasoningPanel: () => null,
    ChecklistPanel: () => null,
  };
});

const { App } = await import('#src/tui/components/App.js');

/** A stdout that reports a terminal size, as in `AppFullScreen.spec`. */
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

/** A stdin the spec can type into: Ink reads through `readable` + `read()`, not `data` alone. */
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

const replyingAgent: TuiAgent = {
  async *runTurn(): AsyncGenerator<AgentStreamEvent> {
    yield { type: 'text', delta: 'ok' };
  },
};

const baseProps = {
  agent: replyingAgent,
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

/** One turn, as an unbroken run: exactly `ceil(length / columns)` rows at any width. */
const TURN_LENGTH = 600;
const turnText = (n: number): string => `t${n}-${'x'.repeat(TURN_LENGTH)}`;

const TURNS = 14;

/** Vitest's default waitFor timeout is one second — short for the thirtieth render under load. */
const TURN_TIMEOUT_MS = 10_000;

/** What a terminal sends for the keys the scroll bindings claim. */
const PAGE_UP = '\x1b[5~';

/**
 * Drive `TURNS` exchanges, optionally scroll back, and report both what the run mounted and what it
 * was looking at.
 *
 * The count is of mounted **assistant turns**, not of mounted components: the lifecycle probe
 * replaces `LiveTurn`, which a committed assistant turn renders and a user line does not, so it
 * sees about half of the mounted slice. The literals below are in those units. The turn numbers are
 * what the run had on screen, and they are what says a gesture moved anything at all — the counts
 * alone are equally satisfied by a viewport in which `PageUp` does nothing.
 */
async function conversationRun(
  columns: number,
  rows: number,
  pageUps = 0
): Promise<{ mounted: number; turns: number[] }> {
  const { stdout, stdin, unmount } = renderAt(columns, rows, <App {...baseProps} />);
  await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
  for (let i = 0; i < TURNS; i++) {
    stdin.write(turnText(i));
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`t${i}-xxx`), {
      timeout: TURN_TIMEOUT_MS,
    });
    stdin.write('\r');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`turns: ${i + 1}`), {
      timeout: TURN_TIMEOUT_MS,
    });
  }
  for (let page = 0; page < pageUps; page++) {
    const frames = stdout.frames.length;
    stdin.write(PAGE_UP);
    await vi.waitFor(() => expect(stdout.frames.length).toBeGreaterThan(frames), { timeout: 2000 });
  }
  // The session is idle here, so the streaming turn is unmounted and what is left is exactly the
  // committed turns the viewport chose to keep.
  const mounted = lifecycle.mounts - lifecycle.unmounts;
  const turns = [
    ...new Set(
      [...(stdout.lastFrame() ?? '').matchAll(/t(\d+)-x/g)].map((match) => Number(match[1]))
    ),
  ].sort((a, b) => a - b);
  unmount();
  return { mounted, turns };
}

describe('<App> mounts a screenful of the transcript, not the whole of it', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;
  });

  it('keeps the mounted slice to the size of the screen, and grows it with the screen', async () => {
    // Every exchange here occupies about ten rows at 80 columns (an eight-row turn, its separator
    // and a one-row answer), so a 24-row terminal can show two or three of them and the numbers
    // below are what that means in mounted components. Measured on the shipped code: four at 24
    // rows and six at 48. The bounds are literals rather than an expression over the terminal
    // height or the slack constant, because an assertion written in terms of the production
    // constants it is checking cannot fail when they change.
    //
    // The ceilings are the ones that bite: with a budget several times the terminal height the
    // conversation looks identical on screen and eleven turns are mounted at 24 rows, fourteen at
    // 48. Keep BOTH — the second is not redundant, because the strict inequality below it still
    // holds under that budget (eleven really is fewer than fourteen) and only the ceiling catches
    // it. The floor catches the opposite error, and the inequality is what stops all of them from
    // being satisfied by a viewport that mounts a fixed number of items whatever the terminal does.
    const short = await conversationRun(80, 24);
    expect(short.mounted).toBeGreaterThanOrEqual(3);
    expect(short.mounted).toBeLessThanOrEqual(6);

    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;

    const tall = await conversationRun(80, 48);
    expect(tall.mounted).toBeGreaterThan(short.mounted);
    expect(tall.mounted).toBeLessThanOrEqual(10);
  }, 60_000);

  it('keeps the slice bounded by the screen at a SCROLLED position too', async () => {
    // The DL-10 acceptance is "bounded at any scroll position", and a count taken only at the end
    // of the conversation measures the one position where the below-the-edge half of the window is
    // empty — so it says nothing about scrolling at all. Scrolled back, the viewport also mounts a
    // screenful BELOW the edge, because a scroll back down has to measure real heights and only a
    // mounted block has one. So the number rises once and then must stop: what would break DL-10
    // is a slice that keeps growing with how far back the reader has gone.
    //
    // Measured on the shipped code at 80x24: four mounted at the end, eight two pages back, eight
    // four pages back. Literals, not expressions over the production constants.
    const atEnd = await conversationRun(80, 24, 0);
    expect(atEnd.mounted).toBeLessThanOrEqual(6);

    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;
    const twoPages = await conversationRun(80, 24, 2);

    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;
    const fourPages = await conversationRun(80, 24, 4);

    // FIRST, that the gesture did anything. Every bound below is satisfied by a viewport in which
    // PageUp is a no-op — same count, same screen — so without these two the whole case is about a
    // conversation nobody scrolled. Different content on screen at each depth is the statement; the
    // counts are only meaningful once it holds.
    expect(twoPages.turns).not.toEqual(atEnd.turns);
    expect(fourPages.turns).not.toEqual(twoPages.turns);
    // …and mounting more while scrolled back is the thing the ceilings then bound: scrolled, the
    // viewport also mounts a screenful BELOW the edge, because only a mounted block has a measured
    // height to scroll back down by.
    expect(twoPages.mounted).toBeGreaterThan(atEnd.mounted);

    expect(twoPages.mounted).toBeLessThanOrEqual(9);
    // Four pages back is most of the way to the start of a fourteen-turn conversation, and the
    // mounted set is the SAME size as two pages back. Equality rather than a ceiling: a ceiling
    // alone would be satisfied by a slice that grew slowly.
    expect(fourPages.mounted).toBe(twoPages.mounted);

    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;
    const tallTwoPages = await conversationRun(80, 48, 2);
    // …and the bound is the SCREEN, not a constant: twice the terminal height mounts more. Without
    // this the two assertions above would also pass on a viewport that mounted a fixed nine items
    // whatever the terminal did.
    expect(tallTwoPages.mounted).toBeGreaterThan(twoPages.mounted);
  }, 90_000);
});
