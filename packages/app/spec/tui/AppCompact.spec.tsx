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
import type { AutocompactStatus } from '@gaunt-sloth/core/core/compactionThreshold.js';
import type { TokenBudget } from '@gaunt-sloth/core/config/tokenBudget.js';
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

  it('a failed compaction reports its reason and gives the hold back: the next plain message starts a turn', async () => {
    const compact = vi.fn(async () => {
      throw new Error('provider down');
    });
    const { agent, turnsRun } = compactingAgent(compact);
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await submit(stdin, lastFrame, '/compact');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Compaction did not happen');
      expect(all).toContain('The conversation was left unchanged: provider down');
    });
    expect(turnsRun()).toBe(0);

    // The hold the compaction took is what a failure has to give back. The status bar never shows
    // it, so the only thing that can pin it is what the hold controls: a plain message afterwards
    // is dispatched as a turn, not refused as "the agent is working". A release that happens only
    // on success leaves this session wedged after any failed /compact.
    await submit(stdin, lastFrame, 'hello afterwards');
    await vi.waitFor(() => expect(turnsRun()).toBe(1));
    expect(frames.join('\n')).not.toContain('The agent is working — only slash commands');

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

/**
 * EXT-161 — `/autocompact` applied by the Ink `<App>`, and the snapshot the synchronous `/status`
 * reads. The controller proves the provenance flips to `session` and the notice proves a session
 * status renders as such; this is the seam between them — the surface refreshing the snapshot
 * after the command — which neither of those can see.
 */
/**
 * [[EXT-167]] — a compaction the SESSION applied, mid-turn, because the provider rejected the turn
 * for size. The App is handed the `context_compacted` event in the stream and has to show it where
 * it happened: below the rows the turn had already painted, above the answer the retry produced,
 * and never as a line in the model's history.
 */
describe('tui <App> — a compaction applied mid-turn (EXT-167)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const foldedTurn: AgentStreamEvent[] = [
    { type: 'tool_start', id: 't1', name: 'read_file' },
    { type: 'tool_args', id: 't1', delta: '{"path":"alpha.txt"}' },
    { type: 'tool_end', id: 't1' },
    { type: 'tool_result', id: 't1', content: 'alpha-tool-result' },
    { type: 'context_compacted', cause: 'context_overflow', compaction: outcome() },
    { type: 'text', delta: 'the answer' },
  ];

  it('draws the notice between the tool row and the answer, and keeps it out of the history', async () => {
    const onTurnComplete = vi.fn();
    const { agent } = compactingAgent(undefined, foldedTurn);
    const { lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="Hi sloth" onTurnComplete={onTurnComplete} />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('the answer'));
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));

    const rows = (lastFrame() ?? '').split('\n');
    const rowOf = (needle: string): number => rows.findIndex((row) => row.includes(needle));
    const user = rowOf('Hi sloth');
    const tool = rowOf('read_file');
    const title = rowOf('Context overflowed — conversation compacted');
    const answer = rowOf('the answer');
    expect(
      [user, tool, title, answer].every((i) => i >= 0),
      rows.join('\n')
    ).toBe(true);
    // Below the turn's own work and above its answer — not a banner over the whole turn, which is
    // where a transcript item pushed on the event would have landed.
    expect(user).toBeLessThan(tool);
    expect(tool).toBeLessThan(title);
    expect(title).toBeLessThan(answer);
    // The numbers are the event's, rendered by the same builder `/compact` uses.
    const frame = rows.join('\n');
    expect(frame).toContain('4 older messages were folded into a summary');
    expect(frame).toContain(
      'Model context: 10 messages (~12,345 characters) → 7 messages (~2,100 characters).'
    );
    // The history gets the model's words alone.
    expect(onTurnComplete).toHaveBeenCalledWith('Hi sloth', 'the answer');

    unmount();
  });
});

describe('tui <App> — /autocompact (EXT-161)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** What the session starts with: the config's number. */
  const configStatus: AutocompactStatus = {
    enabled: true,
    thresholdTokens: 160_000,
    thresholdOrigin: 'config',
    window: 200_000,
    windowOrigin: 'models.dev',
    windowCheck: 'checked',
    budget: { kind: 'tokens', tokens: 160_000 },
  };

  it('/autocompact 300K moves the threshold, and the next /status reports the SESSION provenance', async () => {
    const set = vi.fn(async (budget: TokenBudget): Promise<AutocompactStatus> => ({
      ...configStatus,
      thresholdTokens: 300_000,
      thresholdOrigin: 'session',
      budget,
    }));
    const get = vi.fn(async () => configStatus);
    const { agent, turnsRun } = compactingAgent(undefined);
    const wired: TuiAgent = { ...agent, getAutocompactStatus: get, setAutocompactThreshold: set };
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={wired} />);

    await submit(stdin, lastFrame, '/autocompact 300K');
    await vi.waitFor(() =>
      expect(frames.join('\n')).toContain('Automatic compaction threshold set')
    );
    expect(set).toHaveBeenCalledWith({ kind: 'tokens', tokens: 300_000 });

    await submit(stdin, lastFrame, '/status');
    await vi.waitFor(() => expect(lastFrame()).toContain('Session status'));
    // Only the /status block is read. The /autocompact notice above it already says "session", so
    // an assertion over the whole screen would stay green with the snapshot never refreshed.
    const frame = lastFrame() ?? '';
    const statusBlock = frame.slice(frame.lastIndexOf('Session status'));
    expect(statusBlock).toContain('300,000');
    expect(statusBlock).toContain('overridden'); // the session provenance line
    expect(statusBlock).not.toContain('160,000'); // the config value it replaced
    expect(turnsRun()).toBe(0);

    unmount();
  });

  it('says the threshold is unavailable, and changes nothing, when the agent has no setAutocompactThreshold', async () => {
    const { agent, turnsRun } = compactingAgent(undefined);
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await submit(stdin, lastFrame, '/autocompact 300K');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Automatic compaction unavailable');
      expect(all).toContain('Nothing was changed.');
    });
    expect(frames.join('\n')).not.toContain('threshold set');
    expect(turnsRun()).toBe(0);

    unmount();
  });
});
