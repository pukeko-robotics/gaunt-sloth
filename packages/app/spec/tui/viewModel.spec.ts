import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';

describe('tui/viewModel foldEvents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('starts empty', async () => {
    const { initialTurnViewModel } = await import('#src/tui/viewModel.js');
    expect(initialTurnViewModel()).toEqual({
      segments: [],
      isReasoning: false,
    });
  });

  it('appends text deltas in order, as ONE uninterrupted run', async () => {
    const { foldEventSequence, turnText } = await import('#src/tui/viewModel.js');
    const events: AgentStreamEvent[] = [
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo, ' },
      { type: 'text', delta: 'world' },
    ];
    const vm = foldEventSequence(events);
    expect(vm.segments).toEqual([{ kind: 'text', text: 'Hello, world' }]);
    expect(turnText(vm)).toBe('Hello, world');
  });

  it('toggles the reasoning region and accumulates reasoning deltas as ONE run', async () => {
    const { foldEventSequence, turnReasoning } = await import('#src/tui/viewModel.js');
    const mid = foldEventSequence([
      { type: 'reasoning_start' },
      { type: 'reasoning_delta', delta: 'think ' },
      { type: 'reasoning_delta', delta: 'hard' },
    ]);
    expect(mid.isReasoning).toBe(true);
    expect(mid.segments).toEqual([{ kind: 'reasoning', text: 'think hard' }]);
    expect(turnReasoning(mid)).toBe('think hard');

    const { foldEvents } = await import('#src/tui/viewModel.js');
    const end = foldEvents(mid, { type: 'reasoning_end' });
    expect(end.isReasoning).toBe(false);
    expect(turnReasoning(end)).toBe('think hard');
  });

  it('builds a per-id tool-call record across start/args/end/result', async () => {
    const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
    const vm = foldEventSequence([
      { type: 'tool_start', id: 't1', name: 'read_file' },
      { type: 'tool_args', id: 't1', delta: '{"path":' },
      { type: 'tool_args', id: 't1', delta: '"a.ts"}' },
      { type: 'tool_end', id: 't1' },
      { type: 'tool_result', id: 't1', content: 'file body' },
    ]);
    expect(turnToolCalls(vm)).toHaveLength(1);
    expect(turnToolCalls(vm)[0]).toEqual({
      id: 't1',
      name: 'read_file',
      argsText: '{"path":"a.ts"}',
      status: 'done',
      result: 'file body',
    });
  });

  it('threads the tool_result isError signal onto the tool-call view model', async () => {
    const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
    const errored = foldEventSequence([
      { type: 'tool_start', id: 't1', name: 'run' },
      { type: 'tool_result', id: 't1', content: 'boom', isError: true },
    ]);
    expect(turnToolCalls(errored)[0]).toMatchObject({
      status: 'done',
      result: 'boom',
      isError: true,
    });

    // Success: no isError on the event => undefined on the model (renderer shows ✓).
    const ok = foldEventSequence([
      { type: 'tool_start', id: 't1', name: 'run' },
      { type: 'tool_result', id: 't1', content: 'Error handling guide' },
    ]);
    expect(turnToolCalls(ok)[0].isError).toBeUndefined();
  });

  /**
   * [[TUI-C69]] §5.4 — the gate's account of WHY a result is an error, folded beside `isError`
   * rather than instead of it. Dropped here, the panel would have the fact and no way to read it,
   * and a working negotiation round would go on rendering as a broken tool.
   */
  it('threads the tool_result raterClarification signal on, without disturbing isError', async () => {
    const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
    const clarified = foldEventSequence([
      { type: 'tool_start', id: 't1', name: 'run_shell_command' },
      {
        type: 'tool_result',
        id: 't1',
        content: 'Rejected. Narrow it.',
        isError: true,
        raterClarification: true,
      },
    ]);
    expect(turnToolCalls(clarified)[0]).toMatchObject({
      status: 'done',
      isError: true,
      raterClarification: true,
    });

    // An ordinary failure carries neither the flag nor a claim about one.
    const failed = foldEventSequence([
      { type: 'tool_start', id: 't1', name: 'run_shell_command' },
      { type: 'tool_result', id: 't1', content: 'exit 1', isError: true },
    ]);
    expect(turnToolCalls(failed)[0].raterClarification).toBeUndefined();
  });

  it('interleaves multiple tool calls preserving first-seen order', async () => {
    const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
    const vm = foldEventSequence([
      { type: 'tool_start', id: 'a', name: 'ls' },
      { type: 'tool_start', id: 'b', name: 'grep' },
      { type: 'tool_args', id: 'b', delta: '{"q":1}' },
      { type: 'tool_args', id: 'a', delta: '{}' },
      { type: 'tool_end', id: 'a' },
    ]);
    expect(turnToolCalls(vm).map((t) => t.id)).toEqual(['a', 'b']);
    expect(turnToolCalls(vm)[0]).toMatchObject({ name: 'ls', argsText: '{}', status: 'done' });
    expect(turnToolCalls(vm)[1]).toMatchObject({
      name: 'grep',
      argsText: '{"q":1}',
      status: 'running',
    });
  });

  it('is defensive: a stray event for an unseen id creates a placeholder, never drops', async () => {
    const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
    const vm = foldEventSequence([{ type: 'tool_result', id: 'ghost', content: 'orphan' }]);
    expect(turnToolCalls(vm)).toEqual([
      { id: 'ghost', name: '', argsText: '', status: 'done', result: 'orphan' },
    ]);
  });

  it('does not mutate the input state (immutability for React ref-equality)', async () => {
    const { initialTurnViewModel, foldEvents } = await import('#src/tui/viewModel.js');
    const start = initialTurnViewModel();
    const next = foldEvents(start, { type: 'text', delta: 'x' });
    expect(start.segments).toHaveLength(0);
    expect(next).not.toBe(start);
    expect(next.segments).toEqual([{ kind: 'text', text: 'x' }]);

    // A tool event must clone the segment list rather than push into the prior one.
    const withTool = foldEvents(start, { type: 'tool_start', id: 't', name: 'ls' });
    expect(withTool.segments).not.toBe(start.segments);
    expect(start.segments).toHaveLength(0);
  });

  describe('tool_output live output (TUI-C17)', () => {
    it('accumulates chunks on `output` and the notice on the SEPARATE `notice` field (TUI-C30)', async () => {
      const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
      const vm = foldEventSequence([
        {
          type: 'tool_output',
          id: 't1',
          name: 'run_shell_command',
          chunk: '🔧 Executing run_shell_command: ls -la',
          isNotice: true,
        },
        { type: 'tool_output', id: 't1', name: 'run_shell_command', chunk: 'total 12\n' },
        { type: 'tool_output', id: 't1', name: 'run_shell_command', chunk: 'drwxr file\n' },
      ]);
      expect(turnToolCalls(vm)).toHaveLength(1);
      // The notice lives apart from the raw child output so the TUI-C30 preview counts only
      // real output lines and can style/strip the announcement independently.
      expect(turnToolCalls(vm)[0].notice).toBe('🔧 Executing run_shell_command: ls -la');
      expect(turnToolCalls(vm)[0].output).toBe('total 12\ndrwxr file\n');
    });

    it('joins multiple notices with newlines on the notice field', async () => {
      const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
      const vm = foldEventSequence([
        { type: 'tool_output', id: 't1', name: 'run_tests', chunk: 'first notice', isNotice: true },
        {
          type: 'tool_output',
          id: 't1',
          name: 'run_tests',
          chunk: 'second notice',
          isNotice: true,
        },
      ]);
      expect(turnToolCalls(vm)[0].notice).toBe('first notice\nsecond notice');
      expect(turnToolCalls(vm)[0].output).toBeUndefined();
    });

    it('creates a named placeholder when output arrives BEFORE tool_start (the common live case)', async () => {
      // The agent stream only flushes tool_start when the round's ToolMessage lands, so live
      // output normally precedes it. The placeholder must carry the tool name so the running
      // panel is labelled, and the later tool_start/result must land on the SAME call.
      const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
      const vm = foldEventSequence([
        { type: 'tool_output', id: 't1', name: 'run_tests', chunk: 'suite starting\n' },
        { type: 'tool_start', id: 't1', name: 'run_tests' },
        { type: 'tool_args', id: 't1', delta: '{}' },
        { type: 'tool_end', id: 't1' },
        { type: 'tool_result', id: 't1', content: 'all green' },
      ]);
      expect(turnToolCalls(vm)).toHaveLength(1);
      expect(turnToolCalls(vm)[0]).toMatchObject({
        id: 't1',
        name: 'run_tests',
        status: 'done',
        output: 'suite starting\n',
        result: 'all green',
      });
    });

    it('keeps output attributed per call id when two tools stream interleaved', async () => {
      const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
      const vm = foldEventSequence([
        { type: 'tool_output', id: 'a', name: 'run_lint', chunk: 'lint-1\n' },
        { type: 'tool_output', id: 'b', name: 'run_build', chunk: 'build-1\n' },
        { type: 'tool_output', id: 'a', name: 'run_lint', chunk: 'lint-2\n' },
      ]);
      expect(turnToolCalls(vm).map((t) => t.id)).toEqual(['a', 'b']);
      expect(turnToolCalls(vm)[0].output).toBe('lint-1\nlint-2\n');
      expect(turnToolCalls(vm)[1].output).toBe('build-1\n');
    });

    it('TUI-C31 (e): an id-less chunk goes to the synthetic per-name bucket, never pinned to a running same-name call', async () => {
      const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
      const vm = foldEventSequence([
        { type: 'tool_start', id: 'real', name: 'my_tool' },
        { type: 'tool_output', name: 'my_tool', chunk: 'no-id chunk\n' },
      ]);
      // The real running call is NOT polluted by an id-less chunk (the old fallback pinned it here).
      expect(turnToolCalls(vm).find((t) => t.id === 'real')?.output).toBeUndefined();
      // Instead it lands in a clearly-synthetic bucket — output is still never dropped.
      expect(turnToolCalls(vm).find((t) => t.id === 'my_tool#live')?.output).toBe('no-id chunk\n');
      expect(turnToolCalls(vm)).toHaveLength(2);
    });

    it('TUI-C31 (e): an id-less chunk is not mis-attributed across two concurrent same-name calls', async () => {
      const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
      const vm = foldEventSequence([
        { type: 'tool_start', id: 'call-A', name: 'run_shell_command' },
        { type: 'tool_start', id: 'call-B', name: 'run_shell_command' },
        // A defensive id-less chunk arrives while BOTH same-name calls are running. The old fallback
        // pinned it to the latest running one (call-B), splicing one call's live output into
        // another's panel. It must instead go to the synthetic bucket, leaving BOTH real calls clean.
        { type: 'tool_output', name: 'run_shell_command', chunk: 'ambiguous\n' },
      ]);
      expect(turnToolCalls(vm).find((t) => t.id === 'call-A')?.output).toBeUndefined();
      expect(turnToolCalls(vm).find((t) => t.id === 'call-B')?.output).toBeUndefined();
      expect(turnToolCalls(vm).find((t) => t.id === 'run_shell_command#live')?.output).toBe(
        'ambiguous\n'
      );
    });

    it('never drops id-less output with no matching running call (synthetic per-name bucket)', async () => {
      const { foldEventSequence, turnToolCalls } = await import('#src/tui/viewModel.js');
      const vm = foldEventSequence([{ type: 'tool_output', name: 'orphan_tool', chunk: 'x\n' }]);
      expect(turnToolCalls(vm)).toHaveLength(1);
      expect(turnToolCalls(vm)[0]).toMatchObject({
        id: 'orphan_tool#live',
        name: 'orphan_tool',
        output: 'x\n',
      });
    });

    it('does not mutate prior state when folding tool_output (immutability)', async () => {
      const { initialTurnViewModel, foldEvents } = await import('#src/tui/viewModel.js');
      const start = initialTurnViewModel();
      const next = foldEvents(start, {
        type: 'tool_output',
        id: 't1',
        name: 'run_tests',
        chunk: 'line\n',
      });
      expect(start.segments).toHaveLength(0);
      expect(next.segments).toHaveLength(1);
      expect(next.segments).not.toBe(start.segments);
    });
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
