/**
 * GS2-20 — `/resume` applied by the Ink `<App>`, and a session mounted inside a resumed
 * conversation. The agent decides (it owns the seam); the App renders what was decided: a landed
 * resume replaces the screen with the banner and the restored turns and moves the id `/status`
 * names, a refusal is a notice and nothing else changes, and an agent with no store says so.
 *
 * GS2-112 — a bare `/resume` opens the keyboard-navigable picker on this surface, and the cells for
 * it assert the conversation that was RESUMED, reached by moving the highlight. The readline
 * surface's printed list stays in `agent/spec/interactiveSessionModule.resume.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { resumableConversationsNotice } from '@gaunt-sloth/agent/modules/sessionResume.js';
import type { ResumeResolution, ResumeTarget } from '@gaunt-sloth/agent/modules/sessionResume.js';
import type { ConversationSummary } from '@gaunt-sloth/core/history/historyStore.js';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';
import { RESUME_PICKER_FOOTER, RESUME_PICKER_TITLE } from '#src/tui/components/ResumePicker.js';

const DOWN = '\x1b[B';

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

/** A second candidate, so the picker has a row that is NOT the one the cursor starts on. */
const otherSummary: ConversationSummary = {
  id: 34,
  startedTs: '2026-09-02T09:00:00.000Z',
  lastTs: '2026-09-02T09:30:00.000Z',
  project: '/work/here',
  command: 'code',
  model: 'gemma4:12b',
  turnCount: 5,
  lastPrompt: 'fix the flaky window test',
  threadId: 'thread-34',
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

/**
 * The resolution for whichever conversation was ASKED for. A fixed target would put the same id on
 * screen whatever the picker chose, so the banner would agree with any assertion and none of it
 * would be evidence.
 */
function targetFor(id: number): ResumeTarget {
  const chosen = id === otherSummary.id ? otherSummary : summary;
  return {
    ...target,
    conversationId: id,
    threadId: chosen.threadId ?? `thread-${id}`,
    summary: chosen,
  };
}

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
    expect(resume).toHaveBeenCalledWith({ kind: 'id', id: 12 });
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
      refusal: { kind: 'unknown', ref: { kind: 'id', id: 12 } },
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

  /**
   * GS2-112 — **the cell this node turns on.** Bare `/resume` opens the picker, and what is
   * asserted is the conversation the agent was asked to resume, arrived at by moving the highlight
   * — never that the picker rendered. Its predecessor shipped a printed list and passed every one
   * of its own tests because they asserted a notice existed; a spec that asserts a component
   * mounted proves exactly as little.
   *
   * The wait after the arrow key is on the highlight being ON the second row. Waiting for a bare
   * `❯` would pass before the keystroke landed (the first row is already highlighted), leaving
   * Enter racing the arrow and the assertion below deciding it by luck.
   */
  it('bare /resume opens the picker, and Enter resumes the conversation the highlight is on', async () => {
    const listResumeCandidates = vi.fn(() => [summary, otherSummary]);
    // The resolution follows the id it was ASKED for, so "Resumed conversation #34" on screen
    // cannot be a fixed fixture agreeing with the assertion by accident.
    const resume = vi.fn(async (id: number): Promise<ResumeResolution> => ({
      ok: true,
      target: targetFor(id),
    }));
    const { agent } = resumingAgent(resume);
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={agent}
        conversationId={3}
        initialMessage="Hi sloth"
        listResumeCandidates={listResumeCandidates}
      />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('the answer'));

    await submit(stdin, lastFrame, '/resume');
    await vi.waitFor(() => expect(lastFrame()).toContain(RESUME_PICKER_TITLE));
    expect(listResumeCandidates).toHaveBeenCalledTimes(1);
    // Opening it resumes nothing. (The command's own echo is gone because submitting cleared the
    // buffer, not because the prompt stood down — that the prompt is suspended under a picker is
    // structural, in the render condition it shares with the approvals picker.)
    expect(resume).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('> /resume');
    // Both candidates are offered, the current conversation is not among them (the session module
    // excludes it) and the cursor starts on the first.
    expect(lastFrame()).toContain('❯ #12');
    expect(lastFrame()).toContain('#34');

    stdin.write(DOWN);
    await vi.waitFor(() => expect(lastFrame()).toContain('❯ #34'));
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('Resumed conversation #34'));
    // THE assertion: the agent was asked for the highlighted conversation, once, by id.
    expect(resume.mock.calls).toEqual([[34]]);
    const frame = lastFrame() ?? '';
    // The picker is transient: it closes before the resume replaces the screen, and the prompt
    // comes back.
    expect(frame).not.toContain(RESUME_PICKER_TITLE);
    expect(frame).toContain('You › first old prompt');
    expect(frame).not.toContain('Hi sloth');
    await submit(stdin, lastFrame, '/status');
    await vi.waitFor(() => expect(lastFrame()).toContain('Conversation: #34'));
    unmount();
  });

  /**
   * GS2-112 — Esc is a real no-op, not a notice that claims to be one: the session is still in the
   * conversation it was in (`/status`, the same check the landed case uses), the transcript is
   * untouched, and the agent was never asked to resume anything.
   */
  it('Esc closes the picker, says nothing changed, and leaves the session where it was', async () => {
    const listResumeCandidates = vi.fn(() => [summary, otherSummary]);
    const resume = vi.fn(async (id: number): Promise<ResumeResolution> => ({
      ok: true,
      target: targetFor(id),
    }));
    const { agent } = resumingAgent(resume);
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={agent}
        conversationId={3}
        initialMessage="Hi sloth"
        listResumeCandidates={listResumeCandidates}
      />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('the answer'));

    await submit(stdin, lastFrame, '/resume');
    await vi.waitFor(() => expect(lastFrame()).toContain(RESUME_PICKER_TITLE));
    // Move first: cancelling from a moved cursor must not be read as choosing that row.
    stdin.write(DOWN);
    await vi.waitFor(() => expect(lastFrame()).toContain('❯ #34'));
    stdin.write('\x1b');

    await vi.waitFor(() => expect(lastFrame()).toContain('Resume cancelled'));
    expect(resume).not.toHaveBeenCalled();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain(RESUME_PICKER_TITLE);
    expect(frame).toContain('Nothing was changed.');
    // The conversation that was on screen is still on screen, and still being recorded.
    expect(frame).toContain('Hi sloth');
    expect(frame).toContain('the answer');
    expect(frame).toContain('turns: 1');
    await submit(stdin, lastFrame, '/status');
    await vi.waitFor(() => expect(lastFrame()).toContain('Conversation: #3'));
    unmount();
  });

  /**
   * GS2-112 — with nothing to offer, the notice and no picker. An empty `SelectList` renders a
   * "no matches" line and its Enter is inert, so a picker here would be a modal with no way out
   * but Esc.
   */
  it('with no resumable conversations it says so and opens no picker', async () => {
    const listResumeCandidates = vi.fn((): ConversationSummary[] => []);
    const resume = vi.fn(async (): Promise<ResumeResolution> => ({ ok: true, target }));
    const { agent } = resumingAgent(resume);
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={agent}
        conversationId={3}
        listResumeCandidates={listResumeCandidates}
      />
    );
    await submit(stdin, lastFrame, '/resume');
    await vi.waitFor(() => expect(lastFrame()).toContain('No other conversation can be resumed'));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain(RESUME_PICKER_TITLE);
    expect(frame).toContain('Nothing was changed.');
    expect(resume).not.toHaveBeenCalled();
    // The prompt is back — nothing is owning the keyboard.
    await submit(stdin, lastFrame, '/status');
    await vi.waitFor(() => expect(lastFrame()).toContain('Conversation: #3'));
    unmount();
  });

  /**
   * GS2-112 — the readline surface keeps the printed list, and none of the picker's copy may reach
   * it. Both operands are imported rather than spelled out here: a literal would stop asserting
   * anything the moment either wording changed, which is precisely the shared-copy mistake this
   * guards against.
   */
  it('the text list the plain surface prints describes no picker', () => {
    const notice = resumableConversationsNotice([summary, otherSummary]);
    expect(notice.title).toBe('Conversations you can resume');
    expect(notice.lines.join('\n')).toContain('#34');
    expect(notice.lines.at(-1)).toContain('/resume <id>');
    const text = [notice.title, ...notice.lines].join('\n');
    expect(text).not.toContain(RESUME_PICKER_TITLE);
    expect(text).not.toContain(RESUME_PICKER_FOOTER);
  });

  /**
   * GS2-112 — Ctrl+C from an open picker LEAVES, as it does from the other modal screens, rather
   * than being spent on closing the picker. The session is idle under it — `/resume` is idle-only
   * and no turn can be started while the prompt is unmounted — so this pins the answer the key is
   * supposed to give here, and that the cancel path taken on the way out does not break the exit.
   */
  it('Ctrl+C from the open picker leaves the session', async () => {
    const onExit = vi.fn();
    const listResumeCandidates = vi.fn(() => [summary, otherSummary]);
    const resume = vi.fn(async (id: number): Promise<ResumeResolution> => ({
      ok: true,
      target: targetFor(id),
    }));
    const { agent } = resumingAgent(resume);
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={agent}
        conversationId={3}
        onExit={onExit}
        listResumeCandidates={listResumeCandidates}
      />
    );
    await submit(stdin, lastFrame, '/resume');
    await vi.waitFor(() => expect(lastFrame()).toContain(RESUME_PICKER_TITLE));

    stdin.write('\x03');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(resume).not.toHaveBeenCalled();
    unmount();
  });

  it('without a store, both forms say resume is unavailable', async () => {
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
