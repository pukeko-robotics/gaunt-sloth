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

describe('tui/viewModel foldSubagentTree', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('starts empty', async () => {
    const { initialSubagentTree } = await import('#src/tui/viewModel.js');
    expect(initialSubagentTree()).toEqual({ nodes: [] });
  });

  it('folds a `task` tool call into a subagent node (type + description + result)', async () => {
    const { foldSubagentTree } = await import('#src/tui/viewModel.js');
    const tree = foldSubagentTree([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"researcher",' },
      { type: 'tool_args', id: 's1', delta: '"description":"dig into X"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: 'found it' },
    ]);
    expect(tree.nodes).toEqual([
      {
        id: 's1',
        type: 'researcher',
        description: 'dig into X',
        status: 'done',
        result: 'found it',
      },
    ]);
  });

  it('ignores non-task tool calls entirely (only subagents land in the tree)', async () => {
    const { foldSubagentTree } = await import('#src/tui/viewModel.js');
    const tree = foldSubagentTree([
      { type: 'tool_start', id: 'r1', name: 'read_file' },
      { type: 'tool_args', id: 'r1', delta: '{"path":"a.ts"}' },
      { type: 'tool_end', id: 'r1' },
      { type: 'tool_result', id: 'r1', content: 'body' },
      { type: 'text', delta: 'hello' },
    ]);
    expect(tree.nodes).toEqual([]);
  });

  it('tracks multiple subagents in first-spawned order, marking running vs done', async () => {
    const { foldSubagentTree } = await import('#src/tui/viewModel.js');
    const tree = foldSubagentTree([
      { type: 'tool_start', id: 'a', name: 'task' },
      { type: 'tool_args', id: 'a', delta: '{"subagent_type":"alpha","description":"first"}' },
      { type: 'tool_start', id: 'b', name: 'task' },
      { type: 'tool_args', id: 'b', delta: '{"subagent_type":"beta","description":"second"}' },
      { type: 'tool_end', id: 'a' },
    ]);
    expect(tree.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree.nodes[0]).toMatchObject({ type: 'alpha', description: 'first', status: 'done' });
    expect(tree.nodes[1]).toMatchObject({ type: 'beta', description: 'second', status: 'running' });
  });

  it('tolerates partial/invalid JSON args without throwing (defensive parse)', async () => {
    const { foldSubagentTree } = await import('#src/tui/viewModel.js');
    const tree = foldSubagentTree([
      { type: 'tool_start', id: 's1', name: 'task' },
      // half-streamed JSON: not yet parseable
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"res' },
    ]);
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]).toMatchObject({
      id: 's1',
      type: 'subagent',
      description: '',
      status: 'running',
    });
  });

  it('fills type/description as soon as the streamed args buffer becomes valid JSON', async () => {
    const { foldSubagentTree } = await import('#src/tui/viewModel.js');
    const tree = foldSubagentTree([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"res' },
      { type: 'tool_args', id: 's1', delta: 'earcher","description":"go"}' },
    ]);
    expect(tree.nodes[0]).toMatchObject({ type: 'researcher', description: 'go' });
  });

  it('does not mutate prior state (immutability for React ref-equality)', async () => {
    const { initialSubagentTree, foldSubagentTree } = await import('#src/tui/viewModel.js');
    const start = initialSubagentTree();
    const next = foldSubagentTree([{ type: 'tool_start', id: 's1', name: 'task' }], start);
    expect(start.nodes).toHaveLength(0);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes).not.toBe(start.nodes);
  });
});
