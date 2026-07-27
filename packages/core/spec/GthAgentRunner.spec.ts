import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { GthConfig } from '#src/config.js';
import type { StatusUpdateCallback } from '#src/core/types.js';
import { AttackHaltError, NonInteractiveEscalationError } from '#src/core/shell/approvalStop.js';

// Mock the GthLangChainAgent - using a simplified approach
const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  cleanup: vi.fn(),
};

// CFG-26 — the rater-profile seam. Mocked HERE (its own module) rather than the whole
// `#src/config.js` barrel, so the rest of the runner's config resolution stays real.
const resolveRaterModelMock = vi.fn();
vi.mock('#src/core/shell/raterModel.js', () => ({
  resolveRaterModel: resolveRaterModelMock,
}));

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

      // CFG-27: `write` is the rung that reproduces the pre-rater behaviour — the shell always
      // escalates and no model is consulted. Pinned explicitly so this EXT-52 seam test is not
      // silently re-testing the rater (the default rung, `auto-safe`, rates).
      await runner.init(undefined, {
        ...mockConfig,
        streamOutput: true,
        approvals: 'write',
      } as any);
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

    /**
     * CFG-27 §6.2 — where no human can answer, an escalation is an IMMEDIATE NON-ZERO EXIT
     * carrying the command, the rating and its reason. CFG-26 returned a `reject` decision here,
     * which the model observed and could work around; the spec is explicit that a build which
     * would have asked a question fails, loudly, with everything a person needs to see why.
     */
    it('EXITS non-zero when no approval callback is wired — it does not reject and continue', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('working'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'rm -rf /tmp/x' } }])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;

      await runner.init(undefined, {
        ...mockConfig,
        streamOutput: true,
        approvals: 'write',
      } as any);
      // No setToolApprovalCallback → the one-shot / CI / server case.

      const error = await runner
        .processMessages([new HumanMessage('run rm')])
        .then(() => null)
        .catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(NonInteractiveEscalationError);
      // It carries what a person needs, and points at the supported way to make a pipeline pass.
      expect(error?.message).toContain('rm -rf /tmp/x');
      expect(error?.message).toContain('approvals.allow');
      // The run ENDED: the graph was never resumed with a decision the model could respond to.
      expect(streamResume).not.toHaveBeenCalled();
    });

    // EXT-9 Tier-2 allow-list, at the `write` rung: it applies at every rung except `bypass`, and
    // `write` consults no model, so these tests exercise the allow-list alone.
    //
    // CFG-27 retired `persistAllowlist` (§3: persistence is a per-decision choice — `approve`
    // forgets, `always approve` persists). Nothing below grants `always`, so nothing here can
    // touch the on-disk store; the `session` scope these use is in-memory by construction.
    const ALLOWLIST_CONFIG = {
      streamOutput: true as const,
      approvals: 'write' as const,
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

  // CFG-27 — the session-scoped RUNG (config + `/approvals <rung>`). Under `bypass`, gated
  // run_shell_command calls are approved WITHOUT prompting, but the declared deny list still
  // applies (§2.5) and the exec-time floor is enforced in GthDevToolkit, not here.
  describe('session-scoped approvals rung (/approvals)', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    it('setSessionApprovalRung switches the rung explicitly and is idempotent', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', mockConfig);
      expect(runner.setSessionApprovalRung('bypass')).toBe('bypass');
      expect(runner.setSessionApprovalRung('bypass')).toBe('bypass'); // idempotent
      expect(runner.getSessionApprovals().rung).toBe('bypass');
      expect(runner.setSessionApprovalRung('read-only')).toBe('read-only');
      expect(runner.getSessionApprovals().rung).toBe('read-only');
    });

    it('§1.1 — with no `approvals` key the session starts at auto-safe, on every command', async () => {
      for (const command of ['code', 'exec', 'api'] as const) {
        const runner = new GthAgentRunner(statusUpdateCallback);
        await runner.init(command, mockConfig);
        expect(runner.getSessionApprovals().rung).toBe('auto-safe');
      }
    });

    it('getAllowlistCounts reports the session size and does NOT create the persisted store', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', mockConfig);
      // Nothing granted yet, and the persisted store has not been loaded: `always` is undefined
      // (rendered `—`), NOT a misleading 0 — a display command must never create the store.
      expect(runner.getAllowlistCounts()).toEqual({ session: 0, always: undefined });
    });

    it('init seeds the session rung from a per-command approvals value', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        commands: { code: { approvals: 'bypass' } },
      } as unknown as typeof mockConfig);
      // Config pre-selected bypass, but the rung remains switchable (/approvals write).
      expect(runner.getSessionApprovals().rung).toBe('bypass');
      expect(runner.setSessionApprovalRung('write')).toBe('write');
      expect(runner.getSessionApprovals().rung).toBe('write');
    });

    it('init seeds the whole posture (rung + rater profile + declared lists) from config', async () => {
      resolveRaterModelMock.mockResolvedValue({ withStructuredOutput: vi.fn() } as any);
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        approvals: {
          mode: 'full-auto',
          rater: 'safety-rater',
          allow: ['npm test'],
          deny: ['npm publish'],
        },
      } as unknown as typeof mockConfig);
      expect(runner.getSessionApprovals()).toEqual({
        rung: 'full-auto',
        rater: 'safety-rater',
        allow: ['npm test'],
        deny: ['npm publish'],
      });
      // §3 — the DECLARED lists are merged into the runtime stores at init.
      expect(runner.getDenylist()).toEqual(['npm publish']);
      expect(runner.getAllowlistCounts().session).toBe(1);
    });

    it('switching rungs never rewrites the declared lists — they are config input, not state', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        approvals: { mode: 'write', deny: ['npm publish'] },
      } as unknown as typeof mockConfig);
      runner.setSessionApprovalRung('bypass');
      expect(runner.getSessionApprovals().deny).toEqual(['npm publish']);
      expect(runner.getDenylist()).toEqual(['npm publish']);
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
      runner.setSessionApprovalRung('bypass');

      await runner.processMessages([new HumanMessage('clean')]);

      // The human prompt was never consulted; the resume carried an approve decision.
      expect(human).not.toHaveBeenCalled();
      expect(streamResume.mock.calls[0][0].decisions[0]).toEqual({
        type: 'approve',
        scope: 'once',
      });
    });

    it('still prompts the human at `write` (no rater, no bypass)', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'npm install' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', {
        ...mockConfig,
        streamOutput: true,
        approvals: 'write',
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('install')]);

      expect(human).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * CFG-26 Part A — `approvals.rater` must actually CHANGE WHO RATES. Before this it was
   * validated and then ignored: the config parsed, `gth config validate` passed, CFG-24's dialog
   * promised "set a stronger model as the rater later", and the runtime rated with the session
   * model anyway. That combination is unshippable, because pointing the rater at a competent model
   * is the entire documented mitigation for a weak one (QA-5 baseline: 61.7% tier accuracy on
   * gemma4:12b vs 25.5% on llama3.2:1b, which rated EVERY safe command `danger`).
   */
  describe('approvals.rater is consumed (not just validated)', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    /** A distinguishable fake model, so the test can tell WHICH one rated. */
    function fakeModel(outcome: string) {
      const invoke = vi.fn().mockResolvedValue({ outcome, reason: `${outcome} from this model` });
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      return { model: { withStructuredOutput } as any, withStructuredOutput, invoke };
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

    it('rates with the PROFILE model, and never touches the session model', async () => {
      const session = fakeModel('safe');
      const profile = fakeModel('destructive');
      resolveRaterModelMock.mockResolvedValue(profile.model);

      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('ls -la');
      await runner.init('code', {
        ...mockConfig,
        llm: session.model,
        streamOutput: true,
        approvals: { mode: 'auto-safe', rater: 'safety-rater' },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(resolveRaterModelMock).toHaveBeenCalledWith('safety-rater');
      // The profile's model rated...
      expect(profile.withStructuredOutput).toHaveBeenCalled();
      // ...and the SESSION model was never consulted for rating. This negative is the assertion
      // that separates "the profile is wired" from "the profile is ignored" — without it the test
      // would pass on the old, silently-ignoring behaviour.
      expect(session.withStructuredOutput).not.toHaveBeenCalled();
      // The profile's verdict (destructive) is what drove the decision: it escalated to the human,
      // rather than the session model's `safe` auto-approving.
      expect(human).toHaveBeenCalledTimes(1);
      expect(human.mock.calls[0][0].safetyVerdict.outcome).toBe('destructive');
    });

    it('rates with the SESSION model when no profile is configured', async () => {
      const session = fakeModel('safe');

      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('ls -la');
      await runner.init('code', {
        ...mockConfig,
        llm: session.model,
        streamOutput: true,
        approvals: 'auto-safe',
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      runner.setToolApprovalCallback(vi.fn());

      await runner.processMessages([new HumanMessage('go')]);

      expect(resolveRaterModelMock).not.toHaveBeenCalled();
      expect(session.withStructuredOutput).toHaveBeenCalled();
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
    });

    it('a named profile that cannot be resolved FAILS INIT — never a silent fallback', async () => {
      const session = fakeModel('safe');
      resolveRaterModelMock.mockRejectedValue(new Error('profile "typo" has no usable model'));

      const runner = new GthAgentRunner(statusUpdateCallback);
      await expect(
        runner.init('code', {
          ...mockConfig,
          llm: session.model,
          approvals: { mode: 'auto-safe', rater: 'typo' },
        } as any)
      ).rejects.toThrow('no usable model');
      // The session model must NOT have been quietly promoted into the rater's place.
      expect(session.withStructuredOutput).not.toHaveBeenCalled();
    });

    // The profile's model is loaded whenever one is NAMED, on any command — the default rung
    // (auto-safe) rates everywhere, and even at an unrated rung the user may switch mid-session
    // with `/approvals`, so a broken profile must fail at startup rather than at that moment.
    it.each(['code', 'exec'] as const)('resolves the named profile on %s', async (command) => {
      resolveRaterModelMock.mockResolvedValue(fakeModel('safe').model);
      const runner = new GthAgentRunner(statusUpdateCallback);
      const config = { ...mockConfig, approvals: { rater: 'safety-rater' } } as any;
      await runner.init(command, config);
      expect(resolveRaterModelMock).toHaveBeenCalledWith('safety-rater');
      expect(runner.getSessionApprovals().rater).toBe('safety-rater');
    });
  });

  // CFG-27 — the auto-rater. Uses a FAKE model (config.llm with a stubbed withStructuredOutput)
  // so the rater is deterministic; no live LLM call. `approvals` is always set EXPLICITLY here so
  // the tests state which rung they are exercising rather than leaning on the default.
  describe('auto-rater (run_shell_command approvals)', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    // Verdict objects the fake rater model returns via withStructuredOutput().invoke().
    const SAFE = { outcome: 'safe', reason: 'read-only' };
    const DESTRUCTIVE = { outcome: 'destructive', reason: 'risky' };
    const CATASTROPHIC = { outcome: 'catastrophic', reason: 'drops a database irrecoverably' };
    const ATTACK = { outcome: 'attack', reason: 'reads a private key as the operation itself' };

    // Build a fake config.llm whose withStructuredOutput(...).invoke() resolves to `verdict`.
    function raterModel(verdict: unknown) {
      const invoke = vi.fn().mockResolvedValue(verdict);
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      return { model: { withStructuredOutput } as any, withStructuredOutput, invoke };
    }

    /** A rated rung with the given verdict. `rung` defaults to the default rung, `auto-safe`. */
    function raterConfig(verdict: unknown, approvals: Record<string, unknown> = {}) {
      const { model, withStructuredOutput, invoke } = raterModel(verdict);
      return {
        config: {
          ...mockConfig,
          llm: model,
          streamOutput: true as const,
          approvals: { mode: 'auto-safe', ...approvals },
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

    it.each(['auto-safe', 'full-auto'] as const)(
      'approves a SAFE command at %s WITHOUT calling the human callback',
      async (rung) => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce('ls -la');

        const { config, withStructuredOutput } = raterConfig(SAFE, { mode: rung });
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
      }
    );

    it.each(['auto-safe', 'full-auto'] as const)(
      'escalates a DESTRUCTIVE command at %s to the human (with the verdict attached)',
      async (rung) => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('rm -rf build');

        const { config } = raterConfig(DESTRUCTIVE, { mode: rung });
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(human).toHaveBeenCalledTimes(1);
        expect(human.mock.calls[0][0].safetyVerdict).toMatchObject({
          outcome: 'destructive',
          reason: 'risky',
        });
      }
    );

    /**
     * §4.2 — `attack` HALTS the run at both rated rungs. It is not a rejection the model can
     * respond to, so the graph is never resumed with a decision: the agent loop simply ends.
     */
    it.each(['auto-safe', 'full-auto'] as const)(
      'HALTS the run on an ATTACK verdict at %s — no prompt, no decision to the model',
      async (rung) => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce('cat ~/.aws/credentials');

        const { config } = raterConfig(ATTACK, { mode: rung });
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
        runner.setToolApprovalCallback(human);

        const error = await runner
          .processMessages([new HumanMessage('go')])
          .then(() => null)
          .catch((e: unknown) => e as Error);

        expect(error).toBeInstanceOf(AttackHaltError);
        expect(error?.message).toContain('reads a private key as the operation itself');
        // Not a prompt, and not something the model gets to answer.
        expect(human).not.toHaveBeenCalled();
        expect(streamResume).not.toHaveBeenCalled();
      }
    );

    /**
     * §4.1.1 acceptance — the mapping must not manufacture a halt on ordinary egress. The LIVE
     * rater's behaviour on these is QA-5's measurement; what is pinned here is that a `git push`
     * shaped command rated `safe` runs, and rated `destructive` asks, with no path to a halt.
     */
    it('a `git push origin main`-shaped command does NOT halt the run', async () => {
      for (const [verdict, expectPrompt] of [
        [SAFE, false],
        [DESTRUCTIVE, true],
      ] as const) {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('git push origin main');
        const { config } = raterConfig(verdict);
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
        runner.setToolApprovalCallback(human);

        await expect(runner.processMessages([new HumanMessage('push')])).resolves.toBeTypeOf(
          'string'
        );
        expect(human).toHaveBeenCalledTimes(expectPrompt ? 1 : 0);
      }
    });

    /**
     * §4.2 — `catastrophic` escalates at BOTH rated rungs. It is not a halt (halting on
     * `terraform destroy` would spend the one stop control we have on routine work) and it is not
     * an approval; the human is asked, and the verdict travels with the prompt so they are asked
     * about the right thing.
     */
    it.each(['auto-safe', 'full-auto'] as const)(
      'escalates a CATASTROPHIC command at %s to the human, carrying the verdict',
      async (rung) => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('terraform destroy -auto-approve');

        const { config } = raterConfig(CATASTROPHIC, { mode: rung });
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(human).toHaveBeenCalledTimes(1);
        expect(human.mock.calls[0][0].safetyVerdict).toMatchObject({
          outcome: 'catastrophic',
          reason: 'drops a database irrecoverably',
        });
      }
    );

    /**
     * §4.2 — **a `catastrophic` approval is never sticky.** "The human may approve this one
     * invocation, and only this one": neither `always` nor a session-scoped allow. This is enforced
     * here rather than only in the menu ([[TUI-C26]] withdraws the affordance) because §3 consults
     * the allow-list BEFORE the rater — so one sticky grant would take the command out of rating
     * permanently, and the next `terraform destroy` would never be rated at all.
     *
     * The scope granted below is `session`, which is the in-memory store: the test proves the clamp
     * without touching the on-disk allow-list at all.
     */
    it('NEVER records a sticky grant for a CATASTROPHIC command, even when the human says session', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'terraform destroy -auto-approve' } },
        ])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'terraform destroy -target=x' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      const { config } = raterConfig(CATASTROPHIC);
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      // BOTH commands prompted: the first approval remembered nothing.
      expect(human).toHaveBeenCalledTimes(2);
    });

    /**
     * The control that proves the test above bites: the identical flow on a `destructive` verdict
     * DOES stick, so the second command never reaches the human. Without this, a clamp that
     * accidentally disabled the allow-list for every outcome would pass unnoticed.
     */
    it('...but a DESTRUCTIVE session grant still sticks — the clamp is scoped to catastrophic', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'terraform destroy -auto-approve' } },
        ])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'terraform destroy -target=x' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      const { config } = raterConfig(DESTRUCTIVE);
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(human).toHaveBeenCalledTimes(1);
    });

    /**
     * §6.2 — where nobody can answer, an escalation is an immediate non-zero exit carrying the
     * command, the rating and its reason. `catastrophic` takes that same path: it escalates, and an
     * escalation with no human is an exit, not a wait and not an approval.
     */
    it('§6.2: a CATASTROPHIC command with no human exits non-zero, naming the outcome', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('terraform destroy -auto-approve');

      const { config } = raterConfig(CATASTROPHIC);
      await runner.init('code', config);
      // No approval callback at all — CI, a one-shot run, a server.

      const error = (await runner
        .processMessages([new HumanMessage('go')])
        .then(() => null)
        .catch((e: unknown) => e as Error)) as NonInteractiveEscalationError | null;

      expect(error).toBeInstanceOf(NonInteractiveEscalationError);
      expect(error?.outcome).toBe('catastrophic');
      expect(error?.message).toContain('drops a database irrecoverably');
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
      expect(human.mock.calls[0][0].safetyVerdict.outcome).toBe('destructive');
      expect(human.mock.calls[0][0].safetyVerdict.reason).toContain('Could not assess');
    });

    /**
     * The safety property CFG-26 established, carried through the rescale intact: the preflight is
     * recomputed from the RAW command and rewrites the verdict AHEAD of the `safe` check, so a
     * MANIPULATED `safe` verdict on `ls -la; rm -rf ~` still cannot approve.
     */
    it('a manipulated SAFE verdict on `ls -la; rm -rf ~` still does not approve', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('ls -la; rm -rf ~');

      const { config } = raterConfig(SAFE);
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'reject' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1);
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('reject');
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
        approvals: 'auto-safe',
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1); // escalated on the fail-closed verdict
      // ...and it did not manufacture a run-halting outcome either.
      expect(human.mock.calls[0][0].safetyVerdict.outcome).toBe('destructive');
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

    it.each(['read-only', 'write'] as const)(
      'the unrated rung %s costs NO model call — the human prompts, exactly as EXT-9 did',
      async (rung) => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('ls -la');

        const { model, withStructuredOutput } = raterModel(SAFE);
        await runner.init('code', {
          ...mockConfig,
          llm: model,
          streamOutput: true,
          approvals: rung,
          commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
        } as any);
        const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);
        expect(withStructuredOutput).not.toHaveBeenCalled(); // the rater never ran
        expect(human).toHaveBeenCalledTimes(1);
      }
    );

    it('§6.2 — with NO approval handler, an escalating verdict EXITS with the rating and reason', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('rm -rf build');

      const { config } = raterConfig(DESTRUCTIVE);
      await runner.init('code', config);
      // No setToolApprovalCallback — the one-shot / server case.

      const error = await runner
        .processMessages([new HumanMessage('go')])
        .then(() => null)
        .catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(NonInteractiveEscalationError);
      expect(error?.message).toContain('rm -rf build');
      expect(error?.message).toContain('destructive');
      expect(error?.message).toContain('risky');
      expect(streamResume).not.toHaveBeenCalled();
    });

    it('§3 — the allow-list is consulted BEFORE the rater: a declared entry costs no rater call', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('npm test --watch=false');

      const { model, withStructuredOutput } = raterModel(DESTRUCTIVE);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        approvals: { mode: 'auto-safe', allow: ['npm test'] },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      // Approved from the DECLARED allow-list, with no prompt and — the point of this test — no
      // rating call, even though the rater would have said `destructive`.
      expect(withStructuredOutput).not.toHaveBeenCalled();
      expect(human).not.toHaveBeenCalled();
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
    });

    it('allow-list hit wins: the rater is NOT called for a command a human already trusted', async () => {
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

      const { model, withStructuredOutput } = raterModel(DESTRUCTIVE);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        approvals: 'auto-safe',
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

      const { config, withStructuredOutput } = raterConfig(DESTRUCTIVE, { mode: 'bypass' });
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

  /**
   * EXT-58 §4.4 — the rater is told which built-ins are already granted at the current rung, so a
   * non-`safe` outcome can point the model at a free call instead of an interruption. The list is
   * built from what the AGENT actually registered, intersected with core's own summaries table, so
   * it can name neither a tool this session lacks nor a tool whose description we did not author.
   */
  describe('granted-alternative suggestion reaches the rater and the human', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    function raterConfig(verdict: unknown) {
      const invoke = vi.fn().mockResolvedValue(verdict);
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      return {
        config: {
          ...mockConfig,
          llm: { withStructuredOutput } as any,
          streamOutput: true as const,
          approvals: { mode: 'auto-safe' },
          commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
        },
        invoke,
      };
    }

    function pendingOnce(command: string, registeredToolNames: string[]) {
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).getRegisteredToolNames = vi.fn().mockReturnValue(registeredToolNames);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
    }

    /** The rater's system prompt for the single rating call this suite makes. */
    function raterSystemPrompt(invoke: Mock): string {
      return String(invoke.mock.calls[0][0][0].content);
    }

    it('lists the granted built-ins — and never the gated shell', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('sed -i s/a/b/ src/a.ts', ['read_file', 'edit_file', 'run_shell_command']);
      const { config, invoke } = raterConfig({ outcome: 'destructive', reason: 'rewrites a file' });
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn().mockResolvedValue({ type: 'reject' }));

      await runner.processMessages([new HumanMessage('go')]);

      const system = raterSystemPrompt(invoke);
      expect(system).toContain('ALREADY-GRANTED TOOLS');
      expect(system).toContain('- read_file:');
      expect(system).toContain('- edit_file:');
      // The shell is the gated tool; offering it as its own alternative would be nonsense.
      expect(system).not.toContain('- run_shell_command:');
    });

    it('never lists an MCP or custom tool, whose descriptions are not ours to trust', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('rm -rf build', ['read_file', 'mcp__srv__query', 'my_custom_tool']);
      const { config, invoke } = raterConfig({ outcome: 'destructive', reason: 'deletes a tree' });
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn().mockResolvedValue({ type: 'reject' }));

      await runner.processMessages([new HumanMessage('go')]);

      const system = raterSystemPrompt(invoke);
      expect(system).toContain('- read_file:');
      expect(system).not.toContain('mcp__srv__query');
      expect(system).not.toContain('my_custom_tool');
    });

    it('carries a valid suggestion through to the human prompt', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('sed -i s/a/b/ src/a.ts', ['read_file', 'edit_file']);
      const { config } = raterConfig({
        outcome: 'destructive',
        reason: 'rewrites a file in place; edit_file does this without a shell',
        suggestedTool: 'edit_file',
      });
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'reject' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(human.mock.calls[0][0].safetyVerdict.suggestedTool).toBe('edit_file');
    });

    it('drops a suggestion naming a tool this session never registered', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('sed -i s/a/b/ src/a.ts', ['read_file']);
      const { config } = raterConfig({
        outcome: 'destructive',
        reason: 'rewrites a file in place',
        suggestedTool: 'edit_file',
      });
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'reject' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(human.mock.calls[0][0].safetyVerdict.suggestedTool).toBeUndefined();
      // …and the outcome is untouched: dropping a name never changes what the gate does.
      expect(human.mock.calls[0][0].safetyVerdict.outcome).toBe('destructive');
    });

    it('adds no granted list when the agent exposes no tools', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('rm -rf build', []);
      const { config, invoke } = raterConfig({ outcome: 'destructive', reason: 'deletes a tree' });
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn().mockResolvedValue({ type: 'reject' }));

      await runner.processMessages([new HumanMessage('go')]);

      expect(raterSystemPrompt(invoke)).not.toContain('ALREADY-GRANTED TOOLS');
    });
  });

  /**
   * CFG-27 §3 / §2.5 — the DENY LIST. It is consulted before the allow-list and before the rater,
   * and it is the ONE check `bypass` keeps: choosing `bypass` says "stop asking me", not "forget
   * what I told you never to do".
   */
  describe('deny list', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
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

    function denyConfig(
      rung: string,
      deny: string[],
      verdict: unknown = { outcome: 'safe', reason: 'ok' }
    ) {
      const invoke = vi.fn().mockResolvedValue(verdict);
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      return {
        withStructuredOutput,
        config: {
          ...mockConfig,
          llm: { withStructuredOutput } as any,
          streamOutput: true as const,
          approvals: { mode: rung, deny },
          commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
        },
      };
    }

    it.each(['read-only', 'write', 'auto-safe', 'full-auto', 'bypass'] as const)(
      'refuses a denied command at %s — with no prompt and no rating call',
      async (rung) => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce('npm publish --access public');
        const { config, withStructuredOutput } = denyConfig(rung, ['npm publish']);
        await runner.init('code', config);
        const human = vi.fn();
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('ship it')]);

        expect(human).not.toHaveBeenCalled();
        expect(withStructuredOutput).not.toHaveBeenCalled();
        const decision = streamResume.mock.calls[0][0].decisions[0];
        expect(decision.type).toBe('reject');
        // The refusal quotes the user's own entry back, so it is traceable to the line they wrote.
        expect(decision.message).toContain('npm publish');
        expect(decision.message).toContain('approvals.deny');
      }
    );

    it('§2.5 — bypass keeps the deny list; everything else there is approved', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('rm -rf node_modules');
      const { config } = denyConfig('bypass', ['npm publish']);
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn());

      await runner.processMessages([new HumanMessage('clean')]);
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
    });

    it('fires on a COMPOSED command, which is exactly what a shared allow-list matcher could not do', async () => {
      for (const command of ['git push --force; ls', 'ls && git push --force origin main']) {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce(command);
        const { config } = denyConfig('bypass', ['git push --force']);
        await runner.init('code', config);
        runner.setToolApprovalCallback(vi.fn());

        await runner.processMessages([new HumanMessage('go')]);
        expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('reject');
      }
    });

    it('does not refuse a command that merely shares a prefix token', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('git push origin main');
      const { config } = denyConfig('bypass', ['git push --force']);
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn());

      await runner.processMessages([new HumanMessage('go')]);
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
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

      // `write` — the unrated rung, so this EXT-11 seam test exercises the interrupt round-trip
      // rather than the rater (the default rung, `auto-safe`, rates).
      await runner.init(undefined, {
        ...mockConfig,
        streamOutput: true,
        approvals: 'write',
      } as any);
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

    // §6.2 on the event path too: no handler → the run ENDS, it does not hand the model a
    // rejection it can work around. The generator throws, so the renderer sees the ending.
    it('EXITS non-zero when no approval callback is wired, on the event path as well', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.streamWithEvents.mockImplementation(() =>
        eventStream({ type: 'text', delta: 'x' })
      );
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'rm -rf /tmp/x' } }])
        .mockResolvedValueOnce([]);
      const streamWithEventsResume = vi.fn().mockImplementation(() => eventStream());
      (mockAgent as any).streamWithEventsResume = streamWithEventsResume;

      await runner.init(undefined, {
        ...mockConfig,
        streamOutput: true,
        approvals: 'write',
      } as any);
      // No setToolApprovalCallback → the one-shot / server case.

      const error = await drain(runner.processMessagesWithEvents([new HumanMessage('run rm')]))
        .then(() => null)
        .catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(NonInteractiveEscalationError);
      expect(error?.message).toContain('rm -rf /tmp/x');
      expect(streamWithEventsResume).not.toHaveBeenCalled();
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
      // The rung is pinned so no model is consulted for these two calls.
      await runner.init(undefined, {
        ...mockConfig,
        streamOutput: true,
        approvals: 'write',
      } as any);
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
