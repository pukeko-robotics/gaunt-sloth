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

class FakeStdin extends EventEmitter {
  isTTY = true;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => null;
}

const idleAgent: TuiAgent = {
  async *runTurn(): AsyncGenerator<AgentStreamEvent> {},
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
  return { stdout, instance, rerender: instance.rerender, unmount: instance.unmount };
}

const frameRows = (stdout: SizedStdout) => (stdout.lastFrame() ?? '').split('\n');

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
    // A long conversation plus a debug panel on a short terminal: the clamp is the ONLY thing
    // between this and a frame whose top rows are lost off-screen. Without the fixed height the
    // frame here is ~40 rows on a 14-row terminal and nothing reports it.
    const rows = 14;
    const { stdout, unmount } = renderAt(80, rows, <App {...baseProps} advisories={['bad key']} />);
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready'));

    expect(frameRows(stdout)).toHaveLength(rows);

    unmount();
  });

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
});
