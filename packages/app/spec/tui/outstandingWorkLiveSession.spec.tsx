/**
 * [[EXT-158]] — **the unfinished-checklist notice reaches the live session on the Ink TUI.**
 *
 * The core specs prove the detector and the gate; `singleShot.spec.ts` proves one non-TUI surface.
 * Neither can catch the defect that lives here, in the wiring: the agent correctly reports
 * outstanding work, the gate correctly says to announce it, and the component never pushes
 * anything. Delete the push from `App.tsx` and every core cell stays green — so the wiring needs an
 * assertion of its own, on the surface the node is chiefly about.
 *
 * **The fact is read after the turn, not carried on the stream**, for the same reason the
 * termination reason is: a turn the consumer abandons never finishes its generator, so an in-band
 * event could not deliver it. The App asks the agent once the turn is over.
 *
 * **What the cells compare against is derived from the same renderer the component paints with**, so
 * a cell fails if the App announces a DIFFERENT set of counts — which a hand-written expected
 * sentence could not tell. The silence cells use the shared title PREFIX instead, because the whole
 * claim there is that no such notice was drawn at all.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { GthTerminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import { terminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import type { GthOutstandingWork } from '@gaunt-sloth/core/core/outstandingWork.js';
import {
  OUTSTANDING_WORK_NOTICE_TITLE_PREFIX,
  outstandingWorkNotice,
} from '@gaunt-sloth/core/core/outstandingWork.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

/** The ending this node is about: the model stopped, and nothing went wrong. */
const finished = terminationReason('runner.events-completed', 'control', 'completed');

/** A run parked on a tool approval — mid-turn, and outstanding work is what that looks like. */
const parked = terminationReason('agent.events-ended', 'control', 'suspended');

/** Two of five items still to do, with one of them underway. */
function stall(overrides: Partial<GthOutstandingWork> = {}): GthOutstandingWork {
  return {
    outstanding: 2,
    completed: 3,
    total: 5,
    inProgress: 1,
    signature: 'sig-a',
    repeat: false,
    ...overrides,
  };
}

/**
 * An agent that replays a script, then answers both after-the-turn questions.
 *
 * Both are functions rather than values so a cell can make one throw — the App must survive an
 * agent that cannot answer, since explaining a turn is never allowed to be what breaks the session.
 */
function agentReporting(
  events: AgentStreamEvent[],
  ending: () => GthTerminationReason | null,
  work: () => GthOutstandingWork | null
): TuiAgent {
  return {
    async *runTurn() {
      for (const event of events) {
        yield event;
        await Promise.resolve();
      }
    },
    getTerminationReason: ending,
    getOutstandingWork: work,
  };
}

describe('[[EXT-158]] SURFACE — the Ink TUI says the checklist was left unfinished', () => {
  it('puts the notice in the transcript when a turn ends cleanly with work outstanding', async () => {
    const work = stall();
    const agent = agentReporting(
      [{ type: 'text', delta: 'all set' }],
      () => finished,
      () => work
    );
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      // Derived from the work value, so DIFFERENT counts committed by the App fail here.
      expect(frames.join('\n')).toContain(outstandingWorkNotice(work).title);
    });

    unmount();
  });

  /**
   * **The cell the gate exists for.** A suspended run is parked on a tool-approval interrupt with
   * its checklist outstanding *by construction* — the work is mid-flight. Had the gate been written
   * as the complement of `shouldAnnounceTermination`, which also declines `suspended`, every gated
   * tool call in the session would have drawn this notice under the half-finished turn.
   */
  it('says nothing for a turn that is merely suspended, however much is outstanding', async () => {
    const agent = agentReporting(
      [{ type: 'text', delta: 'thinking' }],
      () => parked,
      () => stall()
    );
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('thinking');
    });
    expect(lastFrame()).not.toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);

    unmount();
  });

  /**
   * The budget, on the surface that would show it. A stall that has already been announced once is
   * reported as a repeat, and the transcript is exactly where an unheeded notice would otherwise
   * accumulate into the banner nobody reads.
   */
  it('says nothing a second time for a stall it has already reported', async () => {
    const agent = agentReporting(
      [{ type: 'text', delta: 'again' }],
      () => finished,
      () => stall({ repeat: true })
    );
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('again');
    });
    expect(lastFrame()).not.toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);

    unmount();
  });

  /** The ordinary turn: finished, nothing outstanding, and no epitaph of any kind. */
  it('says nothing when the turn ended with no work outstanding', async () => {
    const agent = agentReporting(
      [{ type: 'text', delta: 'done' }],
      () => finished,
      () => null
    );
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('done');
    });
    expect(lastFrame()).not.toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);

    unmount();
  });

  it('keeps the session alive when the agent cannot answer what is outstanding', async () => {
    const agent = agentReporting(
      [{ type: 'text', delta: 'fine' }],
      () => finished,
      () => {
        throw new Error('no such method');
      }
    );
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('fine');
    });

    unmount();
  });

  /** An agent that predates this — the scripted fixture agent — behaves exactly as it did. */
  it('is silent for an agent that does not report outstanding work at all', async () => {
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
    expect(lastFrame()).not.toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);

    unmount();
  });
});
