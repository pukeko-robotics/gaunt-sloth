import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import { AcpUpdateMapper } from '#src/modules/acp/acpUpdates.js';
import { AcpV1UpdateMapper } from '#src/modules/acp/acpUpdatesV1.js';

/**
 * [[TUI-C100]] — **what an ACP client is told about a call that is waiting on a human.**
 *
 * The runtime no longer ends a call before its own result is known, which is what stops the Ink TUI
 * drawing a tick over a command nobody has approved yet. That timing reaches this bridge too, and
 * one thing had to move with it: `rawInput`. ACP has no argument-delta update, so the arguments are
 * a whole value sent once — and it used to be sent on `tool_end`. Waiting for a call to end means
 * waiting for the human, and the arguments are exactly what the human is being asked to rule on,
 * so they are sent as soon as they are complete instead.
 *
 * The status story is unchanged and now happens to be truer: a gated call sits at `pending` (what
 * its creating update said) rather than being moved to `in_progress` before anything ran.
 *
 * Both dialects are covered because they are two hand-written mappers over one event stream, and a
 * fix applied to one of them is the shape of divergence this pairing exists to prevent.
 */

type Update = Record<string, unknown>;

/** Feed a mapper a sequence and collect every `session/update` it produces, in order. */
function mapAll(
  mapper: { map(event: AgentStreamEvent): unknown[] },
  events: AgentStreamEvent[]
): Update[] {
  return events.flatMap((event) => mapper.map(event) as Update[]);
}

/** A call announced with complete arguments and then held — no `tool_end`, no result. */
const gatedAnnouncement: AgentStreamEvent[] = [
  { type: 'tool_start', id: 'call-gate', name: 'run_shell_command' },
  {
    type: 'tool_args',
    id: 'call-gate',
    delta: '{"command":"git clone https://example.invalid/x"}',
  },
];

const mappers: Array<[string, () => { map(event: AgentStreamEvent): unknown[] }]> = [
  ['v2', () => new AcpUpdateMapper()],
  ['v1', () => new AcpV1UpdateMapper()],
];

describe.each(mappers)('[[TUI-C100]] ACP %s tool-call updates', (_dialect, makeMapper) => {
  it('sends the arguments while the call is still waiting on a human', async () => {
    const updates = mapAll(makeMapper(), gatedAnnouncement);

    const withRawInput = updates.filter((u) => u.rawInput !== undefined);
    expect(withRawInput).toHaveLength(1);
    expect(withRawInput[0].toolCallId).toBe('call-gate');
    expect(withRawInput[0].rawInput).toEqual({
      command: 'git clone https://example.invalid/x',
    });
  });

  it('does not report a gated call as running before it has run', async () => {
    const updates = mapAll(makeMapper(), gatedAnnouncement);

    // The creating update says `pending`, and nothing after it claims otherwise.
    expect(updates.filter((u) => u.status === 'in_progress')).toEqual([]);
    expect(updates.filter((u) => u.status === 'completed' || u.status === 'failed')).toEqual([]);
    expect(updates[0]).toMatchObject({ toolCallId: 'call-gate', status: 'pending' });
  });

  it('still moves a call to in_progress when it ends, without resending the arguments', async () => {
    const updates = mapAll(makeMapper(), [
      ...gatedAnnouncement,
      { type: 'tool_end', id: 'call-gate' },
    ]);

    const running = updates.filter((u) => u.status === 'in_progress');
    expect(running).toHaveLength(1);
    // The client already has them; an upsert that omits a field leaves it unchanged.
    expect(running[0].rawInput).toBeUndefined();
    expect(updates.filter((u) => u.rawInput !== undefined)).toHaveLength(1);
  });

  it('still settles the call on its result', async () => {
    const updates = mapAll(makeMapper(), [
      ...gatedAnnouncement,
      { type: 'tool_end', id: 'call-gate' },
      { type: 'tool_result', id: 'call-gate', content: 'cloned' },
    ]);

    expect(updates.at(-1)).toMatchObject({ toolCallId: 'call-gate', status: 'completed' });
  });

  it('carries a refusal through as failed, unchanged', async () => {
    const updates = mapAll(makeMapper(), [
      ...gatedAnnouncement,
      { type: 'tool_end', id: 'call-gate' },
      { type: 'tool_result', id: 'call-gate', content: 'rejected by the user', isError: true },
    ]);

    expect(updates.at(-1)).toMatchObject({ toolCallId: 'call-gate', status: 'failed' });
  });

  /**
   * A sibling that returns first does not drag the gated call's status along with it — the defect
   * this node is about, in the shape this surface would have shown it.
   */
  it('leaves a gated sibling pending when the other call of the round completes', async () => {
    const updates = mapAll(makeMapper(), [
      { type: 'tool_start', id: 'call-read', name: 'list_directory' },
      { type: 'tool_args', id: 'call-read', delta: '{"path":"/tmp"}' },
      ...gatedAnnouncement,
      { type: 'tool_end', id: 'call-read' },
      { type: 'tool_result', id: 'call-read', content: '[FILE] x' },
    ]);

    const gatedUpdates = updates.filter((u) => u.toolCallId === 'call-gate');
    expect(gatedUpdates.map((u) => u.status).filter(Boolean)).toEqual(['pending']);
    expect(gatedUpdates.some((u) => u.rawInput !== undefined)).toBe(true);
  });
});
