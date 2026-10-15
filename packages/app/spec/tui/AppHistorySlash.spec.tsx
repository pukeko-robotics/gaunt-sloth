import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

/**
 * GS2-88 — the Ink TUI's half of the same claim the readline cells make in
 * `agent/spec/interactiveSessionModule.historySlash.spec.ts`.
 *
 * The registry is shared between the two surfaces (GS2-8), so a cell on one surface proves
 * nothing about the other: what differs is which context fields each surface populates, and that
 * is precisely where this node's defect lived. These cells drive the real `<App>` — props in,
 * context built, command dispatched, notice rendered — so the App's own forwarding is on the
 * path rather than assumed.
 */

const baseProps = {
  mode: 'chat' as const,
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

/** An agent whose turn emits exactly the events a cell hands it. */
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

describe('tui <App> — /history /insights /search (GS2-88)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // One `<App>` render per cell: an Ink render is the expensive part of these files and the
  // Windows cell pays for each one, so the pair is asserted as two cells that pin opposite sides
  // rather than as one cell mounting twice.
  it('renders the rows when the session read the store, and names no config', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={scriptedAgent([])}
        historyAvailability="available"
        historySummary={['#7  2026-09-01  [chat]  gemma4:12b  (2 turns)', '    widget factory']}
        insightsSummary={['Sessions: 4']}
        historySearch={() => ['#7  2026-09-01  [chat]', '    widget factory']}
      />
    );
    await submit(stdin, lastFrame, '/history');
    await vi.waitFor(() => expect(lastFrame()).toContain('widget factory'));
    expect(lastFrame()).not.toContain('history.enabled');
    unmount();
  });

  it('names the config only when the config is what switched history off', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={scriptedAgent([])} historyAvailability="disabled" />
    );
    await submit(stdin, lastFrame, '/history');
    await vi.waitFor(() => expect(lastFrame()).toContain('history.enabled'));
    // The other side of the pair: the rows the available cell above sees cannot appear here.
    expect(lastFrame()).not.toContain('widget factory');
    unmount();
  });

  it('/insights and /search read the same availability field', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={scriptedAgent([])} historyAvailability="disabled" />
    );
    await submit(stdin, lastFrame, '/insights');
    await vi.waitFor(() => expect(lastFrame()).toContain('history.enabled'));
    await submit(stdin, lastFrame, '/search widget');
    await vi.waitFor(() => expect(lastFrame()).toContain('history.enabled'));
    unmount();
  });
});

/**
 * GS2-88 §2 — the OTHER side of the `/reasoning` divergence.
 *
 * The readline surface passes no `turnReasonings` at all and is told so. This surface passes the
 * array, so every sentence it has always said must still be said — including the one about having
 * no committed turns, which is TRUE here when the array is empty. If the two readings were merged,
 * one of these two files would go red, which is the point of asserting on both.
 */
describe('tui <App> — /reasoning keeps its own, true copy (GS2-88)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reprints a committed turn thinking on the surface that records it', async () => {
    const agent = scriptedAgent([
      { type: 'reasoning_delta', delta: 'weighing the options' },
      { type: 'text', delta: 'the answer' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('the answer'));
    await submit(stdin, lastFrame, '/reasoning');
    await vi.waitFor(() => expect(lastFrame()).toContain('weighing the options'));
    // Never the readline surface's sentence: this one DOES keep the record.
    expect(lastFrame()).not.toContain('keeps no per-turn thinking record');
    unmount();
  });

  it('still says the session has no committed turns when it truly has none', async () => {
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={scriptedAgent([])} />);
    await submit(stdin, lastFrame, '/reasoning 1');
    await vi.waitFor(() => expect(lastFrame()).toContain('no committed turns'));
    expect(lastFrame()).not.toContain('keeps no per-turn thinking record');
    unmount();
  });
});
