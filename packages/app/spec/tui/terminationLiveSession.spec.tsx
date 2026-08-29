/**
 * [[EXT-159]] — **the reason reaches the live session on the Ink TUI**, which is the surface the
 * whole priority argument is about.
 *
 * Most people never make a debug dump. The ones most likely to hit a silent stop have already quit,
 * and `/debug-dump` is assembled from live session state that quitting destroys. And reading a dump
 * is a skill that fails — the maintainer read his own two dumps of this exact bug and did not see
 * the errors in them. So the run has to say why it ended *here*, under the answer, while the person
 * is still looking at the screen.
 *
 * **The reason is read after the stream, not carried on it.** A turn abandoned by the consumer never
 * finishes its generator, so an in-band event could not deliver the one ending most in need of an
 * explanation; the App asks the agent once the turn is over instead.
 *
 * **What is committed is the reason, not a rendered line.** The words below are computed in the test
 * from the same shared renderer the component paints with, so a cell fails if the App commits a
 * DIFFERENT reason — which a hand-written expected sentence could not tell.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { GthTerminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import { terminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import {
  TERMINATION_NOTICE_TITLE_PREFIX,
  terminationCode,
  terminationNotice,
} from '@gaunt-sloth/core/core/terminationNotice.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

/**
 * An agent that replays a script and then reports why the turn ended.
 *
 * `getTerminationReason` is a function rather than a value so a cell can make it throw — the App
 * must survive an agent that cannot answer, since explaining a turn is never allowed to be what
 * breaks the session.
 */
function agentEnding(
  events: AgentStreamEvent[],
  ending: () => GthTerminationReason | null
): TuiAgent {
  return {
    async *runTurn() {
      for (const event of events) {
        yield event;
        await Promise.resolve();
      }
    },
    getTerminationReason: ending,
  };
}

/** The reason [[TUI-C62]] is about: a turn cancelled by something the user never knowingly pressed. */
const cancelled = terminationReason('runner.events-cancelled', 'control', {
  category: 'cancelled',
  detail: 'signal',
});

describe('[[EXT-159]] SURFACE — the Ink TUI says why the turn ended', () => {
  it('puts the notice in the transcript when a turn ends for a reason worth reporting', async () => {
    const agent = agentEnding([{ type: 'text', delta: 'partial' }], () => cancelled);
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      const all = frames.join('\n');
      // Derived in the test from the reason, so a DIFFERENT reason committed by the App fails here.
      expect(all).toContain(terminationNotice(cancelled).title);
      // The quotable code, which is the one fact that makes the next bug report tractable.
      expect(all).toContain(terminationCode(cancelled));
    });

    unmount();
  });

  /**
   * The ending that had nothing on screen at all. The turn returns normally, no error is thrown, no
   * catch fires — from the App's side it is indistinguishable from a turn that simply finished, and
   * that is precisely the shape the node says gets blamed on the provider for months.
   */
  it('reports a stop that produced no answer and threw nothing', async () => {
    const empty = terminationReason('runner.events-empty', 'control', 'empty_response');
    const agent = agentEnding([], () => empty);
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain(terminationCode(empty));
    });

    unmount();
  });

  it('says nothing at all when the model simply finished', async () => {
    const done = terminationReason('runner.events-completed', 'control', 'completed');
    const agent = agentEnding([{ type: 'text', delta: 'all done' }], () => done);
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('all done');
    });
    expect(lastFrame()).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);

    unmount();
  });

  /** A parked graph is the middle of a working turn; announcing it would report a pause as an end. */
  it('says nothing for a turn that is merely suspended', async () => {
    const parked = terminationReason('agent.events-ended', 'control', 'suspended');
    const agent = agentEnding([{ type: 'text', delta: 'thinking' }], () => parked);
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('thinking');
    });
    expect(lastFrame()).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);

    unmount();
  });

  /**
   * The absence stays an absence on this surface too: nothing is said, and nothing is invented. A
   * placeholder here would be a false statement in the one place a person actually reads.
   */
  it('says nothing when no site classified the ending', async () => {
    const agent = agentEnding([{ type: 'text', delta: 'hm' }], () => null);
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('hm');
    });
    expect(lastFrame()).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);

    unmount();
  });

  it('keeps the session alive when the agent cannot answer why the turn ended', async () => {
    const agent = agentEnding([{ type: 'text', delta: 'fine' }], () => {
      throw new Error('no such method');
    });
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('fine');
    });

    unmount();
  });

  /** An agent that predates this — the scripted fixture agent — behaves exactly as it did. */
  it('is silent for an agent that does not report a reason at all', async () => {
    const agent: TuiAgent = {
      async *runTurn() {
        yield { type: 'text', delta: 'legacy' };
      },
    };
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('legacy');
    });
    expect(lastFrame()).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);

    unmount();
  });
});
