import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';

const fsMock = { readFileSync: vi.fn() };
vi.mock('node:fs', () => fsMock);

async function collect(gen: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe('createFixtureTuiAgent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('replays the events of a turn in order', async () => {
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        defaultDelayMs: 0,
        turns: [
          {
            events: [
              { type: 'text', delta: 'a' },
              { type: 'text', delta: 'b' },
            ],
          },
        ],
      })
    );
    const { createFixtureTuiAgent } = await import('#src/tui/fixtureAgent.js');
    const agent = createFixtureTuiAgent('/fixtures/x.json');

    const events = await collect(agent.runTurn('hi', new AbortController().signal));

    expect(events).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'b' },
    ]);
  });

  it('advances through turns and clamps to the last when prompts outnumber turns', async () => {
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        defaultDelayMs: 0,
        turns: [
          { events: [{ type: 'text', delta: 'first' }] },
          { events: [{ type: 'text', delta: 'second' }] },
        ],
      })
    );
    const { createFixtureTuiAgent } = await import('#src/tui/fixtureAgent.js');
    const agent = createFixtureTuiAgent('/fixtures/x.json');
    const signal = new AbortController().signal;

    expect(await collect(agent.runTurn('1', signal))).toEqual([{ type: 'text', delta: 'first' }]);
    expect(await collect(agent.runTurn('2', signal))).toEqual([{ type: 'text', delta: 'second' }]);
    // Third prompt re-uses the last turn.
    expect(await collect(agent.runTurn('3', signal))).toEqual([{ type: 'text', delta: 'second' }]);
  });

  it('throws when the abort signal is already set (Esc surface)', async () => {
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ turns: [{ events: [{ type: 'text', delta: 'a' }] }] })
    );
    const { createFixtureTuiAgent } = await import('#src/tui/fixtureAgent.js');
    const agent = createFixtureTuiAgent('/fixtures/x.json');
    const controller = new AbortController();
    controller.abort();

    await expect(collect(agent.runTurn('hi', controller.signal))).rejects.toThrow('Interrupted');
  });

  it('yields nothing for an empty fixture', async () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ turns: [] }));
    const { createFixtureTuiAgent } = await import('#src/tui/fixtureAgent.js');
    const agent = createFixtureTuiAgent('/fixtures/x.json');

    expect(await collect(agent.runTurn('hi', new AbortController().signal))).toEqual([]);
  });
});
