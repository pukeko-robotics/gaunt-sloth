import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '#src/core/types.js';

// Mock consoleUtils (the default sink routes the notice through displayInfo).
const consoleUtilsMock = {
  displayInfo: vi.fn(),
  displayError: vi.fn(),
  displayWarning: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

// Mock systemUtils (the default sink writes output chunks to stdout).
const systemUtilsMock = {
  stdout: {
    write: vi.fn(),
  },
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

describe('toolOutputChannel (TUI-C17)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Fresh module instance per test so the module-level subscriber can never leak across tests.
    vi.resetModules();
  });

  describe('emitToolOutput default sink (no subscriber — the headless path)', () => {
    it('writes output chunks verbatim to stdout, exactly like the historical toolkits', async () => {
      const { emitToolOutput } = await import('#src/core/toolOutputChannel.js');
      emitToolOutput({ toolName: 'run_tests', kind: 'output', text: 'line one\n' });
      expect(systemUtilsMock.stdout.write).toHaveBeenCalledWith('line one\n');
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
    });

    it('routes the notice through displayInfo with the historical leading newline', async () => {
      const { emitToolOutput } = await import('#src/core/toolOutputChannel.js');
      emitToolOutput({
        toolName: 'run_tests',
        kind: 'notice',
        text: '🔧 Executing run_tests: npm test',
      });
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        '\n🔧 Executing run_tests: npm test'
      );
      expect(systemUtilsMock.stdout.write).not.toHaveBeenCalled();
    });
  });

  describe('subscription (the managed / TUI path)', () => {
    it('delivers chunks to the subscriber and suppresses the default sink entirely', async () => {
      const { emitToolOutput, subscribeToolOutput } =
        await import('#src/core/toolOutputChannel.js');
      const listener = vi.fn();
      const unsubscribe = subscribeToolOutput(listener);
      try {
        emitToolOutput({
          toolCallId: 'call-1',
          toolName: 'run_shell_command',
          kind: 'notice',
          text: '🔧 Executing run_shell_command: ls -la',
        });
        emitToolOutput({
          toolCallId: 'call-1',
          toolName: 'run_shell_command',
          kind: 'output',
          text: 'total 12\n',
        });
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenNthCalledWith(1, {
          toolCallId: 'call-1',
          toolName: 'run_shell_command',
          kind: 'notice',
          text: '🔧 Executing run_shell_command: ls -la',
        });
        expect(listener).toHaveBeenNthCalledWith(2, {
          toolCallId: 'call-1',
          toolName: 'run_shell_command',
          kind: 'output',
          text: 'total 12\n',
        });
        expect(systemUtilsMock.stdout.write).not.toHaveBeenCalled();
        expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });

    it('unsubscribe restores the default stdout sink', async () => {
      const { emitToolOutput, subscribeToolOutput } =
        await import('#src/core/toolOutputChannel.js');
      const listener = vi.fn();
      const unsubscribe = subscribeToolOutput(listener);
      unsubscribe();
      emitToolOutput({ toolName: 'run_tests', kind: 'output', text: 'chunk' });
      expect(listener).not.toHaveBeenCalled();
      expect(systemUtilsMock.stdout.write).toHaveBeenCalledWith('chunk');
    });

    it('a stale unsubscribe never detaches a newer subscriber (last one wins)', async () => {
      const { emitToolOutput, subscribeToolOutput } =
        await import('#src/core/toolOutputChannel.js');
      const first = vi.fn();
      const second = vi.fn();
      const unsubscribeFirst = subscribeToolOutput(first);
      const unsubscribeSecond = subscribeToolOutput(second);
      try {
        unsubscribeFirst(); // stale — must not clear `second`
        emitToolOutput({ toolName: 'run_tests', kind: 'output', text: 'chunk' });
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).not.toHaveBeenCalled();
        expect(systemUtilsMock.stdout.write).not.toHaveBeenCalled();
      } finally {
        unsubscribeSecond();
      }
    });
  });

  describe('mergeToolOutputIntoEvents', () => {
    async function collect(gen: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
      const out: AgentStreamEvent[] = [];
      for await (const event of gen) out.push(event);
      return out;
    }

    it('passes inner events through in order when no tool output is emitted', async () => {
      const { mergeToolOutputIntoEvents } = await import('#src/core/toolOutputChannel.js');
      async function* inner(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'a' };
        yield { type: 'text', delta: 'b' };
      }
      const events = await collect(mergeToolOutputIntoEvents(inner()));
      expect(events).toEqual([
        { type: 'text', delta: 'a' },
        { type: 'text', delta: 'b' },
      ]);
    });

    it('surfaces chunks emitted mid-stream as tool_output events attributed to the call', async () => {
      const { emitToolOutput, mergeToolOutputIntoEvents } =
        await import('#src/core/toolOutputChannel.js');
      async function* inner(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'before' };
        // Simulates a toolkit streaming output while the graph is between events (the real
        // toolkits emit during tool execution, i.e. while the stream awaits its next message).
        emitToolOutput({
          toolCallId: 't1',
          toolName: 'run_shell_command',
          kind: 'notice',
          text: '🔧 Executing run_shell_command: ls',
        });
        emitToolOutput({
          toolCallId: 't1',
          toolName: 'run_shell_command',
          kind: 'output',
          text: 'total 12\n',
        });
        yield { type: 'tool_result', id: 't1', content: 'done' };
      }
      const events = await collect(mergeToolOutputIntoEvents(inner()));
      expect(events).toEqual([
        { type: 'text', delta: 'before' },
        {
          type: 'tool_output',
          id: 't1',
          name: 'run_shell_command',
          chunk: '🔧 Executing run_shell_command: ls',
          isNotice: true,
        },
        { type: 'tool_output', id: 't1', name: 'run_shell_command', chunk: 'total 12\n' },
        { type: 'tool_result', id: 't1', content: 'done' },
      ]);
      // While merged, nothing leaks to the raw sinks.
      expect(systemUtilsMock.stdout.write).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
    });

    it('omits `id` when the producer had no tool call id (defensive fallback shape)', async () => {
      const { emitToolOutput, mergeToolOutputIntoEvents } =
        await import('#src/core/toolOutputChannel.js');
      async function* inner(): AsyncGenerator<AgentStreamEvent> {
        emitToolOutput({ toolName: 'my_tool', kind: 'output', text: 'x' });
        yield { type: 'text', delta: 'end' };
      }
      const events = await collect(mergeToolOutputIntoEvents(inner()));
      expect(events[0]).toEqual({ type: 'tool_output', name: 'my_tool', chunk: 'x' });
      expect('id' in events[0]).toBe(false);
    });

    it('delivers a chunk emitted while the inner stream is PENDING without waiting for it (live)', async () => {
      const { emitToolOutput, mergeToolOutputIntoEvents } =
        await import('#src/core/toolOutputChannel.js');
      let releaseInner: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseInner = resolve;
      });
      async function* inner(): AsyncGenerator<AgentStreamEvent> {
        await gate; // a long-running tool: the graph stream produces nothing until it finishes
        yield { type: 'tool_result', id: 't1', content: 'done' };
      }
      const merged = mergeToolOutputIntoEvents(inner());
      const firstEvent = merged.next(); // consumer is waiting on the merge
      // Give the pump a tick to start awaiting the (gated) inner stream.
      await Promise.resolve();
      emitToolOutput({ toolCallId: 't1', toolName: 'slow_tool', kind: 'output', text: 'tick\n' });
      // The chunk arrives BEFORE the inner stream has produced anything at all.
      await expect(firstEvent).resolves.toEqual({
        done: false,
        value: { type: 'tool_output', id: 't1', name: 'slow_tool', chunk: 'tick\n' },
      });
      releaseInner?.();
      const rest = await collect(merged as AsyncGenerator<AgentStreamEvent>);
      expect(rest).toEqual([{ type: 'tool_result', id: 't1', content: 'done' }]);
    });

    it('unsubscribes when the inner stream completes (later emits fall back to stdout)', async () => {
      const { emitToolOutput, mergeToolOutputIntoEvents } =
        await import('#src/core/toolOutputChannel.js');
      async function* inner(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'only' };
      }
      await collect(mergeToolOutputIntoEvents(inner()));
      emitToolOutput({ toolName: 'late_tool', kind: 'output', text: 'late' });
      expect(systemUtilsMock.stdout.write).toHaveBeenCalledWith('late');
    });

    it('propagates an inner throw (e.g. an abort) after draining, and unsubscribes', async () => {
      const { emitToolOutput, mergeToolOutputIntoEvents } =
        await import('#src/core/toolOutputChannel.js');
      async function* inner(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'pre' };
        throw new Error('stream failed');
      }
      const merged = mergeToolOutputIntoEvents(inner());
      const seen: AgentStreamEvent[] = [];
      await expect(async () => {
        for await (const event of merged) seen.push(event);
      }).rejects.toThrow('stream failed');
      expect(seen).toEqual([{ type: 'text', delta: 'pre' }]);
      // The subscription was released despite the failure.
      emitToolOutput({ toolName: 'after_error', kind: 'output', text: 'raw' });
      expect(systemUtilsMock.stdout.write).toHaveBeenCalledWith('raw');
    });
  });
});
