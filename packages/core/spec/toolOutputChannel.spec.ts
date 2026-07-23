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

    it('TUI-C31 (a): routes a failure-path warning through displayWarning, verbatim', async () => {
      // Headless parity: a hardline-refusal advisory must render exactly as the toolkit's historical
      // displayWarning did — the text (including its own leading `\n⛔`) forwarded UNCHANGED, with
      // NO extra framing (unlike the notice case, which prepends its own newline).
      const { emitToolOutput } = await import('#src/core/toolOutputChannel.js');
      emitToolOutput({
        toolName: 'run_shell_command',
        kind: 'warning',
        text: '\n⛔ Refusing to execute: blocked by hardline safety policy',
      });
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        '\n⛔ Refusing to execute: blocked by hardline safety policy'
      );
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.stdout.write).not.toHaveBeenCalled();
    });

    it('TUI-C31 (a): routes a failure-path error through displayError, verbatim', async () => {
      const { emitToolOutput } = await import('#src/core/toolOutputChannel.js');
      emitToolOutput({
        toolName: 'run_shell_command',
        kind: 'error',
        text: "Failed to start command 'nope': spawn ENOENT.",
      });
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        "Failed to start command 'nope': spawn ENOENT."
      );
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
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

    it('TUI-C31 (a): a failure-path warning/error goes to the subscriber, NOT raw displayWarning/displayError', async () => {
      const { emitToolOutput, subscribeToolOutput } =
        await import('#src/core/toolOutputChannel.js');
      const listener = vi.fn();
      const unsubscribe = subscribeToolOutput(listener);
      try {
        emitToolOutput({
          toolCallId: 'c1',
          toolName: 'run_shell_command',
          kind: 'warning',
          text: '\n⛔ refuse',
        });
        emitToolOutput({
          toolCallId: 'c1',
          toolName: 'run_shell_command',
          kind: 'error',
          text: 'Failed to start',
        });
        expect(listener).toHaveBeenNthCalledWith(1, {
          toolCallId: 'c1',
          toolName: 'run_shell_command',
          kind: 'warning',
          text: '\n⛔ refuse',
        });
        expect(listener).toHaveBeenNthCalledWith(2, {
          toolCallId: 'c1',
          toolName: 'run_shell_command',
          kind: 'error',
          text: 'Failed to start',
        });
        // While managed, the failure-path advisory must NOT leak to the raw console (the Ink-frame
        // corruption this residual closes).
        expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
        expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });
  });

  describe('suppression while the TUI frame is mounted (TUI-C31 d)', () => {
    it('drops a post-turn straggler (no subscriber) instead of writing it raw over the frame', async () => {
      const { emitToolOutput, setToolOutputSuppressed, mergeToolOutputIntoEvents } =
        await import('#src/core/toolOutputChannel.js');
      async function collect(gen: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
        const out: AgentStreamEvent[] = [];
        for await (const event of gen) out.push(event);
        return out;
      }
      // Simulate the mounted TUI: suppression on for the whole session.
      setToolOutputSuppressed(true);
      try {
        async function* inner(): AsyncGenerator<AgentStreamEvent> {
          yield { type: 'text', delta: 'turn-1' };
        }
        // A turn runs and UNSUBSCRIBES on completion (restoring the no-subscriber default sink).
        await collect(mergeToolOutputIntoEvents(inner()));
        // Now a child that outlived the kill grace flushes AFTER unsubscribe, BETWEEN turns, while
        // Ink still owns the frame. It must NOT reach raw stdout / displayInfo.
        emitToolOutput({ toolName: 'straggler', kind: 'output', text: 'late\n' });
        emitToolOutput({ toolName: 'straggler', kind: 'notice', text: '🔧 late notice' });
        expect(systemUtilsMock.stdout.write).not.toHaveBeenCalled();
        expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      } finally {
        setToolOutputSuppressed(false);
      }
      // Once the TUI unmounts (suppression cleared), the headless default sink is restored.
      emitToolOutput({ toolName: 'after', kind: 'output', text: 'raw' });
      expect(systemUtilsMock.stdout.write).toHaveBeenCalledWith('raw');
    });

    it('an active per-turn subscriber always wins over suppression (in-turn output is untouched)', async () => {
      const { emitToolOutput, setToolOutputSuppressed, subscribeToolOutput } =
        await import('#src/core/toolOutputChannel.js');
      const listener = vi.fn();
      setToolOutputSuppressed(true);
      const unsubscribe = subscribeToolOutput(listener);
      try {
        emitToolOutput({ toolName: 'run_tests', kind: 'output', text: 'in-turn\n' });
        expect(listener).toHaveBeenCalledWith({
          toolName: 'run_tests',
          kind: 'output',
          text: 'in-turn\n',
        });
        expect(systemUtilsMock.stdout.write).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        setToolOutputSuppressed(false);
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

    it('TUI-C31 (a): maps a failure-path warning/error chunk to a tool_output event flagged isNotice', async () => {
      const { emitToolOutput, mergeToolOutputIntoEvents } =
        await import('#src/core/toolOutputChannel.js');
      async function* inner(): AsyncGenerator<AgentStreamEvent> {
        emitToolOutput({
          toolCallId: 't1',
          toolName: 'run_shell_command',
          kind: 'warning',
          text: '\n⛔ refuse',
        });
        emitToolOutput({
          toolCallId: 't1',
          toolName: 'run_shell_command',
          kind: 'error',
          text: 'boom',
        });
        yield { type: 'tool_result', id: 't1', content: 'done', isError: true };
      }
      const events = await collect(mergeToolOutputIntoEvents(inner()));
      expect(events).toEqual([
        {
          type: 'tool_output',
          id: 't1',
          name: 'run_shell_command',
          chunk: '\n⛔ refuse',
          isNotice: true,
        },
        { type: 'tool_output', id: 't1', name: 'run_shell_command', chunk: 'boom', isNotice: true },
        { type: 'tool_result', id: 't1', content: 'done', isError: true },
      ]);
      // Nothing leaked to the raw sinks while managed.
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    });

    it('TUI-C31 (b): yields a straggler queued in the window between the loop ending and unsubscribe', async () => {
      const { emitToolOutput, mergeToolOutputIntoEvents } =
        await import('#src/core/toolOutputChannel.js');
      async function* inner(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'a' };
        // `inner` then completes → the merge loop will observe `done` and break.
      }
      const merged = mergeToolOutputIntoEvents(inner());

      // Consume 'a'. The generator is now suspended at the yield; `inner` has been asked for its
      // next value (which completes it).
      const first = await merged.next();
      expect(first).toEqual({ done: false, value: { type: 'text', delta: 'a' } });

      // Deterministic barrier: a macrotask runs AFTER every pending microtask, so the pump has
      // finished draining `inner` and set `done = true` (this is event-loop ordering, not a timed
      // guess — `inner` completes with pure microtasks, no timers/IO).
      await new Promise((resolve) => setImmediate(resolve));

      // Resuming the loop now drains the (empty) queue, sees `done`, breaks, and SUSPENDS at
      // `await pump` — handing control back here synchronously with the subscriber STILL attached
      // (unsubscribe runs only after `await pump`). `merged.next()` returns the pending promise
      // without awaiting it.
      const secondP = merged.next();

      // Straggler emitted in exactly that microwindow: it is queued, but the in-loop drain already
      // ran and won't run again.
      emitToolOutput({ toolCallId: 's', toolName: 'straggler', kind: 'output', text: 'last\n' });

      // The fix drains anything left AFTER unsubscribe, so the straggler is yielded — not dropped.
      // (Mutation check: delete the post-`await pump` drain and this resolves to { done: true }.)
      await expect(secondP).resolves.toEqual({
        done: false,
        value: { type: 'tool_output', id: 's', name: 'straggler', chunk: 'last\n' },
      });
    });

    it('TUI-C31 (c): early-stop via return() releases inner, detaches the subscription, and does not hang', async () => {
      const { emitToolOutput, mergeToolOutputIntoEvents } =
        await import('#src/core/toolOutputChannel.js');
      // A long-running graph stream that has NOT completed when the consumer aborts: after 'a' it
      // parks on an await (the way `processMessagesWithEvents` is awaiting the graph mid-turn).
      async function* innerGen(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'a' };
        await new Promise<void>(() => {});
      }
      const inner = innerGen();
      const returnSpy = vi.spyOn(inner, 'return');
      const merged = mergeToolOutputIntoEvents(inner);

      const first = await merged.next();
      expect(first).toEqual({ done: false, value: { type: 'text', delta: 'a' } });

      // Let the pump reach its parked await on `inner` (so `done` is definitively false — the
      // early-stop precondition).
      await new Promise((resolve) => setImmediate(resolve));

      // Consumer aborts (a `for await` break) while the merge is suspended at its yield. It must
      // settle cleanly — bounded by a race so a regression that re-introduces `await pump` on a
      // parked inner reddens this test as a failure, not a whole-suite timeout.
      const ret = await Promise.race([
        merged.return(undefined as unknown as AgentStreamEvent),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('merged.return() hung')), 1000)
        ),
      ]);
      expect(ret).toEqual({ done: true, value: undefined });

      // Cleanup ran: inner was released (best-effort `return()` propagated to the inner stream)...
      // (Mutation check: delete the finally's `inner.return?.()` and this reddens.)
      expect(returnSpy).toHaveBeenCalled();
      // ...and the subscription was detached — a later emit falls back to the default sink, proving
      // no leaked subscription. (Mutation check: delete the finally's `unsubscribe()` and this stays
      // on the dead queue instead of reaching stdout.)
      emitToolOutput({ toolName: 'after', kind: 'output', text: 'raw' });
      expect(systemUtilsMock.stdout.write).toHaveBeenCalledWith('raw');
    });
  });
});
