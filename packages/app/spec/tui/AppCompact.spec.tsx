/**
 * GS2-23 — `/compact` applied by the Ink `<App>`: the surface awaits the agent's
 * `compactConversation`, commits the notice for what LANDED, leaves the on-screen transcript
 * alone, holds the prompt while the summary is being made, and degrades honestly when the agent
 * has no conversation state behind it or the compaction fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { ConversationCompaction } from '@gaunt-sloth/core/core/compaction.js';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

const outcome = (over: Partial<ConversationCompaction> = {}): ConversationCompaction => ({
  changed: true,
  removedCount: 4,
  keptCount: 6,
  keepRecent: 6,
  summaryText: 'SUMMARY',
  before: { messages: 10, characters: 12345 },
  after: { messages: 7, characters: 2100 },
  ...over,
});

/** A fake agent with a controllable `compactConversation` and a turn counter. */
function compactingAgent(
  compact: TuiAgent['compactConversation'] | undefined,
  events: AgentStreamEvent[] = [{ type: 'text', delta: 'the answer' }]
): { agent: TuiAgent; turnsRun: () => number } {
  let turns = 0;
  const agent: TuiAgent = {
    async *runTurn() {
      turns += 1;
      for (const event of events) {
        yield event;
        await Promise.resolve();
      }
    },
    ...(compact ? { compactConversation: compact } : {}),
  };
  return { agent, turnsRun: () => turns };
}

/** Type a line at the prompt and submit it, waiting for the echo so the keystrokes landed. */
async function submit(
  stdin: { write: (data: string) => void },
  lastFrame: () => string | undefined,
  line: string
): Promise<void> {
  await vi.waitFor(() => expect(lastFrame()).toContain('>'));
  stdin.write(line);
  await vi.waitFor(() => expect(lastFrame()).toContain(line));
  stdin.write('\r');
}

describe('tui <App> — /compact (GS2-23)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('awaits the agent with the focus and commits the landed notice, leaving the transcript', async () => {
    const compact = vi.fn(async () => outcome());
    const { agent, turnsRun } = compactingAgent(compact);
    const { stdin, frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="Hi sloth" />
    );
    // A committed turn first, so there is a transcript to leave alone.
    await vi.waitFor(() => expect(lastFrame()).toContain('the answer'));
    await vi.waitFor(() => expect(lastFrame()).toContain('ready'));

    await submit(stdin, lastFrame, '/compact the migration plan');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Compacting the conversation');
      expect(all).toContain('Conversation compacted');
      expect(all).toContain(
        'Folded 4 older messages into a summary and kept the last 6 word for word.'
      );
      expect(all).toContain(
        'Model context: 10 messages (~12,345 characters) → 7 messages (~2,100 characters).'
      );
      expect(all).toContain('Summary focus: the migration plan');
    });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith({ focus: 'the migration plan' });
    // The screen is the person's record: the earlier exchange is still there, and no turn ran.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Hi sloth');
    expect(frame).toContain('the answer');
    expect(turnsRun()).toBe(1);
    expect(frame).toContain('turns: 1');

    unmount();
  });

  it('a bare /compact passes no focus, and a no-op outcome reads as nothing to compact', async () => {
    const compact = vi.fn(async () =>
      outcome({
        changed: false,
        removedCount: 0,
        keptCount: 2,
        before: { messages: 2, characters: 40 },
        after: { messages: 2, characters: 40 },
      })
    );
    const { agent, turnsRun } = compactingAgent(compact);
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await submit(stdin, lastFrame, '/compact');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Nothing to compact');
      expect(all).toContain('Nothing was changed.');
    });
    expect(compact).toHaveBeenCalledWith({});
    expect(turnsRun()).toBe(0);

    unmount();
  });

  it('says compaction is unavailable when the agent has no conversation state behind it', async () => {
    const { agent, turnsRun } = compactingAgent(undefined);
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await submit(stdin, lastFrame, '/compact');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Compaction unavailable');
      expect(all).toContain('Nothing was changed.');
    });
    expect(turnsRun()).toBe(0);

    unmount();
  });

  it('reports a failed compaction with its reason and says the conversation was left unchanged', async () => {
    const compact = vi.fn(async () => {
      throw new Error('provider down');
    });
    const { agent } = compactingAgent(compact);
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await submit(stdin, lastFrame, '/compact');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Compaction did not happen');
      expect(all).toContain('The conversation was left unchanged: provider down');
    });
    // And the prompt is back — a failed compaction does not leave the session held.
    await vi.waitFor(() => expect(lastFrame()).toContain('ready'));

    unmount();
  });

  it('holds the prompt while the summary is being made: a plain message does not start a turn', async () => {
    let release!: (value: ConversationCompaction) => void;
    const pending = new Promise<ConversationCompaction>((resolve) => {
      release = resolve;
    });
    const compact = vi.fn(() => pending);
    const { agent, turnsRun } = compactingAgent(compact);
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await submit(stdin, lastFrame, '/compact');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('Compacting the conversation'));

    await submit(stdin, lastFrame, 'hello while compacting');
    await vi.waitFor(() =>
      expect(frames.join('\n')).toContain('The agent is working — only slash commands')
    );
    expect(turnsRun()).toBe(0);

    release(outcome());
    await vi.waitFor(() => expect(frames.join('\n')).toContain('Conversation compacted'));

    // Released: the next message is a turn again.
    await submit(stdin, lastFrame, 'hello afterwards');
    await vi.waitFor(() => expect(turnsRun()).toBe(1));

    unmount();
  });
});
