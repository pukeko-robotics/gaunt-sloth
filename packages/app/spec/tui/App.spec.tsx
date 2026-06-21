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
  exitMessage: "Type 'exit' or hit Ctrl+C to exit chat\n",
};

const ESC = String.fromCharCode(27); // Escape key byte
const TAB = '\t'; // Tab key (char 9)
const PAGE_DOWN = '\x1b[6~'; // PageDown CSI sequence
const PAGE_UP = '\x1b[5~'; // PageUp CSI sequence

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

    await vi.waitFor(() => expect(frames.join('\n')).toContain('Unknown command: /bogus'));
    expect(turnsRun).toBe(0);

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
    // Wait for the prompt to clear (the /tools line consumed) before typing the next prompt.
    await vi.waitFor(() => expect(lastFrame()).not.toContain('/tools'));

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
    const { lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

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
