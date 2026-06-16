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
    const { lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => {
      // Once idle the status bar shows the ready line and the prompt is back.
      expect(lastFrame()).toContain('ready');
      expect(lastFrame()).toContain('>');
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
