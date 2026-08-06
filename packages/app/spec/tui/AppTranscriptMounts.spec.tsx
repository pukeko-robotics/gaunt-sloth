import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';

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
  return {
    LiveTurn: ({ turn }: { turn: { text?: string } }) => {
      react.useEffect(() => {
        lifecycle.mounts += 1;
        return () => {
          lifecycle.unmounts += 1;
        };
      }, []);
      return react.createElement(ink.Text, null, turn.text ?? '');
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

/** Drive `TURNS` exchanges and return how many committed turns are still mounted at the end. */
async function mountedAfterConversation(columns: number, rows: number): Promise<number> {
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
  // The session is idle here, so the streaming turn is unmounted and what is left is exactly the
  // committed turns the viewport chose to keep.
  const mounted = lifecycle.mounts - lifecycle.unmounts;
  unmount();
  return mounted;
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
    const mountedShort = await mountedAfterConversation(80, 24);
    expect(mountedShort).toBeGreaterThanOrEqual(3);
    expect(mountedShort).toBeLessThanOrEqual(6);

    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;

    const mountedTall = await mountedAfterConversation(80, 48);
    expect(mountedTall).toBeGreaterThan(mountedShort);
    expect(mountedTall).toBeLessThanOrEqual(10);
  }, 60_000);
});
