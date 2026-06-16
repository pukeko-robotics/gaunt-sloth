import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';

describe('tui/viewModel foldEvents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('starts empty', async () => {
    const { initialTurnViewModel } = await import('#src/tui/viewModel.js');
    expect(initialTurnViewModel()).toEqual({
      text: '',
      reasoning: '',
      isReasoning: false,
      toolCalls: [],
    });
  });

  it('appends text deltas in order', async () => {
    const { foldEventSequence } = await import('#src/tui/viewModel.js');
    const events: AgentStreamEvent[] = [
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo, ' },
      { type: 'text', delta: 'world' },
    ];
    expect(foldEventSequence(events).text).toBe('Hello, world');
  });

  it('toggles the reasoning region and accumulates reasoning deltas', async () => {
    const { foldEventSequence } = await import('#src/tui/viewModel.js');
    const mid = foldEventSequence([
      { type: 'reasoning_start' },
      { type: 'reasoning_delta', delta: 'think ' },
      { type: 'reasoning_delta', delta: 'hard' },
    ]);
    expect(mid.isReasoning).toBe(true);
    expect(mid.reasoning).toBe('think hard');

    const { foldEvents } = await import('#src/tui/viewModel.js');
    const end = foldEvents(mid, { type: 'reasoning_end' });
    expect(end.isReasoning).toBe(false);
    expect(end.reasoning).toBe('think hard');
  });

  it('builds a per-id tool-call record across start/args/end/result', async () => {
    const { foldEventSequence } = await import('#src/tui/viewModel.js');
    const vm = foldEventSequence([
      { type: 'tool_start', id: 't1', name: 'read_file' },
      { type: 'tool_args', id: 't1', delta: '{"path":' },
      { type: 'tool_args', id: 't1', delta: '"a.ts"}' },
      { type: 'tool_end', id: 't1' },
      { type: 'tool_result', id: 't1', content: 'file body' },
    ]);
    expect(vm.toolCalls).toHaveLength(1);
    expect(vm.toolCalls[0]).toEqual({
      id: 't1',
      name: 'read_file',
      argsText: '{"path":"a.ts"}',
      status: 'done',
      result: 'file body',
    });
  });

  it('interleaves multiple tool calls preserving first-seen order', async () => {
    const { foldEventSequence } = await import('#src/tui/viewModel.js');
    const vm = foldEventSequence([
      { type: 'tool_start', id: 'a', name: 'ls' },
      { type: 'tool_start', id: 'b', name: 'grep' },
      { type: 'tool_args', id: 'b', delta: '{"q":1}' },
      { type: 'tool_args', id: 'a', delta: '{}' },
      { type: 'tool_end', id: 'a' },
    ]);
    expect(vm.toolCalls.map((t) => t.id)).toEqual(['a', 'b']);
    expect(vm.toolCalls[0]).toMatchObject({ name: 'ls', argsText: '{}', status: 'done' });
    expect(vm.toolCalls[1]).toMatchObject({ name: 'grep', argsText: '{"q":1}', status: 'running' });
  });

  it('is defensive: a stray event for an unseen id creates a placeholder, never drops', async () => {
    const { foldEventSequence } = await import('#src/tui/viewModel.js');
    const vm = foldEventSequence([{ type: 'tool_result', id: 'ghost', content: 'orphan' }]);
    expect(vm.toolCalls).toEqual([
      { id: 'ghost', name: '', argsText: '', status: 'done', result: 'orphan' },
    ]);
  });

  it('does not mutate the input state (immutability for React ref-equality)', async () => {
    const { initialTurnViewModel, foldEvents } = await import('#src/tui/viewModel.js');
    const start = initialTurnViewModel();
    const next = foldEvents(start, { type: 'text', delta: 'x' });
    expect(start.text).toBe('');
    expect(next).not.toBe(start);
    expect(next.text).toBe('x');

    // A tool event must clone the toolCalls array rather than push into the prior one.
    const withTool = foldEvents(start, { type: 'tool_start', id: 't', name: 'ls' });
    expect(withTool.toolCalls).not.toBe(start.toolCalls);
    expect(start.toolCalls).toHaveLength(0);
  });
});
