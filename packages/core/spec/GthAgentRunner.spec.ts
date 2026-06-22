import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { GthConfig } from '#src/config.js';
import type { StatusUpdateCallback } from '#src/core/types.js';

// Mock the GthLangChainAgent - using a simplified approach
const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  cleanup: vi.fn(),
};

vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class MockGthLangChainAgent {
    constructor() {
      return mockAgent;
    }
  },
  StatusUpdateCallback: vi.fn(),
}));

describe('GthAgentRunner', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdateCallback: Mock<StatusUpdateCallback>;
  let mockConfig: GthConfig;

  const BASE_GTH_CONFIG: Pick<
    GthConfig,
    | 'projectGuidelines'
    | 'streamOutput'
    | 'contentSource'
    | 'requirementSource'
    | 'contentProvider'
    | 'requirementsProvider'
    | 'projectReviewInstructions'
    | 'filesystem'
    | 'useColour'
    | 'writeOutputToFile'
    | 'writeBinaryOutputsToFile'
    | 'streamSessionInferenceLog'
    | 'canInterruptInferenceWithEsc'
    | 'includeCurrentDateAfterGuidelines'
  > = {
    projectGuidelines: 'test guidelines',
    streamOutput: false,
    contentSource: 'file',
    requirementSource: 'file',
    contentProvider: 'file',
    requirementsProvider: 'file',
    projectReviewInstructions: '.gsloth.review.md',
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: true,
    writeBinaryOutputsToFile: true,
    streamSessionInferenceLog: true,
    canInterruptInferenceWithEsc: true,
    includeCurrentDateAfterGuidelines: true,
  };

  beforeEach(async () => {
    vi.resetAllMocks();

    // Reset mock implementations
    mockAgent.init.mockClear();
    mockAgent.setVerbose.mockClear();
    mockAgent.invoke.mockClear();
    mockAgent.stream.mockClear();
    mockAgent.streamWithEvents.mockClear();
    mockAgent.cleanup.mockClear();
    // The HITL interrupt methods are added per-test on the shared mock; remove any that leaked
    // from a previous test so unrelated cases see an agent without interrupt support (no-op loop).
    delete (mockAgent as any).getPendingToolInterrupts;
    delete (mockAgent as any).streamResume;

    statusUpdateCallback = vi.fn();

    mockConfig = {
      ...BASE_GTH_CONFIG,
      llm: {
        _llmType: vi.fn().mockReturnValue('test'),
        verbose: false,
      } as any,
    };

    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  describe('init', () => {
    it('should initialize with basic configuration', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);

      await runner.init(undefined, mockConfig);

      expect(mockAgent.init).toHaveBeenCalledWith(undefined, mockConfig, undefined);
    });

    it('should initialize with checkpoint saver', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const checkpointSaver = new MemorySaver();

      await runner.init(undefined, mockConfig, checkpointSaver);

      expect(mockAgent.init).toHaveBeenCalledWith(undefined, mockConfig, checkpointSaver);
    });
  });

  describe('processMessages', () => {
    it('should throw error if not initialized', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);

      await expect(runner.processMessages([new HumanMessage('test')])).rejects.toThrow(
        'AgentRunner not initialized. Call init() first.'
      );
    });

    it('should delegate to agent invoke method when streaming is disabled', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.invoke.mockResolvedValue('test response');

      await runner.init(undefined, { ...mockConfig, streamOutput: false });

      const messages = [new HumanMessage('test message')];
      const result = await runner.processMessages(messages);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        messages,
        expect.objectContaining({
          recursionLimit: 1000,
          configurable: { thread_id: expect.any(String) },
        })
      );
      expect(mockAgent.stream).not.toHaveBeenCalled();
      expect(result).toBe('test response');
    });

    it('should delegate to agent stream method when streaming is enabled', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield 'chunk1';
          yield 'chunk2';
        },
      };
      mockAgent.stream.mockResolvedValue(mockStream);

      await runner.init(undefined, { ...mockConfig, streamOutput: true });

      const messages = [new HumanMessage('test message')];
      const result = await runner.processMessages(messages);

      expect(mockAgent.stream).toHaveBeenCalledWith(
        messages,
        expect.objectContaining({
          recursionLimit: 1000,
          configurable: { thread_id: expect.any(String) },
        })
      );
      expect(mockAgent.invoke).not.toHaveBeenCalled();
      expect(result).toBe('chunk1chunk2');
    });

    it('should fallback to non-streaming invoke when streaming response is empty', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield '';
          yield '';
        },
      };
      mockAgent.stream.mockResolvedValue(mockStream);
      mockAgent.invoke.mockResolvedValue('fallback response');

      await runner.init(undefined, { ...mockConfig, streamOutput: true });

      const messages = [new HumanMessage('test message')];
      const result = await runner.processMessages(messages);

      expect(mockAgent.stream).toHaveBeenCalledWith(
        messages,
        expect.objectContaining({
          recursionLimit: 1000,
          configurable: { thread_id: expect.any(String) },
        })
      );
      expect(mockAgent.invoke).toHaveBeenCalledWith(
        messages,
        expect.objectContaining({
          recursionLimit: 1000,
          configurable: { thread_id: expect.any(String) },
        })
      );
      expect(result).toBe('fallback response');
    });

    it('should throw when stream and fallback both return empty response', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield '';
          yield '';
        },
      };
      mockAgent.stream.mockResolvedValue(mockStream);
      mockAgent.invoke.mockResolvedValue('');

      await runner.init(undefined, { ...mockConfig, streamOutput: true });

      const messages = [new HumanMessage('test message')];
      await expect(runner.processMessages(messages)).rejects.toThrow(
        'Model returned an empty response after tool execution'
      );
    });

    it('should handle multiple messages', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.invoke.mockResolvedValue('combined response');

      await runner.init(undefined, { ...mockConfig, streamOutput: false });

      const messages = [new HumanMessage('first message'), new HumanMessage('second message')];
      const result = await runner.processMessages(messages);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        messages,
        expect.objectContaining({
          recursionLimit: 1000,
          configurable: { thread_id: expect.any(String) },
        })
      );
      expect(result).toBe('combined response');
    });

    it('should enrich vertex 401 errors with ADC and API key guidance', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.invoke.mockRejectedValue(new Error('Request failed with status code 401'));

      await runner.init(undefined, {
        ...mockConfig,
        streamOutput: false,
        llm: {
          _llmType: vi.fn().mockReturnValue('google'),
          verbose: false,
          _platform: 'gcp',
        } as any,
      });

      const messages = [new HumanMessage('test message')];
      try {
        await runner.processMessages(messages);
        expect(true).toBe(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toMatch(/gcloud auth application-default login/);
        expect(message).toMatch(/Google AI Studio key/);
      }
    });

    it('should not enrich non-vertex 401 errors', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.invoke.mockRejectedValue(new Error('Request failed with status code 401'));

      await runner.init(undefined, {
        ...mockConfig,
        streamOutput: false,
      });

      const messages = [new HumanMessage('test message')];
      try {
        await runner.processMessages(messages);
        expect(true).toBe(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toMatch(/gcloud auth application-default login/);
      }
    });
  });

  describe('tool-approval interrupts (run_shell_command)', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    it('approves a pending tool call via the callback, then resumes with an approve decision', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      // Initial turn streams some text, then suspends on one pending tool call.
      mockAgent.stream.mockResolvedValue(streamOf('working'));
      const getPending = vi
        .fn()
        // First check: one pending command. Second check (after resume): none.
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(' done'));
      (mockAgent as any).getPendingToolInterrupts = getPending;
      (mockAgent as any).streamResume = streamResume;

      await runner.init(undefined, { ...mockConfig, streamOutput: true });
      const approve = vi.fn().mockResolvedValue({ type: 'approve' });
      runner.setToolApprovalCallback(approve);

      const result = await runner.processMessages([new HumanMessage('run ls')]);

      expect(approve).toHaveBeenCalledWith({
        name: 'run_shell_command',
        args: { command: 'ls -la' },
      });
      // Resume sent the HITL decisions array shape humanInTheLoopMiddleware expects.
      expect(streamResume).toHaveBeenCalledWith(
        { decisions: [{ type: 'approve' }] },
        expect.anything()
      );
      expect(result).toBe('working done');
    });

    it('rejects when no approval callback is wired (non-interactive default)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('working'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'rm -rf /' } }])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;

      await runner.init(undefined, { ...mockConfig, streamOutput: true });
      // No setToolApprovalCallback → default reject.
      mockAgent.invoke.mockResolvedValue('rejected and continued');

      await runner.processMessages([new HumanMessage('run rm')]);

      const resumeArg = streamResume.mock.calls[0][0];
      expect(resumeArg.decisions[0].type).toBe('reject');
    });

    it('does not attempt interrupt resolution when the agent lacks getState support', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('hello'));
      // No getPendingToolInterrupts / streamResume on the mock → loop no-ops.
      delete (mockAgent as any).getPendingToolInterrupts;
      delete (mockAgent as any).streamResume;

      await runner.init(undefined, { ...mockConfig, streamOutput: true });
      const result = await runner.processMessages([new HumanMessage('hi')]);

      expect(result).toBe('hello');
    });
  });

  describe('processMessagesWithEvents', () => {
    it('should throw error if not initialized', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);

      const gen = runner.processMessagesWithEvents([new HumanMessage('test')]);
      await expect(gen.next()).rejects.toThrow('AgentRunner not initialized. Call init() first.');
    });

    it('should delegate to the agent streamWithEvents with the thread-bound runConfig and signal', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.streamWithEvents.mockImplementation(async function* () {
        yield { type: 'text', delta: 'Hel' };
        yield { type: 'text', delta: 'lo' };
      });

      await runner.init(undefined, { ...mockConfig, streamOutput: true });

      const messages = [new HumanMessage('hi')];
      const controller = new AbortController();
      const collected = [];
      for await (const event of runner.processMessagesWithEvents(messages, controller.signal)) {
        collected.push(event);
      }

      expect(mockAgent.streamWithEvents).toHaveBeenCalledWith(
        messages,
        expect.objectContaining({
          recursionLimit: 1000,
          configurable: { thread_id: expect.any(String) },
        }),
        controller.signal
      );
      expect(collected).toEqual([
        { type: 'text', delta: 'Hel' },
        { type: 'text', delta: 'lo' },
      ]);
    });
  });

  describe('resetThread', () => {
    it('rotates the thread_id so subsequent turns run against a fresh checkpointer thread', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.streamWithEvents.mockImplementation(async function* () {
        yield { type: 'text', delta: 'ok' };
      });

      await runner.init(undefined, { ...mockConfig, streamOutput: true });

      const messages = [new HumanMessage('hi')];

      // First turn: capture the thread_id the agent was driven with.
      for await (const _e of runner.processMessagesWithEvents(messages)) {
        void _e;
      }
      const firstConfig = mockAgent.streamWithEvents.mock.calls[0][1];
      const firstThreadId = firstConfig.configurable.thread_id;
      expect(firstThreadId).toEqual(expect.any(String));

      // Reset the thread, then run another turn.
      runner.resetThread();
      for await (const _e of runner.processMessagesWithEvents(messages)) {
        void _e;
      }
      const secondConfig = mockAgent.streamWithEvents.mock.calls[1][1];
      const secondThreadId = secondConfig.configurable.thread_id;

      expect(secondThreadId).toEqual(expect.any(String));
      // The whole point of TUI-C8: the second turn uses a different thread, so the model
      // no longer retrieves the prior conversation from the checkpointer.
      expect(secondThreadId).not.toBe(firstThreadId);
    });
  });

  describe('cleanup', () => {
    it('should delegate to agent cleanup and reset state', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);

      await runner.init(undefined, mockConfig);
      await runner.cleanup();

      expect(mockAgent.cleanup).toHaveBeenCalled();
      expect(runner['agent']).toBeNull();
      expect(runner['config']).toBeNull();
    });

    it('should handle cleanup when not initialized', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);

      await expect(runner.cleanup()).resolves.not.toThrow();
    });
  });
});
