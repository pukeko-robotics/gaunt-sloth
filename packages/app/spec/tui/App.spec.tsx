import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

/** A fake agent that replays a fixed event script for each turn. */
function scriptedAgent(events: AgentStreamEvent[]): TuiAgent {
  return {
    async *runTurn() {
      for (const event of events) {
        yield event;
        await Promise.resolve();
      }
    },
  };
}

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' or Ctrl+C to exit chat · /help for commands\n",
};

const ESC = String.fromCharCode(27); // Escape key byte
const TAB = '\t'; // Tab key (char 9)
const PAGE_DOWN = '\x1b[6~'; // PageDown CSI sequence
const PAGE_UP = '\x1b[5~'; // PageUp CSI sequence
const ARROW_DOWN = '\x1b[B'; // Down-arrow CSI sequence
const ARROW_UP = '\x1b[A'; // Up-arrow CSI sequence
const SHIFT_TAB = '\x1b[Z'; // Shift+Tab (back-tab) CSI sequence

describe('tui <App>', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders the user message, a tool-call line, and streamed assistant text', async () => {
    const agent = scriptedAgent([
      { type: 'tool_start', id: 't1', name: 'read_file' },
      { type: 'tool_args', id: 't1', delta: '{"path":"a.ts"}' },
      { type: 'tool_end', id: 't1' },
      { type: 'text', delta: 'Hello ' },
      { type: 'text', delta: 'there' },
    ]);
    const { frames, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="Hi sloth" />
    );

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Hi sloth'); // user line
      expect(all).toContain('read_file'); // tool call
      expect(all).toContain('Hello there'); // streamed assistant text
    });

    unmount();
  });

  it('returns to the ready prompt after a turn completes', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      // Once idle the status bar shows the ready line and the prompt is back.
      expect(lastFrame()).toContain('ready');
      expect(lastFrame()).toContain('>');
    });

    unmount();
  });

  it('surfaces /help in the idle exit hint (TUI-C12)', async () => {
    // The idle hint is the exitMessage; it now also points at /help for command discovery.
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('exit'); // keeps the exit affordance
      expect(frame).toContain('/help for commands'); // new command-discovery hint
    });

    unmount();
  });

  it('shows mode, model name and a turn counter in the idle status bar', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} modelDisplayName="claude-opus-4" initialMessage="go" />
    );

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('chat'); // mode
      expect(frame).toContain('claude-opus-4'); // model display name
      expect(frame).toContain('turns: 1'); // counter after one completed turn
      expect(frame).toContain('ready');
    });

    unmount();
  });

  it('suppresses INFO/DEBUG status lines in the TUI but keeps WARNING/ERROR', async () => {
    // The agent routes per-turn chatter (Requested tools, Loaded tools, Thinking…) through
    // statusUpdate at INFO level; that duplicates the TUI's own live rendering and must not reach
    // the transcript. WARNING/ERROR still surface (e.g. the experimental deep-backend warning).
    let emit: ((level: string, message: string) => void) | undefined;
    const subscribeStatus = (cb: (level: string, message: string) => void) => {
      emit = cb;
      return () => {};
    };
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeStatus={subscribeStatus} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    emit?.('INFO', 'Requested tools: read_file');
    emit?.('DEBUG', 'internal state dump');
    emit?.('WARNING', 'experimental deepagents backend');

    await vi.waitFor(() => expect(frames.join('\n')).toContain('experimental deepagents backend'));
    const all = frames.join('\n');
    expect(all).not.toContain('Requested tools: read_file');
    expect(all).not.toContain('internal state dump');

    unmount();
  });

  it('dispatches /help as a system line instead of running a turn', async () => {
    let turnsRun = 0;
    const agent: TuiAgent = {
      async *runTurn() {
        turnsRun += 1;
        yield { type: 'text', delta: 'should not run' };
      },
    };
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/help');
    await vi.waitFor(() => expect(lastFrame()).toContain('/help'));
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('/clear');
      expect(frames.join('\n')).toContain('/exit');
    });
    expect(turnsRun).toBe(0);

    unmount();
  });

  it('shows a friendly hint for an unknown slash command and does not call the agent', async () => {
    let turnsRun = 0;
    const agent: TuiAgent = {
      async *runTurn() {
        turnsRun += 1;
        yield { type: 'text', delta: 'nope' };
      },
    };
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/bogus');
    await vi.waitFor(() => expect(lastFrame()).toContain('/bogus'));
    stdin.write('\r');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Unknown command: /bogus'); // warn-tone notice title
      expect(all).toContain('Run /help to see everything available.'); // explanatory body
    });
    expect(turnsRun).toBe(0);

    unmount();
  });

  it('/auto-approve on|off calls agent.setAutoApprove, shows the status badge + notices (EXT-12)', async () => {
    let yolo = false;
    let turnsRun = 0;
    const agent: TuiAgent = {
      async *runTurn() {
        turnsRun += 1;
        yield { type: 'text', delta: 'should not run' };
      },
      setAutoApprove(action) {
        yolo = action === 'toggle' ? !yolo : action === 'on';
        return yolo;
      },
    };
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/auto-approve on');
    await vi.waitFor(() => expect(lastFrame()).toContain('/auto-approve on'));
    stdin.write('\r');

    // ON notice + persistent status-bar indicator.
    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('Auto-approve ON');
      expect(lastFrame()).toContain('auto-approve ON'); // status-bar badge
    });
    expect(yolo).toBe(true);

    // /auto-approve off → OFF notice, badge cleared.
    stdin.write('/auto-approve off');
    await vi.waitFor(() => expect(lastFrame()).toContain('/auto-approve off'));
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('Auto-approve OFF');
      expect(lastFrame()).not.toContain('auto-approve ON');
    });
    expect(yolo).toBe(false);

    // The command never reaches the model.
    expect(turnsRun).toBe(0);

    unmount();
  });

  it('initialAutoApprove seeds the status-bar indicator (config-enabled auto-approve)', async () => {
    const agent = scriptedAgent([]);
    const { lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialAutoApprove />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('auto-approve ON'));
    unmount();
  });

  it('/auto-approve is dispatchable mid-turn; a plain message mid-turn is refused (EXT-12)', async () => {
    let yolo = false;
    // A turn that streams then blocks until aborted, so the prompt stays mounted (running) while
    // we exercise mid-turn input.
    const agent: TuiAgent = {
      async *runTurn(_input, signal) {
        yield { type: 'text', delta: 'working' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve());
        });
      },
      setAutoApprove(action) {
        yolo = action === 'toggle' ? !yolo : action === 'on';
        return yolo;
      },
    };
    const { stdin, frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    // While running, a plain message is refused with a hint.
    await vi.waitFor(() => expect(lastFrame()).toContain('Thinking'));
    stdin.write('hello there');
    await vi.waitFor(() => expect(lastFrame()).toContain('> hello there'));
    stdin.write('\r');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('only slash commands'));

    // While running, /auto-approve on IS honoured (flag flips, badge appears next to the spinner).
    stdin.write('/auto-approve on');
    await vi.waitFor(() => expect(lastFrame()).toContain('> /auto-approve on'));
    stdin.write('\r');
    await vi.waitFor(() => expect(yolo).toBe(true));
    await vi.waitFor(() => expect(lastFrame()).toContain('auto-approve ON'));

    stdin.write(String.fromCharCode(27)); // Esc to end the run cleanly
    unmount();
  });

  it('toggles the docked debug panel on /debug (shows then hides the section tabs)', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    // Panel hidden initially.
    expect(lastFrame()).not.toContain('Subagents');

    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Subagents');
      expect(f).toContain('Raw model response');
    });

    // Toggle off.
    stdin.write('/debug');
    await vi.waitFor(() =>
      expect((lastFrame() ?? '').match(/\/debug/g)?.length).toBeGreaterThan(0)
    );
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Subagents'));

    unmount();
  });

  it('advertises Tab in the status bar while the debug panel is open but unfocused', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    // No panel, no hint.
    expect(lastFrame()).not.toContain('Tab: focus debug panel');

    // Open the panel: status bar now tells the user how to step into it.
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Tab: focus debug panel'));

    // Focusing the panel replaces the status-bar hint with the panel's own focused hint.
    stdin.write(TAB);
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Tab: section');
      expect(f).not.toContain('Tab: focus debug panel');
    });

    unmount();
  });

  it('renders the subagent tree in the panel from `task` tool-call events', async () => {
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"researcher","description":"dig"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: 'done digging' },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    // Wait for the turn to complete (the tool-call line is committed), then open the panel.
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');

    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Subagents');
      expect(f).toContain('researcher'); // subagent type
      expect(f).toContain('dig'); // description
    });

    unmount();
  });

  it('scrolls the panel viewport with Tab-to-focus then PageDown/PageUp', async () => {
    // A subagent whose multi-line result overflows the 8-row viewport, so scrolling moves it.
    const longResult = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: longResult },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('worker'));

    // Early lines visible, later lines clipped by the bounded viewport.
    expect(lastFrame()).toContain('line-0');
    expect(lastFrame()).not.toContain('line-30');

    // Focus the panel (Tab), then scroll down two pages (viewport=8, step=7 → offset 14).
    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section')); // focused hint
    stdin.write(PAGE_DOWN);
    stdin.write(PAGE_DOWN);

    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('line-12'); // a later line is now in view
      expect(f).not.toContain('line-0'); // the top scrolled out (offset moved past it)
    });

    // Scroll back up to the top.
    for (let i = 0; i < 5; i++) stdin.write(PAGE_UP);
    await vi.waitFor(() => expect(lastFrame()).toContain('line-0'));

    unmount();
  });

  it('scrolls one line at a time with the ↑/↓ arrow keys while focused (TUI-C11)', async () => {
    // Arrows give fine control (one line) on top of PgUp/PgDn's coarse page-step — and exist on
    // every keyboard, unlike dedicated PgUp/PgDn on Mac/compact keyboards.
    const longResult = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: longResult },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('worker'));

    // The hint advertises the arrows as the scroll keys.
    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('↑/↓: scroll'));

    // Top of the list visible. Arrow-down a few lines: the top line scrolls out one at a time.
    expect(lastFrame()).toContain('line-0');
    for (let i = 0; i < 3; i++) stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).not.toContain('line-0'); // top scrolled out by three single-line steps
      expect(f).toContain('line-3'); // new top line
    });

    // Arrow-up returns toward the top one line at a time.
    for (let i = 0; i < 3; i++) stdin.write(ARROW_UP);
    await vi.waitFor(() => expect(lastFrame()).toContain('line-0'));

    unmount();
  });

  it('clamps down-scroll to the end so PgUp/↑ recover immediately (no phantom offset) (TUI-C11)', async () => {
    // Bug: PageDown had no upper clamp, so paging past the end inflated the offset; afterwards
    // PgUp/↑ had to burn through that phantom offset before anything moved. The clamp pins the
    // offset to its real max, so a single PgUp/↑ visibly scrolls back from the end.
    const longResult = Array.from({ length: 40 }, (_, i) => `row-${i}`).join('\n');
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: longResult },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('worker'));

    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('↑/↓: scroll'));

    // Over-page well past the end. With the clamp the offset pins to its real maximum, so the
    // footer reads "— end —" (last line in view) and never a phantom range beyond the content.
    for (let i = 0; i < 20; i++) stdin.write(PAGE_DOWN);
    const lastLine = `row-${40 - 1}`;
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain(lastLine); // the genuine last line is in view
      expect(f).toContain('— end —'); // footer marks the real end (no over-scroll)
    });

    // A single PgUp moves immediately (no phantom offset to burn through): the last line leaves
    // view and the "more below" marker returns.
    stdin.write(PAGE_UP);
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).not.toContain(lastLine);
      expect(f).toContain('more below');
    });

    unmount();
  });

  it('cycles debug sections backward with Shift+Tab (TUI-C11)', async () => {
    // Plain Tab steps forward (subagents → history → request → response); Shift+Tab steps back.
    // From the first section, one Shift+Tab wraps to the last (response).
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    let emit: ((c: import('#src/tui/types.js').TuiDebugCapture) => void) | undefined;
    const subscribeDebug = (cb: (c: import('#src/tui/types.js').TuiDebugCapture) => void) => {
      emit = cb;
      return () => {};
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeDebug={subscribeDebug} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    // Distinct content per section so we can tell which tab's body is shown.
    emit?.({ kind: 'request', text: 'HISTORY_BODY', details: 'REQUEST_BODY' });
    emit?.({ kind: 'response', text: 'RESPONSE_BODY' });

    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Subagents'));

    stdin.write(TAB); // focus (starts on the subagents section)
    await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section'));
    await vi.waitFor(() => expect(lastFrame()).toContain('(no subagents spawned yet)'));

    // Shift+Tab from the first section wraps backward to the last (response).
    stdin.write(SHIFT_TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('RESPONSE_BODY'));

    // Shift+Tab again steps back one more to the request section.
    stdin.write(SHIFT_TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('REQUEST_BODY'));

    // Plain Tab still goes forward — back to the response section.
    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('RESPONSE_BODY'));

    unmount();
  });

  it('maximises and restores the focused debug panel with the "m" key', async () => {
    // A subagent result long enough to overflow the default 8-row viewport but fit a maximised one.
    const longResult = Array.from({ length: 20 }, (_, i) => `row-${i}`).join('\n');
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: longResult },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('worker'));

    // Default 8-row viewport clips the later rows.
    expect(lastFrame()).toContain('row-0');
    expect(lastFrame()).not.toContain('row-10');

    // Focus the panel, then maximise: the hint flips and previously-clipped rows appear.
    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('maximise'));
    stdin.write('m');
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('row-10'); // grown viewport now shows further down
      expect(f).toContain('restore'); // hint flipped to the restore affordance
    });

    // Restore: tail clipped again, hint flips back.
    stdin.write('m');
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).not.toContain('row-10');
      expect(f).toContain('maximise');
    });

    unmount();
  });

  it('shows the "Sent to model (system + tools)" tab with captured request details', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    let emit: ((c: import('#src/tui/types.js').TuiDebugCapture) => void) | undefined;
    const subscribeDebug = (cb: (c: import('#src/tui/types.js').TuiDebugCapture) => void) => {
      emit = cb;
      return () => {};
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeDebug={subscribeDebug} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    // Feed a request capture (history + the new request details).
    emit?.({
      kind: 'request',
      text: '[]',
      details: '=== MODEL PARAMS ===\n{"model":"claude-opus-4"}',
    });

    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Sent to model (system + tools)'));

    // Step to the request tab (subagents -> history -> request) and read its content.
    stdin.write(TAB); // focus
    await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section'));
    stdin.write(TAB); // -> history
    stdin.write(TAB); // -> request
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('MODEL PARAMS');
      expect(f).toContain('claude-opus-4');
    });

    unmount();
  });

  it('/clear resets the agent conversation thread, not just the transcript (TUI-C8)', async () => {
    // The on-screen reset is already covered by the transcript state; the bug was that the
    // model's checkpointer thread was left intact. Assert /clear calls the agent's
    // resetThread so the next turn starts from an empty model context.
    let resetCount = 0;
    const agent: TuiAgent = {
      async *runTurn() {
        yield { type: 'text', delta: 'hi there' };
      },
      resetThread() {
        resetCount += 1;
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="remember this" />
    );

    // First turn commits, then issue /clear.
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    expect(resetCount).toBe(0); // not reset yet

    stdin.write('/clear');
    await vi.waitFor(() => expect(lastFrame()).toContain('/clear'));
    stdin.write('\r');

    // The agent thread was reset exactly once by the /clear.
    await vi.waitFor(() => expect(resetCount).toBe(1));
    // The status-bar turn counter is part of the cleared conversation state, so it resets to 0.
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 0'));

    unmount();
  });

  it('/clear shows the "history cleared" banner as visible feedback (TUI-C12)', async () => {
    // The old one-line "Transcript cleared." was swallowed because clearing <Static>'s items
    // resets its internal index. The banner now renders outside <Static>, so it must be present
    // in the live frame after a /clear.
    const agent = scriptedAgent([{ type: 'text', delta: 'hi there' }]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="remember this" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    // No banner before the clear.
    expect(lastFrame()).not.toContain('History cleared');

    stdin.write('/clear');
    await vi.waitFor(() => expect(lastFrame()).toContain('/clear'));
    stdin.write('\r');

    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('History cleared'); // banner line 1
      expect(f).toContain('Scroll up'); // banner hint line
    });

    unmount();
  });

  it('/clear bumps the viewport (scroll + clear) without erasing scrollback, and resets the Ink frame (TUI-C12)', async () => {
    // /clear must scroll the prior conversation up + clear the *visible* screen (ESC[H / ESC[J)
    // but never emit ESC[3J (which would destroy scrollback), and must reset Ink's frame
    // accounting via onResetFrame so the re-render lands cleanly at the top.
    let resetFrameCalls = 0;
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, stdout, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={agent}
        initialMessage="go"
        onResetFrame={() => {
          resetFrameCalls += 1;
        }}
      />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));

    stdin.write('/clear');
    await vi.waitFor(() => expect(lastFrame()).toContain('/clear'));
    stdin.write('\r');

    await vi.waitFor(() => expect(resetFrameCalls).toBe(1));

    const written = stdout.frames.join('');
    expect(written).toContain('\x1b[H'); // cursor home
    expect(written).toContain('\x1b[J'); // clear to end of *visible* screen
    expect(written).toContain('\n'); // newlines that bump prior content into scrollback
    expect(written).not.toContain('\x1b[3J'); // must NOT erase scrollback

    unmount();
  });

  it('/clear does not throw when the agent has no resetThread (fixture agent)', async () => {
    // The fixture agent omits resetThread; the optional-chaining call must be a safe no-op —
    // the app must keep running (prompt returns, no error system line).
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, lastFrame, frames, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="hello world" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/clear');
    await vi.waitFor(() => expect(lastFrame()).toContain('/clear'));
    stdin.write('\r');

    // The command consumes cleanly (its echoed text clears from the prompt) and no error line
    // surfaced — i.e. the optional resetThread call did not blow up the run.
    await vi.waitFor(() => expect(lastFrame()).not.toContain('> /clear'));
    expect(frames.join('\n')).not.toContain('[error]');

    unmount();
  });

  it('/tools commits a state-aware notice confirming the new fold state while idle (TUI-C9/C14)', async () => {
    // Committed turns are frozen in <Static> and cannot re-fold, so /tools while idle would be
    // a silent no-op; instead it must confirm the new state via a visible notice.
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { stdin, lastFrame, frames, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    // First /tools turns detail on.
    stdin.write('/tools');
    await vi.waitFor(() => expect(lastFrame()).toContain('/tools'));
    stdin.write('\r');
    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Tool details: on'); // notice title
      expect(all).toContain('full inputs and results'); // explanatory body
    });

    // Second /tools toggles back to off, again with a confirming notice.
    stdin.write('/tools');
    await vi.waitFor(() =>
      expect((lastFrame() ?? '').match(/\/tools/g)?.length).toBeGreaterThan(0)
    );
    stdin.write('\r');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('Tool details: off'));

    unmount();
  });

  it('/mode and /model commit explanatory notices, not silent one-liners (TUI-C14)', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { stdin, lastFrame, frames, unmount } = render(
      <App {...baseProps} agent={agent} modelDisplayName="claude-opus-4" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    stdin.write('/mode');
    await vi.waitFor(() => expect(lastFrame()).toContain('/mode'));
    stdin.write('\r');
    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Session mode: chat'); // notice title
      expect(all).toContain('how the agent handles your messages'); // explanation
    });

    stdin.write('/model');
    await vi.waitFor(() =>
      expect((lastFrame() ?? '').match(/\/model/g)?.length).toBeGreaterThan(0)
    );
    stdin.write('\r');
    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Model: claude-opus-4'); // notice title
      expect(all).toContain('model answering your messages'); // explanation
    });

    unmount();
  });

  it('/debug commits a state-aware notice as visible feedback (TUI-C14)', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { stdin, lastFrame, frames, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('Debug panel: shown'));

    stdin.write('/debug');
    await vi.waitFor(() =>
      expect((lastFrame() ?? '').match(/\/debug/g)?.length).toBeGreaterThan(0)
    );
    stdin.write('\r');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('Debug panel: hidden'));

    unmount();
  });

  it('/tools sets the tool-call detail mode applied to the (live) turn that follows', async () => {
    // A blocking agent so the turn stays live for the assertion. Committed turns live in
    // Ink's <Static> and are frozen once written, so the collapsible affordance is a
    // live-turn concern; /tools sets the mode that the next live turn picks up.
    const agent: TuiAgent = {
      async *runTurn(_input, signal) {
        yield { type: 'tool_start', id: 't1', name: 'read_file' };
        yield { type: 'tool_args', id: 't1', delta: '{"path":"after.ts"}' };
        yield { type: 'tool_end', id: 't1' };
        yield { type: 'tool_result', id: 't1', content: 'after-body' };
        yield { type: 'text', delta: 'working' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve());
        });
      },
    };
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    // Turn on expanded detail while idle, before sending a prompt.
    stdin.write('/tools');
    await vi.waitFor(() => expect(lastFrame()).toContain('/tools'));
    stdin.write('\r');
    // Wait for the command to be consumed: the notice commits (so detail is now on) and the
    // prompt is back to empty (the echoed "/tools" cleared from the input line).
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Tool details: on'); // notice committed
      expect(f).not.toContain('> /tools'); // prompt line cleared
    });

    // Now run a turn: the live tool call shows its args/result body because /tools is on.
    stdin.write('hello');
    await vi.waitFor(() => expect(lastFrame()).toContain('hello'));
    stdin.write('\r');
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('read_file');
      expect(f).toContain('after.ts'); // args visible (expanded mode)
      expect(f).toContain('after-body'); // result visible
    });

    stdin.write(String.fromCharCode(27)); // Esc to end the run
    unmount();
  });

  it('Ctrl+T toggles tool-call detail while a turn is streaming', async () => {
    const CTRL_T = '\x14'; // Ctrl+T control byte
    // Agent that streams a tool result then blocks, so the turn stays running for the toggle.
    const agent: TuiAgent = {
      async *runTurn(_input, signal) {
        yield { type: 'tool_start', id: 't1', name: 'read_file' };
        yield { type: 'tool_args', id: 't1', delta: '{"path":"live.ts"}' };
        yield { type: 'tool_end', id: 't1' };
        yield { type: 'tool_result', id: 't1', content: 'live-body' };
        yield { type: 'text', delta: 'working' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve());
        });
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    // Live (running) tool call: collapsed summary, body hidden.
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('read_file');
      expect(f).not.toContain('live-body');
    });

    // Ctrl+T while running expands the live tool's body.
    stdin.write(CTRL_T);
    await vi.waitFor(() => expect(lastFrame()).toContain('live-body'));

    stdin.write(String.fromCharCode(27)); // Esc to end the run cleanly
    unmount();
  });

  it('renders completed assistant markdown as formatted output in the transcript', async () => {
    const agent = scriptedAgent([
      { type: 'text', delta: '# Heading\n' },
      { type: 'text', delta: '- bullet point' },
    ]);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      // Markdown applied once the turn committed: list bullet glyph present, raw '- ' gone.
      expect(f).toContain('Heading');
      expect(f).toContain('• bullet point');
    });

    unmount();
  });

  it('aborts the in-flight turn when Esc is pressed', async () => {
    let aborted = false;
    const agent: TuiAgent = {
      async *runTurn(_input, signal) {
        yield { type: 'text', delta: 'working' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    };

    const { stdin, frames, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="run" />
    );

    await vi.waitFor(() => expect(frames.join('\n')).toContain('working'));
    stdin.write(ESC);
    await vi.waitFor(() => expect(aborted).toBe(true));

    unmount();
  });
});
