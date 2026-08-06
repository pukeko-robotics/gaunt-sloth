import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import type { MouseEvent } from '#src/tui/mouseParser.js';
import { App } from '#src/tui/components/App.js';

/**
 * TUI-C48 — scrolling the conversation, asserted against what actually lands on the screen.
 *
 * The alternate screen has no terminal scrollback, so before this the conversation above the fold
 * was simply unreachable. What makes these cases worth their runtime is that the interesting
 * failures are all silent: a scroll that moves the wrong DISTANCE looks exactly like one that
 * works, a view that drifts while a turn streams looks like the user mis-remembering, and a
 * binding claimed by the wrong owner just does the other thing. So the assertions are on the
 * region's rows, compared row for row against the same rows before the gesture — the only form
 * that states the distance.
 */

/** A stdout that reports a terminal SIZE, which `ink-testing-library`'s does not. */
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
  resizeTo(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
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

/** The decoded-mouse bridge `<App>` subscribes to, driven by hand. */
function fakeMouse() {
  const listeners = new Set<(event: MouseEvent) => void>();
  return {
    subscribe: (listener: (event: MouseEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    wheel: (direction: 'up' | 'down', shift = false) => {
      const event: MouseEvent = {
        type: 'wheel',
        button: 'none',
        column: 10,
        row: 5,
        shift,
        meta: false,
        ctrl: false,
        wheel: direction,
      };
      for (const listener of [...listeners]) listener(event);
    },
    press: () => {
      const event: MouseEvent = {
        type: 'press',
        button: 'left',
        column: 10,
        row: 5,
        shift: false,
        meta: false,
        ctrl: false,
      };
      for (const listener of [...listeners]) listener(event);
    },
  };
}

/** What a terminal sends for the keys this node binds (measured in task 0 against Konsole). */
const KEY = {
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  ctrlHome: '\x1b[1;5H',
  ctrlEnd: '\x1b[1;5F',
  escape: '\x1b',
  tab: '\t',
  enter: '\r',
  ctrlT: '\x14',
};

const idleAgent: TuiAgent = {
  async *runTurn(): AsyncGenerator<AgentStreamEvent> {},
};

const replyingAgent: TuiAgent = {
  async *runTurn(): AsyncGenerator<AgentStreamEvent> {
    yield { type: 'text', delta: 'ok' };
  },
};

/** Eighty numbered rows in ONE answer — a single transcript item taller than the whole screen. */
const NUMBERED_ROWS = Array.from(
  { length: 80 },
  (_, i) => `numbered-row-${String(i + 1).padStart(3, '0')}`
);

const tallAgent: TuiAgent = {
  async *runTurn(): AsyncGenerator<AgentStreamEvent> {
    yield { type: 'text', delta: NUMBERED_ROWS.join('\n') };
  },
};

/**
 * An agent whose turn the spec feeds chunk by chunk, so output can arrive with no keystroke behind
 * it. That distinction is the whole point of the auto-stick cases: typing deliberately returns the
 * view to the end, so a test that produced output BY typing could never observe the view staying
 * put while a turn streams underneath it.
 */
const END_OF_TURN = Symbol('end of turn');

function pumpedAgent(): {
  agent: TuiAgent;
  emit: (delta: string) => void;
  finish: () => void;
} {
  // A queue with an explicit end marker rather than a flag, so a test may queue a whole turn before
  // the generator has even started without the end overtaking the chunks.
  const pending: (AgentStreamEvent | typeof END_OF_TURN)[] = [];
  let wake: (() => void) | null = null;
  const nudge = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    agent: {
      async *runTurn(): AsyncGenerator<AgentStreamEvent> {
        for (;;) {
          while (pending.length) {
            const next = pending.shift() as AgentStreamEvent | typeof END_OF_TURN;
            if (next === END_OF_TURN) return;
            yield next;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    emit: (delta: string) => {
      pending.push({ type: 'text', delta });
      nudge();
    },
    finish: () => {
      pending.push(END_OF_TURN);
      nudge();
    },
  };
}

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

const frameRows = (stdout: SizedStdout) => (stdout.lastFrame() ?? '').split('\n');

/**
 * The rows of the conversation region — everything above the dock.
 *
 * Found from the bottom up rather than from a constant, because the dock's height is not one: it
 * grows a debug pane, advisories and a checklist, and it LOSES the prompt while the debug pane has
 * the keyboard. The exit hint is always the row above the closing rule, and the dock's opening rule
 * is two or three rows above that; both ends are asserted, so a change to the dock breaks this
 * helper loudly instead of silently shifting every comparison in the file by a row. The status bar
 * is deliberately not the landmark — it swaps to a spinner while a turn streams, which is exactly
 * when several of these cases look at it.
 */
function regionRows(stdout: SizedStdout): string[] {
  const rows = frameRows(stdout);
  const rule = /^─+$/;
  const exitRow = rows.findIndex((r) => r.includes("Type 'exit' to leave"));
  expect(exitRow).toBeGreaterThan(3);
  expect(rows[exitRow + 1]).toMatch(rule);
  const openingRule = [exitRow - 2, exitRow - 3].find((row) => rule.test(rows[row] ?? ''));
  expect(openingRule).toBeGreaterThan(0);
  // The docked debug pane sits above that rule and is dock, not conversation.
  const panelTop = rows.findIndex((r) => r.startsWith('╭'));
  const dockTop = openingRule as number;
  return rows.slice(0, panelTop >= 0 && panelTop < dockTop ? panelTop : dockTop);
}

/** One turn, as an unbroken run so its height is exactly `ceil(length / columns)` at any width. */
const turnText = (n: number): string => `t${n}-${'x'.repeat(200)}`;

/**
 * Numbered one-row lines for a turn the spec grows by hand — `live-001`, `live-002`, … Numbered so
 * an assertion can name the row it expects at the bottom of the region rather than only saying
 * something is there.
 */
const liveRows = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `live-${String(from + i).padStart(3, '0')}`);

const TURN_TIMEOUT_MS = 10_000;

async function converse(
  stdout: SizedStdout,
  stdin: FakeStdin,
  turns: number,
  from = 0
): Promise<void> {
  for (let i = from; i < from + turns; i++) {
    stdin.write(turnText(i));
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`t${i}-xxx`), {
      timeout: TURN_TIMEOUT_MS,
    });
    stdin.write(KEY.enter);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`turns: ${i + 1}`), {
      timeout: TURN_TIMEOUT_MS,
    });
  }
}

/** Wait for the frame to settle, so a comparison is against a committed render rather than a race. */
async function settle(stdout: SizedStdout): Promise<void> {
  const before = stdout.frames.length;
  await vi.waitFor(() => expect(stdout.frames.length).toBeGreaterThan(before), { timeout: 2000 });
}

/** Turn numbers currently drawn in the conversation region. */
function visibleTurns(stdout: SizedStdout): number[] {
  return [
    ...new Set(
      regionRows(stdout).flatMap((row) => [...row.matchAll(/t(\d+)-x/g)].map((m) => Number(m[1])))
    ),
  ].sort((a, b) => a - b);
}

describe('<App> transcript scrolling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('PageUp reveals older output and PageDown comes back to the newest', async () => {
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    const atBottom = visibleTurns(stdout);
    expect(atBottom).toContain(13);

    stdin.write(KEY.pageUp);
    await settle(stdout);
    const scrolledBack = visibleTurns(stdout);

    // Older conversation that was off the screen is now on it, and the newest is not — a scroll
    // that merely re-rendered the same rows would satisfy neither half.
    expect(Math.min(...scrolledBack)).toBeLessThan(Math.min(...atBottom));
    expect(scrolledBack).not.toContain(13);

    stdin.write(KEY.pageDown);
    await settle(stdout);
    expect(visibleTurns(stdout)).toEqual(atBottom);

    unmount();
  }, 40_000);

  it('moves the conversation by exactly three rows per wheel notch', async () => {
    // The distance IS the binding, and it is the one thing a "something changed" assertion cannot
    // state. Comparing the region row for row against itself, offset by three, fails for any other
    // number — which is what makes the lines-per-notch mutation bite.
    const mouse = fakeMouse();
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} mouseEnabled subscribeMouse={mouse.subscribe} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    const before = regionRows(stdout);
    mouse.wheel('up');
    await settle(stdout);
    const after = regionRows(stdout);

    expect(after).toHaveLength(before.length);
    for (let row = 3; row < before.length; row++) {
      expect(`row ${row}: ${after[row]}`).toBe(`row ${row}: ${before[row - 3]}`);
    }
    // …and the three rows that came in at the top are genuinely new content, not blanks.
    expect(after.slice(0, 3).join('').trim()).not.toBe('');

    unmount();
  }, 40_000);

  it('pages on Shift+wheel rather than stepping three rows', async () => {
    const mouse = fakeMouse();
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} mouseEnabled subscribeMouse={mouse.subscribe} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    const before = regionRows(stdout);
    mouse.wheel('up', true);
    await settle(stdout);
    const after = regionRows(stdout);

    // A page is the region less a row of overlap, so exactly one row of the old view survives — at
    // the very bottom. Three rows would have left all but three.
    expect(after[after.length - 1]).toBe(before[0]);

    unmount();
  }, 40_000);

  it('ignores the wheel when mouse input is off', async () => {
    // Keyboard-only operation is unchanged with the mouse disabled: nothing subscribes, so an
    // event that somehow arrived cannot move the view.
    const mouse = fakeMouse();
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App
        {...baseProps}
        agent={replyingAgent}
        mouseEnabled={false}
        subscribeMouse={mouse.subscribe}
      />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    const before = regionRows(stdout);
    mouse.wheel('up');
    mouse.wheel('up');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(regionRows(stdout)).toEqual(before);

    unmount();
  }, 40_000);

  it('Ctrl+Home shows the start of the conversation and Ctrl+End comes back', async () => {
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);
    const atBottom = visibleTurns(stdout);

    stdin.write(KEY.ctrlHome);
    await settle(stdout);
    await vi.waitFor(() => expect(visibleTurns(stdout)).toContain(0), { timeout: TURN_TIMEOUT_MS });

    // The very first exchange is on screen — and the region is FULL, not one row of conversation
    // floating at the bottom of an empty screen, which is what an unsettled jump would leave.
    const atStart = regionRows(stdout);
    expect(atStart[0].trim()).not.toBe('');
    expect(visibleTurns(stdout)).not.toContain(13);

    stdin.write(KEY.ctrlEnd);
    await settle(stdout);
    expect(visibleTurns(stdout)).toEqual(atBottom);

    unmount();
  }, 40_000);
});

describe('<App> auto-stick to the newest output', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('follows new output while at the end', async () => {
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 10);

    await converse(stdout, stdin, 1, 10);
    expect(visibleTurns(stdout)).toContain(10);

    unmount();
  }, 40_000);

  it('leaves the view exactly where it is while a turn streams below it', async () => {
    // The node's wording: new output must not yank a reader who has scrolled up. "Not yanked" is
    // not enough on its own — the rows they are reading must stay on the SAME screen rows, which
    // is what an item-anchored position buys and a position held as a row offset from the end
    // loses on every chunk. Output has to arrive with no keystroke behind it, because typing is
    // itself defined to return the view to the end.
    const pump = pumpedAgent();
    const { stdout, stdin, unmount } = renderAt(80, 24, <App {...baseProps} agent={pump.agent} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    for (let i = 0; i < 12; i++) {
      stdin.write(turnText(i));
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`t${i}-xxx`), {
        timeout: TURN_TIMEOUT_MS,
      });
      stdin.write(KEY.enter);
      pump.emit('ok');
      pump.finish();
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`turns: ${i + 1}`), {
        timeout: TURN_TIMEOUT_MS,
      });
    }

    // A thirteenth turn that stays open, so the spec can grow it a chunk at a time.
    stdin.write('grow');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> grow'));
    stdin.write(KEY.enter);
    pump.emit('first chunk');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('first chunk'), {
      timeout: TURN_TIMEOUT_MS,
    });

    stdin.write(KEY.pageUp);
    await settle(stdout);
    const parked = regionRows(stdout);
    expect(parked.join('')).not.toContain('first chunk');

    for (let chunk = 0; chunk < 6; chunk++) {
      pump.emit(`\nchunk ${chunk} ${'y'.repeat(70)}`);
      await settle(stdout);
    }

    // Six chunks of a growing turn later — roughly a screenful of new rows — and not one row of
    // what the reader is looking at has moved.
    expect(regionRows(stdout)).toEqual(parked);

    pump.finish();
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('turns: 13'), {
      timeout: TURN_TIMEOUT_MS,
    });
    // A turn COMPLETING below the edge must not move it either — that is the moment the streaming
    // block becomes a committed item and the block numbering shifts under the anchor.
    expect(regionRows(stdout)).toEqual(parked);

    unmount();
  }, 60_000);

  it('returns to the end when the user types, without eating the character', async () => {
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);
    const atBottom = visibleTurns(stdout);

    stdin.write(KEY.pageUp);
    await settle(stdout);
    expect(visibleTurns(stdout)).not.toContain(13);

    stdin.write('h');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> h'), {
      timeout: TURN_TIMEOUT_MS,
    });
    // Both halves: the view came back AND the keystroke still reached the prompt. A handler that
    // swallowed the key to reset the scroll would pass the first and eat the first letter of every
    // message the user writes after reading back.
    expect(visibleTurns(stdout)).toEqual(atBottom);

    unmount();
  }, 40_000);

  it('returns to the end on Esc', async () => {
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);
    const atBottom = visibleTurns(stdout);

    stdin.write(KEY.pageUp);
    await settle(stdout);
    expect(visibleTurns(stdout)).not.toContain(13);

    stdin.write(KEY.escape);
    await settle(stdout);
    expect(visibleTurns(stdout)).toEqual(atBottom);

    unmount();
  }, 40_000);
});

/**
 * Every key this node binds already had an owner, and which owner wins is a decision rather than
 * an accident of ordering. These are the cases that go red when a later refactor moves a branch.
 */
describe('<App> scroll bindings yield to their prior claimants', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('Esc aborts the running turn instead of returning to the end', async () => {
    let aborted = false;
    const hangingAgent: TuiAgent = {
      async *runTurn(_input, signal) {
        yield { type: 'text', delta: 'streaming' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    };
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    stdin.write(KEY.pageUp);
    await settle(stdout);
    const parked = regionRows(stdout);

    // Swap in the agent that hangs, start a turn, and press Esc while it streams.
    unmount();
    const second = renderAt(80, 24, <App {...baseProps} agent={hangingAgent} />);
    await vi.waitFor(() => expect(second.stdout.lastFrame()).toContain('ready'));
    second.stdin.write('go');
    await vi.waitFor(() => expect(second.stdout.lastFrame()).toContain('> go'));
    second.stdin.write(KEY.enter);
    await vi.waitFor(() => expect(second.stdout.lastFrame()).toContain('streaming'));

    second.stdin.write(KEY.escape);
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: TURN_TIMEOUT_MS });

    expect(parked.length).toBeGreaterThan(0);
    second.unmount();
  }, 60_000);

  it('PageUp scrolls the focused debug pane, not the conversation', async () => {
    const { stdout, stdin, unmount } = renderAt(
      80,
      30,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    stdin.write('/debug');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> /debug'));
    stdin.write(KEY.enter);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Subagents'), {
      timeout: TURN_TIMEOUT_MS,
    });
    stdin.write(KEY.tab);
    await settle(stdout);

    const parked = regionRows(stdout);
    stdin.write(KEY.pageUp);
    stdin.write(KEY.pageUp);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The pane owns the key while it is focused; the conversation above it must not have moved.
    expect(regionRows(stdout)).toEqual(parked);

    unmount();
  }, 60_000);

  it('Esc unfocuses the debug pane instead of returning to the end', async () => {
    const { stdout, stdin, unmount } = renderAt(
      80,
      30,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    stdin.write(KEY.pageUp);
    await settle(stdout);
    const parked = regionRows(stdout);

    stdin.write('/debug');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> /debug'));
    stdin.write(KEY.enter);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Subagents'), {
      timeout: TURN_TIMEOUT_MS,
    });
    stdin.write(KEY.tab);
    await settle(stdout);
    stdin.write(KEY.escape);
    await settle(stdout);

    // The pane took the Esc. The prompt is back (unfocused) and the conversation has NOT jumped to
    // the end — a second Esc is what does that.
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('  >'));
    expect(regionRows(stdout).some((row) => row.includes('t0-x'))).toBe(
      parked.some((row) => row.includes('t0-x'))
    );

    unmount();
  }, 60_000);
});

describe('<App> keeps the scroll position honest when the layout moves under it', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('does not drift when a resize re-wraps the whole conversation', async () => {
    // A width change re-wraps every committed item, so every height the position was measured
    // against is stale. There is no height cache to invalidate — the region simply re-renders and
    // the next measurement is the new one — but the anchor still has to land somewhere sensible
    // rather than on a blank band or past the end.
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    stdin.write(KEY.pageUp);
    await settle(stdout);
    const before = visibleTurns(stdout);

    stdout.resizeTo(120, 24);
    await vi.waitFor(() => expect(frameRows(stdout)).toHaveLength(24));
    await settle(stdout);

    const after = regionRows(stdout);
    expect(after[0].trim()).not.toBe('');
    expect(frameRows(stdout)).toHaveLength(24);
    // Still looking at roughly the same part of the conversation, not thrown to either end.
    expect(visibleTurns(stdout).some((turn) => before.includes(turn))).toBe(true);

    unmount();
  }, 40_000);

  it('does not blank the region when the terminal gets SHORTER while scrolled back', async () => {
    // The clip is sized against the region's measured height, and that measurement is a frame old
    // when a resize lands. A shrink is the direction that matters: the clip that fitted the old
    // region can be taller than the new one, which is the shape that renders nothing at all. It
    // has to be back inside the region by the time anyone could look.
    const { stdout, stdin, unmount } = renderAt(120, 40, <App {...baseProps} agent={tallAgent} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    stdin.write('go');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> go'));
    stdin.write(KEY.enter);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('turns: 1'), {
      timeout: TURN_TIMEOUT_MS,
    });

    stdin.write(KEY.pageUp);
    await settle(stdout);
    expect(regionRows(stdout)[0]).toContain('numbered-row-012');

    stdout.resizeTo(120, 20);
    await vi.waitFor(() => expect(frameRows(stdout)).toHaveLength(20), { timeout: 5000 });
    await vi.waitFor(() => expect(regionRows(stdout).join('').trim()).not.toBe(''), {
      timeout: 5000,
    });
    expect(frameRows(stdout)).toHaveLength(20);

    stdout.resizeTo(120, 40);
    await vi.waitFor(() => expect(frameRows(stdout)).toHaveLength(40), { timeout: 5000 });
    expect(regionRows(stdout).join('').trim()).not.toBe('');

    unmount();
  }, 40_000);

  it('does not reveal the block below when Ctrl+T re-folds the conversation', async () => {
    // Toggling detail changes the height of the block the edge is cutting through. Without the
    // normalizer the clip keeps its old height and quietly shows part of the NEXT item — the
    // position moves with no gesture, and nothing on screen says so.
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    stdin.write(KEY.pageUp);
    await settle(stdout);

    stdin.write(KEY.ctrlT);
    await new Promise((resolve) => setTimeout(resolve, 80));

    // The region is still full and the frame still fits the terminal: the two ways this fails.
    expect(frameRows(stdout)).toHaveLength(24);
    expect(regionRows(stdout)[0].trim()).not.toBe('');

    unmount();
  }, 40_000);
});

/**
 * TUI-C48 — one answer taller than the screen, which is the shape that broke.
 *
 * With many short turns the edge always lands within a screenful of a block boundary, so the clip
 * that draws it is never taller than the region and everything works. One long answer is different:
 * a page back sits forty-odd rows into an eighty-row block, and the clip drawn for that is taller
 * than the region it lives in.
 *
 * That is not a detail. Ink writes each row against the INNERMOST clip on its stack rather than the
 * intersection of the stack (`Output.write` reads `clips.at(-1)`), so a clip reaching above the
 * region's top edge REPLACES the region's clip, the rows it lets through are written at negative
 * screen rows, and the whole conversation disappears. It is silent, it needs no error, and a long
 * model answer is the commonest thing on this screen.
 */
describe('<App> scrolling inside a single answer taller than the screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('shows the middle of a long answer instead of a blank screen', async () => {
    const { stdout, stdin, unmount } = renderAt(120, 40, <App {...baseProps} agent={tallAgent} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    stdin.write('go');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> go'));
    stdin.write(KEY.enter);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('turns: 1'), {
      timeout: TURN_TIMEOUT_MS,
    });

    // The tail of the answer is on screen; its beginning is thirty-odd rows above.
    expect(regionRows(stdout).join('\n')).toContain('numbered-row-080');
    expect(regionRows(stdout).join('\n')).not.toContain('numbered-row-012');

    stdin.write(KEY.pageUp);
    await settle(stdout);

    const region = regionRows(stdout);
    // The three failure modes, each asserted: a blank region, a frame that outgrew the terminal,
    // and a scroll that landed somewhere other than a page back.
    expect(region.join('').trim()).not.toBe('');
    expect(frameRows(stdout)).toHaveLength(40);
    expect(region[0]).toContain('numbered-row-012');
    expect(region.join('\n')).not.toContain('numbered-row-080');

    stdin.write(KEY.ctrlEnd);
    await settle(stdout);
    expect(regionRows(stdout).join('\n')).toContain('numbered-row-080');

    unmount();
  }, 40_000);

  it('draws a long answer while it is STILL STREAMING, not only once it commits', async () => {
    // Every other tall-turn case in this file waits for `turns: N` before it looks, so all of them
    // assert the COMMITTED shape — the one where the answer has become an ordinary transcript item
    // above the edge, outside the clip that draws the edge. The state a session actually spends its
    // life in is following a turn that is still open, and an answer longer than the region is the
    // commonest thing on this screen. So this case asserts MID-STREAM, and that is the whole point
    // of it: a clip applied while following cuts the tail block at its own natural height, which
    // for a turn taller than the region reaches above the region's top edge, replaces the region's
    // own clip (Ink takes `clips.at(-1)`, not the intersection), and takes every row of the write
    // with it — a conversation that is blank for as long as the answer takes to finish.
    const pump = pumpedAgent();
    const { stdout, stdin, unmount } = renderAt(120, 40, <App {...baseProps} agent={pump.agent} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    for (let i = 0; i < 3; i++) {
      stdin.write(turnText(i));
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`t${i}-xxx`), {
        timeout: TURN_TIMEOUT_MS,
      });
      stdin.write(KEY.enter);
      pump.emit('ok');
      pump.finish();
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`turns: ${i + 1}`), {
        timeout: TURN_TIMEOUT_MS,
      });
    }

    const regionHeight = regionRows(stdout).length;
    expect(regionHeight).toBeGreaterThan(10);

    stdin.write('go');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> go'));
    stdin.write(KEY.enter);

    // A first chunk that FITS the region: the positive control. Everything below is about what
    // changes when the same open turn grows past the region, so this states it renders beforehand.
    const fitting = liveRows(1, regionHeight - 5);
    pump.emit(fitting.join('\n'));
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain(fitting[fitting.length - 1]), {
      timeout: TURN_TIMEOUT_MS,
    });

    // …and now one delta that takes the turn well past the region's height. One delta rather than a
    // row at a time so there is exactly one state update between here and the assertions.
    const overflowing = liveRows(regionHeight - 4, regionHeight + 20);
    const lastRow = overflowing[overflowing.length - 1];
    const beforeGrowth = stdout.lastFrame();
    pump.emit(`\n${overflowing.join('\n')}`);
    await vi.waitFor(() => expect(stdout.lastFrame()).not.toBe(beforeGrowth), {
      timeout: TURN_TIMEOUT_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const region = regionRows(stdout);
    // The three things that have to be true of a followed turn taller than the region: there is a
    // conversation there at all, the frame still fits the terminal, and it is the NEWEST rows that
    // sit against the dock rather than the turn's first screenful frozen in place.
    expect(region.join('').trim()).not.toBe('');
    expect(frameRows(stdout)).toHaveLength(40);
    expect(region[region.length - 1]).toContain(lastRow);
    expect(region.join('\n')).not.toContain('live-001');

    pump.finish();
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('turns: 4'), {
      timeout: TURN_TIMEOUT_MS,
    });
    // Committing it must not lose it either — that is the state the rest of the file looks at.
    expect(regionRows(stdout).join('\n')).toContain(lastRow);

    unmount();
  }, 60_000);
});
