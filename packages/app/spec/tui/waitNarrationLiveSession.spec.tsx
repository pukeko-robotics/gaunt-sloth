/**
 * [[EXT-92]] — **the three surfaces this node changes, asserted on the Ink TUI itself.**
 *
 * The core specs prove the mechanisms: `waitNarration.spec.ts` that a wait past the threshold
 * produces exactly one signal, `providerErrorNotice.spec.ts` that a provider error renders as
 * prose with the raw payload kept, and `GthLeanShellApprovalGate.spec.ts` that the real runner
 * really wraps the rating call and really tells a non-TUI surface. None of them can catch the
 * defect that lives here, in the wiring: the runtime emits correctly, the renderer is correct, and
 * the App never joins them. Delete the routing from `App.tsx` and every core cell stays green.
 *
 * So each cell below drives the **real `App`** and reads the **frames**:
 *
 * - **(a)** the status bar names the wait instead of claiming the model is thinking, and goes back
 *   to its own label when the wait is over;
 * - **(b)** a provider error reaches the transcript as prose, with no serialized object in it;
 * - **(e)** the turn that error ended is drawn as a turn that stopped, not one that finished.
 *
 * Every expected string is derived from the exported constant the production code paints from,
 * never from a hand-written copy — the [[EXT-158]] rule, for the reason that file gives: a
 * hand-written expectation cannot tell "the App drew something else" from "the App drew nothing".
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import { waitNarrationMessage } from '@gaunt-sloth/core/core/waitNarration.js';
import {
  PROVIDER_ERROR_METADATA_SEPARATOR,
  providerErrorNotice,
} from '@gaunt-sloth/core/core/providerErrorNotice.js';
import type { TranscriptItem, TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';
import { RUNNING_LABEL_DEFAULT } from '#src/tui/components/StatusBar.js';
import { TURN_ENDED_IN_ERROR_MARK } from '#src/tui/viewModel.js';

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

/** The provider payload the reporter of #433 received, in the upstream's own flattened shape. */
const METADATA = {
  raw: 'google/gemini-3.6-flash is temporarily rate-limited upstream. Please retry shortly.',
  provider_name: 'Google',
  provider_error_code: '429',
  limit_source: 'upstream_provider_shared_pool',
  remedy_hint: 'Retry shortly, or add your own provider key',
  previous_errors: [{ code: 429 }],
};

function rateLimitError(): Error {
  const err = new Error(
    `Provider returned error | metadata: ${JSON.stringify(METADATA)}`
  ) as Error & { metadata?: unknown; statusCode?: number };
  err.metadata = METADATA;
  err.statusCode = 429;
  return err;
}

/** An agent whose turn is held open until the test releases it. */
function heldAgent(): { agent: TuiAgent; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    agent: {
      async *runTurn() {
        await held;
      },
    },
  };
}

/** An agent that yields `events`, then throws — the shape a provider refusal has. */
function throwingAgent(events: AgentStreamEvent[], error: unknown): TuiAgent {
  return {
    async *runTurn() {
      for (const event of events) {
        yield event;
        await Promise.resolve();
      }
      throw error;
    },
  };
}

describe('[[EXT-92]] SURFACE — the Ink TUI', () => {
  describe('scope (a) — the status bar names the wait', () => {
    /**
     * **The mislabel is the defect, not the silence.** While the rater holds the turn the bar used
     * to go on saying the model was thinking — for up to thirty seconds, about a call to a second
     * model that the user was never told had been made. This asserts the replacement AND the
     * absence of the old label, because a bar that showed both would read as two things happening.
     */
    it('replaces the model-thinking label with the named wait, and drops it when the wait ends', async () => {
      const narration = waitNarrationMessage('rating', { budgetMs: 30_000 });
      let emit: ((level: string, message: string) => void) | undefined;
      const { agent, release } = heldAgent();

      const { lastFrame, unmount } = render(
        <App
          {...baseProps}
          agent={agent}
          initialMessage="go"
          subscribeStatus={(cb) => {
            emit = cb;
            return () => {
              emit = undefined;
            };
          }}
        />
      );

      // The turn is running and the bar is saying what it has always said.
      await vi.waitFor(() => {
        expect(lastFrame()).toContain(RUNNING_LABEL_DEFAULT);
      });

      // The runtime reports the wait, at the level the TUI otherwise DROPS. That is the whole
      // wiring: routed before the INFO filter, to the bar rather than to the transcript.
      emit?.('INFO', narration);

      await vi.waitFor(() => {
        expect(lastFrame()).toContain(narration);
      });
      expect(lastFrame()).not.toContain(RUNNING_LABEL_DEFAULT);
      // A transient fact about now is not a transcript entry: it must not have been committed.
      expect(lastFrame()).not.toContain('[INFO]');

      release();
      await vi.waitFor(() => {
        expect(lastFrame()).not.toContain(narration);
      });

      unmount();
    });

    /** Ordinary INFO chatter is still dropped — the routing must not have widened the filter. */
    it('still swallows ordinary INFO chatter rather than showing it on the bar', async () => {
      let emit: ((level: string, message: string) => void) | undefined;
      const { agent, release } = heldAgent();

      const { lastFrame, unmount } = render(
        <App
          {...baseProps}
          agent={agent}
          initialMessage="go"
          subscribeStatus={(cb) => {
            emit = cb;
            return () => undefined;
          }}
        />
      );

      await vi.waitFor(() => {
        expect(lastFrame()).toContain(RUNNING_LABEL_DEFAULT);
      });
      emit?.('INFO', 'Loaded tools');
      await Promise.resolve();

      expect(lastFrame()).not.toContain('Loaded tools');
      expect(lastFrame()).toContain(RUNNING_LABEL_DEFAULT);

      release();
      unmount();
    });

    /** A WARNING is signal, and still reaches the transcript exactly as it did. */
    it('still commits a WARNING to the transcript', async () => {
      let emit: ((level: string, message: string) => void) | undefined;
      const { agent, release } = heldAgent();

      const { frames, unmount } = render(
        <App
          {...baseProps}
          agent={agent}
          initialMessage="go"
          subscribeStatus={(cb) => {
            emit = cb;
            return () => undefined;
          }}
        />
      );

      await vi.waitFor(() => {
        expect(frames.join('\n')).toContain(RUNNING_LABEL_DEFAULT);
      });
      emit?.('WARNING', 'the rater did not answer in time');

      await vi.waitFor(() => {
        expect(frames.join('\n')).toContain('the rater did not answer in time');
      });

      release();
      unmount();
    });
  });

  describe('scope (b) — the provider error is a sentence', () => {
    it('shows the provider’s own text and remedy, and no serialized object', async () => {
      const error = rateLimitError();
      const expected = providerErrorNotice(error);
      const agent = throwingAgent([{ type: 'text', delta: 'working' }], error);

      const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

      await vi.waitFor(() => {
        expect(frames.join('\n')).toContain('Retry shortly, or add your own provider key');
      });
      const screen = frames.join('\n');
      expect(screen).toContain(METADATA.raw);
      expect(screen).toContain(expected?.text.split('\n')[0]);
      // The before/after, stated as an absence — and asserted against a whitespace-STRIPPED frame.
      // Ink wraps a long `<Text>` at the terminal width, so a needle tested against the raw frame
      // can go missing because the renderer broke it across two rows rather than because the
      // product stopped printing it. That is an assertion that cannot fail for the reason it
      // claims to: mutating the renderer to put the blob back left this cell green until the
      // stripping below was added.
      const dense = screen.replace(/\s+/g, '');
      expect(dense).not.toContain('|metadata:');
      expect(dense).not.toContain('previous_errors');
      expect(dense).not.toContain('"remedy_hint"');
      expect(dense).not.toContain('limit_source');

      unmount();
    });

    /**
     * **The other half of the acceptance, which no screen assertion can reach.**
     *
     * Scope (b) is two claims, not one: the serialized payload leaves the user's line, *and* it
     * stays reachable in the dump. Every cell above asserts the first by reading frames — and the
     * field that carries the second is one the renderer never prints, so all of them stay green
     * when it is deleted (measured: dropping the `raw` spread from `App.tsx` left this file at 8/8).
     * An assertion on `providerErrorNotice(...).raw` would not close it either: that proves the
     * builder produced a value, not that the item the App pushed kept it.
     *
     * So this drives the real `/debug-dump` through the real App and reads the transcript the
     * archive writer is actually handed. The two assertions are a differential on one item: the
     * text the user saw has no serialized payload in it, and the `raw` beside it still does.
     */
    it('keeps the original payload on the transcript item that /debug-dump archives', async () => {
      const error = rateLimitError();
      const agent = throwingAgent([{ type: 'text', delta: 'working' }], error);
      const dumpDebugSession = vi.fn().mockReturnValue({ archiveDir: '/tmp/ext-92-dump' });

      const { stdin, lastFrame, unmount } = render(
        <App
          {...baseProps}
          agent={agent}
          initialMessage="go"
          resolvedConfig={{ modelDisplayName: 'test-model' }}
          dumpDebugSession={dumpDebugSession}
        />
      );

      await vi.waitFor(() => {
        expect(lastFrame()).toContain('Retry shortly, or add your own provider key');
      });

      await vi.waitFor(() => expect(lastFrame()).toContain('>'));
      stdin.write('/debug-dump');
      await vi.waitFor(() => expect(lastFrame()).toContain('/debug-dump'));
      stdin.write('\r');

      await vi.waitFor(() => expect(dumpDebugSession).toHaveBeenCalled());

      const input = dumpDebugSession.mock.calls[0][0] as { transcript: TranscriptItem[] };

      // **Identified by the field under test, not by position.** This fixture's agent throws
      // directly, so the App's catch pushes the only `system`/`error` item there is — but the real
      // runtime commits a second one *first*, from core's own `LLM invocation failed` status
      // update, which has no `raw` because a status subscription receives a string and never the
      // error object. Picking "the first errored system item" would therefore quietly assert
      // against the wrong item the day this spec is given a realistic agent. Asking instead whether
      // ANY item carries the original payload is the claim the acceptance actually makes: the
      // archive can still show it.
      expect(
        input.transcript.some((item) => item.kind === 'system' && item.raw === error.message)
      ).toBe(true);

      const errored = input.transcript.find(
        (item): item is Extract<TranscriptItem, { kind: 'system' }> =>
          item.kind === 'system' && item.level === 'error' && item.raw !== undefined
      );
      expect(errored).toBeDefined();

      // What the user read: prose, and nothing serialized.
      expect(errored?.text).toContain(METADATA.raw);
      expect(errored?.text).not.toContain(PROVIDER_ERROR_METADATA_SEPARATOR);
      expect(errored?.text).not.toContain('previous_errors');
      // What the archive still holds: the provider's original message, untouched.
      expect(errored?.raw).toBe(error.message);
      expect(errored?.raw).toContain(PROVIDER_ERROR_METADATA_SEPARATOR);
      expect(errored?.raw).toContain('previous_errors');

      unmount();
    });

    /**
     * The guard on the other side. An ordinary runtime failure has nothing this renderer can add,
     * and must keep exactly the line it always had — otherwise every error in the product gets
     * re-worded by a change that was about one provider's payload.
     */
    it('leaves an ordinary runtime error message exactly as it was', async () => {
      const agent = throwingAgent([], new Error('ENOENT: no such file or directory'));

      const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

      await vi.waitFor(() => {
        expect(frames.join('\n')).toContain('ENOENT: no such file or directory');
      });

      unmount();
    });
  });

  describe('scope (e) — the turn says it stopped', () => {
    /**
     * **The reporter's own signature.** Their turn carried 42 completed tool calls and `text: ""`,
     * with the error floating above it as an unrelated line — so the turn read as one that simply
     * had nothing to say, and the next thing they typed was *"what happend?"*. The mark is what
     * makes those two turns different objects on screen.
     */
    it('marks a turn that a provider error ended', async () => {
      const agent = throwingAgent([{ type: 'text', delta: 'half the job' }], rateLimitError());

      const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

      await vi.waitFor(() => {
        expect(frames.join('\n')).toContain(TURN_ENDED_IN_ERROR_MARK);
      });
      expect(frames.join('\n')).toContain('half the job');

      unmount();
    });

    /** A textless turn is the worst case and the one the node measured: it must still be marked. */
    it('marks a turn that ended in error with nothing to say at all', async () => {
      const agent = throwingAgent([], rateLimitError());

      const { frames, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

      await vi.waitFor(() => {
        expect(frames.join('\n')).toContain(TURN_ENDED_IN_ERROR_MARK);
      });

      unmount();
    });

    /** The control: a turn that finished quietly is NOT marked, or the mark means nothing. */
    it('leaves a turn that finished quietly unmarked', async () => {
      const agent: TuiAgent = {
        async *runTurn() {
          yield { type: 'text', delta: 'all done' };
        },
      };

      const { frames, lastFrame, unmount } = render(
        <App {...baseProps} agent={agent} initialMessage="go" />
      );

      await vi.waitFor(() => {
        expect(frames.join('\n')).toContain('all done');
      });
      expect(lastFrame()).not.toContain(TURN_ENDED_IN_ERROR_MARK);

      unmount();
    });
  });
});
