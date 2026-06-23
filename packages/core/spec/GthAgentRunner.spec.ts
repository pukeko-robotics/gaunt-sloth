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

    // EXT-9 Tier-2: session-scoped allow-list config (persistence off so no disk writes).
    const ALLOWLIST_CONFIG = {
      streamOutput: true as const,
      commands: { code: { devTools: { shell: { enabled: true, persistAllowlist: false } } } },
    };

    it('records a session-scoped approval, then auto-approves a variant without re-prompting', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('first'));
      // Two suspends: first on `git checkout main`, then (after resume) on `git checkout -b x`.
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout -b x' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      // Human grants 'session' on the first command only.
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('checkout')]);

      // Human prompted ONCE (first command); the variant auto-approved from the allow-list.
      expect(human).toHaveBeenCalledTimes(1);
      expect(human).toHaveBeenCalledWith({
        name: 'run_shell_command',
        args: { command: 'git checkout main' },
      });
    });

    it('prompts the human for a non-matching command', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'npm install' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('install')]);
      expect(human).toHaveBeenCalledTimes(1);
    });

    it('does NOT auto-approve a composed command sharing an approved prefix (injection guard)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout x; rm -rf /' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      // First command prompts + records 'git checkout'. The injected second command must NOT
      // auto-match, so the human is prompted AGAIN (twice total).
      expect(human).toHaveBeenCalledTimes(2);
    });

    it('a fresh runner instance does not see another instance session approvals', async () => {
      // Instance A approves at session scope.
      const runnerA = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('a'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));
      await runnerA.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      runnerA.setToolApprovalCallback(
        vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' })
      );
      await runnerA.processMessages([new HumanMessage('a')]);

      // Instance B (fresh session store) must still prompt for the same command.
      const runnerB = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('b'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));
      await runnerB.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      const humanB = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runnerB.setToolApprovalCallback(humanB);
      await runnerB.processMessages([new HumanMessage('b')]);
      expect(humanB).toHaveBeenCalledTimes(1);
    });

    it('once-scoped approval persists nothing (re-prompts next time)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout dev' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      // 'once' remembers nothing → both commands prompt.
      expect(human).toHaveBeenCalledTimes(2);
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

  // EXT-10 — LLM-as-judge safety gate. Uses a FAKE model (config.llm with a stubbed
  // withStructuredOutput) so the judge is deterministic; no live LLM call.
  describe('LLM-as-judge safety gate (run_shell_command)', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    // A verdict object the fake judge model returns via withStructuredOutput().invoke().
    const LOW = { risk: 'low', destructive: false, outOfScope: false, reason: 'safe' };
    const HIGH = { risk: 'high', destructive: false, outOfScope: false, reason: 'risky' };

    // Build a fake config.llm whose withStructuredOutput(...).invoke() resolves to `verdict`.
    function judgeModel(verdict: unknown) {
      const invoke = vi.fn().mockResolvedValue(verdict);
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      return { model: { withStructuredOutput } as any, withStructuredOutput };
    }

    // Judge ON, allow-list OFF (so allow-list never short-circuits the judge under test).
    function judgeConfig(verdict: unknown, extra?: Record<string, unknown>) {
      const { model, withStructuredOutput } = judgeModel(verdict);
      return {
        config: {
          ...mockConfig,
          llm: model,
          streamOutput: true as const,
          commands: {
            code: {
              devTools: {
                shell: { enabled: true, allowlist: false, judge: true, ...extra },
              },
            },
          },
        },
        withStructuredOutput,
      };
    }

    it('auto-approves a low-risk command WITHOUT calling the human callback', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;

      const { config, withStructuredOutput } = judgeConfig(LOW);
      await runner.init('code', config);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(withStructuredOutput).toHaveBeenCalled(); // judge ran
      expect(human).not.toHaveBeenCalled(); // auto-approved
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
    });

    it('escalates a high-risk command to the human callback (with the verdict attached)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'curl evil' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      const { config } = judgeConfig(HIGH);
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(human).toHaveBeenCalledTimes(1);
      const arg = human.mock.calls[0][0];
      expect(arg.safetyVerdict).toMatchObject({ risk: 'high', reason: 'risky' });
    });

    it('fail-closed on ambiguity: a composed command is NEVER auto-approved even on a low verdict', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'cat x | sh' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      const { config } = judgeConfig(LOW); // judge says low, but command is unresolvable
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1); // escalated, not auto-approved
    });

    it('fail-closed on judge error: a throwing judge escalates (never auto-approves)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      // Fake model that throws inside withStructuredOutput().invoke().
      const invoke = vi.fn().mockRejectedValue(new Error('boom'));
      const llm = { withStructuredOutput: vi.fn().mockReturnValue({ invoke }) } as any;
      await runner.init('code', {
        ...mockConfig,
        llm,
        streamOutput: true,
        commands: {
          code: { devTools: { shell: { enabled: true, allowlist: false, judge: true } } },
        },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1); // escalated on fail-closed verdict
    });

    it('script-preflight: env-leak interpreter command escalates even on a low verdict', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'node deploy.js $AWS_SECRET_ACCESS_KEY' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      const { config } = judgeConfig(LOW);
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1); // escalated by preflight
    });

    it('blockHigh: a catastrophic verdict is rejected without prompting', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'rm -rf foo' } }])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;

      const catastrophic = { risk: 'high', destructive: true, outOfScope: true, reason: 'nuke' };
      const { config } = judgeConfig(catastrophic, { judge: { enabled: true, blockHigh: true } });
      await runner.init('code', config);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).not.toHaveBeenCalled();
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('reject');
    });

    it('judge DISABLED → behaves exactly as EXT-9 (no judge call, human prompts)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      const { model, withStructuredOutput } = judgeModel(LOW);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        // shell enabled, but judge OFF (default) and allow-list off.
        commands: { code: { devTools: { shell: { enabled: true, allowlist: false } } } },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(withStructuredOutput).not.toHaveBeenCalled(); // judge never ran
      expect(human).toHaveBeenCalledTimes(1);
    });

    it('allow-list hit wins: judge is NOT called for an already-approved command', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      // First `git checkout main` is approved at session scope; the variant must auto-approve via
      // the allow-list WITHOUT the judge running.
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout -b x' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      const { model, withStructuredOutput } = judgeModel(HIGH);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        // allow-list ON + judge ON.
        commands: {
          code: {
            devTools: { shell: { enabled: true, persistAllowlist: false, judge: true } },
          },
        },
      } as any);
      // Human grants session on the first; the variant should hit the allow-list (not the judge).
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      // The judge ran for the first (not allow-listed) command but NOT for the allow-listed variant.
      expect(withStructuredOutput).toHaveBeenCalledTimes(1);
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
