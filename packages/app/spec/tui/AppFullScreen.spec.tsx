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
    const statusRow = lines.findIndex((l) => l.includes('chat') && l.includes('turns: 0'));
    expect(statusRow).toBeGreaterThan(lines.length - 6);
    // …and the region above the dock is empty, because there is no conversation yet.
    expect(lines[0].trim()).toBe('');

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
    expect(leadingBlankRows(stdout)).toBe(0);

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
      40,
      <App {...baseProps} agent={replyingAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    await converse(stdout, stdin, 12);

    expect(frameRows(stdout)).toHaveLength(40);
    expect(leadingBlankRows(stdout)).toBe(0);
    // …and the conversation on screen really is wide-terminal conversation: a turn that occupies 8
    // rows at the fallback width occupies 3 here, so the screen holds six of them (measured) where
    // a window computed at 80 columns leaves room for four.
    const visibleTurns = new Set(
      frameRows(stdout).flatMap((row) => [...row.matchAll(/t(\d+)-x/g)].map((m) => m[1]))
    );
    expect(visibleTurns.size).toBeGreaterThanOrEqual(5);

    unmount();
  }, 30_000);
});
