/**
 * GS2-20 — `/resume` applied by the Ink `<App>`, and a session mounted inside a resumed
 * conversation. The agent decides (it owns the seam); the App renders what was decided: a landed
 * resume replaces the screen with the banner and the restored turns and moves the id `/status`
 * names, a refusal is a notice and nothing else changes, a bare `/resume` lists what could be
 * resumed, and an agent with no store says so.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { ResumeResolution, ResumeTarget } from '@gaunt-sloth/agent/modules/sessionResume.js';
import type { ConversationSummary } from '@gaunt-sloth/core/history/historyStore.js';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

const summary: ConversationSummary = {
  id: 12,
  startedTs: '2026-09-01T10:00:00.000Z',
  project: '/work/here',
  command: 'chat',
  model: 'gemma4:12b',
  turnCount: 2,
  lastPrompt: 'second old prompt',
  threadId: 'thread-12',
};

const target: ResumeTarget = {
  conversationId: 12,
  threadId: 'thread-12',
  summary,
  turns: [
    { prompt: 'first old prompt', response: 'first old answer' },
    { prompt: 'second old prompt', response: 'second old answer' },
  ],
  grants: { allow: [], deny: [] },
};

function resumingAgent(
  resume: TuiAgent['resumeConversation'] | undefined,
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
    ...(resume ? { resumeConversation: resume } : {}),
  };
  return { agent, turnsRun: () => turns };
}

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

describe('tui <App> — /resume (GS2-20)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('a landed /resume replaces the transcript with the banner and the restored turns, moves the id, and continues from there', async () => {
    const resume = vi.fn(async (): Promise<ResumeResolution> => ({ ok: true, target }));
    const { agent, turnsRun } = resumingAgent(resume);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} conversationId={3} initialMessage="Hi sloth" />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('the answer'));
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));

    await submit(stdin, lastFrame, '/resume 12');

    await vi.waitFor(() => expect(lastFrame()).toContain('Resumed conversation #12'));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(12);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 turns recorded under gth chat, with gemma4:12b');
    expect(frame).toContain('You › first old prompt');
    expect(frame).toContain('(restored)');
    expect(frame).toContain('first old answer');
    expect(frame).toContain('You › second old prompt');
    expect(frame).toContain('second old answer');
    // The conversation being left is off the screen — it belonged to conversation #3.
    expect(frame).not.toContain('Hi sloth');
    expect(frame).not.toContain('You › the answer');
    // The counter continues from the record, and /status names the resumed id.
    expect(frame).toContain('turns: 2');
    await submit(stdin, lastFrame, '/status');
    await vi.waitFor(() => expect(lastFrame()).toContain('Conversation: #12'));

    // And the session goes on: the next turn runs under the restored ones.
    await submit(stdin, lastFrame, 'what next');
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 3'));
    expect(turnsRun()).toBe(2);
    const after = lastFrame() ?? '';
    expect(after.indexOf('second old answer')).toBeLessThan(after.indexOf('You › what next'));
    unmount();
  });

  it('a refused /resume is a notice with the reason, and the transcript stays', async () => {
    const resume = vi.fn(async (): Promise<ResumeResolution> => ({
      ok: false,
      refusal: { kind: 'unknown', id: 12 },
    }));
    const { agent } = resumingAgent(resume);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} conversationId={3} initialMessage="Hi sloth" />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('the answer'));

    await submit(stdin, lastFrame, '/resume 12');

    await vi.waitFor(() => expect(lastFrame()).toContain('No conversation #12'));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/resume with no id');
    expect(frame).toContain('Hi sloth');
    expect(frame).toContain('the answer');
    expect(frame).toContain('turns: 1');
    await submit(stdin, lastFrame, '/status');
    await vi.waitFor(() => expect(lastFrame()).toContain('Conversation: #3'));
    unmount();
  });

  it('naming the conversation the session is already in changes nothing, and never reaches the agent', async () => {
    const resume = vi.fn(async (): Promise<ResumeResolution> => ({ ok: true, target }));
    const { agent } = resumingAgent(resume);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} conversationId={12} />
    );
    await submit(stdin, lastFrame, '/resume 12');
    await vi.waitFor(() => expect(lastFrame()).toContain('Already in conversation #12'));
    expect(resume).not.toHaveBeenCalled();
    unmount();
  });

  it('bare /resume lists what the session module offers; without a store, both forms say resume is unavailable', async () => {
    const listResumeCandidates = vi.fn(() => [summary]);
    const withStore = resumingAgent(
      vi.fn(async (): Promise<ResumeResolution> => ({ ok: true, target }))
    );
    const a = render(
      <App
        {...baseProps}
        agent={withStore.agent}
        conversationId={3}
        listResumeCandidates={listResumeCandidates}
      />
    );
    await submit(a.stdin, a.lastFrame, '/resume');
    await vi.waitFor(() => expect(a.lastFrame()).toContain('Conversations you can resume'));
    expect(a.lastFrame()).toContain('#12');
    expect(listResumeCandidates).toHaveBeenCalledTimes(1);
    a.unmount();

    const { agent } = resumingAgent(undefined);
    const b = render(<App {...baseProps} agent={agent} />);
    await submit(b.stdin, b.lastFrame, '/resume');
    await vi.waitFor(() => expect(b.lastFrame()).toContain('Resume unavailable'));
    await submit(b.stdin, b.lastFrame, '/resume 12');
    await vi.waitFor(() => {
      const frame = b.lastFrame() ?? '';
      expect(frame.split('Resume unavailable').length - 1).toBe(2);
    });
    expect(b.lastFrame()).toContain('Nothing was changed.');
    b.unmount();
  });

  it('a typo is named before anything is looked up', async () => {
    const resume = vi.fn(async (): Promise<ResumeResolution> => ({ ok: true, target }));
    const { agent } = resumingAgent(resume);
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);
    await submit(stdin, lastFrame, '/resume abc');
    await vi.waitFor(() => expect(lastFrame()).toContain('Not a conversation id: abc'));
    expect(resume).not.toHaveBeenCalled();
    unmount();
  });

  it('a session mounted with --resume opens on the banner and the restored turns, not the greeting', async () => {
    const { agent } = resumingAgent(undefined);
    const { lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} conversationId={12} resumed={target} showLaunchBanner />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('Resumed conversation #12'));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('You › first old prompt');
    expect(frame).toContain('(restored)');
    expect(frame).toContain('second old answer');
    expect(frame).not.toContain('ready to chat');
    expect(frame).toContain('turns: 2');
    unmount();
  });
});
