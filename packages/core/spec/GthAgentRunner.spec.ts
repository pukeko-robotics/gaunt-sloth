import { afterAll, afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { GthConfig } from '#src/config.js';
import type { PendingToolInterrupt, StatusUpdateCallback } from '#src/core/types.js';
import { AttackHaltError, NonInteractiveEscalationError } from '#src/core/shell/approvalStop.js';
import {
  applyDestructiveFloor,
  COULD_NOT_ASSESS_PREFIX,
  openWorldToolFloorReason,
} from '#src/core/shell/rater.js';
import { createEffectiveToolAnnotationSource } from '#src/core/approvals/annotations.js';
import {
  builtInToolAnnotations,
  mcpDeclaredAnnotationLookup,
} from '#src/core/approvals/toolAnnotationSources.js';
import { resolveApprovals } from '#src/config.js';
import { MECHANISM_NOTES, PARSER_NOTE_PREAMBLE } from '#src/core/shell/abstention.js';
import { checkHardline } from '#src/core/shell/hardline.js';
import { describeApprovalEntry, MCP_FAIL_CLOSED_ANNOTATIONS } from '#src/core/approvals/matcher.js';
import {
  approvalSubjectForToolName,
  mcpToolRegisteredName,
} from '#src/core/approvals/mcpSubjects.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';

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

/**
 * EXT-71 — **the persisted grant store is anchored at the PROJECT DIR, so a spec that drives a
 * gated call must clamp that anchor or it reads (and, on a v1 file, rewrites) the real
 * `.gsloth/.gsloth-settings/shell-allowlist.json` of whoever is running the suite.**
 *
 * Clamped through the production hook (`setProjectDir` — the same call config discovery makes)
 * rather than by mocking `fileUtils`, so the resolution under test is the real one and only its
 * input is pinned. Measured, not assumed: with a v1 file in place this suite rewrote it to v2 and
 * three unrelated tests went red on the ambient grants (the OPS-33 class).
 */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-runner-spec-'));

describe('GthAgentRunner', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdateCallback: Mock<StatusUpdateCallback>;
  let mockConfig: GthConfig;
  let priorProjectDir: string | undefined;

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

    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    rmSync(join(projectDir, SHELL_ALLOWLIST_FILE), { force: true });

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

  afterEach(() => {
    setProjectDir(priorProjectDir);
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('should initialize with basic configuration', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);

      await runner.init(undefined, mockConfig);

      expect(mockAgent.init).toHaveBeenCalledWith(undefined, mockConfig, undefined, {
        displayCommand: undefined,
      });
    });

    it('should initialize with checkpoint saver', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const checkpointSaver = new MemorySaver();

      await runner.init(undefined, mockConfig, checkpointSaver);

      expect(mockAgent.init).toHaveBeenCalledWith(undefined, mockConfig, checkpointSaver, {
        displayCommand: undefined,
      });
    });

    // GS2-95 — the run header's name for the run is forwarded to the agent, and it does NOT
    // become the command: the verb the runner was initialized with is what selects the mode
    // prompt, and it must arrive unchanged beside a display name that differs from it.
    it('forwards the display command to the agent without touching the init verb', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);

      await runner.init('ask', mockConfig, undefined, { displayCommand: 'eval' });

      expect(mockAgent.init).toHaveBeenCalledWith('ask', mockConfig, undefined, {
        displayCommand: 'eval',
      });
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
      // silently re-testing the rater (the default rung, `assisted`, rates).
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
        // [[TUI-C67]] — the subject the gate decided on travels to the surface, so the prompt's
        // opening sentence can branch on the same discriminator the decision did instead of
        // announcing every gated call as a shell command. Attached unconditionally, which is why
        // it appears on this exact-shape assertion.
        subject: { kind: 'shell', command: 'ls -la' },
        // EXT-71 §6 — the prompt is told what a sticky choice would store, so it can show the user
        // the thing they are agreeing to before they agree to it, and (EXT-70) the same grant in
        // the words the menu's control is written in.
        grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "ls -la" }',
        grantSummary: 'ls -la',
        // [[TUI-C26]] §6 — and the same for the *always reject* control. For a resolvable command
        // the two entries coincide; they part company on the commands that do not resolve, which
        // `GthAgentRunnerDenyMenu.spec.ts` is about.
        denyPreview: '{ "type": "shell", "matcher": "exact", "pattern": "ls -la" }',
        denySummary: 'ls -la',
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

    /**
     * [[EXT-80]] — **a gated NON-SHELL call has to survive the whole interrupt path**, not merely
     * appear in a gated set. The matcher and the annotation path already model `tool` subjects and
     * `decideToolApproval` already has `subject.kind !== 'shell'` arms, but whether those pieces
     * connect is a thing to test rather than assume: an interrupt that is built and then dropped
     * somewhere between the graph and the prompt would leave `manual` exactly as false as it was.
     */
    describe('EXT-80 — a newly gated non-shell tool reaches the human', () => {
      const MANUAL_CONFIG = { streamOutput: true as const, approvals: 'manual' as const };

      it('prompts the human for write_file at manual and resumes with the decision', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        mockAgent.stream.mockResolvedValue(streamOf('working'));
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          .mockResolvedValueOnce([
            { name: 'write_file', args: { path: 'notes.md', content: 'hello' } },
          ])
          .mockResolvedValueOnce([]);
        const streamResume = vi.fn().mockResolvedValue(streamOf(' done'));
        (mockAgent as any).streamResume = streamResume;

        await runner.init(undefined, { ...mockConfig, ...MANUAL_CONFIG } as any);
        const human = vi.fn().mockResolvedValue({ type: 'approve' });
        runner.setToolApprovalCallback(human);

        const result = await runner.processMessages([new HumanMessage('write notes')]);

        expect(human).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'write_file',
            args: { path: 'notes.md', content: 'hello' },
          })
        );
        expect(streamResume).toHaveBeenCalledWith(
          { decisions: [{ type: 'approve' }] },
          expect.anything()
        );
        expect(result).toBe('working done');
        // §4.3 keeps the rater on the shell: a tool subject is escalated, never rated.
        expect(resolveRaterModelMock).not.toHaveBeenCalled();
      });

      it('carries a REJECT decision back for a newly gated tool', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        mockAgent.stream.mockResolvedValue(streamOf('working'));
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          .mockResolvedValueOnce([{ name: 'delete_file', args: { path: 'notes.md' } }])
          .mockResolvedValueOnce([]);
        const streamResume = vi.fn().mockResolvedValue(streamOf(' stopped'));
        (mockAgent as any).streamResume = streamResume;

        await runner.init(undefined, { ...mockConfig, ...MANUAL_CONFIG } as any);
        runner.setToolApprovalCallback(vi.fn().mockResolvedValue({ type: 'reject' }));

        await runner.processMessages([new HumanMessage('delete notes')]);

        expect(streamResume).toHaveBeenCalledWith(
          { decisions: [expect.objectContaining({ type: 'reject' })] },
          expect.anything()
        );
      });

      it('prompts for an MCP tool at manual even when it declares readOnlyHint', async () => {
        // The EXT-30 (iii) exemption is deliberately NOT carried into these two rungs: a server's
        // self-declared annotation is least earned where the ladder is strictest.
        const runner = new GthAgentRunner(statusUpdateCallback);
        mockAgent.stream.mockResolvedValue(streamOf('working'));
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          .mockResolvedValueOnce([{ name: 'mcp__docs__search', args: { query: 'x' } }])
          .mockResolvedValueOnce([]);
        (mockAgent as any).getDeclaredMcpToolAnnotations = vi
          .fn()
          .mockReturnValue(new Map([['mcp__docs__search', { readOnlyHint: true }]]));
        (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

        await runner.init(undefined, { ...mockConfig, ...MANUAL_CONFIG } as any);
        const human = vi.fn().mockResolvedValue({ type: 'approve' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('search docs')]);

        expect(human).toHaveBeenCalledWith(expect.objectContaining({ name: 'mcp__docs__search' }));
      });

      it('prompts for a custom tool at manual', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        mockAgent.stream.mockResolvedValue(streamOf('working'));
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          .mockResolvedValueOnce([{ name: 'my_custom_tool', args: { thing: 1 } }])
          .mockResolvedValueOnce([]);
        (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

        await runner.init(undefined, { ...mockConfig, ...MANUAL_CONFIG } as any);
        const human = vi.fn().mockResolvedValue({ type: 'approve' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('do the thing')]);

        expect(human).toHaveBeenCalledWith(expect.objectContaining({ name: 'my_custom_tool' }));
      });

      /**
       * §6.2 for the widened set: a non-interactive run must EXIT non-zero rather than hang or hand
       * the model a rejection it can work around. The message names the tool, since a non-shell
       * subject has no command string to quote.
       */
      it('EXITS non-zero for a newly gated tool when no human can answer', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        mockAgent.stream.mockResolvedValue(streamOf('working'));
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          .mockResolvedValueOnce([{ name: 'write_file', args: { path: 'out.txt' } }])
          .mockResolvedValueOnce([]);
        const streamResume = vi.fn().mockResolvedValue(streamOf(''));
        (mockAgent as any).streamResume = streamResume;

        await runner.init(undefined, { ...mockConfig, ...MANUAL_CONFIG } as any);
        // No setToolApprovalCallback → the CI / one-shot / server case.

        const error = await runner
          .processMessages([new HumanMessage('write out')])
          .then(() => null)
          .catch((e: unknown) => e as Error);

        expect(error).toBeInstanceOf(NonInteractiveEscalationError);
        expect(error?.message).toContain('write_file');
        expect(streamResume).not.toHaveBeenCalled();
      });

      it('still lets the declared deny list refuse a newly gated tool before any prompt', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        mockAgent.stream.mockResolvedValue(streamOf('working'));
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          .mockResolvedValueOnce([{ name: 'my_custom_tool', args: {} }])
          .mockResolvedValueOnce([]);
        (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

        await runner.init(undefined, {
          ...mockConfig,
          ...MANUAL_CONFIG,
          approvals: {
            rung: 'manual',
            deny: [{ type: 'tool', matcher: 'exact', pattern: 'my_custom_tool' }],
          },
        } as any);
        const human = vi.fn();
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('do the thing')]);

        expect(human).not.toHaveBeenCalled();
      });
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

    /**
     * EXT-71 §3.1/§6 — **a session grant is exactly the command the human saw, and both halves of
     * that are asserted here.** The same command stops asking; a command that merely starts with it
     * asks again. The menu never widens, so the only thing that grew broader than one command is
     * something a human typed into a config file.
     *
     * Both directions in one test on purpose: the narrowing half alone would pass against a gate
     * that had simply stopped remembering anything, and the grant half alone was what the retired
     * prefix store already did.
     */
    it('a session grant is EXACTLY that command: the same one stops asking, a longer one still asks', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('first'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        // A longer command that starts with the granted one — the §3.1 case that used to ride the
        // grant, and must not.
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main --force' } },
        ])
        // The granted command itself, again: it must NOT prompt, or the grant does nothing.
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('checkout')]);

      // Two prompts: the first command, then the longer variant. The repeat of the granted command
      // never reached the human.
      expect(human).toHaveBeenCalledTimes(2);
      expect(
        human.mock.calls.map((call: unknown[]) => (call[0] as PendingToolInterrupt).args)
      ).toEqual([{ command: 'git checkout main' }, { command: 'git checkout main --force' }]);
    });

    /**
     * §3.1 — **the escalation menu writes what the human saw, and the prompt shows it first.** The
     * preview is rendered from the very entry the grant will store, so it cannot promise one thing
     * and remember another; the assertion below is on the round trip, not on an object literal.
     */
    it('§6 — the prompt is shown the entry a sticky choice will store, and that is what is stored', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          // Padded spelling: what is stored is the command in the form every comparison runs over,
          // which is what makes the grant match the very call that produced it.
          { name: 'run_shell_command', args: { command: 'npm   test\n' } },
        ])
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'npm test' } }])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'npm test --watch' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('test')]);

      const first = human.mock.calls[0][0] as PendingToolInterrupt;
      expect(first.grantPreview).toBe(
        '{ "type": "shell", "matcher": "exact", "pattern": "npm test" }'
      );
      // The round trip: what the preview promised is what auto-approves, and only that. `npm test`
      // never prompts again; `npm test --watch` does.
      expect(human).toHaveBeenCalledTimes(2);
      expect((human.mock.calls[1][0] as PendingToolInterrupt).args).toEqual({
        command: 'npm test --watch',
      });
    });

    /**
     * EXT-71 §3.1 — **there is no second-guessing layer on top of a match.** The retired
     * `WIDENING_FLAGS` set refused a match whenever the command carried a flag from a hardcoded
     * deny-set (`-o`, `--output`, `-c`, `--exec`, …). It existed to bound a grant the MACHINE had
     * widened on a human's behalf, and after §3.1 there are none left to bound: an exact entry is
     * the command itself. Overruling a grant the user made for exactly this command would be a
     * control offered and then refused.
     *
     * Asserted as a behaviour change and not as a missing symbol: the grant is made, and the very
     * same command runs without a second prompt. The control is the neighbouring command that
     * differs only in the flag's VALUE — it still asks, so this is not merely "the gate stopped
     * checking anything".
     */
    it('§3.1 — a grant for a command carrying a once-"widening" flag is honoured, not second-guessed', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'curl -o out.txt https://x/y' } },
        ])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'curl -o out.txt https://x/y' } },
        ])
        // Control: a different output path is a different command, and still asks.
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'curl -o other.txt https://x/y' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('fetch')]);

      expect(human).toHaveBeenCalledTimes(2);
      expect(
        human.mock.calls.map((call: unknown[]) => (call[0] as PendingToolInterrupt).args)
      ).toEqual([
        { command: 'curl -o out.txt https://x/y' },
        { command: 'curl -o other.txt https://x/y' },
      ]);
    });

    /**
     * §3.5 — the `/approvals` display counts the declared entries AND the runtime grants, because
     * both are in force for this session and §3 requires every list to be inspectable. The
     * persisted count stays `undefined` (rendered `—`) until the store is actually loaded.
     */
    it('§3 — the allow-list count covers the declared entries and the session grants alike', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'npm install' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', {
        ...mockConfig,
        ...ALLOWLIST_CONFIG,
        approvals: {
          mode: 'write',
          allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
        },
      } as unknown as typeof mockConfig);
      expect(runner.getAllowlistCounts().session).toBe(1); // the declared entry alone

      runner.setToolApprovalCallback(
        vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' })
      );
      await runner.processMessages([new HumanMessage('install')]);

      expect(runner.getAllowlistCounts().session).toBe(2); // …plus the grant just made
    });

    /**
     * §3.1 — a command that does not statically resolve is not recorded. It could not be stored
     * harmfully (no allow entry of any matcher matches an unresolvable command, so the entry would
     * be inert), but an inert entry sitting in a list §3 requires to be inspectable would tell the
     * user something is in force when nothing is.
     *
     * **And it is not offered either**, which is the half that matters to the human: §6 shows the
     * menu the entry a sticky choice will store, so a preview for a command nothing would store is a
     * control offered and then silently refused. Both halves are asserted here because the storage
     * one alone passes on a gate that shows the preview and then declines to write it.
     */
    it('neither offers nor records a grant for a command that does not statically resolve', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'ls; rm -rf /tmp/x' } },
        ])
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      const compound = human.mock.calls[0][0] as PendingToolInterrupt;
      const ordinary = human.mock.calls[1][0] as PendingToolInterrupt;
      expect(compound.args, 'the compound command is the one that was asked about first').toEqual({
        command: 'ls; rm -rf /tmp/x',
      });
      expect(
        compound.grantPreview,
        'nothing is offered where nothing would be stored'
      ).toBeUndefined();
      // CONTROL: the ordinary command that followed IS shown the entry it will store, so the
      // absence above is this command's unresolvability and not a preview that never renders.
      expect(ordinary.grantPreview).toBe(
        '{ "type": "shell", "matcher": "exact", "pattern": "ls -la" }'
      );

      // The compound command left nothing behind; the ordinary one that followed did.
      expect(runner.getAllowlistCounts().session).toBe(1);
    });

    /**
     * §2.5 — at `bypass` the allow list is moot, so a session that has switched the gate off must
     * not read or rewrite the project's grant file. `always: undefined` is the observable: the
     * store was never loaded, even though a gated call went all the way through the decision.
     */
    it('does not touch the persisted grant file at bypass', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', {
        ...mockConfig,
        ...ALLOWLIST_CONFIG,
        approvals: 'bypass',
      } as unknown as typeof mockConfig);
      runner.setToolApprovalCallback(vi.fn());
      await runner.processMessages([new HumanMessage('go')]);

      expect(runner.getAllowlistCounts().always).toBeUndefined();
    });

    /**
     * §2.4 — the v1 migration **through the runner**: the file the product actually resolves, the
     * notice on the surface the product actually reports to (`statusUpdate`), and the narrowed
     * grant honoured by the gate itself.
     *
     * It doubles as the guard on the project-dir clamp above: this only passes because the runner's
     * real path resolution lands inside the temp dir. Remove the clamp and this reads someone's
     * actual allow-list instead.
     */
    it('§2.4 — migrates a v1 store on first use, reports it once, and grants only the exact command', async () => {
      const storePath = join(projectDir, SHELL_ALLOWLIST_FILE);
      writeFileSync(storePath, JSON.stringify({ version: 1, prefixes: ['npm install'] }), 'utf8');

      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'npm install' } }])
        // The v1 prefix used to cover this too. It must ask now.
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'npm install left-pad' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      await runner.init('code', { ...mockConfig, ...ALLOWLIST_CONFIG });
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('install')]);

      // The migrated grant covered the exact command (no prompt) but not the longer one.
      expect(human).toHaveBeenCalledTimes(1);
      expect((human.mock.calls[0][0] as PendingToolInterrupt).args).toEqual({
        command: 'npm install left-pad',
      });
      // The notice reached the user, once, naming the file.
      const notices = statusUpdateCallback.mock.calls
        .map((call: unknown[]) => String(call[1]))
        .filter((message: string) => message.includes('older format'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(storePath);
      // …and the file itself is now v2, so the next session says nothing.
      expect(JSON.parse(readFileSync(storePath, 'utf8')).version).toBe(2);
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
      // **The injected command is deliberately one the §8 floor does NOT catch.** The floor is
      // consulted before the allow-list at every gated rung, so a composition ending in `rm -rf /`
      // would be refused without the matcher ever being asked — and this test, which exists to
      // measure the matcher, would pass for a reason that has nothing to do with it. The matcher's
      // own refusal to auto-approve the floored spelling is pinned in `approvalGrants.spec.ts`.
      const INJECTED = 'git checkout x; rm -rf ./build';
      expect(checkHardline(INJECTED), 'the guard must be the matcher, not the floor').toBeNull();
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: INJECTED } }])
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
      expect(runner.setSessionApprovalRung('manual')).toBe('manual');
      expect(runner.getSessionApprovals().rung).toBe('manual');
    });

    it('§1.1 — with no `approvals` key the session starts at assisted, on every command', async () => {
      for (const command of ['code', 'exec', 'api'] as const) {
        const runner = new GthAgentRunner(statusUpdateCallback);
        await runner.init(command, mockConfig);
        expect(runner.getSessionApprovals().rung).toBe('assisted');
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

    /**
     * EXT-66 — the rater timeout is part of the resolved posture, and a call that runs out of it is
     * SAID OUT LOUD rather than laundered into the escalation.
     *
     * Both halves matter and neither is cosmetic. The budget had no config key at all, so a local
     * rater — measured at 6.0s–114.7s per call on `gemma4:12b` — was cut off by a 30s constant it
     * could not reach, and `auto` drifted toward escalating everything, which is the failure
     * the rung exists to prevent. And because the timeout produced a verdict byte-identical to a
     * real `destructive` judgement, every layer reported success while it happened: the only
     * symptom was the gate becoming mysteriously more talkative.
     */
    it('carries the rater timeout into the resolved posture', async () => {
      resolveRaterModelMock.mockResolvedValue({ withStructuredOutput: vi.fn() } as any);
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        approvals: { mode: 'auto', rater: 'safety-rater', raterTimeoutMs: 120_000 },
      } as unknown as typeof mockConfig);
      expect(runner.getSessionApprovals().raterTimeoutMs).toBe(120_000);
    });

    it('leaves the rater timeout undefined when config does not set one', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        approvals: 'auto',
      } as unknown as typeof mockConfig);
      // Undefined, not 30000: the default belongs to the rater, so the effective-config snapshot
      // does not churn and an unset key stays visibly unset.
      expect(runner.getSessionApprovals().raterTimeoutMs).toBeUndefined();
    });

    /**
     * EXT-66 — the PER-COMMAND budget, and the reason the runner passes the timeout explicitly
     * rather than letting `rateShellCommand` resolve it alone.
     *
     * `rateShellCommand` resolves `approvals` with no command, so it can only ever see the ROOT
     * value. A `commands.code.approvals.raterTimeoutMs` reaches it exclusively through the runner,
     * which resolved the posture WITH the command. Found by deleting the runner's pass-through and
     * watching the suite stay green — the two paths agree on the root value, so nothing else here
     * could tell them apart.
     */
    it('honours a per-command rater timeout, which only the runner can resolve', async () => {
      const invoke = vi.fn(() => new Promise(() => {}));
      resolveRaterModelMock.mockResolvedValue({
        withStructuredOutput: () => ({ invoke }),
      } as any);
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield 'working';
        },
      });
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield ' done';
        },
      });
      await runner.init('code', {
        ...mockConfig,
        streamOutput: true,
        // Root says a budget long enough to hang the test; the per-command value is the one that
        // must win, exactly as the rung does.
        approvals: { mode: 'auto', rater: 'slow-rater', raterTimeoutMs: 900_000 },
        commands: {
          code: { approvals: { mode: 'auto', rater: 'slow-rater', raterTimeoutMs: 6 } },
        },
      } as unknown as typeof mockConfig);
      runner.setToolApprovalCallback(vi.fn().mockResolvedValue({ type: 'approve' }));

      await runner.processMessages([new HumanMessage('run ls')]);

      const said = statusUpdateCallback.mock.calls.map(([, message]) => String(message));
      const notice = said.find((m) => m.includes('did not answer in time'));
      expect(
        notice,
        `expected the per-command budget to apply; saw: ${JSON.stringify(said)}`
      ).toBeDefined();
      expect(notice).toContain('6ms');
    });

    it('warns the user when the rater runs out of time, instead of escalating silently', async () => {
      // A rater model that never answers, with a 5ms budget — the shape of a local model on a
      // hard command, compressed.
      resolveRaterModelMock.mockResolvedValue({
        withStructuredOutput: () => ({ invoke: () => new Promise(() => {}) }),
      } as any);
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield 'working';
        },
      });
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield ' done';
        },
      });
      await runner.init('code', {
        ...mockConfig,
        streamOutput: true,
        approvals: { mode: 'auto', rater: 'slow-rater', raterTimeoutMs: 5 },
      } as unknown as typeof mockConfig);
      runner.setToolApprovalCallback(vi.fn().mockResolvedValue({ type: 'approve' }));

      await runner.processMessages([new HumanMessage('run ls')]);

      const said = statusUpdateCallback.mock.calls.map(([, message]) => String(message));
      const notice = said.find((m) => m.includes('did not answer in time'));
      expect(notice, `expected a timeout notice among: ${JSON.stringify(said)}`).toBeDefined();
      expect(notice).toContain('5ms');
      expect(notice).toContain('approvals.raterTimeoutMs');
      // It must not claim the command was judged — that is the whole distinction.
      expect(notice).not.toMatch(/\bdestructive\b/);
      // It reports the action that actually happened: with no allow entry, the call escalated.
      expect(notice).toContain('was escalated without being rated');
    });

    /**
     * EXT-71 §3.2 — the same timeout on an ALLOW-matched call does not escalate: the rating is a
     * tripwire, the fail-closed verdict is `destructive`, and `destructive` runs. So the notice
     * must say what happened rather than reuse the escalation wording, which would be simply
     * false. A notice that misreports the action it accompanies is worse than none.
     */
    it('says the call RAN on its allow match when the tripwire is the thing that timed out', async () => {
      resolveRaterModelMock.mockResolvedValue({
        withStructuredOutput: () => ({ invoke: () => new Promise(() => {}) }),
      } as any);
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield 'working';
        },
      });
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: 'ls -la' } }])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield ' done';
        },
      });
      (mockAgent as any).streamResume = streamResume;
      await runner.init('code', {
        ...mockConfig,
        streamOutput: true,
        approvals: {
          mode: 'auto',
          rater: 'slow-rater',
          raterTimeoutMs: 5,
          // A glob, so §3.2 keeps the rater involved — which is what makes the timeout reachable.
          allow: [{ type: 'shell', matcher: 'glob', pattern: 'ls*' }],
        },
      } as unknown as typeof mockConfig);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('run ls')]);

      const said = statusUpdateCallback.mock.calls.map(([, message]) => String(message));
      const notice = said.find((m) => m.includes('did not answer in time'));
      expect(notice, `expected a timeout notice among: ${JSON.stringify(said)}`).toBeDefined();
      expect(notice).toContain('ran on its approvals.allow match alone');
      expect(notice).not.toContain('was escalated without being rated');
      // And the action it describes is the one that happened: no prompt, the call ran.
      expect(human).not.toHaveBeenCalled();
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
    });

    it('init seeds the whole posture (rung + rater profile + declared lists) from config', async () => {
      resolveRaterModelMock.mockResolvedValue({ withStructuredOutput: vi.fn() } as any);
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        approvals: {
          mode: 'auto',
          rater: 'safety-rater',
          allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
          deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
          escalate: [{ type: 'shell', matcher: 'exact', pattern: 'terraform apply' }],
        },
      } as unknown as typeof mockConfig);
      expect(runner.getSessionApprovals()).toEqual({
        rung: 'auto',
        rater: 'safety-rater',
        alignmentChecker: 'safety-rater',
        allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
        deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
        escalate: [{ type: 'shell', matcher: 'exact', pattern: 'terraform apply' }],
      });
      // §3 — every list MUST be inspectable, so the declared entries are what the `/approvals`
      // display counts. They are NOT copied into the prefix stores (that is what made an `exact`
      // entry behave as a prefix); they are matched from the posture itself.
      expect(runner.getDenylist()).toEqual(['npm publish']);
      expect(runner.getAllowlistCounts().session).toBe(1);
    });

    /**
     * EXT-71 — a `glob` entry is inspectable too, and its rendering says which matcher it is, since
     * a pattern that is not the command has to be readable as one.
     */
    it('renders a pattern entry in the deny display with its matcher', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        approvals: {
          mode: 'write',
          allow: [{ type: 'shell', matcher: 'glob', pattern: 'git status*' }],
          deny: [
            { type: 'shell', matcher: 'glob', pattern: 'npm publish*' },
            { type: 'mcpTool', server: 'jira', matcher: 'exact', pattern: 'delete_issue' },
          ],
        },
      } as unknown as typeof mockConfig);
      expect(runner.getDenylist()).toEqual(['npm publish* (glob)', 'mcpTool jira/delete_issue']);
      expect(runner.getAllowlistCounts().session).toBe(1);
    });

    it('switching rungs never rewrites the declared lists — they are config input, not state', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        approvals: {
          mode: 'write',
          deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
        },
      } as unknown as typeof mockConfig);
      runner.setSessionApprovalRung('bypass');
      expect(runner.getSessionApprovals().deny).toEqual([
        { type: 'shell', matcher: 'exact', pattern: 'npm publish' },
      ]);
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
        approvals: { mode: 'assisted', rater: 'safety-rater' },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(resolveRaterModelMock).toHaveBeenCalledWith('safety-rater', 'approvals.rater');
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
        approvals: 'assisted',
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
          approvals: { mode: 'assisted', rater: 'typo' },
        } as any)
      ).rejects.toThrow('no usable model');
      // The session model must NOT have been quietly promoted into the rater's place.
      expect(session.withStructuredOutput).not.toHaveBeenCalled();
    });

    // The profile's model is loaded whenever one is NAMED, on any command — the default rung
    // (assisted) rates everywhere, and even at an unrated rung the user may switch mid-session
    // with `/approvals`, so a broken profile must fail at startup rather than at that moment.
    it.each(['code', 'exec'] as const)('resolves the named profile on %s', async (command) => {
      resolveRaterModelMock.mockResolvedValue(fakeModel('safe').model);
      const runner = new GthAgentRunner(statusUpdateCallback);
      const config = { ...mockConfig, approvals: { rater: 'safety-rater' } } as any;
      await runner.init(command, config);
      expect(resolveRaterModelMock).toHaveBeenCalledWith('safety-rater', 'approvals.rater');
      expect(runner.getSessionApprovals().rater).toBe('safety-rater');
    });

    /**
     * [[EXT-127]] — **the alignment checker is a SECOND profile, resolved under its own key.**
     *
     * The two are resolved by the same function, and the key it is given is the only thing that
     * tells a user which of the two they mis-typed. Nothing asserted the checker's half: the string
     * `approvals.alignmentChecker` appeared in no spec anywhere, so the call site could have
     * reported the rater's key — or resolved the rater's profile — with everything green.
     *
     * Two names on purpose, since the same name twice is the DEFAULT and would let a wiring that
     * ignored the checker key entirely pass this cell.
     */
    it('resolves the checker under `approvals.alignmentChecker`, separately from the rater', async () => {
      resolveRaterModelMock.mockResolvedValue(fakeModel('safe').model);
      const runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', {
        ...mockConfig,
        approvals: { mode: 'auto', rater: 'safety-rater', alignmentChecker: 'big-checker' },
      } as any);
      expect(resolveRaterModelMock).toHaveBeenCalledWith('safety-rater', 'approvals.rater');
      expect(resolveRaterModelMock).toHaveBeenCalledWith(
        'big-checker',
        'approvals.alignmentChecker'
      );
      expect(runner.getSessionApprovals().alignmentChecker).toBe('big-checker');
    });

    /**
     * [[EXT-127]] / [[GS2-62]] — **and it is strict, exactly as the rater is.** A checker profile
     * that names nothing usable is a config error the user is told about at startup, never a quiet
     * fall back to the session model — which is the failure this whole resolution path exists to
     * remove, since the user asked for a different model and would silently have been given the one
     * they were replacing.
     *
     * Measured before this cell existed: wrapping the checker's resolve in a `try`/`catch` that
     * swallowed the error survived the entire suite.
     */
    it('a checker profile that cannot be resolved FAILS INIT — never a silent fallback', async () => {
      resolveRaterModelMock.mockImplementation(async (_profile: string, key: string) => {
        if (key === 'approvals.alignmentChecker') {
          throw new Error(
            'The identity profile "typo-checker" resolved to a config with no usable model.'
          );
        }
        return fakeModel('safe').model;
      });
      const runner = new GthAgentRunner(statusUpdateCallback);
      await expect(
        runner.init('code', {
          ...mockConfig,
          approvals: { mode: 'auto', rater: 'safety-rater', alignmentChecker: 'typo-checker' },
        } as any)
      ).rejects.toThrow('no usable model');
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
    const SAFE = { outcome: 'safe', reason: 'manual' };
    const DESTRUCTIVE = { outcome: 'destructive', reason: 'risky' };
    const CATASTROPHIC = { outcome: 'catastrophic', reason: 'drops a database irrecoverably' };
    const ATTACK = { outcome: 'attack', reason: 'reads a private key as the operation itself' };

    // Build a fake config.llm whose withStructuredOutput(...).invoke() resolves to `verdict`.
    function raterModel(verdict: unknown) {
      const invoke = vi.fn().mockResolvedValue(verdict);
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      return { model: { withStructuredOutput } as any, withStructuredOutput, invoke };
    }

    /** A rated rung with the given verdict. `rung` defaults to the default rung, `assisted`. */
    function raterConfig(verdict: unknown, approvals: Record<string, unknown> = {}) {
      const { model, withStructuredOutput, invoke } = raterModel(verdict);
      return {
        config: {
          ...mockConfig,
          llm: model,
          streamOutput: true as const,
          approvals: { mode: 'assisted', ...approvals },
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

    /**
     * Several gated calls in one run, each suspending on its own turn, so a test can exercise a RUN
     * of decisions rather than a single one, and read the decision the runner returned for each.
     *
     * Each command comes back as its own `getPendingToolInterrupts` batch, which is exactly the
     * shape the resume loop sees in production when a model answers a rejection with another tool
     * call.
     */
    function pendingSequence(...commands: string[]) {
      let pending = ((mockAgent as any).getPendingToolInterrupts = vi.fn());
      for (const command of commands) {
        pending = pending.mockResolvedValueOnce([{ name: 'run_shell_command', args: { command } }]);
      }
      pending.mockResolvedValue([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      /** The decision the runner returned for the Nth gated call of the run. */
      const decisionAt = (index: number) => streamResume.mock.calls[index][0].decisions[0];
      return { streamResume, decisionAt };
    }

    it.each(['assisted', 'auto'] as const)(
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

    /**
     * **`assisted` — pinned, because the whole of [[EXT-29]] is that the two rated rungs stopped
     * being the same posture, and proving one of them did NOT move is half of that claim.**
     * A `destructive` outcome here reaches the human on the FIRST rating, with the verdict attached
     * and with no negotiation of any kind: no rejection handed to the model, and no transcript on
     * the prompt.
     */
    it('escalates a DESTRUCTIVE command at assisted to the human on the FIRST rating', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('rm -rf build');

      const { config, withStructuredOutput } = raterConfig(DESTRUCTIVE, { mode: 'assisted' });
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(human).toHaveBeenCalledTimes(1);
      expect(human.mock.calls[0][0].safetyVerdict).toMatchObject({
        outcome: 'destructive',
        reason: 'risky',
      });
      // One rating call, not a round of an argument…
      expect(withStructuredOutput).toHaveBeenCalledTimes(1);
      // …the model was never handed a rejection…
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
      // …and the prompt carries no negotiation, because there was none.
      expect(human.mock.calls[0][0].negotiationRounds).toBeUndefined();
    });

    /**
     * §4.2 — `attack` HALTS the run at both rated rungs. It is not a rejection the model can
     * respond to, so the graph is never resumed with a decision: the agent loop simply ends.
     */
    it.each(['assisted', 'auto'] as const)(
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
    it.each(['assisted', 'auto'] as const)(
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
     *
     * The second command is the SAME command, not a variant. Under §3.1 a grant covers exactly the
     * command it was made for, so a variant would prompt again whether or not the clamp exists —
     * an assertion that cannot fail. Repeating the identical command is what makes the second
     * prompt evidence of the clamp and nothing else.
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
          { name: 'run_shell_command', args: { command: 'terraform destroy -auto-approve' } },
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
        // The same command, so the only reason it could prompt again is the clamp — which is what
        // this control exists to show does NOT fire here.
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'terraform destroy -auto-approve' } },
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

    /**
     * ── [[EXT-81]] — a command the gate's PARSER cannot read is rated, not refused ─────────────
     *
     * The field issue: `pwd && ls` at `auto` interrupted a human, because `&&` composes and
     * the gate cannot resolve the composition. Two frontier models, two days, the cheapest command
     * anyone could type. §6.1's rule is that a deterministic layer fires only where it is confident
     * something is a threat — and a parser reporting that it could not resolve a string has
     * detected nothing — so the finding becomes a neutral note in the rating prompt and the
     * decision comes from the rater.
     *
     * These are runner-level properties: `mapVerdictToAction` is pure and cannot say whether anyone
     * PAID for a model call, and it cannot say what the prompt contained. Only this layer can.
     */
    describe('EXT-81: an unresolvable command is rated like any other', () => {
      /**
       * **The call is now MADE.** The exact inverse of the assertion this replaced, which pinned
       * that an abstaining command cost zero rating calls. The control is a resolvable command, so
       * "one call" is about this command rather than about the rater having started firing twice.
       */
      it.each(['assisted', 'auto'] as const)(
        'at %s an UNRESOLVABLE command costs exactly one rating call, same as a resolvable one',
        async (rung) => {
          const composedRunner = new GthAgentRunner(statusUpdateCallback);
          pendingOnce('pwd && ls');
          const composed = raterConfig(SAFE, { mode: rung });
          await composedRunner.init('code', composed.config);
          composedRunner.setToolApprovalCallback(vi.fn());
          await composedRunner.processMessages([new HumanMessage('go')]);
          expect(composed.invoke).toHaveBeenCalledTimes(1);

          const resolvable = new GthAgentRunner(statusUpdateCallback);
          pendingOnce('ls -la');
          const plain = raterConfig(SAFE, { mode: rung });
          await resolvable.init('code', plain.config);
          resolvable.setToolApprovalCallback(vi.fn());
          await resolvable.processMessages([new HumanMessage('go')]);
          expect(plain.invoke).toHaveBeenCalledTimes(1);
        }
      );

      /**
       * **The interruption this node removes**, measured where a user meets it: `pwd && ls` at
       * `auto` no longer reaches a human, and is no longer refused back to the model either.
       * It runs.
       */
      it.each(['assisted', 'auto'] as const)(
        'at %s a composed command the rater calls SAFE is approved, with no human and no rejection',
        async (rung) => {
          const runner = new GthAgentRunner(statusUpdateCallback);
          const { decisionAt } = pendingSequence('pwd && ls');
          const { config } = raterConfig(SAFE, { mode: rung });
          await runner.init('code', config);
          const human = vi.fn();
          runner.setToolApprovalCallback(human);

          await runner.processMessages([new HumanMessage('go')]);

          expect(decisionAt(0)).toEqual({ type: 'approve', scope: 'once' });
          expect(human).not.toHaveBeenCalled();
        }
      );

      /**
       * **The note reaches the rater**, and this is the only layer that can see it — the runner
       * builds the prompt through `rateShellCommand`, so what the model was actually shown is
       * observable on the mock's arguments and nowhere else.
       *
       * The control is the same assertion on a resolvable command: no note at all. Without it a
       * `toContain` would pass with the note attached unconditionally, which is exactly the failure
       * `describeAbstention`'s guard exists to prevent.
       */
      it('hands the rater the neutral parser note, and hands it NO note for a resolvable command', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('pwd && ls');
        const composed = raterConfig(SAFE);
        await runner.init('code', composed.config);
        runner.setToolApprovalCallback(vi.fn());
        await runner.processMessages([new HumanMessage('go')]);

        const messages = composed.invoke.mock.calls[0][0] as { content: string }[];
        const user = messages[messages.length - 1].content;
        expect(user).toContain(PARSER_NOTE_PREAMBLE);
        expect(user).toContain(MECHANISM_NOTES.composition);

        const plainRunner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('ls -la');
        const plain = raterConfig(SAFE);
        await plainRunner.init('code', plain.config);
        plainRunner.setToolApprovalCallback(vi.fn());
        await plainRunner.processMessages([new HumanMessage('go')]);

        const plainMessages = plain.invoke.mock.calls[0][0] as { content: string }[];
        expect(plainMessages[plainMessages.length - 1].content).not.toContain('PREFLIGHT NOTE');
      });

      /**
       * **The ceiling this node restores.** Nothing rated this class while the abstention stood, so
       * `attack` was unreachable for every composed command — `pwd && rm -rf ~` could be floored at
       * `destructive` and no layer was positioned to call it worse. It now halts the run.
       */
      // The command is composed but does NOT match the §8 floor — `pwd && rm -rf ~` does, and since
      // [[EXT-29]] a floor match is settled deterministically before any rating, which would make
      // this a test of the floor rather than of the rater reaching `attack` on a composed command.
      it('HALTS the run when the rater calls a composed command an attack', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('pwd && rm -rf ~/projects');
        const { config } = raterConfig(ATTACK, { mode: 'auto' });
        await runner.init('code', config);
        runner.setToolApprovalCallback(vi.fn());

        await expect(runner.processMessages([new HumanMessage('go')])).rejects.toBeInstanceOf(
          AttackHaltError
        );
      });

      /**
       * A `destructive` verdict escalates carrying the RATER's own sentence — not a synthetic
       * "could not assess" note the gate wrote about its own parser, which is what the human used
       * to be shown for this class.
       */
      it('escalates a DESTRUCTIVE composed command with the rater’s own explanation', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('cd build && rm -rf artifacts');
        const { config } = raterConfig(DESTRUCTIVE);
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(human).toHaveBeenCalledTimes(1);
        const shown = human.mock.calls[0][0].safetyVerdict;
        expect(shown.outcome).toBe('destructive');
        expect(shown.reason).toBe((DESTRUCTIVE as { reason: string }).reason);
        expect(shown.reason).not.toContain('composes, substitutes or redirects');
      });

      /**
       * **The unrated rungs are untouched**, and this is pinned at the runner level because an AI
       * reviewer once read the diff as moving that check outside the rung guard. At `manual` and
       * `write` the human is asked with no verdict attached at all, and no model is consulted —
       * whether or not the parser could read the command.
       */
      it.each(['manual', 'write'] as const)(
        'at %s an unresolvable command reaches the human with NO verdict and NO rating call',
        async (rung) => {
          const runner = new GthAgentRunner(statusUpdateCallback);
          pendingOnce('cat x | sh');
          const composed = raterConfig(SAFE, { mode: rung });
          await runner.init('code', composed.config);
          const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
          runner.setToolApprovalCallback(human);
          await runner.processMessages([new HumanMessage('go')]);

          expect(human).toHaveBeenCalledTimes(1);
          expect(human.mock.calls[0][0].safetyVerdict).toBeUndefined();
          expect(composed.invoke).not.toHaveBeenCalled();
        }
      );

      /**
       * §6.2 — where nobody can answer, an escalating verdict on an unresolvable command is an
       * immediate non-zero exit carrying the RATER's reason. It is no longer refused to the model
       * first: there is no parser finding for the model to comply with.
       */
      it('§6.2: an unresolvable command with no human exits non-zero, carrying the rating', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('cat x | sh');
        const { config } = raterConfig(DESTRUCTIVE);
        await runner.init('code', config);
        // No approval callback at all.

        const error = (await runner
          .processMessages([new HumanMessage('go')])
          .then(() => null)
          .catch((e: unknown) => e as Error)) as NonInteractiveEscalationError | null;

        expect(error).toBeInstanceOf(NonInteractiveEscalationError);
        expect(error?.outcome).toBe('destructive');
        expect(error?.message).toContain((DESTRUCTIVE as { reason: string }).reason);
      });

      /**
       * `bypass` consults neither the classifier nor the rater, so nothing here changes it: the
       * command is approved once, nothing is rated, and no note is built.
       */
      it('bypass is unaffected: approved once, no rating call', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const { decisionAt } = pendingSequence('pwd && ls');
        const composed = raterConfig(SAFE, { mode: 'bypass' });
        await runner.init('code', composed.config);
        const human = vi.fn();
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(decisionAt(0)).toEqual({ type: 'approve', scope: 'once' });
        expect(human).not.toHaveBeenCalled();
        expect(composed.invoke).not.toHaveBeenCalled();
      });

      /**
       * A rater approval on an unresolvable command is scoped `once` and writes nothing to the
       * allow-list — the same rule every other rater approval follows. Otherwise the composed
       * command that just approved would stop being rated at all on its next appearance, which is
       * how the release of this class would quietly become permanent.
       */
      it('never persists a grant for a command it approved on the rater’s word', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const { decisionAt } = pendingSequence('pwd && ls');
        const { config } = raterConfig(SAFE, { mode: 'auto' });
        await runner.init('code', config);
        runner.setToolApprovalCallback(vi.fn());
        await runner.processMessages([new HumanMessage('go')]);

        expect(decisionAt(0).scope).toBe('once');
        expect(runner.getAllowlistCounts().session).toBe(0);
      });
    });

    /**
     * The safety property CFG-26 established, carried through the rescale intact: **a preflight is
     * recomputed from the RAW command, so a manipulated `safe` verdict cannot buy its way past
     * one.** The command carries a composition AND expands an environment variable into a script —
     * only the second of those is a FINDING, and it is the one that floors.
     *
     * [[EXT-81]] is why the command changed. This used to be asserted on `ls -la; rm -rf ~`, where
     * what actually stopped the approval was the abstention rather than any preflight; with that
     * branch gone the assertion would have been about a command no preflight looks at. Read the
     * assertion, not the history: the property is the preflight's, and it needs a command a
     * preflight fires on.
     */
    it('a manipulated SAFE verdict cannot buy its way past a preflight FINDING', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('bash -c "echo $AWS_SECRET_ACCESS_KEY" && ls');

      const { config } = raterConfig(SAFE);
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'reject' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      expect(human).toHaveBeenCalledTimes(1);
      expect(human.mock.calls[0][0].safetyVerdict.outcome).toBe('destructive');
      expect(human.mock.calls[0][0].safetyVerdict.reason).toContain(COULD_NOT_ASSESS_PREFIX);
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
        approvals: 'assisted',
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

    it.each(['manual', 'write'] as const)(
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
      const streamResume = pendingOnce('npm test');

      const { model, withStructuredOutput } = raterModel(DESTRUCTIVE);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        approvals: {
          mode: 'assisted',
          allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
        },
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

    /**
     * EXT-71 §3.1 — **the other direction of the test above, and the gap this node closed.** An
     * `exact` entry is the command itself; it does not cover a flag-suffixed sibling. Before the
     * matcher engine the declared entries were copied into the token-aligned prefix store, so
     * `npm test` also auto-approved `npm test --watch=false` — unrated and unprompted, which is the
     * one direction §3.1 says the design cannot afford: *"a too-broad allow entry has no backstop —
     * it runs, unrated and unprompted."*
     */
    it('§3.1 — an exact allow entry does NOT approve a flag-suffixed sibling', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pendingOnce('npm test --watch=false');

      const { model, withStructuredOutput } = raterModel(DESTRUCTIVE);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        approvals: {
          mode: 'assisted',
          allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
        },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn().mockResolvedValue({ type: 'reject' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      // It was rated (the entry did not match) and, on `destructive`, escalated to the human.
      expect(withStructuredOutput).toHaveBeenCalledTimes(1);
      expect(human).toHaveBeenCalledTimes(1);
    });

    /**
     * The supported way to cover the whole family is a GLOB, which the author writes deliberately.
     * §3.2 then keeps the rater involved by default, because a glob recorded a shape rather than a
     * command — and the rating is a TRIPWIRE: `destructive` runs, because the human already
     * authorized it.
     */
    it('§3.1/§3.2 — a glob entry covers the sibling, and its rating is a tripwire that still runs it', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('npm test --watch=false');

      const { model, withStructuredOutput } = raterModel(DESTRUCTIVE);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        approvals: {
          mode: 'assisted',
          allow: [{ type: 'shell', matcher: 'glob', pattern: 'npm test*' }],
        },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      // Rated (glob defaults to `rate: true`) but NOT escalated: the rater does not overrule a
      // standing human decision by disliking it.
      expect(withStructuredOutput).toHaveBeenCalledTimes(1);
      expect(human).not.toHaveBeenCalled();
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
    });

    it('allow-list hit wins: the rater is NOT called for a command a human already trusted', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      // First `git checkout main` is approved at session scope; the SAME command must then approve
      // from the grant WITHOUT the rater running. (§3.1: a grant is that command, so the repeat is
      // what a grant covers — a variant would be rated again, and rightly.)
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git checkout main' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

      const { model, withStructuredOutput } = raterModel(DESTRUCTIVE);
      await runner.init('code', {
        ...mockConfig,
        llm: model,
        streamOutput: true,
        approvals: 'assisted',
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as any);
      // The human grants session on the first; the repeat should hit the grant, not the rater.
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);
      // The rater ran for the first (ungranted) command but NOT for the granted repeat, and the
      // human was asked exactly once — the two halves of "an allow match settles the human's part".
      expect(withStructuredOutput).toHaveBeenCalledTimes(1);
      expect(human).toHaveBeenCalledTimes(1);
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
          approvals: { mode: 'assisted' },
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

    // EXT-71 §3.1 — the declared deny list is a list of explicit entries.
    function shellExact(...patterns: string[]): unknown[] {
      return patterns.map((pattern) => ({ type: 'shell', matcher: 'exact', pattern }));
    }

    function shellGlob(...patterns: string[]): unknown[] {
      return patterns.map((pattern) => ({ type: 'shell', matcher: 'glob', pattern }));
    }

    function denyConfig(
      rung: string,
      deny: unknown[],
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

    it.each(['manual', 'write', 'assisted', 'auto', 'bypass'] as const)(
      'refuses a denied command at %s — with no prompt and no rating call',
      async (rung) => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce('npm publish --access public');
        // §3.1 — `exact` is the command itself, so covering the whole family is a GLOB, which is
        // also what §3.1 tells a user relying on the deny list under `bypass` to write.
        const { config, withStructuredOutput } = denyConfig(rung, shellGlob('npm publish*'));
        await runner.init('code', config);
        const human = vi.fn();
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('ship it')]);

        expect(human).not.toHaveBeenCalled();
        expect(withStructuredOutput).not.toHaveBeenCalled();
        const decision = streamResume.mock.calls[0][0].decisions[0];
        expect(decision.type).toBe('reject');
        // The refusal quotes the user's own entry back, so it is traceable to the line they wrote.
        expect(decision.message).toContain('npm publish*');
        expect(decision.message).toContain('approvals.deny');
      }
    );

    it('§2.5 — bypass keeps the deny list; everything else there is approved', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('rm -rf node_modules');
      const { config } = denyConfig('bypass', shellGlob('npm publish*'));
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn());

      await runner.processMessages([new HumanMessage('clean')]);
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
    });

    /**
     * §3.1 — **the asymmetry.** A deny entry MAY match a command that does not statically resolve,
     * because a prohibition that catches something unresolvable errs in the direction that costs
     * nothing. Both spellings below are unclassifiable, so no ALLOW entry of any matcher could
     * touch them (the paired assertion lives in the matcher spec).
     */
    it('fires on a COMPOSED command, which is exactly what a shared allow-list matcher could not do', async () => {
      for (const command of ['git push --force; ls', 'ls && git push --force origin main']) {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce(command);
        const { config } = denyConfig('bypass', shellGlob('git push --force*'));
        await runner.init('code', config);
        runner.setToolApprovalCallback(vi.fn());

        await runner.processMessages([new HumanMessage('go')]);
        expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('reject');
      }
    });

    /**
     * An `exact` deny entry still matches a compound command SEGMENT-wise — `git push --force; ls`
     * runs `git push --force` as one of its segments — which is what makes the segment split worth
     * having even for the narrowest matcher.
     */
    it('an exact deny entry fires on a segment of a composed command', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('git push --force; ls');
      const { config } = denyConfig('bypass', shellExact('git push --force'));
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn());

      await runner.processMessages([new HumanMessage('go')]);
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('reject');
    });

    it('does not refuse a command that merely shares a prefix token', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce('git push origin main');
      const { config } = denyConfig('bypass', shellGlob('git push --force*'));
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn());

      await runner.processMessages([new HumanMessage('go')]);
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
    });

    /**
     * §3.3 — the declared lists and the runtime stores are ONE set of rules resolved
     * most-restrictive-wins, so a grant the human made at a prompt cannot outrank a prohibition
     * they wrote in config, whichever arrived first.
     */
    it('a declared deny outranks a runtime session grant for the same command', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        // First `git push origin main` is granted at session scope, recording the prefix
        // `git push`; the second command then matches BOTH that grant and the declared deny.
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git push origin main' } },
        ])
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'git push --force origin main' } },
        ])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;

      const { config } = denyConfig('write', shellGlob('git push --force*'));
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      // The first command prompted and was granted; the second was refused without a prompt.
      expect(human).toHaveBeenCalledTimes(1);
      expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
      expect(streamResume.mock.calls[1][0].decisions[0].type).toBe('reject');
    });
  });

  /**
   * EXT-71 §3.2 — the `escalate` list, the `rate` axis, and the allow-match tripwire.
   *
   * Every negative assertion here ships its control, because each one is exactly the shape that
   * passes on a gate that does nothing: "no rating call" passes on a gate that never rates, "inert
   * at bypass" passes on a gate that approves everything, and "runs on destructive" passes on a
   * gate that is simply open. The rater stub below **would answer permissively if it were called**,
   * so an assertion that it was not called is an assertion about the gate rather than about a stub
   * that could not have answered anyway.
   */
  describe('escalate list, the rate axis and the allow tripwire (EXT-71 §3.2)', () => {
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

    const SAFE = { outcome: 'safe', reason: 'manual' };
    const DESTRUCTIVE = { outcome: 'destructive', reason: 'risky' };
    const CATASTROPHIC = { outcome: 'catastrophic', reason: 'drops a database irrecoverably' };
    const ATTACK = { outcome: 'attack', reason: 'reads a private key as the operation itself' };

    /**
     * A rater stub that is **fully capable of answering**, and answers permissively by default.
     * That is load-bearing: an assertion that the rater was never invoked proves the gate did not
     * reach it only when reaching it would have produced a verdict.
     */
    function gateConfig(approvals: Record<string, unknown>, verdict: unknown = SAFE) {
      const invoke = vi.fn().mockResolvedValue(verdict);
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      return {
        withStructuredOutput,
        invoke,
        config: {
          ...mockConfig,
          llm: { withStructuredOutput } as any,
          streamOutput: true as const,
          approvals,
          commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
        } as unknown as GthConfig,
      };
    }

    const ESCALATE_TERRAFORM = [
      { type: 'shell', matcher: 'exact', pattern: 'terraform apply' },
    ] as unknown[];

    describe('escalate always asks the human, whatever the rung would have done', () => {
      it.each(['manual', 'write'] as const)(
        'asks at %s, naming the entry that fired',
        async (rung) => {
          const runner = new GthAgentRunner(statusUpdateCallback);
          pendingOnce('terraform apply');
          const { config, withStructuredOutput } = gateConfig({
            mode: rung,
            escalate: ESCALATE_TERRAFORM,
          });
          await runner.init('code', config);
          const human = vi.fn().mockResolvedValue({ type: 'reject' });
          runner.setToolApprovalCallback(human);

          await runner.processMessages([new HumanMessage('go')]);

          expect(human).toHaveBeenCalledTimes(1);
          expect(human.mock.calls[0][0].escalatedBy).toBe('terraform apply');
          expect(withStructuredOutput).not.toHaveBeenCalled();
        }
      );

      it.each(['assisted', 'auto'] as const)(
        'at %s it goes straight to the human with NO rating call',
        async (rung) => {
          const runner = new GthAgentRunner(statusUpdateCallback);
          pendingOnce('terraform apply');
          // The stub would have said `safe` — i.e. would have APPROVED this call without a prompt.
          const { config, withStructuredOutput } = gateConfig(
            { mode: rung, escalate: ESCALATE_TERRAFORM },
            SAFE
          );
          await runner.init('code', config);
          const human = vi.fn().mockResolvedValue({ type: 'reject' });
          runner.setToolApprovalCallback(human);

          await runner.processMessages([new HumanMessage('go')]);

          expect(withStructuredOutput).not.toHaveBeenCalled();
          expect(human).toHaveBeenCalledTimes(1);
          expect(human.mock.calls[0][0].safetyVerdict).toBeUndefined();
        }
      );

      it('CONTROL: without the escalate entry the same call is rated and auto-approved', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce('terraform apply');
        const { config, withStructuredOutput } = gateConfig({ mode: 'assisted' }, SAFE);
        await runner.init('code', config);
        const human = vi.fn();
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(withStructuredOutput).toHaveBeenCalledTimes(1);
        expect(human).not.toHaveBeenCalled();
        expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
      });

      it('§2.5 — is INERT at bypass: the rung chosen for the session wins', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce('terraform apply');
        const { config } = gateConfig({ mode: 'bypass', escalate: ESCALATE_TERRAFORM });
        await runner.init('code', config);
        const human = vi.fn();
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(human).not.toHaveBeenCalled();
        expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
      });

      /**
       * §2.5's rule is about the RUNG, not about which tool asked. The test above only proves the
       * shell path, because the `bypass` early return is scoped to a shell call — so a non-shell
       * gated call would carry an escalate match into the prompt at `bypass` unless the escalate
       * term says otherwise. No non-shell tool is gated until [[EXT-30]], so what is observable
       * today is the provenance rather than the prompt itself; pinning it now is what stops EXT-30
       * quietly inheriting the gap.
       */
      /**
       * §2.5 is now kept one step earlier and more completely: at `bypass` a non-shell tool is not
       * gated at all ([[EXT-80]]), so the escalate entry cannot fire because nothing is decided.
       * The assertion is stronger than the one it replaces — that one allowed the human to be
       * asked as long as no provenance was attached, which at `bypass` was itself wrong.
       */
      it('§2.5 — is inert at bypass for a NON-shell subject too, not just via the shell path', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          .mockResolvedValueOnce([{ name: 'gth_web_fetch', args: { url: 'https://example.com' } }])
          .mockResolvedValueOnce([]);
        const streamResume = vi.fn().mockResolvedValue(streamOf(''));
        (mockAgent as any).streamResume = streamResume;
        mockAgent.stream.mockResolvedValue(streamOf('x'));

        const { config } = gateConfig({
          mode: 'bypass',
          escalate: [{ type: 'tool', matcher: 'exact', pattern: 'gth_web_fetch' }],
        });
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        // The call really did arrive at the gate and was decided — without that, "not asked" would
        // pass on a run in which nothing happened.
        expect(streamResume).toHaveBeenCalledTimes(1);
        expect(human).not.toHaveBeenCalled();
      });

      it('CONTROL: the same tool entry DOES carry its provenance at write', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          .mockResolvedValueOnce([{ name: 'gth_web_fetch', args: { url: 'https://example.com' } }])
          .mockResolvedValueOnce([]);
        (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));
        mockAgent.stream.mockResolvedValue(streamOf('x'));

        const { config } = gateConfig({
          mode: 'write',
          escalate: [{ type: 'tool', matcher: 'exact', pattern: 'gth_web_fetch' }],
        });
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(human).toHaveBeenCalledTimes(1);
        expect(human.mock.calls[0][0].escalatedBy).toBe('tool gth_web_fetch');
      });

      it('CONTROL: the same entry DOES escalate at write, so bypass is what made it inert', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('terraform apply');
        const { config } = gateConfig({ mode: 'write', escalate: ESCALATE_TERRAFORM });
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);
        expect(human).toHaveBeenCalledTimes(1);
      });

      it('outranks an allow entry that matched the same call', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('terraform apply');
        const { config } = gateConfig({
          mode: 'write',
          allow: [{ type: 'shell', matcher: 'exact', pattern: 'terraform apply' }],
          escalate: ESCALATE_TERRAFORM,
        });
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);
        expect(human).toHaveBeenCalledTimes(1);
        expect(human.mock.calls[0][0].escalatedBy).toBe('terraform apply');
      });

      /**
       * The three-list resolution already puts escalate above allow for DECLARED entries, so the
       * test above passes even if the runner stops guarding the second allow source — the EXT-9
       * Tier-2 prefix store the escalation menu writes. This is that second source: a grant the
       * human made at a prompt must not answer an escalate entry either, or the very first
       * *always approve* would silently retire the rule the user wrote.
       */
      it('outranks a RUNTIME session grant for the same command', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        mockAgent.stream.mockResolvedValue(streamOf('x'));
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          // `terraform apply` prompts (the escalate entry), the human grants `session` scope, and
          // the SAME command comes back: the recorded prefix must not answer for it.
          .mockResolvedValueOnce([
            { name: 'run_shell_command', args: { command: 'terraform apply' } },
          ])
          .mockResolvedValueOnce([
            { name: 'run_shell_command', args: { command: 'terraform apply' } },
          ])
          .mockResolvedValueOnce([]);
        (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

        const { config } = gateConfig({ mode: 'write', escalate: ESCALATE_TERRAFORM });
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);
        expect(human).toHaveBeenCalledTimes(2);
      });

      it('CONTROL: without the escalate entry, the runtime grant DOES answer the second call', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        mockAgent.stream.mockResolvedValue(streamOf('x'));
        (mockAgent as any).getPendingToolInterrupts = vi
          .fn()
          .mockResolvedValueOnce([
            { name: 'run_shell_command', args: { command: 'terraform apply' } },
          ])
          .mockResolvedValueOnce([
            { name: 'run_shell_command', args: { command: 'terraform apply' } },
          ])
          .mockResolvedValueOnce([]);
        (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));

        const { config } = gateConfig({ mode: 'write' });
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'session' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);
        expect(human).toHaveBeenCalledTimes(1);
      });

      it('CONTROL: the allow entry alone approves without a prompt', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce('terraform apply');
        const { config } = gateConfig({
          mode: 'write',
          allow: [{ type: 'shell', matcher: 'exact', pattern: 'terraform apply' }],
        });
        await runner.init('code', config);
        const human = vi.fn();
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);
        expect(human).not.toHaveBeenCalled();
        expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
      });

      it('§6.2 — exits non-zero non-interactively, naming the entry rather than approvals.allow', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('terraform apply');
        const { config } = gateConfig({ mode: 'write', escalate: ESCALATE_TERRAFORM });
        await runner.init('code', config);
        // No approval callback — the CI / one-shot case.

        const error = await runner
          .processMessages([new HumanMessage('go')])
          .then(() => null)
          .catch((e: unknown) => e as Error);

        expect(error).toBeInstanceOf(NonInteractiveEscalationError);
        expect(error?.message).toContain('approvals.escalate');
        expect(error?.message).toContain('terraform apply');
        // It says the OPPOSITE of the ordinary escalation's advice: telling someone to declare the
        // command in approvals.allow would send them to a list that an escalate match outranks.
        expect(error?.message).toContain('no entry in approvals.allow can answer it');
        expect(error?.message).not.toContain('Declare the commands this run is allowed to execute');
      });

      it('CONTROL: an ordinary escalation still points the user at approvals.allow', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('terraform apply');
        const { config } = gateConfig({ mode: 'write' });
        await runner.init('code', config);

        const error = await runner
          .processMessages([new HumanMessage('go')])
          .then(() => null)
          .catch((e: unknown) => e as Error);

        expect(error).toBeInstanceOf(NonInteractiveEscalationError);
        expect(error?.message).toContain('Declare the commands this run is allowed to execute');
        expect(error?.message).not.toContain('approvals.escalate');
      });
    });

    /**
     * §3.2 — `rate` is honored at the rater rungs and **inert at every deterministic rung**: no
     * entry may smuggle a model call into `manual` or `write`.
     */
    describe('rate is inert at the deterministic rungs', () => {
      const RATED_ALLOW = [
        { type: 'shell', matcher: 'exact', pattern: 'npm test', rate: true },
      ] as unknown[];

      it.each(['manual', 'write'] as const)(
        'at %s an allow entry with rate:true approves with NO rating call',
        async (rung) => {
          const runner = new GthAgentRunner(statusUpdateCallback);
          const streamResume = pendingOnce('npm test');
          const { config, withStructuredOutput } = gateConfig({ mode: rung, allow: RATED_ALLOW });
          await runner.init('code', config);
          const human = vi.fn();
          runner.setToolApprovalCallback(human);

          await runner.processMessages([new HumanMessage('go')]);

          // The stub would have answered. It was never asked.
          expect(withStructuredOutput).not.toHaveBeenCalled();
          expect(human).not.toHaveBeenCalled();
          expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
        }
      );

      it('CONTROL: the SAME entry and command DO reach the rater at assisted', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('npm test');
        const { config, withStructuredOutput } = gateConfig({
          mode: 'assisted',
          allow: RATED_ALLOW,
        });
        await runner.init('code', config);
        runner.setToolApprovalCallback(vi.fn());

        await runner.processMessages([new HumanMessage('go')]);
        expect(withStructuredOutput).toHaveBeenCalledTimes(1);
      });

      it('§3.2 — rate:false on a glob entry suppresses the rating the default would have made', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('npm test --watch');
        const { config, withStructuredOutput } = gateConfig({
          mode: 'assisted',
          allow: [{ type: 'shell', matcher: 'glob', pattern: 'npm test*', rate: false }],
        });
        await runner.init('code', config);
        runner.setToolApprovalCallback(vi.fn());

        await runner.processMessages([new HumanMessage('go')]);
        expect(withStructuredOutput).not.toHaveBeenCalled();
      });

      it('CONTROL: the same glob entry WITHOUT rate:false is rated, per the §3.2 default', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('npm test --watch');
        const { config, withStructuredOutput } = gateConfig({
          mode: 'assisted',
          allow: [{ type: 'shell', matcher: 'glob', pattern: 'npm test*' }],
        });
        await runner.init('code', config);
        runner.setToolApprovalCallback(vi.fn());

        await runner.processMessages([new HumanMessage('go')]);
        expect(withStructuredOutput).toHaveBeenCalledTimes(1);
      });
    });

    /**
     * §3.2 — a rated allow match is a **TRIPWIRE, not a re-adjudication**. `safe` and `destructive`
     * both run; `attack` halts per §4.2; `catastrophic` escalates. The teeth are the last two: a
     * suite that exercised only the first two would pass on a gate that never consults the rater at
     * all.
     */
    describe('the allow-match tripwire', () => {
      const RATED_GLOB = [{ type: 'shell', matcher: 'glob', pattern: 'terraform *' }] as unknown[];

      it.each([
        ['safe', SAFE],
        ['destructive', DESTRUCTIVE],
      ] as const)('runs on %s, because the human already authorized it', async (_name, verdict) => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce('terraform destroy');
        const { config, withStructuredOutput } = gateConfig(
          { mode: 'assisted', allow: RATED_GLOB },
          verdict
        );
        await runner.init('code', config);
        const human = vi.fn();
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(withStructuredOutput).toHaveBeenCalledTimes(1); // it WAS rated
        expect(human).not.toHaveBeenCalled(); // and still ran
        expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
      });

      it('CONTROL: the same destructive verdict on an UNMATCHED command escalates', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('terraform destroy');
        const { config } = gateConfig({ mode: 'assisted' }, DESTRUCTIVE);
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);
        expect(human).toHaveBeenCalledTimes(1);
      });

      it('HALTS on attack — a standing grant does not answer a hostile structure', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('terraform destroy');
        const { config } = gateConfig({ mode: 'assisted', allow: RATED_GLOB }, ATTACK);
        await runner.init('code', config);
        runner.setToolApprovalCallback(vi.fn());

        const error = await runner
          .processMessages([new HumanMessage('go')])
          .then(() => null)
          .catch((e: unknown) => e as Error);

        expect(error).toBeInstanceOf(AttackHaltError);
        expect(error?.message).toContain('private key');
      });

      it('ESCALATES on catastrophic, carrying the verdict to the human', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('terraform destroy');
        const { config } = gateConfig({ mode: 'assisted', allow: RATED_GLOB }, CATASTROPHIC);
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(human).toHaveBeenCalledTimes(1);
        expect(human.mock.calls[0][0].safetyVerdict).toEqual(CATASTROPHIC);
      });

      /**
       * §4.6 — *"An allow match lifts this floor even when the entry keeps the rater involved: the
       * tripwire still sees the call; the floor does not apply to it."* This is the supported answer
       * to "won't this ask constantly" for a team that fetches from one internal host all day.
       */
      it('lifts the §4.6 open-world floor: a host-bearing command rated safe RUNS', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingOnce('curl https://internal.example.com/health');
        const { config, withStructuredOutput } = gateConfig(
          {
            mode: 'assisted',
            allow: [
              { type: 'shell', matcher: 'glob', pattern: 'curl https://internal.example.com*' },
            ],
          },
          SAFE
        );
        await runner.init('code', config);
        const human = vi.fn();
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(withStructuredOutput).toHaveBeenCalledTimes(1); // the tripwire saw it
        expect(human).not.toHaveBeenCalled(); // the floor did not apply
        expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
      });

      it('CONTROL: the same command and verdict WITHOUT an allow entry is floored and escalated', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingOnce('curl https://internal.example.com/health');
        const { config } = gateConfig({ mode: 'assisted' }, SAFE);
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        expect(human).toHaveBeenCalledTimes(1);
        // The §4.6 preflight's own words, not the rater's `safe`.
        expect(human.mock.calls[0][0].safetyVerdict.outcome).toBe('destructive');
        expect(human.mock.calls[0][0].safetyVerdict.reason).toContain('internal.example.com');
      });
    });
  });

  /**
   * [[EXT-103]] §4.2/§8 — **the floor is consulted before the human is, at the deterministic rungs
   * too.** "If the deterministic floor matches, the command is refused at execution regardless of
   * rating, rung, or approval — so it MUST NOT be negotiated and SHOULD NOT be escalated", because
   * *"asking a human to approve something that is then refused anyway teaches them their answer does
   * not count, which is worse than a flat refusal"*.
   *
   * §4.2 is a statement about the COMMAND, not about who was going to be asked about it, so
   * `manual` and `write` are the rungs where the harm is sharpest: they are the two a user picks in
   * order to read and answer every call themselves, and they are the two where a floored command
   * used to reach a person, be approved, and be refused at exec anyway.
   *
   * **The human here APPROVES.** A prompt answered `reject` would land on the same decision type the
   * floor produces, so a rejecting stub cannot tell the two apart — and the reported defect is
   * precisely that the human's *yes* did not count.
   */
  describe('[[EXT-103]] §4.2/§8 — a floored command is refused before anyone is asked', () => {
    /** On the floor at every rung. */
    const WIPE_ROOT = 'rm -rf /';
    /**
     * Off the floor, matched by no list, and therefore the most ordinary gated call there is: at a
     * deterministic rung it goes to the human, at a rated one it goes to the rater. That is what
     * makes it the control for BOTH counterparts.
     */
    const ORDINARY = 'npm test';

    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    /** One gated shell call, with the resume mock that carries what the gate decided about it. */
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

    /**
     * A rater stub that is **fully capable of answering, and answers `safe`** — deliberately
     * permissive. A floored command must be refused even where the rater would have waved it
     * through, and a stub that refused anyway could not tell whether the floor did the work.
     */
    function gateConfig(approvals: Record<string, unknown>) {
      const invoke = vi.fn().mockResolvedValue({ outcome: 'safe', reason: 'the stub says safe' });
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      return {
        withStructuredOutput,
        config: {
          ...mockConfig,
          llm: { withStructuredOutput } as any,
          streamOutput: true as const,
          approvals,
          commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
        } as unknown as GthConfig,
      };
    }

    /**
     * One gated call, driven end to end, with everything this block asserts separately handed back.
     * The human ANSWERS `approve`, which is what makes "refused" and "the model was told" say
     * something: a rejecting stub lands on the floor's own decision type and cannot tell the two
     * apart.
     *
     * `entries` adds declared approvals lists to the same config; `human: false` wires no approval
     * callback at all, which is the non-interactive caller (batch, CI) and the one shape where the
     * gate's answer is an error rather than a decision.
     */
    async function driveOne(
      rung: 'manual' | 'write' | 'assisted',
      command: string,
      options: { entries?: Record<string, unknown>; human?: false } = {}
    ) {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingOnce(command);
      const { config, withStructuredOutput } = gateConfig({ mode: rung, ...options.entries });
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
      if (options.human !== false) runner.setToolApprovalCallback(human);

      const error = await runner
        .processMessages([new HumanMessage('go')])
        .then(() => undefined)
        .catch((e: unknown) => e);

      return {
        human,
        withStructuredOutput,
        error,
        // Absent when the run ended before the graph was resumed — §6.2's non-interactive exit is
        // exactly that shape, so this cannot be typed as always present.
        decision: streamResume.mock.calls[0]?.[0].decisions[0] as
          { type: string; message?: string } | undefined,
      };
    }

    /**
     * The premise every case below rests on. Without it the control silently becomes a second copy
     * of the floored case the day a pattern is widened, and the block would keep passing while
     * asserting half of what it says.
     */
    it('the two commands sit on opposite sides of the floor', () => {
      expect(checkHardline(WIPE_ROOT), WIPE_ROOT).not.toBeNull();
      expect(checkHardline(ORDINARY), ORDINARY).toBeNull();
    });

    /**
     * **Four separate cases, not four assertions in one.** A single test stops at its first failed
     * expectation, so the three behind it would be claims nobody had ever seen fail — the
     * assertion-that-cannot-fail class this suite is written against.
     *
     * **`assisted` is in the list even though it was never the defect**, and it is not padding: at
     * the deterministic rungs "is NOT rated" is protected by two independent mechanisms — this
     * floor, and the rung gate on the rating call — so no single change to production can turn it
     * red there, and an assertion that survives every one-line mutation is one nobody has seen work.
     * At `assisted` the rung gate is open, so disabling the floor alone reaches the rater and the
     * same assertion falsifies. Being green at all three is also what says this is one rule about
     * the command rather than three rung-shaped special cases.
     */
    describe.each(['manual', 'write', 'assisted'] as const)('at %s', (rung) => {
      it('a floored command reaches NO human', async () => {
        const { human } = await driveOne(rung, WIPE_ROOT);
        expect(human).not.toHaveBeenCalled();
      });

      it('a floored command is NOT rated', async () => {
        const { withStructuredOutput } = await driveOne(rung, WIPE_ROOT);
        // The stub would have answered `safe`. It was never consulted.
        expect(withStructuredOutput).not.toHaveBeenCalled();
      });

      it('a floored command is refused, whatever the human would have said', async () => {
        const { decision } = await driveOne(rung, WIPE_ROOT);
        expect(decision?.type).toBe('reject');
      });

      it('the floor’s refusal reaches the agent', async () => {
        const { decision } = await driveOne(rung, WIPE_ROOT);
        // A refusal the model is not told about reads to it as the tool having silently failed.
        expect(decision?.message).toContain('blocked by hardline safety policy');
      });
    });

    /**
     * **The load-bearing control.** Without it this block is indistinguishable from a change that
     * suppressed approval prompts in general — a serious safety regression a green suite would not
     * catch — and "reaches NO human" above would be measuring the harness rather than the gate.
     *
     * The two deterministic rungs only: at `assisted` an ordinary command is settled by the rater
     * and reaches nobody, which is that rung's own control immediately below.
     */
    describe.each(['manual', 'write'] as const)('an ordinary command at %s', (rung) => {
      it('CONTROL: still reaches the human, and their answer decides it', async () => {
        const { human, decision } = await driveOne(rung, ORDINARY);
        expect(human).toHaveBeenCalledTimes(1);
        expect(human.mock.calls[0][0].args.command).toBe(ORDINARY);
        expect(decision?.type).toBe('approve');
      });
    });

    /**
     * The counterpart for "NOT rated": the SAME stub, reached. The rater has no call site at a
     * deterministic rung at all, so the proof that it is wired has to come from a rung that rates —
     * otherwise `not.toHaveBeenCalled()` would hold just as well for a config that never had one.
     */
    it('CONTROL: the same permissive rater stub IS reached at assisted', async () => {
      const { withStructuredOutput, human, decision } = await driveOne('assisted', ORDINARY);
      expect(withStructuredOutput).toHaveBeenCalledTimes(1);
      // …and its `safe` answer is what settled the call, so the stub was heard and not merely built.
      expect(human).not.toHaveBeenCalled();
      expect(decision?.type).toBe('approve');
    });

    /**
     * **The three routes this change closes at the deterministic rungs**, each of which used to
     * decide a floored command some other way: an allow entry approved it outright, an escalate
     * entry put it in front of a person, and a run with nobody to ask ended on it. All three follow
     * from where the floor now sits — above the escalate and allow branches, and before the
     * escalation — and all three were already the behaviour at the rated rungs.
     *
     * **They are pinned here because nothing else would notice them coming back.** A refactor that
     * moved the floor test back below the allow branch would leave every case above green: the
     * plain floored command has no entry to be approved by. The allow row is the sharpest of the
     * three — before this node an `approvals.allow` entry naming `rm -rf /` produced a silent,
     * session-scoped approval at `manual`, with no prompt and no rating, and only the execution-time
     * floor behind it.
     *
     * Each case is paired with a control that drives the SAME list against the non-floored command,
     * because "the entry did not decide the call" and "the entry was never wired" are the same green
     * otherwise.
     */
    describe.each(['manual', 'write'] as const)(
      'at %s the floor outranks every other route',
      (rung) => {
        const floorEntry = [{ type: 'shell', matcher: 'exact', pattern: WIPE_ROOT }] as unknown[];
        const ordinaryEntry = [{ type: 'shell', matcher: 'exact', pattern: ORDINARY }] as unknown[];

        it('an approvals.allow entry does not buy past it', async () => {
          const { human, withStructuredOutput, decision } = await driveOne(rung, WIPE_ROOT, {
            entries: { allow: floorEntry },
          });
          expect(decision?.type).toBe('reject');
          expect(decision?.message).toContain('blocked by hardline safety policy');
          expect(human).not.toHaveBeenCalled();
          expect(withStructuredOutput).not.toHaveBeenCalled();
        });

        it('CONTROL: that allow list is live — it approves the command it names', async () => {
          const { human, decision } = await driveOne(rung, ORDINARY, {
            entries: { allow: ordinaryEntry },
          });
          expect(human).not.toHaveBeenCalled();
          expect(decision?.type).toBe('approve');
        });

        it('an approvals.escalate entry does not send it to a person', async () => {
          const { human, decision } = await driveOne(rung, WIPE_ROOT, {
            entries: { escalate: floorEntry },
          });
          expect(human).not.toHaveBeenCalled();
          expect(decision?.type).toBe('reject');
          expect(decision?.message).toContain('blocked by hardline safety policy');
        });

        it('CONTROL: that escalate list is live — it names itself on the prompt it causes', async () => {
          const { human } = await driveOne(rung, ORDINARY, {
            entries: { escalate: ordinaryEntry },
          });
          expect(human).toHaveBeenCalledTimes(1);
          // Provenance, not merely a prompt: at these rungs an ordinary command would reach a person
          // anyway, so the entry firing is only visible in what the prompt says fired.
          expect(human.mock.calls[0][0].escalatedBy).toBe(ORDINARY);
        });

        it('a run with nobody to ask is refused rather than ended', async () => {
          const { error, decision } = await driveOne(rung, WIPE_ROOT, { human: false });
          expect(error).toBeUndefined();
          expect(decision?.type).toBe('reject');
          expect(decision?.message).toContain('blocked by hardline safety policy');
        });

        it('CONTROL: an ordinary command with nobody to ask still ends the run', async () => {
          const { error } = await driveOne(rung, ORDINARY, { human: false });
          expect(error).toBeInstanceOf(NonInteractiveEscalationError);
        });
      }
    );
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
      // rather than the rater (the default rung, `assisted`, rates).
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
        // [[TUI-C67]] — as above: the gate's own subject, attached to every interrupt a surface
        // is asked to render.
        subject: { kind: 'shell', command: 'ls -la' },
        grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "ls -la" }',
        grantSummary: 'ls -la',
        denyPreview: '{ "type": "shell", "matcher": "exact", "pattern": "ls -la" }',
        denySummary: 'ls -la',
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

  /**
   * EXT-70 §4.7.1/§4.7.5 — the subject a non-shell tool call presents, end to end through the
   * runner: config → `resolveApprovals` → the effective-annotation source → the rule matcher →
   * the decision.
   *
   * The fail-open this closes: every non-shell tool used to become a `kind: 'tool'` subject, which
   * is the TRUSTED provenance. So an MCP tool was matchable by `tool` entries and NOT by the
   * `mcpTool` entries a user wrote for it, and its own `tools/list` claims would have been read
   * verbatim. Both directions are asserted, each against a control that a degenerate gate — one
   * that approves everything, or refuses everything — would fail.
   */
  describe('MCP tool calls present as mcpTool subjects (EXT-70 §4.7.5)', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    /** Suspend the run once on a call to `toolName`, then complete. */
    function pendingToolOnce(toolName: string) {
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: toolName, args: {} }])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      return streamResume;
    }

    /** What the connected servers declared, exactly as `GthAbstractAgent` records it. */
    function declaring(entries: Record<string, Record<string, unknown>>) {
      (mockAgent as any).getDeclaredMcpToolAnnotations = vi
        .fn()
        .mockReturnValue(new Map(Object.entries(entries)));
    }

    function gateConfig(
      approvals: Record<string, unknown>,
      mcpServers: Record<string, unknown> = { jira: { url: 'https://example.invalid/mcp' } }
    ) {
      return {
        ...mockConfig,
        streamOutput: true as const,
        approvals,
        mcpServers,
      } as unknown as GthConfig;
    }

    /**
     * Drive one gated call and report whether the human was asked. It asserts the run really did
     * suspend and resume first — otherwise every "was not asked" here would pass on a run in which
     * no gated call ever happened.
     */
    async function askedTheHuman(config: GthConfig, toolName: string): Promise<boolean> {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingToolOnce(toolName);
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve' });
      runner.setToolApprovalCallback(human);
      await runner.processMessages([new HumanMessage('go')]);
      expect(streamResume).toHaveBeenCalledTimes(1);
      return human.mock.calls.length > 0;
    }

    beforeEach(() => {
      // Declarations are attached per test on the shared mock; drop any that leaked from the last.
      delete (mockAgent as any).getDeclaredMcpToolAnnotations;
    });

    it('an mcpTool deny entry refuses the call — it could not have matched a tool subject', async () => {
      // This is the assertion that would have caught the fail-open: with the call presenting as
      // `kind: 'tool'`, the user's own `mcpTool` deny entry would silently never have fired.
      const config = gateConfig({
        mode: 'write',
        deny: [{ type: 'mcpTool', server: 'jira', matcher: 'exact', pattern: 'delete_issue' }],
      });
      const runner = new GthAgentRunner(statusUpdateCallback);
      const streamResume = pendingToolOnce('mcp__jira__delete_issue');
      await runner.init('code', config);
      const human = vi.fn().mockResolvedValue({ type: 'approve' });
      runner.setToolApprovalCallback(human);

      await runner.processMessages([new HumanMessage('go')]);

      expect(human).not.toHaveBeenCalled();
      const decision = streamResume.mock.calls[0][0].decisions[0];
      expect(decision.type).toBe('reject');
      expect(decision.message).toContain('delete_issue');
    });

    it('a `tool` allow entry naming the MCP tool does NOT auto-approve it', async () => {
      // The other half of the same fail-open: a `tool` entry cannot claim an MCP subject, so the
      // user is still asked.
      const config = gateConfig({
        mode: 'write',
        allow: [{ type: 'tool', matcher: 'exact', pattern: 'mcp__jira__delete_issue' }],
      });
      expect(await askedTheHuman(config, 'mcp__jira__delete_issue')).toBe(true);
    });

    it('CONTROL: the same `tool` allow entry DOES auto-approve one of our own tools', async () => {
      // Without this the assertion above would pass on a gate that asks about everything.
      const config = gateConfig({
        mode: 'write',
        allow: [{ type: 'tool', matcher: 'exact', pattern: 'gth_web_fetch' }],
      });
      expect(await askedTheHuman(config, 'gth_web_fetch')).toBe(false);
    });

    it('a name no configured server explains stays an MCP subject and is still asked about', async () => {
      // Fail-closed, and specifically NOT `kind: 'tool'`: the `tool` allow entry below names it
      // exactly and still cannot claim it.
      const config = gateConfig({
        mode: 'write',
        allow: [{ type: 'tool', matcher: 'exact', pattern: 'mcp__ghost__delete' }],
      });
      expect(await askedTheHuman(config, 'mcp__ghost__delete')).toBe(true);
    });

    describe('the discriminating pair, end to end from config to decision', () => {
      /** A `hint` entry that exempts anything effectively read-only, for one server's tools. */
      const allowReadOnlyMcp = [
        { type: 'mcpTool', server: 'jira', matcher: 'hint', pattern: { readOnlyHint: true } },
      ];

      it('TRUSTED: the server’s own readOnlyHint declaration exempts its tool', async () => {
        declaring({ mcp__jira__search: { readOnlyHint: true } });
        const config = gateConfig({
          mode: 'write',
          allow: allowReadOnlyMcp,
          mcp: { servers: { jira: { trustAnnotations: ['readOnlyHint'] } } },
        });
        expect(await askedTheHuman(config, 'mcp__jira__search')).toBe(false);
      });

      it('UNTRUSTED: the very same declaration exempts nothing, and the human is asked', async () => {
        declaring({ mcp__jira__search: { readOnlyHint: true } });
        const config = gateConfig({
          mode: 'write',
          allow: allowReadOnlyMcp,
          mcp: { servers: { jira: { trustAnnotations: [] } } },
        });
        expect(await askedTheHuman(config, 'mcp__jira__search')).toBe(true);
      });

      it('CONTROL: one of OUR OWN read tools is exempted by the same hint with no trust list', async () => {
        // The built-in half: `gth_grep`'s authored `readOnlyHint: true` is read verbatim, so an
        // annotation-driven allow entry exempts it where the identical MCP claim does not.
        const config = gateConfig({
          mode: 'write',
          allow: [{ type: 'tool', matcher: 'hint', pattern: { readOnlyHint: true } }],
        });
        expect(await askedTheHuman(config, 'gth_grep')).toBe(false);
      });

      /**
       * Driven at `manual` rather than `write`, because [[EXT-80]] makes `write` grant the write
       * built-ins outright: at that rung `write_file` is not gated at all, so "the hint did not
       * exempt it" would be answered by the rung and not by the matcher. `manual` is where the
       * question is still the matcher's.
       */
      it('CONTROL: a built-in that WRITES is not exempted by that hint', async () => {
        const config = gateConfig({
          mode: 'manual',
          allow: [{ type: 'tool', matcher: 'hint', pattern: { readOnlyHint: true } }],
        });
        expect(await askedTheHuman(config, 'write_file')).toBe(true);
      });
    });

    describe('§4.7.3 — an open-world read is not a local read', () => {
      const allowLocalRead = [
        {
          type: 'tool',
          matcher: 'hint',
          pattern: { readOnlyHint: true, openWorldHint: false },
        },
      ];

      const localReadConfig = () => gateConfig({ mode: 'write', allow: allowLocalRead });

      it('gth_web_fetch is NOT exempted by a local-read hint entry', async () => {
        expect(await askedTheHuman(localReadConfig(), 'gth_web_fetch')).toBe(true);
      });

      it('CONTROL: gth_grep IS exempted by that very entry', async () => {
        expect(await askedTheHuman(localReadConfig(), 'gth_grep')).toBe(false);
      });
    });

    /**
     * EXT-70 §4.7.2/§4.7.3 — an effective `openWorldHint` floors the call at `destructive`, through
     * the SAME `applyDestructiveFloor` the shell path reaches via `mapVerdictToAction`.
     *
     * **What is observable today, stated so these assertions are not read as more than they are.**
     * No ACTION changes under the current gate: the rater is shell-only (§4.3), an allow match
     * returns before the floor, and `bypass` plus the two deterministic rungs never reach it — so
     * every call that is floored here was already going to the human. What the floor supplies is
     * the verdict that call carries: onto the approval prompt (§6) and into the §6.2 non-interactive
     * exit. [[EXT-30]], which rates tool calls, is what makes it decide an action.
     */
    describe('§4.7.3 — an effective openWorldHint floors the call at destructive', () => {
      /** The reason the ONE floor produces, read from its own builder rather than re-spelt here. */
      const FLOOR_REASON = openWorldToolFloorReason(MCP_FAIL_CLOSED_ANNOTATIONS);

      /** Every hint believed, so a declaration can state an arbitrary combination and be read. */
      const trustingJira = {
        servers: {
          jira: {
            trustAnnotations: [
              'readOnlyHint',
              'destructiveHint',
              'idempotentHint',
              'openWorldHint',
            ],
          },
        },
      };

      /**
       * Drive one gated call and hand back what the human was shown — or `null` when nothing asked.
       * Asserts the run really did suspend and resume, so a "was not floored" can never pass on a
       * run in which no gated call happened at all.
       */
      async function shownToTheHuman(
        config: GthConfig,
        toolName: string
      ): Promise<PendingToolInterrupt | null> {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingToolOnce(toolName);
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'approve' });
        runner.setToolApprovalCallback(human);
        await runner.processMessages([new HumanMessage('go')]);
        expect(streamResume).toHaveBeenCalledTimes(1);
        return human.mock.calls.length > 0
          ? (human.mock.calls[0][0] as PendingToolInterrupt)
          : null;
      }

      /**
       * The verdict the floor produces for a call on `toolName`, or `undefined` when it does not
       * floor — **re-derived through the runner's own composition rather than through a run.**
       *
       * [[EXT-80]] is why this is not driven through `processMessages` any more. The floor lives in
       * the `subject.kind !== 'shell'` arm, which is entered only at a RATED rung; and at a rated
       * rung nothing but the shell is gated, so a non-shell call never reaches it — the runner now
       * approves it on arrival, and gating it there would turn every MCP call at the default rung
       * into a human prompt with no rating (which is [[EXT-30]]'s change to make, not this one's).
       * The two sets are disjoint by construction, so an end-to-end drive of THIS arm is only
       * possible for a malformed `run_shell_command`, asserted in its own block below.
       *
       * What is asserted here is unchanged: the same three functions the runner calls, in the same
       * order, over the same declared/trust inputs — so every discriminating pair below still
       * discriminates on exactly the values it names.
       */
      function floorVerdictFor(config: GthConfig, toolName: string) {
        const source = createEffectiveToolAnnotationSource({
          mcp: resolveApprovals(config, 'code').mcp,
          declared: {
            builtIn: builtInToolAnnotations,
            mcp: mcpDeclaredAnnotationLookup((mockAgent as any).getDeclaredMcpToolAnnotations?.()),
          },
        });
        const subject = approvalSubjectForToolName(
          toolName,
          Object.keys((config as { mcpServers?: object }).mcpServers ?? {})
        );
        return applyDestructiveFloor(undefined, openWorldToolFloorReason(source(subject)));
      }

      const rated = (extra: Record<string, unknown> = {}) =>
        gateConfig({ mode: 'assisted', ...extra });

      /**
       * The discriminating pair for §4.7.3, on OUR OWN tools so no trust question is in play.
       * `readOnlyHint` is `true` on both sides — only `openWorldHint` differs — so a gate that
       * floored on `readOnlyHint`, or floored everything, or floored nothing, fails one half.
       */
      it('gth_web_fetch is floored at destructive DESPITE being readOnlyHint true', () => {
        const verdict = floorVerdictFor(rated(), 'gth_web_fetch');
        expect(verdict?.outcome).toBe('destructive');
        // Compared against the floor's own reason builder, not against a copy of the sentence: a
        // second floor written inline at this call site would say something else and fail here.
        expect(verdict?.reason).toBe(FLOOR_REASON);
        expect(verdict?.reason).not.toContain(COULD_NOT_ASSESS_PREFIX);
      });

      it('CONTROL: gth_grep — the same readOnlyHint, no open world — is NOT floored', () => {
        expect(floorVerdictFor(rated(), 'gth_grep')).toBeUndefined();
      });

      /**
       * The pair that proves the floor reads EFFECTIVE values and not declared ones. Both servers
       * declare `openWorldHint: false`; only the trusted one is believed.
       */
      it('an UNTRUSTED server declaring openWorldHint false is still floored', () => {
        declaring({ mcp__jira__search: { readOnlyHint: true, openWorldHint: false } });
        const config = rated({ mcp: { servers: { jira: { trustAnnotations: [] } } } });
        expect(floorVerdictFor(config, 'mcp__jira__search')?.outcome).toBe('destructive');
      });

      it('CONTROL: the very same declaration from a TRUSTED server is not floored', () => {
        declaring({ mcp__jira__search: { readOnlyHint: true, openWorldHint: false } });
        const config = rated({
          mcp: { servers: { jira: { trustAnnotations: ['openWorldHint'] } } },
        });
        expect(floorVerdictFor(config, 'mcp__jira__search')).toBeUndefined();
      });

      /**
       * §4.7.2 — `idempotentHint` has NO built-in consumer. On its own "the outcome is unchanged"
       * passes on a harness that cannot detect any change at all, so the CONTROL is in the same
       * test: flipping a DIFFERENT hint in the very same declaration does move the outcome.
       */
      it('idempotentHint changes no outcome — CONTROL: openWorldHint does', async () => {
        const decide = (declaration: Record<string, unknown>) => {
          declaring({ mcp__jira__search: declaration });
          return floorVerdictFor(rated({ mcp: trustingJira }), 'mcp__jira__search');
        };
        const local = { readOnlyHint: true, openWorldHint: false };
        const idempotent = await decide({ ...local, idempotentHint: true });
        const notIdempotent = await decide({ ...local, idempotentHint: false });
        expect(idempotent).toEqual(notIdempotent);
        expect(idempotent, 'neither is floored').toBeUndefined();

        const openWorld = await decide({ ...local, openWorldHint: true, idempotentHint: false });
        expect(openWorld, 'the harness CAN see an outcome change').not.toEqual(notIdempotent);
        expect(openWorld?.outcome).toBe('destructive');
      });

      /**
       * §4.7.2 — `destructiveHint` may only ever RAISE: it can decide that a tool is rated or
       * floored, never that it is exempt.
       */
      it('destructiveHint false does NOT lower a floor openWorldHint set', () => {
        declaring({
          mcp__jira__search: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        });
        const config = rated({ mcp: trustingJira });
        expect(floorVerdictFor(config, 'mcp__jira__search')?.outcome).toBe('destructive');
      });

      /**
       * Driven at `manual`, where an MCP call is gated, because that is where "the human is
       * still asked" is a claim about the gate rather than about a fabricated arrival. The floor
       * itself does not apply at a deterministic rung (there is no rating to floor), which is the
       * second half of what this asserts: `destructiveHint` is not the rule that floors.
       */
      it('destructiveHint true never buys an exemption', async () => {
        declaring({
          mcp__jira__wipe: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        });
        const config = gateConfig({ mode: 'manual', mcp: trustingJira });
        const pending = await shownToTheHuman(config, 'mcp__jira__wipe');
        expect(pending, 'the human is still asked').not.toBeNull();
        expect(pending?.safetyVerdict).toBeUndefined();
        // ...and the floor, asked directly, agrees it is not the hint that floors.
        expect(floorVerdictFor(config, 'mcp__jira__wipe')).toBeUndefined();
      });

      it('CONTROL: the harness CAN exempt — an allow entry approves that very call', async () => {
        declaring({
          mcp__jira__wipe: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        });
        const config = gateConfig({
          mode: 'manual',
          allow: [{ type: 'mcpTool', server: 'jira', matcher: 'exact', pattern: 'wipe' }],
          mcp: trustingJira,
        });
        expect(await shownToTheHuman(config, 'mcp__jira__wipe')).toBeNull();
      });

      /**
       * §4.6's fourth bullet, unchanged for tools: the allow-list is consulted BEFORE the rater and
       * therefore before this floor, and lifts it — including where the entry carries `rate: true`.
       *
       * **The `rate: true` case matches the shell on the floor and NOT on the tripwire, and the
       * second test's name says only the first.** §4.6 pairs floor-lifting with the rating still
       * seeing the call, but step (4) short-circuits to approve for a non-shell subject, so no
       * tripwire runs for a tool. That half does not exist while §4.3 keeps the rater on the shell;
       * [[EXT-30]] is what brings it, and asserting it here would be asserting a wish.
       */
      it('an allow entry approves an open-world tool without asking', async () => {
        const config = gateConfig({
          mode: 'manual',
          allow: [{ type: 'tool', matcher: 'exact', pattern: 'gth_web_fetch' }],
        });
        expect(await shownToTheHuman(config, 'gth_web_fetch')).toBeNull();
      });

      it('and approves it just the same when the allow entry sets rate true', async () => {
        const config = gateConfig({
          mode: 'manual',
          allow: [{ type: 'tool', matcher: 'exact', pattern: 'gth_web_fetch', rate: true }],
        });
        expect(await shownToTheHuman(config, 'gth_web_fetch')).toBeNull();
      });

      /**
       * CONTROL for both cells above, and it is not optional: they are driven at `manual`, where
       * the human is asked by default, so without this the pair would pass on a harness that never
       * asked anyone. It is the ENTRY that exempts, and nothing else.
       */
      it('CONTROL: the same tool with no allow entry IS asked about', async () => {
        expect(
          await shownToTheHuman(gateConfig({ mode: 'manual' }), 'gth_web_fetch')
        ).not.toBeNull();
      });

      /**
       * §6.2 — where no human can answer, the floored verdict is what the process exits with. This
       * is the second of the two places the floor is observable today, and the one a CI run reads.
       */
      /**
       * §6.2 — where no human can answer, a gated tool call ENDS the run non-zero rather than
       * hanging. Driven at `manual`, the rung at which such a call is gated; the floored VERDICT
       * riding that exit is asserted on the one shape that still reaches the floor, in the
       * malformed-`run_shell_command` block below.
       */
      it('with no human, a gated tool call exits the run', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pendingToolOnce('gth_web_fetch');
        await runner.init('code', gateConfig({ mode: 'manual' }));
        // No approval callback at all — CI, a one-shot run, a server.

        const error = (await runner
          .processMessages([new HumanMessage('go')])
          .then(() => null)
          .catch((e: unknown) => e as Error)) as NonInteractiveEscalationError | null;

        expect(error).toBeInstanceOf(NonInteractiveEscalationError);
        expect(error?.message).toContain('gth_web_fetch');
      });

      /**
       * The floor applies exactly where the shell's preflights apply — at the two RATED rungs — and
       * for the same reason: `mapVerdictToAction` returns at `bypass` and at the deterministic
       * rungs before any preflight runs, because there is no rating there to floor. The call is
       * asked about at every one of these rungs either way, so nothing is less gated below.
       */
      it.each(['assisted', 'auto'] as const)(
        'the floor itself is rung-independent — it produces the same verdict at %s',
        (mode) => {
          // The floor is a property of the ANNOTATIONS, not of the rung; which rungs can reach it
          // is the runner's business, asserted in `approvalRungTransition.spec.ts` and in the
          // malformed-`run_shell_command` block below.
          const verdict = floorVerdictFor(gateConfig({ mode }), 'gth_web_fetch');
          expect(verdict?.outcome).toBe('destructive');
          expect(verdict?.reason).toBe(FLOOR_REASON);
        }
      );

      it.each(['manual', 'write'] as const)(
        'at %s there is no rating to floor, and the human is asked regardless',
        async (mode) => {
          const pending = await shownToTheHuman(gateConfig({ mode }), 'gth_web_fetch');
          expect(pending, 'still gated').not.toBeNull();
          expect(pending?.safetyVerdict).toBeUndefined();
        }
      );

      /**
       * **The path on which this floor is reachable under today's gate**, and the reason the
       * rest of this block is not merely a rehearsal for [[EXT-30]].
       *
       * `run_shell_command` is the only tool either backend puts in `interruptOn`, so it is the
       * only call that suspends. When the model emits it with a MISSING or non-string `command`
       * there is nothing to rate: `isShellCommand` is false, the call presents as a `tool` subject
       * named `run_shell_command`, and — since that name is deliberately absent from our authored
       * annotation table — its effective set is the fail-closed one, whose `openWorldHint` is true.
       * So the tool arm floors it.
       *
       * That is the fail-closed direction and it is correct: a shell call whose command we cannot
       * even read is not a call anything can say something reassuring about. The ACTION is
       * unchanged — it escalated before this floor existed and it escalates now — so what these
       * assertions pin is the VERDICT the human and the §6.2 exit carry.
       */
      describe('a malformed run_shell_command reaches the tool arm', () => {
        const RATER_SAID = 'the rater was consulted';

        /**
         * A rated rung whose rater would answer `outcome`. Supplied so "floored" can be told
         * apart from "the rater happened to say destructive" — the floor's own reason is compared
         * by equality below, and the rater's is a different sentence.
         */
        function shellGateConfig(approvals: Record<string, unknown>, outcome: string) {
          const invoke = vi.fn().mockResolvedValue({ outcome, reason: RATER_SAID });
          const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
          const config = {
            ...mockConfig,
            llm: { withStructuredOutput } as any,
            streamOutput: true as const,
            approvals,
            commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
          } as unknown as GthConfig;
          return { config, withStructuredOutput };
        }

        /** Suspend once on `run_shell_command` carrying exactly these args, then complete. */
        function pendingShellOnce(args: Record<string, unknown>) {
          (mockAgent as any).getPendingToolInterrupts = vi
            .fn()
            .mockResolvedValueOnce([{ name: 'run_shell_command', args }])
            .mockResolvedValueOnce([]);
          const streamResume = vi.fn().mockResolvedValue(streamOf(''));
          (mockAgent as any).streamResume = streamResume;
          mockAgent.stream.mockResolvedValue(streamOf('x'));
          return streamResume;
        }

        /** Drive one gated shell call; report what the human saw and whether the rater ran. */
        async function decideOn(
          args: Record<string, unknown>,
          approvals: Record<string, unknown> = { mode: 'assisted' },
          outcome = 'safe'
        ) {
          const { config, withStructuredOutput } = shellGateConfig(approvals, outcome);
          const runner = new GthAgentRunner(statusUpdateCallback);
          const streamResume = pendingShellOnce(args);
          await runner.init('code', config);
          const human = vi.fn().mockResolvedValue({ type: 'approve' });
          runner.setToolApprovalCallback(human);
          await runner.processMessages([new HumanMessage('go')]);
          expect(streamResume).toHaveBeenCalledTimes(1);
          return {
            pending:
              human.mock.calls.length > 0 ? (human.mock.calls[0][0] as PendingToolInterrupt) : null,
            raterRan: withStructuredOutput.mock.calls.length > 0,
          };
        }

        it.each([
          ['no command argument at all', {}],
          ['a non-string command argument', { command: 42 }],
          ['a null command argument', { command: null }],
        ])('%s — floored as a tool, with no rating call', async (_label, args) => {
          const { pending, raterRan } = await decideOn(args);
          expect(pending, 'the human is still asked').not.toBeNull();
          expect(raterRan, 'there is no command to rate, so nothing rated it').toBe(false);
          expect(pending?.safetyVerdict?.outcome).toBe('destructive');
          // Equality against the floor's own builder: a rater verdict, or a second floor written
          // inline, would say something else.
          expect(pending?.safetyVerdict?.reason).toBe(FLOOR_REASON);
        });

        /**
         * The control that makes the pair discriminating: the SAME tool at the SAME rung, and only
         * the argument differs. Without it every assertion above passes on a gate that floors
         * every `run_shell_command`.
         */
        it('CONTROL: the very same tool WITH a string command is rated, not floored', async () => {
          const { pending, raterRan } = await decideOn({ command: 'ls -la' });
          expect(raterRan, 'the shell arm consulted the rater').toBe(true);
          expect(pending, 'a `safe` command runs without asking').toBeNull();
        });

        it('CONTROL: a rated malformed call carries the FLOOR reason, never the rater’s', async () => {
          // The rater would have said `destructive` too, so outcome alone cannot tell the two
          // apart — the reason can, and it is the floor's.
          const { pending } = await decideOn({}, { mode: 'assisted' }, 'destructive');
          expect(pending?.safetyVerdict?.reason).not.toContain(RATER_SAID);
          expect(pending?.safetyVerdict?.reason).toBe(FLOOR_REASON);
        });

        it('CONTROL: at an unrated rung the same malformed call carries no verdict', async () => {
          const { pending } = await decideOn({}, { mode: 'write' });
          expect(pending, 'still gated').not.toBeNull();
          expect(pending?.safetyVerdict).toBeUndefined();
        });
      });
    });
  });

  /**
   * EXT-70 — **the non-shell corpus, driven through the real decision path**, and an EXPIRY-DATED
   * pin on where that path stops today.
   *
   * `spec-fixtures/approvals-tool-corpus.json` is the other half of the approvals corpus: an
   * innocuous tool NAME carrying hostile ARGUMENTS. `approvalsToolCorpus.spec.ts` asserts the two
   * halves of §3.2 over it as pure functions — the entry matches on identity and arms the tripwire
   * (`rate: true`), and the tripwire mapping turns each labelled outcome into run / escalate / halt.
   *
   * **This block asserts what the runner actually does with those same cases, which is less.** §4.3
   * scopes the rater's first implementation to the shell, so `decideToolApproval` short-circuits on
   * `!isShellCommand`: a rated allow-match on a tool subject approves with **no rating call at
   * all**, hostile arguments and benign ones alike. Nothing here is a defect of this node — it is
   * [[EXT-30]]'s scope, and the ledger records it — but it has to be a TEST rather than a sentence,
   * because the alternative is a corpus of hostile calls that nothing in production ever looks at
   * and no one notices.
   *
   * **When [[EXT-30]] routes tool calls into the tripwire, these assertions go red — that is their
   * purpose.** Replace them with the consequence assertions in `approvalsToolCorpus.spec.ts`:
   * `tc-01`/`tc-02`/`tc-03`/`tc-10` must then HALT, `tc-04`/`tc-05` must escalate, and the `run`
   * cases must still run.
   */
  describe('the non-shell corpus reaches the gate (EXT-70 §3.2, §4.3)', () => {
    /** Only the fields this block reads are modelled; the fixture's own spec models the rest. */
    interface ToolCorpusCase {
      id: string;
      subject: 'tool' | 'mcpTool';
      server?: string;
      tool: string;
      arguments: Record<string, unknown>;
      outcome: string;
      tripwire: string;
    }

    /** Resolved RELATIVE TO THIS FILE — never from `process.cwd()`, never a POSIX path literal. */
    const TOOL_CORPUS: { cases: ToolCorpusCase[] } = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../../spec-fixtures/approvals-tool-corpus.json', import.meta.url)
        ),
        'utf8'
      )
    );

    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    /** Suspend the run once on this call — the tool's registered name AND its arguments. */
    function pendingToolOnce(toolName: string, args: Record<string, unknown>) {
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([{ name: toolName, args }])
        .mockResolvedValueOnce([]);
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      return streamResume;
    }

    /**
     * A rated rung (`assisted`) whose allow list holds the one entry a user could write for this
     * call: its IDENTITY, which is all §3.1 lets a tool entry record. The rater model is a spy that
     * would answer `attack` — so "no rating call" below is a fact about the gate and not about a
     * model that had nothing to say.
     */
    function gateFor(corpusCase: ToolCorpusCase) {
      const invoke = vi.fn().mockResolvedValue({ outcome: 'attack', reason: 'hostile arguments' });
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      const entry =
        corpusCase.subject === 'mcpTool'
          ? {
              type: 'mcpTool',
              server: corpusCase.server,
              matcher: 'exact',
              pattern: corpusCase.tool,
            }
          : { type: 'tool', matcher: 'exact', pattern: corpusCase.tool };
      const config = {
        ...mockConfig,
        llm: { withStructuredOutput } as any,
        streamOutput: true as const,
        approvals: { mode: 'assisted', allow: [entry] },
        ...(corpusCase.server === undefined
          ? {}
          : { mcpServers: { [corpusCase.server]: { url: 'https://example.invalid/mcp' } } }),
      } as unknown as GthConfig;
      return { config, withStructuredOutput };
    }

    const registeredName = (corpusCase: ToolCorpusCase) =>
      corpusCase.subject === 'mcpTool'
        ? mcpToolRegisteredName(corpusCase.server ?? '', corpusCase.tool)
        : corpusCase.tool;

    const ROWS = TOOL_CORPUS.cases.map((corpusCase) => [corpusCase.id, corpusCase] as const);

    it('reads a fixture with hostile-argument cases in it (a wrong path must fail loudly)', () => {
      expect(TOOL_CORPUS.cases.length).toBeGreaterThan(0);
      // Both directions must be present, or the indiscriminate approval below proves nothing.
      expect(TOOL_CORPUS.cases.filter((c) => c.tripwire === 'halt').length).toBeGreaterThan(0);
      expect(TOOL_CORPUS.cases.filter((c) => c.tripwire === 'run').length).toBeGreaterThan(0);
    });

    it.each(ROWS)(
      '%s: the identity entry approves it with NO rating call (EXT-30 turns this red)',
      async (_id, corpusCase) => {
        const { config, withStructuredOutput } = gateFor(corpusCase);
        const runner = new GthAgentRunner(statusUpdateCallback);
        const streamResume = pendingToolOnce(registeredName(corpusCase), corpusCase.arguments);
        await runner.init('code', config);
        const human = vi.fn().mockResolvedValue({ type: 'approve' });
        runner.setToolApprovalCallback(human);

        await runner.processMessages([new HumanMessage('go')]);

        // The run really did suspend on this call — otherwise everything below passes vacuously.
        expect(streamResume).toHaveBeenCalledTimes(1);
        expect(streamResume.mock.calls[0][0].decisions[0].type).toBe('approve');
        expect(human, 'the allow match settled the human’s part').not.toHaveBeenCalled();
        // §4.3's scope boundary, stated as the measurement it is: the arguments never reached a
        // rater, so the `rate: true` this entry carries buys nothing yet.
        expect(
          withStructuredOutput,
          'no rating call on a tool subject today'
        ).not.toHaveBeenCalled();
      }
    );

    /**
     * The CONTROL, and the thing that makes the block above a boundary rather than an inability to
     * see a rating: the identical rung and the identical harness DO consult the rater when the
     * subject is a shell command, and the tripwire then halts on `attack`.
     */
    it('CONTROL: the same rung and harness DO rate an allow-matched SHELL call, and halt it', async () => {
      const invoke = vi.fn().mockResolvedValue({ outcome: 'attack', reason: 'hostile arguments' });
      const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
      const config = {
        ...mockConfig,
        llm: { withStructuredOutput } as any,
        streamOutput: true as const,
        approvals: {
          mode: 'assisted',
          allow: [{ type: 'shell', matcher: 'glob', pattern: 'curl *' }],
        },
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as unknown as GthConfig;
      const runner = new GthAgentRunner(statusUpdateCallback);
      (mockAgent as any).getPendingToolInterrupts = vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'run_shell_command', args: { command: 'curl https://registry.npmjs.ag/lodash' } },
        ])
        .mockResolvedValueOnce([]);
      (mockAgent as any).streamResume = vi.fn().mockResolvedValue(streamOf(''));
      mockAgent.stream.mockResolvedValue(streamOf('x'));
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn());

      const error = await runner
        .processMessages([new HumanMessage('go')])
        .then(() => null)
        .catch((e: unknown) => e as Error);

      expect(withStructuredOutput, 'the shell arm rated it').toHaveBeenCalled();
      expect(error, 'and the tripwire halted on attack').toBeInstanceOf(AttackHaltError);
    });
  });

  /**
   * EXT-70 §4.7.4 — **sticky grants on tool calls**, end to end through the runner: what the menu
   * says it will store, what it stores, what that grant then covers, and what withdraws it.
   *
   * Everything here drives real gated calls and reads the human prompt, because the question is
   * never "is the right object in the store" but "does the next call still ask". A test that
   * inspected the store would pass against a store holding exactly the right entries and a gate that
   * consulted them wrongly.
   */
  describe('sticky tool grants and annotation weakening (EXT-70 §4.7.4)', () => {
    function streamOf(...chunks: string[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    interface GatedCall {
      name: string;
      args?: Record<string, unknown>;
      /** What the connected servers declare for THIS call, if it should change between calls. */
      declaring?: Record<string, Record<string, unknown>>;
      /**
       * EXT-70 — run against the LIVE runner immediately before this call is decided. It is how a
       * mid-session `/approvals trust|untrust` is driven: the user's trust change has to land
       * between two calls on ONE runner, because what it does to a grant made under the old trust
       * is the whole question.
       */
      before?: (_runner: GthAgentRunner) => void;
    }

    function toolConfig(approvals: Record<string, unknown>) {
      return {
        ...mockConfig,
        streamOutput: true as const,
        approvals,
        mcpServers: {
          jira: { url: 'https://example.invalid/mcp' },
          gitlab: { url: 'https://example.invalid/gl' },
        },
      } as unknown as GthConfig;
    }

    /**
     * Drive a SEQUENCE of gated calls on ONE runner, answering every prompt with `answer`, and hand
     * back what the human was shown each time (`null` where they were not asked).
     *
     * A sequence rather than one call because every assertion in this block is about the SECOND
     * call: whether the first one's grant still covers it. The run is asserted to have suspended and
     * resumed once per call, so a "was not asked" can never pass on a run in which nothing was gated.
     */
    async function driveCalls(
      config: GthConfig,
      calls: readonly GatedCall[],
      answer: Record<string, unknown> = { type: 'approve', scope: 'session' }
    ): Promise<(PendingToolInterrupt | null)[]> {
      // The call currently being decided. Every prompt is attributed to it by INDEX rather than by
      // matching on the tool name: these sequences deliberately repeat one tool, so a name-based
      // attribution would happily map the third call's prompt onto the second call and turn a
      // "was not asked" into a pass.
      let index = -1;
      // Assigned below, before any interrupt is polled; the hook cannot run earlier than that.
      let runner: GthAgentRunner;
      const pending = vi.fn(async () => {
        index += 1;
        const call = calls[index];
        if (call?.before) call.before(runner);
        return call ? [{ name: call.name, args: call.args ?? {} }] : [];
      });
      // **Every connected server declares, not just the one being called.** The production accessor
      // reports what all registered tools declare, so the map accumulates every declaration made up
      // to and including the current call, later declarations of the SAME tool winning — which is
      // how a sequence still models a tool that changes what it says about itself between calls.
      //
      // Two things depend on it. An accessor called AFTER the run (a `/approvals` display, a trust
      // change) reads the whole set rather than an empty map, so a held grant is not read as though
      // its server had withdrawn every annotation it ever made. And in a sequence that touches TWO
      // servers, the first server goes on declaring after the second one's call — without that, its
      // grant reads as maximally weakened whatever the user's trust says, and any assertion about
      // WHY it was invalidated passes for the wrong reason.
      const declared = vi.fn(() => {
        const map = new Map<string, Record<string, unknown>>();
        for (const call of calls.slice(0, Math.min(index + 1, calls.length))) {
          for (const [name, annotations] of Object.entries(call.declaring ?? {})) {
            map.set(name, annotations);
          }
        }
        return map;
      });
      (mockAgent as any).getPendingToolInterrupts = pending;
      (mockAgent as any).getDeclaredMcpToolAnnotations = declared;
      const streamResume = vi.fn().mockResolvedValue(streamOf(''));
      (mockAgent as any).streamResume = streamResume;
      mockAgent.stream.mockResolvedValue(streamOf('x'));

      const byCall: (PendingToolInterrupt | null)[] = calls.map(() => null);
      runner = new GthAgentRunner(statusUpdateCallback);
      await runner.init('code', config);
      const human = vi.fn(async (prompt: PendingToolInterrupt) => {
        byCall[index] = prompt;
        return answer;
      });
      runner.setToolApprovalCallback(human as never);
      await runner.processMessages([new HumanMessage('go')]);

      expect(streamResume).toHaveBeenCalledTimes(calls.length);
      return byCall;
    }

    /** The warnings the runner emitted, for the invalidation notice. */
    const warningsSaid = () =>
      statusUpdateCallback.mock.calls.map(([, message]) => String(message)).join('\n');

    /**
     * **What every "nothing was withdrawn" assertion below anchors on.** The notice's prose is not
     * pinned by anything, so a negative keyed on a phrase from it (*"was removed"*) goes vacuous the
     * moment someone rewords the message — and every such negative in this block would go vacuous
     * together, silently. This is the one fragment the notice cannot be reworded out of, because
     * `describeWeakenedGrant` renders it with this very function: the grant it withdrew. Nothing
     * else the runner reports about an auto-approved call renders an entry, so its presence means an
     * invalidation and its absence means none.
     */
    const jiraSearchGrantLine = describeApprovalEntry({
      type: 'mcpTool',
      server: 'jira',
      matcher: 'exact',
      pattern: 'search',
    });

    afterEach(() => {
      delete (mockAgent as any).getDeclaredMcpToolAnnotations;
    });

    describe('what the menu says it will store (§6)', () => {
      it('names the tool and the host, in the form the user would write in config', async () => {
        const [first] = await driveCalls(toolConfig({ mode: 'write' }), [
          { name: 'gth_web_fetch', args: { input: 'https://docs.internal.example/guide' } },
        ]);
        expect(first?.grantPreview).toBe(
          '{ "type": "tool", "matcher": "exact", "pattern": "gth_web_fetch", "host": "docs.internal.example" }'
        );
      });

      it('names the server for an MCP tool, and no host where none is involved', async () => {
        const [first] = await driveCalls(toolConfig({ mode: 'write' }), [
          { name: 'mcp__jira__create_issue', args: { summary: 'a bug' } },
        ]);
        // §6's own example: *always approve mcp__jira__create_issue*, where no host is involved.
        expect(first?.grantPreview).toBe(
          '{ "type": "mcpTool", "server": "jira", "matcher": "exact", "pattern": "create_issue" }'
        );
      });
    });

    /**
     * §4.7.4's bound, on the live gate. Both halves, because the first alone passes on a grant that
     * ignores the host and the second alone passes on a grant that matches nothing.
     */
    describe('a tool+host grant binds to that host', () => {
      const fetchArgs = (url: string) => ({ input: url });

      it('auto-approves the SAME host and PROMPTS for a different one', async () => {
        const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
          { name: 'gth_web_fetch', args: fetchArgs('https://docs.internal.example/a') },
          { name: 'gth_web_fetch', args: fetchArgs('https://docs.internal.example/b') },
          { name: 'gth_web_fetch', args: fetchArgs('https://evil.example/c') },
        ]);
        expect(prompts[0], 'the first call asks').not.toBeNull();
        expect(prompts[1], 'the same host is covered by the grant').toBeNull();
        expect(prompts[2], 'a different host is not').not.toBeNull();
      });

      it('and a later call carrying NO host is not covered either', async () => {
        const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
          { name: 'gth_web_fetch', args: fetchArgs('https://docs.internal.example/a') },
          { name: 'gth_web_fetch', args: { input: 'not a url' } },
        ]);
        expect(prompts[1]).not.toBeNull();
      });
    });

    /**
     * §4.7.5 — the server key is what a grant is bound to, so one server's grant can never be
     * claimed by another server's same-named tool. The control is the same tool on the same server.
     */
    it('a grant for one server’s tool never covers another server’s same-named tool', async () => {
      const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
        { name: 'mcp__jira__delete_issue' },
        { name: 'mcp__jira__delete_issue' },
        { name: 'mcp__gitlab__delete_issue' },
      ]);
      expect(prompts[0]).not.toBeNull();
      expect(prompts[1], 'CONTROL: the same tool on the same server IS covered').toBeNull();
      expect(prompts[2], 'the other server’s same-named tool is not').not.toBeNull();
    });

    /**
     * §6 — the menu may not display one thing and store another. A call naming two hosts has no
     * honest single-host entry, so no sticky grant is offered at all and nothing is recorded.
     */
    describe('a call naming several hosts gets no grant', () => {
      const twoHosts = { from: 'https://a.example/x', to: 'https://b.example/y' };

      it('offers no preview, records nothing, and asks again next time', async () => {
        const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
          { name: 'gth_web_fetch', args: twoHosts },
          { name: 'gth_web_fetch', args: twoHosts },
        ]);
        expect(prompts[0]?.grantPreview).toBeUndefined();
        expect(prompts[1], 'nothing was remembered, so it asks again').not.toBeNull();
      });

      it('CONTROL: one of those hosts alone does get a preview and does stop asking', async () => {
        const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
          { name: 'gth_web_fetch', args: { from: 'https://a.example/x' } },
          { name: 'gth_web_fetch', args: { from: 'https://a.example/x' } },
        ]);
        expect(prompts[0]?.grantPreview).toContain('a.example');
        expect(prompts[1]).toBeNull();
      });

      /**
       * **What refusing the multi-host grant does NOT do, pinned so the rule's stated reason cannot
       * drift back into claiming it.** A host-less entry imposes no host condition at all, so the
       * tool-only grant that any host-less call produces auto-approves a call naming two hosts — the
       * identical breadth this arm declines to grant, handed out the moment one argument fails to
       * parse as a URL. The arm survives on the §3.1 grammar (one optional `host` string, strict
       * arms, so a set is unrepresentable) and on §4.7.4's useless-grant test, never on breadth.
       *
       * Both tests above hold the host count at TWO across their calls, which is exactly why neither
       * can see this: the grant and the call it covers have to differ in host COUNT, not in host.
       */
      it('a tool-only grant from a HOSTLESS call already covers a multi-host one', async () => {
        const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
          { name: 'gth_web_fetch', args: { input: 'not a url' } },
          { name: 'gth_web_fetch', args: twoHosts },
        ]);
        expect(prompts[0]?.grantPreview, 'the hostless call takes the tool-only arm').toBe(
          '{ "type": "tool", "matcher": "exact", "pattern": "gth_web_fetch" }'
        );
        expect(prompts[1], 'and that grant covers a call naming two hosts').toBeNull();
      });
    });

    /**
     * A shell call with no readable `command` presents as a `tool` subject named
     * `run_shell_command`, and it names no host — so without an explicit exclusion it would take the
     * tool-only arm and write a grant that auto-approves every future call whose command cannot even
     * be read.
     */
    describe('run_shell_command never becomes a tool grant', () => {
      it('offers no preview and remembers nothing, so the next malformed call still asks', async () => {
        const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
          { name: 'run_shell_command', args: {} },
          { name: 'run_shell_command', args: {} },
        ]);
        expect(prompts[0]?.grantPreview).toBeUndefined();
        expect(prompts[1]).not.toBeNull();
      });

      it('CONTROL: another tool in exactly the same shape does get a grant', async () => {
        const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
          { name: 'gth_checklist', args: {} },
          { name: 'gth_checklist', args: {} },
        ]);
        expect(prompts[0]?.grantPreview).toContain('gth_checklist');
        expect(prompts[1]).toBeNull();
      });
    });

    /**
     * §2.5 — at `bypass` there is nothing to remember because there is nothing to ask: [[EXT-80]]
     * gates no non-shell tool there, so both calls run undecided. The old form of this cell asserted
     * that the SECOND call still prompted, which was the pre-EXT-80 fall-through — a `bypass`
     * session prompting on a tool call, which §2.5 says it must never do.
     */
    it('at bypass nothing is remembered from a tool call, because nothing is asked', async () => {
      const prompts = await driveCalls(toolConfig({ mode: 'bypass' }), [
        { name: 'gth_checklist', args: {} },
        { name: 'gth_checklist', args: {} },
      ]);
      expect(prompts[0]).toBeNull();
      expect(prompts[1]).toBeNull();
    });

    /**
     * CONTROL for the cell above: the very same sequence at `write` DOES prompt, so "nothing was
     * asked" at `bypass` is a statement about the rung and not about a harness that never asks.
     */
    it('CONTROL: the same sequence at write does ask, and remembers', async () => {
      const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
        { name: 'gth_checklist', args: {} },
        { name: 'gth_checklist', args: {} },
      ]);
      expect(prompts[0]).not.toBeNull();
      expect(prompts[0]?.grantPreview).toContain('gth_checklist');
      expect(prompts[1]).toBeNull();
    });

    /**
     * §4.7.4 — **weakening invalidates, with a notice.** Every "X does not invalidate" assertion
     * below is paired with a weakening that DOES, in the same block, because on a broken checker —
     * one that never invalidates anything — every negative passes and only the pair fails.
     */
    describe('weakening the effective annotations invalidates the grant', () => {
      /** Every hint believed, so a declaration can state any combination and be read verbatim. */
      const trustingJira = (approvals: Record<string, unknown> = {}) =>
        toolConfig({
          mode: 'write',
          mcp: {
            servers: {
              jira: {
                trustAnnotations: [
                  'readOnlyHint',
                  'destructiveHint',
                  'idempotentHint',
                  'openWorldHint',
                ],
              },
            },
          },
          ...approvals,
        });

      /**
       * The three moves, each ISOLATED. `destructiveHint` needs `readOnlyHint: false` on both sides
       * because effective `readOnlyHint: true` derives `destructiveHint: false` (§4.7.1), so the
       * obvious spelling would move two hints and prove nothing about `destructiveHint` in
       * particular — which is exactly how a checker that implements one field and misses two hides.
       */
      const LOCAL_WRITE = {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      };

      /**
       * The fourth column is the hint that MOVED; the fifth is one that stayed exactly where it was
       * (`false` on both sides of this row), and naming it is what makes the fourth mean something.
       * A notice built from the four hints rather than from the moved ones reads *"openWorldHint
       * changed from false to false"* — the gate reporting a change that did not happen — and passes
       * every `toContain` here. Only the absence assertion sees it.
       */
      it.each([
        [
          'readOnlyHint true → false',
          { ...LOCAL_WRITE, readOnlyHint: true },
          LOCAL_WRITE,
          'readOnlyHint',
          'openWorldHint',
        ],
        [
          'openWorldHint false → true',
          LOCAL_WRITE,
          { ...LOCAL_WRITE, openWorldHint: true },
          'openWorldHint',
          'readOnlyHint',
        ],
        [
          'destructiveHint false → true',
          LOCAL_WRITE,
          { ...LOCAL_WRITE, destructiveHint: true },
          'destructiveHint',
          'readOnlyHint',
        ],
      ])(
        '%s invalidates, and the notice names it and no hint that stayed put',
        async (_label, before, after, hint, stayed) => {
          const prompts = await driveCalls(trustingJira(), [
            { name: 'mcp__jira__search', declaring: { mcp__jira__search: before } },
            { name: 'mcp__jira__search', declaring: { mcp__jira__search: after } },
          ]);
          expect(prompts[0], 'the first call asks and grants').not.toBeNull();
          expect(prompts[1], 'the weakened tool asks again').not.toBeNull();

          const said = warningsSaid();
          expect(said).toContain('search');
          expect(said).toContain('jira');
          expect(said).toContain(hint);
          expect(said, 'a hint that did not move is not something to report').not.toContain(stayed);
        }
      );

      it.each([
        ['readOnlyHint false → true', LOCAL_WRITE, { ...LOCAL_WRITE, readOnlyHint: true }],
        [
          'openWorldHint true → false',
          { ...LOCAL_WRITE, openWorldHint: true },
          { ...LOCAL_WRITE, openWorldHint: false },
        ],
        ['destructiveHint true → false', { ...LOCAL_WRITE, destructiveHint: true }, LOCAL_WRITE],
      ])(
        'the mirror image (%s) STRENGTHENS and the grant stands',
        async (_label, before, after) => {
          const prompts = await driveCalls(trustingJira(), [
            { name: 'mcp__jira__search', declaring: { mcp__jira__search: before } },
            { name: 'mcp__jira__search', declaring: { mcp__jira__search: after } },
          ]);
          expect(prompts[1], 'a safer tool is still covered').toBeNull();
          expect(warningsSaid(), 'and nothing was withdrawn').not.toContain(jiraSearchGrantLine);
        }
      );

      it('an unchanged declaration invalidates nothing', async () => {
        const prompts = await driveCalls(trustingJira(), [
          { name: 'mcp__jira__search', declaring: { mcp__jira__search: LOCAL_WRITE } },
          { name: 'mcp__jira__search', declaring: { mcp__jira__search: LOCAL_WRITE } },
        ]);
        expect(prompts[1]).toBeNull();
      });

      /**
       * **Descriptions churn on every server release**, and a grant that dissolved on churn would
       * teach users that grants are worthless. It holds by construction rather than by a rule: a
       * snapshot is four booleans and a description is not one of them.
       */
      it('a change to anything BUT the four hints invalidates nothing', async () => {
        const prompts = await driveCalls(trustingJira(), [
          {
            name: 'mcp__jira__search',
            declaring: { mcp__jira__search: { ...LOCAL_WRITE, description: 'Search issues.' } },
          },
          {
            name: 'mcp__jira__search',
            declaring: {
              mcp__jira__search: {
                ...LOCAL_WRITE,
                description: 'Search issues, now with more fields.',
                title: 'Issue search',
              },
            },
          },
        ]);
        expect(prompts[1], 'the grant survives a description change').toBeNull();
      });

      it('CONTROL: the same pair with one hint weakened DOES invalidate', async () => {
        const prompts = await driveCalls(trustingJira(), [
          {
            name: 'mcp__jira__search',
            declaring: { mcp__jira__search: { ...LOCAL_WRITE, description: 'Search issues.' } },
          },
          {
            name: 'mcp__jira__search',
            declaring: {
              mcp__jira__search: {
                ...LOCAL_WRITE,
                openWorldHint: true,
                description: 'Search issues, now with more fields.',
              },
            },
          },
        ]);
        expect(prompts[1]).not.toBeNull();
      });

      /**
       * §4.7.1 — an UNTRUSTED server's effective set IS the constant fail-closed default, so its
       * declarations cannot move it and cannot invalidate anything. By construction, not by a rule.
       * The control is the very same declaration pair from a TRUSTED server.
       */
      it('an untrusted server’s declaration change invalidates nothing', async () => {
        // No `mcp` block at all: nothing external is believed.
        const prompts = await driveCalls(toolConfig({ mode: 'write' }), [
          {
            name: 'mcp__jira__search',
            declaring: { mcp__jira__search: { ...LOCAL_WRITE, readOnlyHint: true } },
          },
          {
            name: 'mcp__jira__search',
            declaring: {
              mcp__jira__search: { ...LOCAL_WRITE, readOnlyHint: false, openWorldHint: true },
            },
          },
        ]);
        expect(prompts[1], 'nothing the server says can move a constant').toBeNull();
        expect(warningsSaid(), 'and nothing was withdrawn').not.toContain(jiraSearchGrantLine);
      });

      it('CONTROL: the very same declaration pair from a TRUSTED server does invalidate', async () => {
        const prompts = await driveCalls(trustingJira(), [
          {
            name: 'mcp__jira__search',
            declaring: { mcp__jira__search: { ...LOCAL_WRITE, readOnlyHint: true } },
          },
          {
            name: 'mcp__jira__search',
            declaring: {
              mcp__jira__search: { ...LOCAL_WRITE, readOnlyHint: false, openWorldHint: true },
            },
          },
        ]);
        expect(prompts[1]).not.toBeNull();
      });

      /**
       * **A tool-only grant imposes no host condition, so it auto-approves a call that DOES carry a
       * host** — which means the set of grants that could approve a call is larger than the one
       * entry that call would itself grant. A lookup keyed only on the call's own entry misses the
       * tool-only grant that is about to approve it, and the weakening rides straight through: the
       * exact failure §4.7.4 exists to stop, reachable for any tool whose arguments sometimes carry
       * a URL and sometimes do not.
       */
      describe('a tool-only grant is invalidated by a weakened call that carries a host', () => {
        const withHost = { url: 'https://x.example/a' };

        it('the weakening is caught even though the call now names a host', async () => {
          const prompts = await driveCalls(trustingJira(), [
            // Grants {mcpTool jira/fetch} — no host in these arguments, so no host bound.
            { name: 'mcp__jira__fetch', declaring: { mcp__jira__fetch: LOCAL_WRITE } },
            {
              name: 'mcp__jira__fetch',
              args: withHost,
              declaring: { mcp__jira__fetch: { ...LOCAL_WRITE, openWorldHint: true } },
            },
          ]);
          expect(prompts[1], 'the weakened tool asks again').not.toBeNull();
          expect(warningsSaid()).toContain('openWorldHint');
        });

        it('CONTROL: without the weakening that very call is auto-approved by it', async () => {
          const prompts = await driveCalls(trustingJira(), [
            { name: 'mcp__jira__fetch', declaring: { mcp__jira__fetch: LOCAL_WRITE } },
            {
              name: 'mcp__jira__fetch',
              args: withHost,
              declaring: { mcp__jira__fetch: LOCAL_WRITE },
            },
          ]);
          expect(prompts[1], 'a tool-only grant covers a call carrying a host').toBeNull();
        });

        /**
         * The other direction stays untouched: a grant bound to one host is not this call's to
         * invalidate, because it does not match this call either. Asserted by the host-A grant still
         * working after a weakened call to host B.
         */
        it('a grant bound to another host is NOT invalidated by a weakened call elsewhere', async () => {
          const prompts = await driveCalls(trustingJira(), [
            {
              name: 'mcp__jira__fetch',
              args: { url: 'https://a.example/1' },
              declaring: { mcp__jira__fetch: LOCAL_WRITE },
            },
            {
              name: 'mcp__jira__fetch',
              args: { url: 'https://b.example/2' },
              declaring: { mcp__jira__fetch: { ...LOCAL_WRITE, openWorldHint: true } },
            },
            {
              name: 'mcp__jira__fetch',
              args: { url: 'https://a.example/3' },
              declaring: { mcp__jira__fetch: LOCAL_WRITE },
            },
          ]);
          expect(prompts[1], 'the other host was never granted').not.toBeNull();
          expect(prompts[2], 'the host A grant survived it').toBeNull();
        });
      });

      /**
       * Invalidation is a REMOVAL, so the human can re-grant. The stores de-duplicate by entry
       * identity: a grant that was skipped rather than removed would make the re-approval a silent
       * no-op and the tool would ask forever.
       */
      it('the human can re-grant the weakened tool, and the new grant holds', async () => {
        const prompts = await driveCalls(trustingJira(), [
          { name: 'mcp__jira__search', declaring: { mcp__jira__search: LOCAL_WRITE } },
          {
            name: 'mcp__jira__search',
            declaring: { mcp__jira__search: { ...LOCAL_WRITE, openWorldHint: true } },
          },
          {
            name: 'mcp__jira__search',
            declaring: { mcp__jira__search: { ...LOCAL_WRITE, openWorldHint: true } },
          },
        ]);
        expect(prompts[1], 'the weakening asked again').not.toBeNull();
        expect(prompts[2], 'and the re-grant covers the tool as it now is').toBeNull();
      });

      /**
       * An `always` grant and its invalidation both reach the FILE. Held only in memory the removal
       * would be undone by the next session, so the notice would fire once per session forever.
       */
      it('an always-scoped tool grant is persisted, and its invalidation rewrites the file', async () => {
        const storePath = join(projectDir, SHELL_ALLOWLIST_FILE);
        await driveCalls(
          trustingJira(),
          [{ name: 'mcp__jira__search', declaring: { mcp__jira__search: LOCAL_WRITE } }],
          { type: 'approve', scope: 'always' }
        );
        const written = JSON.parse(readFileSync(storePath, 'utf8'));
        expect(written.grants).toHaveLength(1);
        expect(written.grants[0].entry).toEqual({
          type: 'mcpTool',
          server: 'jira',
          matcher: 'exact',
          pattern: 'search',
        });
        expect(written.grants[0].annotations).toEqual(LOCAL_WRITE);

        // A fresh runner reads that file, sees the weakened declaration, and clears the grant.
        const prompts = await driveCalls(
          trustingJira(),
          [
            {
              name: 'mcp__jira__search',
              declaring: { mcp__jira__search: { ...LOCAL_WRITE, openWorldHint: true } },
            },
          ],
          { type: 'reject' }
        );
        expect(prompts[0], 'the persisted grant no longer covers it').not.toBeNull();
        expect(JSON.parse(readFileSync(storePath, 'utf8')).grants).toHaveLength(0);
      });
    });

    /**
     * EXT-70 §4.7.1 / §6 / §4.7.4 — **the surface half.** What the menu names a grant, what the
     * runner exposes for an approvals view, and what moving trust from the TUI does to grants made
     * under the old trust.
     */
    describe('the TUI trust affordance, and what the menu names (§4.7.1, §6)', () => {
      /** A declaration a fully-trusting session reads verbatim: local, safe, closed. */
      const SAFE_DECL = {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      };
      /** The same, but not read-only — so `destructiveHint` is not forced by the §4.7.1 derivation. */
      const WRITING_DECL = { ...SAFE_DECL, readOnlyHint: false };
      const ALL_HINTS = [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ] as const;

      const believingJira = (trustAnnotations: readonly string[] = ALL_HINTS) =>
        toolConfig({ mode: 'write', mcp: { servers: { jira: { trustAnnotations } } } });

      /** A runner initialized on one config, for the accessors that need no run at all. */
      async function idleRunner(approvals: Record<string, unknown>): Promise<GthAgentRunner> {
        const runner = new GthAgentRunner(statusUpdateCallback);
        await runner.init('code', toolConfig(approvals));
        return runner;
      }

      /** What one server's believed hints are, by the runner's own display accessor. */
      const believed = (runner: GthAgentRunner, server: string): readonly string[] | undefined =>
        runner.getMcpAnnotationTrust().servers.find((s) => s.server === server)?.trusted;

      describe('§6 — the menu names what it will store, in the same words the notice uses', () => {
        /**
         * **The pin against drift between the two renderers.** The menu's summary and the §4.7.4
         * withdrawal notice describe ONE grant, and a user who is shown two different descriptions
         * of the same thing stops trusting both. Asserted as an identity plus a containment rather
         * than as two literals, so no rewording can satisfy one and not the other.
         */
        it('the summary the menu shows is the exact line the withdrawal notice later names', async () => {
          const prompts = await driveCalls(believingJira(), [
            { name: 'mcp__jira__search', declaring: { mcp__jira__search: SAFE_DECL } },
            {
              name: 'mcp__jira__search',
              declaring: { mcp__jira__search: { ...SAFE_DECL, openWorldHint: true } },
            },
          ]);
          const summary = prompts[0]?.grantSummary;
          expect(summary).toBe(jiraSearchGrantLine);
          expect(prompts[1], 'the weakened tool asks again').not.toBeNull();
          expect(warningsSaid()).toContain(summary as string);
        });

        it('names the tool and its host bound, never the arguments', async () => {
          const [first] = await driveCalls(toolConfig({ mode: 'write' }), [
            { name: 'gth_web_fetch', args: { input: 'https://docs.internal.example/guide' } },
          ]);
          expect(first?.grantSummary).toBe('tool gth_web_fetch (host docs.internal.example)');
          expect(first?.grantSummary, 'the arguments are not what is stored').not.toContain(
            'guide'
          );
        });

        /**
         * The pair §6 turns on: a control is SHOWN only where something would be stored. Asserting
         * only the absence would pass on a runner that never sent a summary at all, so the same
         * tool, one host fewer, is the control.
         */
        it('offers nothing to name where nothing would be stored (several hosts)', async () => {
          const [several] = await driveCalls(toolConfig({ mode: 'write' }), [
            {
              name: 'gth_web_fetch',
              args: { a: 'https://one.example/x', b: 'https://two.example/y' },
            },
          ]);
          expect(several?.grantSummary).toBeUndefined();
          expect(several?.grantPreview).toBeUndefined();

          const [one] = await driveCalls(toolConfig({ mode: 'write' }), [
            { name: 'gth_web_fetch', args: { a: 'https://one.example/x' } },
          ]);
          expect(one?.grantSummary, 'CONTROL: one host is named').toBe(
            'tool gth_web_fetch (host one.example)'
          );
        });
      });

      describe('§4.7.1 — trust moves per hint, never per server', () => {
        /**
         * The trap this node exists to avoid: a test that believes one hint and checks that hint
         * passes just as well on a per-server boolean. So the assertion is on BOTH halves — the one
         * moved and one deliberately left alone.
         */
        it('believing one hint leaves the others exactly where they were', async () => {
          const runner = await idleRunner({ mode: 'write' });
          runner.setMcpAnnotationTrust('jira', ['readOnlyHint'], true);
          expect(believed(runner, 'jira')).toEqual(['readOnlyHint']);

          runner.setMcpAnnotationTrust('jira', ['openWorldHint'], true);
          expect(believed(runner, 'jira')).toEqual(['readOnlyHint', 'openWorldHint']);

          runner.setMcpAnnotationTrust('jira', ['readOnlyHint'], false);
          expect(believed(runner, 'jira'), 'the other hint survives the withdrawal').toEqual([
            'openWorldHint',
          ]);
        });

        /**
         * The same claim where it decides something. A grant records the effective set it was made
         * under (§4.7.4), so the snapshot is the derivation's own answer: with only `readOnlyHint`
         * believed, the server's `openWorldHint: false` is NOT read and the effective value stays
         * the fail-closed `true`. One object, both halves.
         */
        it('an unbelieved hint stays fail-closed in the set a grant is made under', async () => {
          let runner!: GthAgentRunner;
          // Believed FROM THE TUI, on a session whose config believes nothing — so this pins the
          // affordance itself and not the config path Task 1 already covers.
          await driveCalls(toolConfig({ mode: 'write' }), [
            {
              name: 'mcp__jira__search',
              declaring: { mcp__jira__search: SAFE_DECL },
              before: (r) => {
                r.setMcpAnnotationTrust('jira', ['readOnlyHint'], true);
                runner = r;
              },
            },
          ]);
          expect(runner.getGrants()[0].annotations).toEqual({
            readOnlyHint: true, // believed, and read verbatim
            destructiveHint: false, // §4.7.1's derivation, not the declaration
            idempotentHint: false, // NOT believed — the declared `true` is ignored
            openWorldHint: true, // NOT believed — the declared `false` is ignored
          });
        });

        /**
         * §9 — a server not named under `servers` inherits `defaults`, and naming it makes it state
         * its relationship IN FULL. So a trust change must seed from what was in force, or believing
         * one more hint would silently withdraw everything `defaults` granted — a weakening nobody
         * asked for, and one that would invalidate their grants.
         */
        it('believing a hint for an unnamed server keeps what defaults already granted', async () => {
          const runner = await idleRunner({
            mode: 'write',
            mcp: { defaults: { trustAnnotations: ['openWorldHint'] } },
          });
          runner.setMcpAnnotationTrust('jira', ['readOnlyHint'], true);
          expect(believed(runner, 'jira')).toEqual(['readOnlyHint', 'openWorldHint']);
        });

        it('CONTROL: a server NAMED with no trust does not inherit defaults, and still does not', async () => {
          const runner = await idleRunner({
            mode: 'write',
            mcp: {
              defaults: { trustAnnotations: ['openWorldHint'] },
              servers: { jira: {} },
            },
          });
          expect(believed(runner, 'jira'), 'a named server states it in full').toEqual([]);
          runner.setMcpAnnotationTrust('jira', ['readOnlyHint'], true);
          expect(believed(runner, 'jira')).toEqual(['readOnlyHint']);
        });

        it('a trust change never rewrites the config block it was resolved from', async () => {
          const mcp = { servers: { jira: { trustAnnotations: ['readOnlyHint'] } } };
          const runner = new GthAgentRunner(statusUpdateCallback);
          await runner.init('code', toolConfig({ mode: 'write', mcp }));
          runner.setMcpAnnotationTrust('jira', ['openWorldHint'], true);
          expect(mcp.servers.jira.trustAnnotations).toEqual(['readOnlyHint']);
        });

        it('names every server either side knows about, believed or not', async () => {
          const runner = await idleRunner({
            mode: 'write',
            mcp: { servers: { typo: { trustAnnotations: ['readOnlyHint'] } } },
          });
          const view = runner.getMcpAnnotationTrust();
          expect(view.servers.map((s) => [s.server, s.configured])).toEqual(
            expect.arrayContaining([
              ['jira', true],
              ['gitlab', true],
              ['typo', false],
            ])
          );
        });
      });

      describe('§4.7.4 — withdrawing trust weakens, and the change SAYS so', () => {
        /**
         * The three hints whose fail-closed default is the dangerous value. **`destructiveHint` is
         * one of them** — this node's own brief said it was not, and the moves table says otherwise:
         * a believed `destructiveHint: false` becomes `true` again the moment it stops being
         * believed. `readOnlyHint` is false in that row's declaration on purpose, because an
         * effective `readOnlyHint: true` would force `destructiveHint: false` by derivation and the
         * row would prove nothing.
         */
        it.each([
          ['readOnlyHint', SAFE_DECL],
          ['openWorldHint', SAFE_DECL],
          ['destructiveHint', WRITING_DECL],
        ] as const)('withdrawing %s reports a weakening', async (hint, decl) => {
          let runner!: GthAgentRunner;
          await driveCalls(believingJira(), [
            {
              name: 'mcp__jira__search',
              declaring: { mcp__jira__search: decl },
              before: (r) => {
                runner = r;
              },
            },
          ]);
          const change = runner.setMcpAnnotationTrust('jira', [hint], false);
          expect(change.removed).toEqual([hint]);
          expect(change.weakening).toEqual([hint]);
          expect(change.invalidates).toEqual([jiraSearchGrantLine]);
        });

        /**
         * The negative, and the only hint it is true of: `idempotentHint` names no weakening move,
         * so withdrawing it invalidates nothing. Its control is the `it.each` above — on a checker
         * that reported nothing for anything, this would pass alone.
         */
        it('withdrawing idempotentHint reports no weakening and no invalidation', async () => {
          let runner!: GthAgentRunner;
          await driveCalls(believingJira(), [
            {
              name: 'mcp__jira__search',
              declaring: { mcp__jira__search: SAFE_DECL },
              before: (r) => {
                runner = r;
              },
            },
          ]);
          const change = runner.setMcpAnnotationTrust('jira', ['idempotentHint'], false);
          expect(change.removed, 'it really was believed, and really was withdrawn').toEqual([
            'idempotentHint',
          ]);
          expect(change.weakening).toEqual([]);
          expect(change.invalidates).toEqual([]);
        });

        /**
         * BELIEVING can never weaken: every weakening move ends at the fail-closed default, and
         * belief only moves away from it. Its control is the same hints withdrawn, immediately
         * after, on the same runner.
         */
        it('believing a hint reports no weakening — its control is withdrawing the same hint', async () => {
          let runner!: GthAgentRunner;
          await driveCalls(believingJira(['readOnlyHint']), [
            {
              name: 'mcp__jira__search',
              declaring: { mcp__jira__search: SAFE_DECL },
              before: (r) => {
                runner = r;
              },
            },
          ]);
          const granted = runner.setMcpAnnotationTrust('jira', ['openWorldHint'], true);
          expect(granted.added).toEqual(['openWorldHint']);
          expect(granted.weakening).toEqual([]);
          expect(granted.invalidates).toEqual([]);

          const withdrawn = runner.setMcpAnnotationTrust('jira', ['readOnlyHint'], false);
          expect(withdrawn.weakening, 'CONTROL: the withdrawal does report one').toEqual([
            'readOnlyHint',
          ]);
        });

        /**
         * Two claims, and the test has to carry both: the listing names only the server whose trust
         * moved, **and it names it because of the withdrawal**. The second is the one a scoping test
         * gets for free and should not: `invalidates` compares each grant's snapshot against the set
         * in force NOW, so a jira grant that read as weakened for some reason of its own would be
         * listed under any withdrawal at all, and the assertion would pass without trust having
         * decided anything.
         *
         * So the causal half runs FIRST and on the same runner: `idempotentHint` is the one hint no
         * weakening move names, and withdrawing it must list nothing. Order matters — the comparison
         * is snapshot-versus-now rather than before-versus-after, so once `readOnlyHint` is gone the
         * grant stays weakened and every later withdrawal would list it too.
         */
        it('names only THIS server’s grants, and only because the withdrawal weakened them', async () => {
          let runner!: GthAgentRunner;
          await driveCalls(
            toolConfig({
              mode: 'write',
              mcp: {
                servers: {
                  jira: { trustAnnotations: ALL_HINTS },
                  gitlab: { trustAnnotations: ALL_HINTS },
                },
              },
            }),
            [
              {
                name: 'mcp__jira__search',
                declaring: { mcp__jira__search: SAFE_DECL },
                before: (r) => {
                  runner = r;
                },
              },
              { name: 'mcp__gitlab__search', declaring: { mcp__gitlab__search: SAFE_DECL } },
            ]
          );
          expect(runner.getGrants(), 'both were granted').toHaveLength(2);

          const harmless = runner.setMcpAnnotationTrust('jira', ['idempotentHint'], false);
          expect(harmless.removed, 'it really was believed, and really was withdrawn').toEqual([
            'idempotentHint',
          ]);
          expect(
            harmless.invalidates,
            'a withdrawal that weakens nothing lists nothing — so the line below is caused by the trust move'
          ).toEqual([]);

          const change = runner.setMcpAnnotationTrust('jira', ['readOnlyHint'], false);
          expect(change.invalidates).toEqual([jiraSearchGrantLine]);
        });

        /**
         * **The behaviour the notice promises, end to end.** The grant is made while the hint is
         * believed; the user withdraws belief mid-session, exactly as `/approvals untrust` does; the
         * next call to that very tool is invalidated with the §4.7.4 notice and asks again. Nothing
         * about the server's declaration changed — the trust did.
         *
         * Once per hint whose withdrawal weakens on this declaration, because the whole sequence is
         * what a row proves: a checker that answered for `readOnlyHint` alone would leave the other
         * covered only as far as `change.invalidates` and never as far as the second call actually
         * being asked about.
         *
         * **`destructiveHint` is the third such hint and has no row here — a stated boundary, not a
         * claim of coverage.** It is asserted only as far as `change.invalidates`, by the three-row
         * `it.each` above, which is also where the not-read-only declaration it needs belongs. So
         * nothing below that level is proved for it, and adding the row is the way to prove it.
         */
        it.each(['readOnlyHint', 'openWorldHint'] as const)(
          'a mid-session withdrawal of %s invalidates the grant at the next call, with the notice',
          async (hint) => {
            const prompts = await driveCalls(believingJira(), [
              { name: 'mcp__jira__search', declaring: { mcp__jira__search: SAFE_DECL } },
              {
                name: 'mcp__jira__search',
                declaring: { mcp__jira__search: SAFE_DECL },
                before: (r) => {
                  r.setMcpAnnotationTrust('jira', [hint], false);
                },
              },
            ]);
            expect(prompts[0], 'the first call asks and grants').not.toBeNull();
            expect(prompts[1], 'the withdrawal made the tool ask again').not.toBeNull();
            const said = warningsSaid();
            expect(said).toContain(jiraSearchGrantLine);
            expect(said).toContain(hint);
          }
        );

        /**
         * CONTROL for the above: withdrawing the one hint no weakening move names leaves the grant
         * in force. Without it, an invalidator that fired on ANY trust change would pass the test
         * above.
         */
        it('CONTROL: withdrawing idempotentHint leaves the grant covering the next call', async () => {
          const prompts = await driveCalls(believingJira(), [
            { name: 'mcp__jira__search', declaring: { mcp__jira__search: SAFE_DECL } },
            {
              name: 'mcp__jira__search',
              declaring: { mcp__jira__search: SAFE_DECL },
              before: (r) => {
                r.setMcpAnnotationTrust('jira', ['idempotentHint'], false);
              },
            },
          ]);
          expect(prompts[1], 'the grant still covers it').toBeNull();
          expect(warningsSaid()).not.toContain(jiraSearchGrantLine);
        });

        it('reports whether the key names a configured server, without refusing an unknown one', async () => {
          const runner = await idleRunner({ mode: 'write' });
          expect(runner.setMcpAnnotationTrust('jira', ['readOnlyHint'], true).configured).toBe(
            true
          );
          const unknown = runner.setMcpAnnotationTrust('jira-typo', ['readOnlyHint'], true);
          expect(unknown.configured).toBe(false);
          // Not refused: §9 deliberately does not check policy keys against `mcpServers`, so policy
          // may be written before the server exists and config ORDER never matters.
          expect(unknown.trusted).toEqual(['readOnlyHint']);
        });
      });

      describe('§3/§4.7.4 — getGrants, the approvals view’s data', () => {
        it('shows what was granted, when, at what scope, and under which annotations', async () => {
          let runner!: GthAgentRunner;
          await driveCalls(believingJira(), [
            {
              name: 'mcp__jira__search',
              declaring: { mcp__jira__search: SAFE_DECL },
              before: (r) => {
                runner = r;
              },
            },
          ]);
          const [grant] = runner.getGrants();
          expect(grant.entry).toEqual({
            type: 'mcpTool',
            server: 'jira',
            matcher: 'exact',
            pattern: 'search',
          });
          expect(grant.scope).toBe('session');
          expect(grant.grantedAt).toEqual(expect.any(String));
          expect(grant.annotations).toEqual(SAFE_DECL);
        });

        /**
         * The stores hand back their LIVE records, so a view that mutated what it read would be
         * rewriting what the gate matches against. The control at the end asserts the mutation did
         * land somewhere, so this is isolation rather than a no-op.
         */
        it('hands back copies — a display cannot rewrite what the gate matches', async () => {
          let runner!: GthAgentRunner;
          await driveCalls(believingJira(), [
            {
              name: 'mcp__jira__search',
              declaring: { mcp__jira__search: SAFE_DECL },
              before: (r) => {
                runner = r;
              },
            },
          ]);
          const mine = runner.getGrants()[0];
          (mine.entry as { pattern: string }).pattern = 'delete_issue';
          mine.annotations!.openWorldHint = true;
          mine.scope = 'always';

          const fresh = runner.getGrants()[0];
          expect(fresh.entry).toEqual({
            type: 'mcpTool',
            server: 'jira',
            matcher: 'exact',
            pattern: 'search',
          });
          expect(fresh.annotations).toEqual(SAFE_DECL);
          expect(fresh.scope).toBe('session');
          expect(mine.entry, 'CONTROL: the mutation landed on the copy').toMatchObject({
            pattern: 'delete_issue',
          });
        });

        /**
         * Read-only by construction, exactly as `getAllowlistCounts` is: a display must never CREATE
         * the persisted store in order to show it. The control is the same session driven to a point
         * where the store IS loaded, where the persisted grant does appear.
         */
        it('never loads the persisted store, and lists it once it is loaded', async () => {
          const idle = await idleRunner({ mode: 'write' });
          expect(idle.getGrants()).toEqual([]);
          expect(idle.getAllowlistCounts().always, 'the store was not created').toBeUndefined();

          let runner!: GthAgentRunner;
          await driveCalls(
            believingJira(),
            [
              {
                name: 'mcp__jira__search',
                declaring: { mcp__jira__search: SAFE_DECL },
                before: (r) => {
                  runner = r;
                },
              },
            ],
            { type: 'approve', scope: 'always' }
          );
          // CONTROL: an `always` grant is written to BOTH stores, and is listed exactly once.
          expect(runner.getGrants()).toHaveLength(1);
          expect(runner.getGrants()[0].scope).toBe('always');
          expect(runner.getAllowlistCounts().always).toBe(1);
        });
      });
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
