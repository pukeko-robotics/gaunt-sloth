/**
 * [[EXT-178]] — **the end-of-run recap reaches the live session on the Ink TUI.**
 *
 * The core specs prove the source, the gate, the renderer and the arbitration on values, and
 * `singleShot.spec.ts` proves one non-TUI surface. None of them catches the defect that lives here,
 * in the wiring: the runner produces a recap, `runEndReport` says it should be drawn, and the
 * component never pushes anything. Delete the push from `App.tsx` and every core cell stays green —
 * so the surface the node is chiefly about needs assertions of its own.
 *
 * **The recap is read after the turn, not carried on the stream**, for the same reason the
 * termination reason and the outstanding-work value are: a turn the consumer abandons never
 * finishes its generator, so an in-band event could not deliver it. And it is awaited OFF the
 * turn's teardown — a model call made after the answer is already on screen must not hold the
 * spinner or the prompt — which is why every cell here waits for a frame rather than asserting one.
 *
 * **What the cells compare against is derived from the same renderer the component paints with**,
 * so a cell fails if the App draws a DIFFERENT recap — which a hand-written expected sentence could
 * not. The silence cells use the title PREFIXES instead, because the whole claim there is that no
 * such block was drawn at all.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { GthTerminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import { terminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import type { GthOutstandingWork } from '@gaunt-sloth/core/core/outstandingWork.js';
import { OUTSTANDING_WORK_NOTICE_TITLE_PREFIX } from '@gaunt-sloth/core/core/outstandingWork.js';
import type { GthRunRecap } from '@gaunt-sloth/core/core/runRecap.js';
import { RUN_RECAP_TITLE_PREFIX, runRecapNotice } from '@gaunt-sloth/core/core/runRecap.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

/** The ending this node is about: the model finished, and nothing went wrong. */
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
 * Let a resolved-but-dropped recap have every chance to draw before a cell asserts it did not.
 *
 * Needed only by the `/clear` cell, which has nothing positive to wait for: the whole claim is that
 * a frame never arrives, and `vi.waitFor` can only wait for one that does. Twenty macrotask turns is
 * far more than the push → `setState` → Ink render chain needs, and the mutation battery is what
 * says so — remove the invalidation and this cell reds, which a wait that was merely too short
 * could not do.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function recapValue(overrides: Partial<GthRunRecap> = {}): GthRunRecap {
  return {
    goal: 'Thread the recap rung through the config',
    happened: 'Edited the schema, regenerated the published JSON Schema, and built.',
    outstanding: 'The configuration page still needs the new key.',
    complete: false,
    work: null,
    ...overrides,
  };
}

/**
 * An agent that replays a script, then answers the three after-the-turn questions.
 *
 * All three are functions rather than values so a cell can make one throw or hang — the App must
 * survive an agent that cannot answer, since explaining a turn is never allowed to be what breaks
 * the session, and the recap is the one of the three that talks to a network.
 */
function agentReporting(
  events: AgentStreamEvent[],
  ending: () => GthTerminationReason | null,
  work: () => GthOutstandingWork | null,
  recap: () => Promise<GthRunRecap | null>
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
    requestRunRecap: recap,
  };
}

describe('[[EXT-178]] SURFACE — the Ink TUI draws the end-of-run recap', () => {
  it('puts the recap in the transcript when a clean turn produced one', async () => {
    const recap = recapValue();
    const agent = agentReporting(
      [{ type: 'text', delta: 'all set' }],
      () => finished,
      () => null,
      async () => recap
    );
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      // Derived from the recap value, so a DIFFERENT recap committed by the App fails here.
      expect(frames.join('\n')).toContain(runRecapNotice(recap).title);
    });
    // And the body, which is the half the node actually asks for: goal, what happened, what is left.
    expect(frames.join('\n')).toContain('Thread the recap rung through the config');

    unmount();
  });

  /**
   * **The subsumption cell on the surface.** Both would speak about this stop; exactly one does,
   * and it is the recap — proved by the absence of the notice's own title prefix from the whole
   * frame history, not merely from the last frame.
   */
  it('draws the recap instead of the unfinished-checklist notice, carrying its counts', async () => {
    const work = stall();
    const recap = recapValue({ work });
    const agent = agentReporting(
      [{ type: 'text', delta: 'partly' }],
      () => finished,
      () => work,
      async () => recap
    );
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain(RUN_RECAP_TITLE_PREFIX);
    });
    expect(frames.join('\n')).not.toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);
    expect(frames.join('\n')).toContain('2 of 5 items');

    unmount();
  });

  /**
   * The same stop with the recap unavailable — the rung is `off`, or the call failed. The floor
   * speaks. This is the cell that stops the suppression becoming a silent removal of [[EXT-158]].
   */
  it('leaves the notice standing when no recap was produced', async () => {
    const work = stall();
    const agent = agentReporting(
      [{ type: 'text', delta: 'partly' }],
      () => finished,
      () => work,
      async () => null
    );
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);
    });
    expect(frames.join('\n')).not.toContain(RUN_RECAP_TITLE_PREFIX);

    unmount();
  });

  /**
   * The acceptance's second bullet, on the surface: an announced category is [[EXT-159]]'s to
   * explain and this adds nothing to it. `suspended` is the case the gate is built around — a run
   * parked on a tool approval, outstanding by construction — so it doubles as the trap cell.
   */
  it('draws no recap for a run that is merely suspended', async () => {
    const agent = agentReporting(
      [{ type: 'text', delta: 'thinking' }],
      () => parked,
      () => stall(),
      // The runner's own gate declines this ending, so production never reaches the model here.
      // Answering `null` is what that looks like from the App's side.
      async () => null
    );
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('thinking');
    });
    expect(lastFrame()).not.toContain(RUN_RECAP_TITLE_PREFIX);

    unmount();
  });

  it('keeps the session alive when the recap call rejects', async () => {
    const agent = agentReporting(
      [{ type: 'text', delta: 'fine' }],
      () => finished,
      () => null,
      async () => {
        throw new Error('provider down');
      }
    );
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('fine');
    });

    unmount();
  });

  /**
   * **A recap is a model call, so the session does not stand still while it is out.** `/clear`
   * empties the transcript the pending recap is a summary OF, and appending it afterwards puts a
   * paragraph about a wiped conversation onto a blank screen — the one place the recap could say
   * something about work the user is no longer looking at.
   *
   * The deferred promise is the whole point of the cell: it holds the window open so the clear
   * lands strictly inside it, which is a race the other cells cannot reach because they resolve
   * immediately.
   */
  it('drops a recap still in flight when /clear wipes the conversation it describes', async () => {
    let release: (value: GthRunRecap | null) => void = () => {};
    const pending = new Promise<GthRunRecap | null>((resolve) => {
      release = resolve;
    });
    const cleared = recapValue({ goal: 'GOAL FROM THE CLEARED CONVERSATION' });
    const agent = agentReporting(
      [{ type: 'text', delta: 'done' }],
      () => finished,
      () => null,
      () => pending
    );
    const { stdin, frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    // The turn is over and the recap is out, but unanswered.
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));

    stdin.write('/clear');
    await vi.waitFor(() => expect(lastFrame()).toContain('/clear'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 0'));

    // The clear is the ONLY thing that has happened since — deliberately no second turn, since a
    // new turn invalidates a pending recap by itself and would carry this cell without `/clear`
    // ever being the reason it passed.
    release(cleared);
    await settle();

    expect(frames.join('\n')).not.toContain('GOAL FROM THE CLEARED CONVERSATION');
    expect(frames.join('\n')).not.toContain(RUN_RECAP_TITLE_PREFIX);

    unmount();
  });

  /**
   * The other half of the same window: the user does not clear, they simply ask something else.
   * A recap filed after the next turn has started reads as a summary of THAT turn, which is a
   * quieter version of the same wrong claim.
   */
  it('drops a recap still in flight when the next turn has already begun', async () => {
    let release: (value: GthRunRecap | null) => void = () => {};
    const pending = new Promise<GthRunRecap | null>((resolve) => {
      release = resolve;
    });
    const stale = recapValue({ goal: 'GOAL FROM THE SUPERSEDED TURN' });
    const current = recapValue({ goal: 'GOAL FROM THE CURRENT TURN' });
    let asked = 0;
    const agent = agentReporting(
      [{ type: 'text', delta: 'first' }],
      () => finished,
      () => null,
      () => {
        asked += 1;
        // Chained, as in the cell above: the superseded answer is delivered strictly before the
        // current one, so waiting for the current one is proof the stale one has had its chance.
        return asked === 1 ? pending : pending.then(() => current);
      }
    );
    const { stdin, frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));

    stdin.write('again');
    await vi.waitFor(() => expect(lastFrame()).toContain('again'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 2'));

    release(stale);
    await vi.waitFor(() => expect(frames.join('\n')).toContain('GOAL FROM THE CURRENT TURN'));

    expect(frames.join('\n')).not.toContain('GOAL FROM THE SUPERSEDED TURN');

    unmount();
  });

  /**
   * **An agent from before this existed still works.** `requestRunRecap` is optional on `TuiAgent`,
   * and the ACP/AG-UI-shaped doubles and any embedder's own agent will not have it. The optional
   * call must degrade to "no recap", not to a crash in the turn's teardown.
   */
  it('degrades to the notice for an agent that cannot be asked for a recap', async () => {
    const work = stall();
    const agent: TuiAgent = {
      async *runTurn() {
        yield { type: 'text', delta: 'older agent' } as AgentStreamEvent;
      },
      getTerminationReason: () => finished,
      getOutstandingWork: () => work,
    };
    const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);
    });

    unmount();
  });
});
