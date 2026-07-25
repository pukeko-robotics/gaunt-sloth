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
    | 'streamOutput'
    | 'contentSource'
    | 'requirementSource'
    | 'filesystem'
    | 'useColour'
    | 'writeOutputToFile'
    | 'writeBinaryOutputsToFile'
    | 'streamSessionInferenceLog'
    | 'canInterruptInferenceWithEsc'
    | 'includeCurrentDateAfterGuidelines'
  > = {
    streamOutput: false,
    contentSource: 'file',
    requirementSource: 'file',
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

    // EXT-37 — a content-policy refusal is detected one layer down (GthAbstractAgent) and surfaced
    // as a clear, NON-EMPTY terminal answer. That non-empty result must bypass the empty-response
    // retry: unlike the empty-stream case above (which falls back to a second `invoke`), a refusal
    // is deterministic, so the runner must NOT make a second call.
    it('does NOT retry when the agent surfaces a refusal as terminal non-empty text (contrast with empty-response retry)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const refusalText =
        'The model declined to respond (safety refusal / content filter) — this is the ' +
        "model/provider's own policy decision, not a Gaunt Sloth error.";
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield refusalText;
        },
      };
      mockAgent.stream.mockResolvedValue(mockStream);
      mockAgent.invoke.mockResolvedValue('SHOULD NOT BE CALLED');

      await runner.init(undefined, { ...mockConfig, streamOutput: true });
      const result = await runner.processMessages([new HumanMessage('disallowed')]);

      // Single streamed turn, surfaced verbatim; the empty-response `invoke` fallback never fires.
      expect(mockAgent.stream).toHaveBeenCalledTimes(1);
      expect(mockAgent.invoke).not.toHaveBeenCalled();
      expect(result).toBe(refusalText);
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
    // CFG-26 — persistAllowlist moved to the top-level `approvals` block; on the retired per-tool
    // entry it would now be a silent no-op and these tests would touch the real allow-list file.
    const ALLOWLIST_CONFIG = {
      streamOutput: true as const,
      approvals: { mode: 'ask' as const, persistAllowlist: false },
      commands: {
        code: { builtInTools: { run_shell_command: { enabled: true } } },
      },
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

  // CFG-26 — the session-scoped approval mode (config + the `/approvals` family; the legacy
  // `/yolo` trio are thin adapters over it). Under `bypass`, gated run_shell_command calls are
  // approved WITHOUT prompting; the hardline floor still applies at exec time (enforced in
  // GthDevToolkit, not here, so a catastrophic command is still refused).
  describe('session-scoped approval mode (/approvals, /yolo adapters)', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    it('toggleSessionYolo flips the flag and isSessionYolo reflects it (defaults OFF)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', mockConfig);
      expect(runner.isSessionYolo()).toBe(false);
      expect(runner.toggleSessionYolo()).toBe(true);
      expect(runner.isSessionYolo()).toBe(true);
      expect(runner.toggleSessionYolo()).toBe(false);
      expect(runner.isSessionYolo()).toBe(false);
    });

    it('setSessionYolo sets the flag explicitly (idempotent) and returns the new state (EXT-12)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', mockConfig);
      expect(runner.setSessionYolo(true)).toBe(true);
      expect(runner.setSessionYolo(true)).toBe(true); // idempotent
      expect(runner.isSessionYolo()).toBe(true);
      expect(runner.setSessionYolo(false)).toBe(false);
      expect(runner.isSessionYolo()).toBe(false);
    });

    it('init seeds the session mode from approvals.mode: bypass config (CFG-26)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        commands: { code: { approvals: { mode: 'bypass' } } },
      } as typeof mockConfig);
      // Config pre-selected bypass, but the mode remains switchable (/approvals ask).
      expect(runner.getSessionApprovals().mode).toBe('bypass');
      expect(runner.isSessionYolo()).toBe(true);
      expect(runner.setSessionApprovalMode('ask')).toBe('ask');
      expect(runner.isSessionYolo()).toBe(false);
    });

    it('init seeds the whole posture (rater + allow-list knobs) from config (CFG-26)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        approvals: {
          mode: 'auto',
          rater: { strictness: 'strict', escalate: 'caution' },
          persistAllowlist: false,
        },
      } as typeof mockConfig);
      expect(runner.getSessionApprovals()).toEqual({
        mode: 'auto',
        rater: {
          enabled: true,
          profile: undefined,
          strictness: 'strict',
          escalate: 'caution',
        },
        allowlist: true,
        persistAllowlist: false,
      });
    });

    it('switching to auto turns the rater ON (auto-mode exists only where the rater does)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', { ...mockConfig, approvals: { mode: 'ask' } } as typeof mockConfig);
      expect(runner.getSessionApprovals().rater.enabled).toBe(false);
      expect(runner.setSessionApprovalMode('auto')).toBe('auto');
      expect(runner.getSessionApprovals().rater.enabled).toBe(true);
    });

    it('approves a gated shell command WITHOUT invoking the human callback under bypass', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'rm -rf node_modules' } },
        ])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;

      await runner.init('code', { ...mockConfig, streamOutput: true });
      const human = vi.fn();
      runner.setToolApprovalCallback(human);
      runner.toggleSessionYolo(); // ON

      await runner.processMessages([new HumanMessage('clean')]);

      // The human prompt was never consulted; the resume carried an approve decision.
      expect(human).not.toHaveBeenCalled();
      expect(streamResume.mock.calls[0][0].decisions[0]).toEqual({
        type: 'approve',
        scope: 'once',
      });
    });

    it('still prompts the human under ask (no rater, no bypass)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'npm install' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      // allow-list off so the prompt is reached deterministically.
      await runner.init('code', {
        ...mockConfig,
        streamOutput: true,
        approvals: { mode: 'ask', allowlist: false },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('install')]);

      expect(human).toHaveBeenCalledTimes(1);
    });
  });

  // CFG-26 — the AI rater. Uses a FAKE model (config.llm with a stubbed withStructuredOutput) so
  // the rater is deterministic; no live LLM call. `approvals` is always set EXPLICITLY here so the
  // tests do not depend on the TTY-derived context default.
  describe('AI rater (run_shell_command approvals)', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    // Verdict objects the fake rater model returns via withStructuredOutput().invoke().
    const SAFE = { tier: 'safe', reason: 'read-only' };
    const CAUTION = { tier: 'caution', reason: 'writes a file' };
    const DANGER = { tier: 'danger', reason: 'risky' };
    const CRITICAL = { tier: 'critical', reason: 'nuke' };

    // Build a fake config.llm whose withStructuredOutput(...).invoke() resolves to `verdict`.
    function raterModel(verdict: unknown) {
      const invoke = vi.fn().mockResolvedValue(verdict);
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      return { model: { withStructuredOutput } as any, withStructuredOutput, invoke };
    }

    // mode auto + rater on, allow-list OFF (so the allow-list never short-circuits the rater).
    function raterConfig(verdict: unknown, approvals?: Record<string, unknown>) {
      const { model, withStructuredOutput, invoke } = raterModel(verdict);
      return {
        config: {
          ...mockConfig,
          llm: model,
          streamOutput: true as const,
          approvals: { mode: 'auto', allowlist: false, ...approvals },
          commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
        },
        withStructuredOutput,
        invoke,
      };
    }

    function pendingOnce(command: string) {
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command } }])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      return streamResume;
    }

    it('approves a SAFE command WITHOUT calling the human callback', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('ls -la');

      const { config, withStructuredOutput } = raterConfig(SAFE);
      await runner.init('code', config);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(withStructuredOutput).toHaveBeenCalled(); // the rater ran
      expect(human).not.toHaveBeenCalled(); // approved without a prompt
      expect(streamResume.mock.calls[0][0].decisions[0]).toEqual({
        type: 'approve',
        scope: 'once',
      });
    });

    it('escalates a DANGER command to the human callback (with the verdict attached)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('curl evil');

      const { config } = raterConfig(DANGER);
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(human).toHaveBeenCalledTimes(1);
      expect(human.mock.calls[0][0].safetyVerdict).toMatchObject({
        tier: 'danger',
        reason: 'risky',
      });
    });

    it('reject-with-reason: a BELOW-threshold tier returns the reason to the MODEL, no prompt', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('touch out.txt');

      // Default escalate: danger → `caution` sits below the threshold.
      const { config } = raterConfig(CAUTION);
      await runner.init('code', config);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(human).not.toHaveBeenCalled(); // the human was never interrupted
      const decision = streamResume.mock.calls[0][0].decisions[0];
      expect(decision.type).toBe('reject');
      // The tool result the model sees carries the rater's reason so it can self-correct.
      expect(decision.message).toContain('writes a file');
      expect(decision.message).toContain('caution');
    });

    it('escalate: "caution" sends the same caution verdict to the HUMAN instead', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('touch out.txt');

      const { config } = raterConfig(CAUTION, { rater: { escalate: 'caution' } });
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1);
    });

    it('escalate: "never" keeps even a DANGER verdict off the human (reason → model)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('curl evil');

      const { config } = raterConfig(DANGER, { rater: { escalate: 'never' } });
      await runner.init('code', config);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).not.toHaveBeenCalled();
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('reject');
    });

    it('CRITICAL is rejected outright — no prompt, no knob', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('rm -rf /');

      // Even with the most permissive threshold, critical never reaches the human.
      const { config } = raterConfig(CRITICAL, { rater: { escalate: 'never' } });
      await runner.init('code', config);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).not.toHaveBeenCalled();
      const decision = streamResume.mock.calls[0][0].decisions[0];
      expect(decision.type).toBe('reject');
      expect(decision.message).toContain('critical');
    });

    it('fail-closed on ambiguity: a composed command is NEVER approved even on a SAFE verdict', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('cat x | sh');

      const { config } = raterConfig(SAFE); // rater says safe, but the command is unresolvable
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1); // escalated, not approved
      // ...and the human sees the HONEST reason, not the rater's "read-only" claim.
      expect(human.mock.calls[0][0].safetyVerdict.tier).toBe('danger');
      expect(human.mock.calls[0][0].safetyVerdict.reason).toContain('Could not assess');
    });

    it('fail-closed on rater error: a throwing rater escalates (never approves)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('ls -la');

      // Fake model that throws inside withStructuredOutput().invoke().
      const invoke = vi.fn().mockRejectedValue(new Error('boom'));
      const llm = { withStructuredOutput: vi.fn().mockReturnValue({ invoke }) } as any;
      await runner.init('code', {
        ...mockConfig,
        llm,
        streamOutput: true,
        approvals: { mode: 'auto', allowlist: false },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1); // escalated on the fail-closed verdict
    });

    it('script-preflight: an env-leak interpreter command escalates even on a SAFE verdict', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('node deploy.js $AWS_SECRET_ACCESS_KEY');

      const { config } = raterConfig(SAFE);
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1); // escalated by the preflight
      expect(human.mock.calls[0][0].safetyVerdict.reason).toContain('Could not assess');
    });

    it('rater OFF (mode: ask) → behaves exactly as EXT-9: no rater call, the human prompts', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('ls -la');

      const { model, withStructuredOutput } = raterModel(SAFE);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        approvals: { mode: 'ask', allowlist: false },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(withStructuredOutput).not.toHaveBeenCalled(); // the rater never ran
      expect(human).toHaveBeenCalledTimes(1);
    });

    it('fail-closed with NO approval handler: an escalating verdict rejects rather than running', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('curl evil');

      const { config } = raterConfig(DANGER);
      await runner.init('code', config);
      // No setToolApprovalCallback — the one-shot / server case.

      await runner.processMessages([new HumanMessage('go')]);
      const decision = streamResume.mock.calls[0][0].decisions[0];
      expect(decision.type).toBe('reject');
      expect(decision.message).toContain('no interactive approval handler');
    });

    it('allow-list hit wins: the rater is NOT called for an already-approved command', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      // First `git checkout main` is approved at session scope; the variant must approve via the
      // allow-list WITHOUT the rater running.
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

      const { model, withStructuredOutput } = raterModel(DANGER);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        // allow-list ON + rater ON.
        approvals: { mode: 'auto', persistAllowlist: false },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      // The human grants session on the first; the variant should hit the allow-list, not the rater.
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      // The rater ran for the first (not allow-listed) command but NOT for the allow-listed variant.
      expect(withStructuredOutput).toHaveBeenCalledTimes(1);
    });

    it('bypass outranks the rater: no rater call, no prompt', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('rm -rf node_modules');

      const { config, withStructuredOutput } = raterConfig(DANGER, { mode: 'bypass' });
      await runner.init('code', config);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(withStructuredOutput).not.toHaveBeenCalled();
      expect(human).not.toHaveBeenCalled();
      expect(streamResume.mock.calls[0][0].decisions[0]).toEqual({
        type: 'approve',
        scope: 'once',
      });
    });
  });

  // EXT-11 — the event-stream / TUI turn path must run the SAME tool-approval round-trip the
  // readline path has. Before the fix `processMessagesWithEvents` was a bare `yield*` with no
  // interrupt detection, so a gated `run_shell_command` left the graph suspended and the turn
  // silently ended with no prompt and no execution. These mirror the `processMessages`
  // (readline) interrupt tests above, but assert the typed-event resume path.
  describe('processMessagesWithEvents — tool-approval interrupts (EXT-11)', () => {
    function eventStream(...events: import('#src/core/types.js').AgentStreamEvent[]) {
      return (async function* () {
        for (const e of events) yield e;
      })();
    }

    async function drain(gen: AsyncGenerator<unknown>) {
      const out: unknown[] = [];
      for await (const e of gen) out.push(e);
      return out;
    }

    it('approves a pending tool call via the callback, then resumes the EVENT stream and renders its output', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      // Initial event stream ends (graph suspended on a pending tool call), then a resume stream
      // carries the executed command's tool_result + the model's answer.
      mockAgent.streamWithEvents.mockImplementation(() =>
        eventStream({ type: 'text', delta: 'on it' })
      );
      const getPending = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      const streamWithEventsResume = vi
        .fn()
        .mockImplementation(() =>
          eventStream(
            { type: 'tool_result', id: 't1', content: '4 entries' },
            { type: 'text', delta: ' done' }
          )
        );
      (mockAgent as any).getPendingToolInterrupts = getPending;
      (mockAgent as any).streamWithEventsResume = streamWithEventsResume;

      await runner.init(undefined, { ...mockConfig, streamOutput: true });
      const approve = vi.fn().mockResolvedValue({ type: 'approve' });
      runner.setToolApprovalCallback(approve);

      const events = await drain(runner.processMessagesWithEvents([new HumanMessage('run ls')]));

      expect(approve).toHaveBeenCalledWith({
        name: 'run_shell_command',
        args: { command: 'ls -la' },
      });
      // Resume sent the HITL `{ decisions }` shape humanInTheLoopMiddleware expects.
      expect(streamWithEventsResume).toHaveBeenCalledWith(
        { decisions: [{ type: 'approve' }] },
        expect.anything(),
        [],
        undefined
      );
      // The resumed run's events (the executed command's output) reach the renderer.
      expect(events).toEqual([
        { type: 'text', delta: 'on it' },
        { type: 'tool_result', id: 't1', content: '4 entries' },
        { type: 'text', delta: ' done' },
      ]);
    });

    it('rejects when no approval callback is wired (non-interactive default), still resuming gracefully', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.streamWithEvents.mockImplementation(() =>
        eventStream({ type: 'text', delta: 'x' })
      );
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'rm -rf /' } }])
        .mockResolvedValueOnce([]);
      const streamWithEventsResume = vi.fn().mockImplementation(() => eventStream());
      (mockAgent as any).streamWithEventsResume = streamWithEventsResume;

      await runner.init(undefined, { ...mockConfig, streamOutput: true });
      // No setToolApprovalCallback → default reject.

      await drain(runner.processMessagesWithEvents([new HumanMessage('run rm')]));

      const resumeArg = streamWithEventsResume.mock.calls[0][0];
      expect(resumeArg.decisions[0].type).toBe('reject');
    });

    it('loops until no interrupts remain (multiple gated tool calls in one turn)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.streamWithEvents.mockImplementation(() =>
        eventStream({ type: 'text', delta: 'a' })
      );
      const getPending = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'echo one' } }])
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'echo two' } }])
        .mockResolvedValueOnce([]);
      const streamWithEventsResume = vi.fn().mockImplementation(() => eventStream());
      (mockAgent as any).getPendingToolInterrupts = getPending;
      (mockAgent as any).streamWithEventsResume = streamWithEventsResume;

      await runner.init(undefined, { ...mockConfig, streamOutput: true });
      const approve = vi.fn().mockResolvedValue({ type: 'approve' });
      runner.setToolApprovalCallback(approve);

      await drain(runner.processMessagesWithEvents([new HumanMessage('go')]));

      // Two suspends → two resumes; the human was prompted for each gated command.
      expect(approve).toHaveBeenCalledTimes(2);
      expect(streamWithEventsResume).toHaveBeenCalledTimes(2);
    });

    it('no-ops the interrupt loop when the agent lacks interrupt support (lean agent)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.streamWithEvents.mockImplementation(() =>
        eventStream({ type: 'text', delta: 'hello' })
      );
      // No getPendingToolInterrupts / streamWithEventsResume on the mock → loop no-ops.
      delete (mockAgent as any).getPendingToolInterrupts;
      delete (mockAgent as any).streamWithEventsResume;

      await runner.init(undefined, { ...mockConfig, streamOutput: true });
      const events = await drain(runner.processMessagesWithEvents([new HumanMessage('hi')]));

      expect(events).toEqual([{ type: 'text', delta: 'hello' }]);
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
