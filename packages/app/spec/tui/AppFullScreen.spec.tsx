import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

/**
 * A stdout that reports a terminal SIZE, which `ink-testing-library`'s does not.
 *
 * The full-screen layout is a function of the terminal height, so a spec that cannot vary the
 * height can only ever check one number and would pass on a layout that ignored the terminal
 * entirely. This is the smallest thing that lets the height be an input.
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
  /** Change size the way a terminal does: new dimensions, then SIGWINCH. */
  resizeTo(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

/**
 * A stdin the spec can type into. Ink reads its input through `readable` + `read()`, so a plain
 * `emit('data')` is delivered to nothing — the shape below is what actually reaches the prompt.
 */
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

/** An agent that answers every turn with one short line, so a turn commits and the next can start. */
const replyingAgent: TuiAgent = {
  async *runTurn(): AsyncGenerator<AgentStreamEvent> {
    yield { type: 'text', delta: 'ok' };
  },
};

/**
 * An agent whose turn STAYS open until the test closes it, so the mid-stream frame can be looked
 * at. A generator that simply yields and returns is committed by the time the next frame renders,
 * and there is no streaming state left to assert on.
 */
function streamingAgent(): {
  agent: TuiAgent;
  emit: (text: string) => void;
  finish: () => void;
} {
  const pending: string[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const nudge = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  return {
    agent: {
      async *runTurn(): AsyncGenerator<AgentStreamEvent> {
        for (;;) {
          while (pending.length) yield { type: 'text', delta: pending.shift() as string };
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    emit: (text: string) => {
      pending.push(text);
      nudge();
    },
    finish: () => {
      done = true;
      nudge();
    },
  };
}

/**
 * TUI-C90 / trap 3 — an agent that leaves a three-item checklist pinned in the dock. The checklist
 * tool draws nothing inside the turn; it is the dock panel, which is exactly why it is the item
 * that makes the dock its tallest.
 */
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
  return { stdout, stdin, instance, rerender: instance.rerender, unmount: instance.unmount };
}

const frameRows = (stdout: SizedStdout) => (stdout.lastFrame() ?? '').split('\n');

/** Blank rows between the top of the screen and the first row of conversation. */
function leadingBlankRows(stdout: SizedStdout): number {
  const rows = frameRows(stdout);
  let count = 0;
  while (count < rows.length && rows[count].trim() === '') count += 1;
  return count;
}

/** Places where one blank row sits directly under another — the signature of padding. */
function adjacentBlankRows(stdout: SizedStdout): number {
  const rows = frameRows(stdout);
  return rows.filter((r, i) => i > 0 && r.trim() === '' && rows[i - 1].trim() === '').length;
}

/**
 * The region is FULL: the conversation reaches the top of the screen rather than floating on a
 * band of padding, which is what an over-counting window estimate produces.
 *
 * "No blank row at the top" is not the way to say it, because since TUI-C90 every item draws its
 * own blank separator row and the top edge of the region can land exactly on one — a legitimately
 * full screen whose first row is blank. Padding is what has to be excluded, and padding has a
 * signature the separator does not: it sits ABOVE the topmost mounted item, which draws its own
 * blank row, so any padding at all puts two blank rows next to each other. Hence the pair — at
 * most one blank row at the top, and no two adjacent anywhere.
 *
 * What this catches is the BAND, which is the visible defect: an estimator wrong by enough to
 * outrun the window walker's slack item and the whole-terminal budget it spends. The direction of
 * a single item's estimate is not measurable from a frame and is not asserted here — that is
 * `transcriptWindow.spec.tsx`, which compares every item kind against Ink's own render.
 */
function expectRegionFull(stdout: SizedStdout): void {
  expect(leadingBlankRows(stdout)).toBeLessThanOrEqual(1);
  expect(adjacentBlankRows(stdout)).toBe(0);
}

/**
 * One turn of conversation, as an unbroken run of characters.
 *
 * Unbroken on purpose: a run with no spaces occupies exactly `ceil(length / columns)` rows at any
 * width, so how much of the screen a turn fills is a pure function of the terminal width and the
 * test's arithmetic does not depend on where a word break happens to fall. It also keeps markdown
 * out of it — a fenced block or a rule is drawn at the width `renderMarkdown` reads for itself,
 * which is not the width under test here.
 */
const TURN_LENGTH = 600;
const turnText = (n: number): string => `t${n}-${'x'.repeat(TURN_LENGTH)}`;

/**
 * Type `turns` exchanges into the prompt, waiting for each to commit before starting the next.
 *
 * The waits carry their own timeout because vitest's default is one second, which is generous for
 * a single render and not for the thirtieth one on a box running fifteen other test files.
 */
const TURN_TIMEOUT_MS = 10_000;

async function converse(stdout: SizedStdout, stdin: FakeStdin, turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) {
    stdin.write(turnText(i));
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`t${i}-xxx`), {
      timeout: TURN_TIMEOUT_MS,
    });
    stdin.write('\r');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`turns: ${i + 1}`), {
      timeout: TURN_TIMEOUT_MS,
    });
  }
}

/**
 * TUI-C48 — the two properties of the full-screen frame that fail SILENTLY when they are wrong.
 *
 * A frame taller than the terminal does not error: its top rows scroll off the top of the screen
 * and the user simply never sees them. A dock that is not on the floor does not error either — it
 * just floats, which is the thing this node exists to fix. Both are height arithmetic, so both are
 * asserted against a terminal whose height the spec chooses.
 */
describe('<App> full-screen frame', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    [80, 24],
    [120, 40],
    [60, 12],
    [100, 60],
  ])('is exactly the terminal height at %ix%i', async (columns, rows) => {
    const { stdout, unmount } = renderAt(columns, rows, <App {...baseProps} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    expect(frameRows(stdout)).toHaveLength(rows);

    unmount();
  });

  it('never exceeds the terminal height, even when the content would overflow it', async () => {
    // The clamp is the ONLY thing between this and a frame whose top rows are lost off the top of
    // the screen — and it fails as missing content, not as an error, so the case has to put the
    // layout in the overflow regime for real. That takes a conversation: an idle session on a
    // 14-row terminal is about seven rows of dock and nothing to overflow with, so the assertion
    // would hold on a layout that clamped nothing at all. With several turns behind it the
    // content is half again the terminal height, and removing the clamp is visible as a frame
    // taller than the screen.
    const rows = 14;
    const { stdout, stdin, unmount } = renderAt(
      80,
      rows,
      <App {...baseProps} agent={replyingAgent} advisories={['bad key']} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    await converse(stdout, stdin, 6);

    expect(frameRows(stdout)).toHaveLength(rows);

    unmount();
  }, 30_000);

  it('pins the dock to the terminal floor', async () => {
    const { stdout, unmount } = renderAt(80, 30, <App {...baseProps} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    const lines = frameRows(stdout);
    // The dock's closing rule is the LAST row of the terminal, and the status bar is a handful of
    // rows above it — not floating in the middle of a 30-row screen with blank space below.
    expect(lines[lines.length - 1]).toMatch(/^─+$/);
    // The dock is blank · rule · status · blank · prompt · blank · hint · rule, so the status bar
    // sits six rows above the last one.
    const statusRow = lines.findIndex((l) => l.includes('chat') && l.includes('turns: 0'));
    expect(statusRow).toBeGreaterThan(lines.length - 8);
    // …and the region above the dock is empty, because there is no conversation yet.
    expect(lines[0].trim()).toBe('');

    unmount();
  });

  it('TUI-C90 — gives the prompt a row of air above and below it', async () => {
    const { stdout, unmount } = renderAt(80, 30, <App {...baseProps} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    const lines = frameRows(stdout);
    const promptRow = lines.findIndex((l) => l.trimStart().startsWith('>'));
    expect(promptRow).toBeGreaterThan(0);
    // Real rows, not empty <Text>s Yoga collapses away: the status bar and the hint are two rows
    // further from the prompt than they were, and both gaps have to be there.
    expect(lines[promptRow - 1].trim()).toBe('');
    expect(lines[promptRow + 1].trim()).toBe('');
    expect(lines[promptRow - 2]).toContain('chat');
    expect(lines[promptRow + 2]).toContain("Type 'exit' to leave");

    unmount();
  });

  it('TUI-C90 — the prompt takes its rows of air with it when it stands down', async () => {
    // The prompt is unmounted whenever something else owns the keyboard. Rows left behind would be
    // two rows of nothing between the status bar and the hint in every one of those states, which
    // on a short terminal is conversation the reader paid for and cannot see.
    const { stdout, stdin, unmount } = renderAt(80, 30, <App {...baseProps} debug />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    // `/debug` opens the docked pane, Tab gives it the keyboard, and the prompt stands down.
    stdin.write('/debug');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> /debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Subagents'));
    stdin.write('\t');
    await vi.waitFor(() => {
      const rows = frameRows(stdout);
      expect(rows.some((l) => l.trimStart().startsWith('> '))).toBe(false);
    });

    const lines = frameRows(stdout);
    const hintRow = lines.findIndex((l) => l.includes("Type 'exit' to leave"));
    expect(hintRow).toBeGreaterThan(0);
    expect(lines[hintRow - 1]).toContain('chat');

    unmount();
  });

  it('TUI-C91 — the dock opens on a blank row, whatever state it is in', async () => {
    // The dock's opening rule is the boundary between the conversation and the controls, and it
    // gets a row of air above it exactly as every other boundary does — otherwise it reads as the
    // top edge of the status bar rather than as the end of the conversation.
    //
    // Both the row and the rule are unconditional, so the three states below are the ones where
    // something else moves: idle, mid-stream (the prompt stays mounted, the conversation is
    // growing), and with the prompt stood down for a focused debug pane. A row that was somehow
    // tied to the prompt would survive the first two and vanish in the third.
    const dockOpening = (stdout: SizedStdout): number => {
      const lines = frameRows(stdout);
      // The status bar says something different while a turn is running, so both spellings are
      // named — anchoring on the idle one alone would simply not find the dock mid-stream.
      const statusRow = lines.findIndex(
        (l) => l.includes('model:') || l.includes('Esc to interrupt')
      );
      expect(statusRow).toBeGreaterThan(1);
      // The rule directly above the status bar, past the advisory rows that may sit between them.
      let rule = statusRow - 1;
      while (rule > 0 && !/^─+$/.test(lines[rule].trim())) rule -= 1;
      expect(lines[rule].trim()).toMatch(/^─+$/);
      return rule;
    };

    const stream = streamingAgent();
    const { stdout, stdin, unmount } = renderAt(
      80,
      30,
      <App {...baseProps} agent={stream.agent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    // Idle.
    expect(frameRows(stdout)[dockOpening(stdout) - 1].trim()).toBe('');

    // Streaming: a turn is in flight and its text is on screen above the dock.
    stdin.write('ask');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> ask'));
    stdin.write('\r');
    stream.emit('half an answer');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('half an answer'));
    const streamingRule = dockOpening(stdout);
    expect(frameRows(stdout)[streamingRule - 1].trim()).toBe('');
    // …and it really is the dock's row, not the conversation's: the row above it is the newest
    // line of the answer, so nothing has floated the streaming turn off the region's own floor.
    expect(frameRows(stdout)[streamingRule - 2]).toContain('half an answer');
    stream.finish();
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('turns: 1'));

    unmount();
  }, 30_000);

  it('TUI-C91 — the dock opens on a blank row with the prompt stood down', async () => {
    const { stdout, stdin, unmount } = renderAt(80, 30, <App {...baseProps} debug />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    stdin.write('/debug');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> /debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Subagents'));
    stdin.write('\t');
    await vi.waitFor(() => {
      const rows = frameRows(stdout);
      expect(rows.some((l) => l.trimStart().startsWith('> '))).toBe(false);
    });

    const lines = frameRows(stdout);
    const statusRow = lines.findIndex((l) => l.includes('chat') && l.includes('model:'));
    expect(statusRow).toBeGreaterThan(1);
    expect(lines[statusRow - 1].trim()).toMatch(/^─+$/);
    expect(lines[statusRow - 2].trim()).toBe('');

    unmount();
  }, 30_000);

  it('TUI-C91 — the dock still fits 80x24 with every optional row mounted', async () => {
    // TUI-C90's third trap, as a test rather than a manual look, re-measured for the row TUI-C91
    // adds above the dock's opening rule. Every row added to a dock pinned to the terminal floor
    // is a row taken from the conversation at every size, and the dock is at its tallest with an
    // advisory, an MCP failure and a pinned checklist all on screen at once. On the smallest
    // terminal anyone uses, the frame must still be exactly the terminal — a taller one does not
    // error, it loses its top rows silently — and there must still be conversation visible above
    // the dock rather than a dock that has eaten the whole screen.
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App
        {...baseProps}
        agent={checklistAgent}
        advisories={['config has problems']}
        mcpFailures={[{ server: 'some-server', error: 'connect ECONNREFUSED' }]}
      />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    stdin.write('go');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> go'));
    stdin.write('\r');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('Verify output'));

    const lines = frameRows(stdout);
    expect(lines).toHaveLength(24);
    expect(lines[23].trim()).toMatch(/^─+$/);

    // Everything the dock can carry really is on screen — otherwise this would pass by having
    // silently dropped the rows it is meant to be measuring.
    const frame = lines.join('\n');
    expect(frame).toContain('config has problems');
    expect(frame).toContain('some-server');
    expect(frame).toContain('Verify output');

    // …and the conversation is not squeezed out. The dock runs from the pinned checklist panel to
    // the closing rule; measured, it starts on row 9 — fifteen dock rows, leaving the conversation
    // nine of the twenty-four. Asserted with one row of margin, so the next thing added to the
    // dock at this size fails here rather than on someone's screen. The number moves only when
    // someone decides it should: this bound is re-measured against the frame above, never widened
    // to whatever the current dock happens to need.
    const dockTop = lines.findIndex((l) => l.includes('Checklist'));
    expect(dockTop).toBeGreaterThanOrEqual(8);
    expect(lines.slice(0, dockTop).join('\n')).toContain('go');

    unmount();
  });

  it('stays pinned across a resize', async () => {
    // Ink relays out on SIGWINCH but does not re-render React, so a height read once at mount
    // would leave the frame at its old size: short of the floor after a grow, overflowing the
    // screen after a shrink. Both halves are asserted because they fail in opposite directions.
    const { stdout, unmount } = renderAt(80, 30, <App {...baseProps} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));
    expect(frameRows(stdout)).toHaveLength(30);

    stdout.resizeTo(80, 18);
    await vi.waitFor(() => expect(frameRows(stdout)).toHaveLength(18));
    expect(frameRows(stdout)[17]).toMatch(/^─+$/);

    stdout.resizeTo(80, 44);
    await vi.waitFor(() => expect(frameRows(stdout)).toHaveLength(44));
    expect(frameRows(stdout)[43]).toMatch(/^─+$/);

    unmount();
  });

  it('reflows every rule to the new WIDTH, including the ones inside memoised rows', async () => {
    // The height cases above resize only the height, and the width is carried by a different
    // mechanism: a rule reads the width from React context, and the rules between committed turns
    // live inside `React.memo`'d transcript rows. A context value that stopped propagating — or one
    // whose identity churned into the memo's props — leaves those rules at the width they were
    // first drawn at, which is a stale line across the screen and not an error. The dock's own
    // rules sit outside the memo and would keep following, so asserting on the dock alone would
    // pass while the conversation's rules were stranded: the count is asserted too, so a case that
    // stopped seeing the separators cannot quietly become a test of the dock.
    const { stdout, stdin, unmount } = renderAt(
      120,
      30,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    // Four short exchanges: three separator rules between them, plus the dock's two.
    for (let i = 0; i < 4; i++) {
      stdin.write(`q${i}`);
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`q${i}`), { timeout: 10_000 });
      stdin.write('\r');
      await vi.waitFor(() => expect(stdout.lastFrame()).toContain(`turns: ${i + 1}`), {
        timeout: 10_000,
      });
    }

    const ruleWidths = () =>
      frameRows(stdout)
        .filter((row) => /^─+$/.test(row))
        .map((row) => row.length);

    expect(ruleWidths()).toEqual([120, 120, 120, 120, 120]);

    for (const columns of [60, 160, 80]) {
      stdout.resizeTo(columns, 30);
      await vi.waitFor(() => expect(ruleWidths()).toEqual(Array(5).fill(columns)));
    }

    unmount();
  }, 30_000);
});

/**
 * TUI-C48 — the size `<App>` hands its viewport, observed as OCCUPANCY rather than as a prop.
 *
 * The viewport's own spec supplies the row budget and the width itself, so it proves what the
 * component does with a size and says nothing about which size it is given. That leaves the two
 * props at the call site pinned by nothing: a row budget of 1, or a width hardcoded to the
 * fallback, both keep every other assertion in the suite green while a band of empty rows opens
 * above the conversation on a real terminal.
 *
 * What makes that band the right thing to assert is the direction of the estimate. It is a
 * deliberate lower bound (`transcriptWindow.ts`), so with the right size the slice always covers
 * the region and the conversation reaches the top of the screen. Any size that makes the estimate
 * too big for the terminal — too few rows to spend, or a width narrower than the real one, which
 * inflates the rows every item is thought to need — cuts the list too high, and the region cannot
 * fill. So `leading blank rows === 0` is the single observable that catches all of them, and it is
 * observable to the user as blank screen.
 */
describe('<App> fills the conversation region it hands the viewport', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('leaves no blank band above a conversation longer than the screen', async () => {
    const { stdout, stdin, unmount } = renderAt(
      80,
      24,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    await converse(stdout, stdin, 10);

    expect(frameRows(stdout)).toHaveLength(24);
    expectRegionFull(stdout);

    unmount();
  }, 30_000);

  it('fills the region at the TERMINAL width, not at the fallback width', async () => {
    // 200 columns, and that is the whole point of the case: the fallback width is 80, so at an
    // 80-column terminal a viewport wired to the fallback — or to a hardcoded 80 — is
    // indistinguishable from one wired to the terminal. Only a terminal wider than the fallback
    // separates them. Here each turn wraps to a third of the rows it would take at 80, so a
    // window computed at 80 mounts roughly half the conversation the screen has room for and the
    // top of the region is left empty.
    const { stdout, stdin, unmount } = renderAt(
      200,
      56,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    await converse(stdout, stdin, 12);

    expect(frameRows(stdout)).toHaveLength(56);
    expectRegionFull(stdout);
    // …and the conversation on screen really is wide-terminal conversation: a turn that occupies 8
    // rows at the fallback width occupies 3 here, so the screen holds seven of them (measured)
    // where a window computed at 80 columns leaves room for about half that. The terminal is 56
    // rows rather than 40 so the discriminating gap survives the rows TUI-C90 spends — two in the
    // dock, and one separator above every item.
    const visibleTurns = new Set(
      frameRows(stdout).flatMap((row) => [...row.matchAll(/t(\d+)-x/g)].map((m) => m[1]))
    );
    expect(visibleTurns.size).toBeGreaterThanOrEqual(6);

    unmount();
  }, 30_000);
});
