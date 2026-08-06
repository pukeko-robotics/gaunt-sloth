import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent, TuiDebugCapture } from '#src/tui/types.js';
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
  emit: (event: AgentStreamEvent | string) => void;
  finish: () => void;
  /** Whether the session aborted the open turn — Esc's first meaning. */
  wasAborted: () => boolean;
} {
  // A queue with an explicit end marker rather than a flag, so a test may queue a whole turn before
  // the generator has even started without the end overtaking the chunks.
  const pending: (AgentStreamEvent | typeof END_OF_TURN)[] = [];
  let wake: (() => void) | null = null;
  let aborted = false;
  const nudge = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    agent: {
      async *runTurn(_input, signal): AsyncGenerator<AgentStreamEvent> {
        signal.addEventListener('abort', () => {
          aborted = true;
          nudge();
        });
        for (;;) {
          while (pending.length) {
            const next = pending.shift() as AgentStreamEvent | typeof END_OF_TURN;
            if (next === END_OF_TURN) return;
            yield next;
          }
          if (signal.aborted) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    emit: (event: AgentStreamEvent | string) => {
      pending.push(typeof event === 'string' ? { type: 'text', delta: event } : event);
      nudge();
    },
    finish: () => {
      pending.push(END_OF_TURN);
      nudge();
    },
    wasAborted: () => aborted,
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

/**
 * The docked debug pane's own scroll status: the `first-last/total` range it prints below its
 * viewport whenever the section is taller than the window. It is the only thing on screen that
 * distinguishes "the pane paged" from "the key went nowhere", and the pane prints it as a plain
 * line count instead when nothing overflows — so an empty match is a fixture that gave the pane
 * nothing to scroll, not a pane that refused to.
 */
function paneRange(stdout: SizedStdout): string {
  const match = frameRows(stdout)
    .map((row) => row.match(/\d+-\d+\/\d+/))
    .find((m) => m !== null);
  return match ? match[0] : '';
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

/** Turn numbers drawn in a captured set of region rows. */
function turnsIn(rows: string[]): number[] {
  return [
    ...new Set(rows.flatMap((row) => [...row.matchAll(/t(\d+)-x/g)].map((m) => Number(m[1])))),
  ].sort((a, b) => a - b);
}

/** Turn numbers currently drawn in the conversation region. */
function visibleTurns(stdout: SizedStdout): number[] {
  return turnsIn(regionRows(stdout));
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
    //
    // The gesture is a WHEEL NOTCH over a THIRTY-ROW first chunk, and both halves are the case.
    // The edge is held as a count of rows from the TOP of the block it cuts rather than from that
    // block's bottom, and for a block that is not growing the two are the same number — so an edge
    // parked in committed conversation cannot tell them apart however long a turn streams below
    // it. Only an edge sitting INSIDE the growing block does, and landing one there needs a tail
    // taller than the gesture: a page clears a thirty-row tail outright, a three-row notch lands
    // three rows into it.
    const mouse = fakeMouse();
    const pump = pumpedAgent();
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={pump.agent} mouseEnabled subscribeMouse={mouse.subscribe} />
    );
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

    // A thirteenth turn that stays open, so the spec can grow it a chunk at a time — opening with
    // thirty rows, ten times the wheel notch that follows.
    stdin.write('grow');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> grow'));
    stdin.write(KEY.enter);
    pump.emit(liveRows(1, 30).join('\n'));
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('live-030'), {
      timeout: TURN_TIMEOUT_MS,
    });

    mouse.wheel('up');
    await settle(stdout);
    const parked = regionRows(stdout);
    // The edge is three rows up from the newest row, which puts it INSIDE the streaming block —
    // the only position at which the two conventions disagree, and so the only one worth holding
    // still. Named rather than implied: without this the case could park anywhere and still pass.
    expect(parked[parked.length - 1]).toContain('live-027');

    for (let chunk = 0; chunk < 6; chunk++) {
      pump.emit(`\nchunk ${chunk} ${'y'.repeat(70)}`);
      await settle(stdout);
    }

    // Six chunks of a growing turn later — roughly a screenful of new rows — and not one row of
    // what the reader is looking at has moved. Counted from the block's BOTTOM the edge would have
    // walked down with every chunk, and this row would now be six chunks further on.
    expect(regionRows(stdout)[regionRows(stdout).length - 1]).toContain('live-027');
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
    // Both halves in ONE session, because the claim is about which owner takes the key: the abort
    // landed, AND the view the reader had parked is exactly where they left it. Two sessions could
    // only ever have said "an abort works somewhere and a page-up works somewhere else".
    const pump = pumpedAgent();
    const { stdout, stdin, unmount } = renderAt(80, 24, <App {...baseProps} agent={pump.agent} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    for (let i = 0; i < 14; i++) {
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
    const atEnd = visibleTurns(stdout);

    // A fifteenth turn that stays open, so Esc has a running turn to abort.
    stdin.write('go');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> go'));
    stdin.write(KEY.enter);
    pump.emit('streaming');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('streaming'), {
      timeout: TURN_TIMEOUT_MS,
    });

    stdin.write(KEY.pageUp);
    await settle(stdout);
    const parked = regionRows(stdout);
    // Control: the page really moved the view, so "still parked" below is a statement about
    // something. Without it both outcomes would be the same screen.
    expect(turnsIn(parked)).not.toEqual(atEnd);

    stdin.write(KEY.escape);
    await vi.waitFor(() => expect(pump.wasAborted()).toBe(true), { timeout: TURN_TIMEOUT_MS });
    // A fixed wait rather than a frame wait: an Esc that was correctly swallowed by the abort has
    // no reason to draw anything, so "the next frame" is not an event this can wait on.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Esc went to the abort, not to the scroll: the reader is still reading what they were.
    expect(visibleTurns(stdout)).not.toEqual(atEnd);
    expect(regionRows(stdout)).toEqual(parked);

    unmount();
  }, 60_000);

  it('PageUp scrolls the focused debug pane, not the conversation', async () => {
    // Both halves of the name, and the second is the one that was missing: a change that broke the
    // PANE's own paging would leave "the conversation did not move" perfectly true. So the pane is
    // given a section long enough to overflow its viewport — its footer reports the line range it
    // is showing — and that range is what the assertions are about.
    let pushDebug: ((capture: TuiDebugCapture) => void) | null = null;
    const { stdout, stdin, unmount } = renderAt(
      80,
      30,
      <App
        {...baseProps}
        agent={replyingAgent}
        subscribeDebug={(cb) => {
          pushDebug = cb;
          return () => {
            pushDebug = null;
          };
        }}
      />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    await converse(stdout, stdin, 14);

    stdin.write('/debug');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> /debug'));
    stdin.write(KEY.enter);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Subagents'), {
      timeout: TURN_TIMEOUT_MS,
    });
    pushDebug?.({
      kind: 'request',
      text: 'history',
      system: Array.from({ length: 60 }, (_, i) => `sys-${String(i + 1).padStart(3, '0')}`).join(
        '\n'
      ),
      tools: 'tools',
      mcp: 'mcp',
    });
    // Focus the pane, then step it on to the section that has those sixty lines.
    stdin.write(KEY.tab);
    await settle(stdout);
    stdin.write(KEY.tab);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('/60'), {
      timeout: TURN_TIMEOUT_MS,
    });

    // Page the pane down first, so PageUp has somewhere to come back from.
    stdin.write(KEY.pageDown);
    await vi.waitFor(() => expect(paneRange(stdout)).not.toMatch(/^1-/), {
      timeout: TURN_TIMEOUT_MS,
    });
    const parked = regionRows(stdout);
    const pagedDown = paneRange(stdout);

    stdin.write(KEY.pageUp);
    await vi.waitFor(() => expect(paneRange(stdout)).not.toBe(pagedDown), {
      timeout: TURN_TIMEOUT_MS,
    });

    // The pane moved back up — the key reached its owner and did the thing it is bound to.
    expect(paneRange(stdout)).toMatch(/^1-/);
    // …and the conversation above it did not move a row.
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

    // The pane is opened BEFORE the reader parks, because typing is itself defined to return the
    // view to the end — parking first and then typing `/debug` would have thrown the position away
    // before Esc was ever pressed, and left the case comparing the end against the end.
    stdin.write('/debug');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> /debug'));
    stdin.write(KEY.enter);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Subagents'), {
      timeout: TURN_TIMEOUT_MS,
    });
    const atEnd = visibleTurns(stdout);

    stdin.write(KEY.pageUp);
    await settle(stdout);
    const parkedTurns = visibleTurns(stdout);
    // Control: parked and at-the-end are different screens, so the comparison after the Esc says
    // something. Naming one old turn that is off screen in both would not.
    expect(parkedTurns).not.toEqual(atEnd);

    stdin.write(KEY.tab);
    await settle(stdout);
    stdin.write(KEY.escape);
    await settle(stdout);

    // The pane took the Esc. The prompt is back (unfocused) and the conversation has NOT jumped to
    // the end — a second Esc is what does that.
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('  >'));
    expect(visibleTurns(stdout)).toEqual(parkedTurns);

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
    //
    // Three things here are what make the toggle actually reach that path, and none of them is
    // incidental: the turns carry TOOL PANELS, so there is something to fold; `/verbose` expands
    // them first, so the keystroke makes blocks SHORTER, which is the direction that over-runs an
    // edge; and a turn is left OPEN, because Ctrl+T is bound only while one is running — idle, the
    // prompt owns the key and types a stray character instead.
    const mouse = fakeMouse();
    const pump = pumpedAgent();
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={pump.agent} mouseEnabled subscribeMouse={mouse.subscribe} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    for (let i = 0; i < 8; i++) {
      stdin.write(turnText(i));
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`t${i}-xxx`), {
        timeout: TURN_TIMEOUT_MS,
      });
      stdin.write(KEY.enter);
      pump.emit({ type: 'tool_start', id: `call-${i}`, name: 'read_file' });
      pump.emit({ type: 'tool_args', id: `call-${i}`, delta: `{"path":"file-${i}.ts"}` });
      pump.emit({ type: 'tool_end', id: `call-${i}` });
      pump.emit({
        type: 'tool_result',
        id: `call-${i}`,
        content: Array.from({ length: 6 }, (_, line) => `result-${i}-line-${line}`).join('\n'),
      });
      // A per-turn last row, so the assertions below can name the row the edge sits on.
      pump.emit(`answer-${i}`);
      pump.finish();
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`turns: ${i + 1}`), {
        timeout: TURN_TIMEOUT_MS,
      });
    }

    // Expand every committed panel, so there is height to lose.
    stdin.write('/verbose');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> /verbose'));
    stdin.write(KEY.enter);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('result-7-line-'), {
      timeout: TURN_TIMEOUT_MS,
    });

    // A ninth turn that stays open, so Ctrl+T is live.
    stdin.write('go');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> go'));
    stdin.write(KEY.enter);
    pump.emit('streaming');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('streaming'), {
      timeout: TURN_TIMEOUT_MS,
    });

    stdin.write(KEY.pageUp);
    await settle(stdout);

    // Walk the edge up until it sits on the LAST row of an assistant block. That position is the
    // whole point: it is where a block that then gets SHORTER leaves the edge past its own bottom,
    // and an edge that is not brought back inside uncovers the block below. Parked anywhere in a
    // user item — which the toggle cannot resize — the case would exercise nothing. A bounded walk
    // with an assertion on the outcome, so it cannot silently stop finding that position.
    let onBlockEnd = false;
    for (let notch = 0; notch < 12 && !onBlockEnd; notch++) {
      const rows = regionRows(stdout);
      if (/answer-\d/.test(rows[rows.length - 1] ?? '')) onBlockEnd = true;
      else {
        mouse.wheel('up');
        await settle(stdout);
      }
    }
    expect(onBlockEnd).toBe(true);

    const before = regionRows(stdout);
    const argsLine = /^\s*args: /m;
    // Control on the fixture: there IS an expanded panel inside the parked view, so the keystroke
    // below has something to change. Without this the case would pass over a conversation the
    // toggle cannot touch, which is exactly how it passed while doing nothing.
    expect(before.join('\n')).toMatch(argsLine);

    stdin.write(KEY.ctrlT);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = regionRows(stdout);

    // The region is still full and the frame still fits the terminal. These two hold for any
    // viewport that renders at all, so they are kept first and deliberately not relied on.
    expect(frameRows(stdout)).toHaveLength(24);
    expect(after[0].trim()).not.toBe('');
    // Control on the keystroke: it landed and it folded. The expanded body is gone from the view.
    expect(after.join('\n')).not.toMatch(argsLine);
    // The behaviour the case is named for. Every block on screen just lost a row, so an edge held
    // as anything other than a position inside its own block would slide down and uncover what
    // sits below it — the bottom row of the region is precisely where that shows.
    expect(after[after.length - 1]).toBe(before[before.length - 1]);
    expect(Math.max(...turnsIn(after))).toBe(Math.max(...turnsIn(before)));

    unmount();
  }, 60_000);
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
