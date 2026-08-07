/**
 * [[EXT-80]] — **what is gated AFTER the rung moves, and what is still free at the rated rungs.**
 *
 * The approval interrupt is wired once, when the graph is built, while `/approvals <rung>` moves the
 * rung underneath it for the rest of the session. The default rung is `assisted`, so typing
 * `/approvals manual` is the ORDINARY way to reach the strict mode — and a gate whose set carried
 * the rung would be frozen on `assisted` and would leave `write_file` ungated at the exact moment
 * the session printed *"It asks for approval for anything else"*. So the interrupt is
 * rung-independent (`resolveInterruptToolNames`) and `GthAgentRunner.decideToolApproval` decides on
 * the live `sessionApprovals.rung`.
 *
 * Both halves of that arrangement are asserted here, through a REAL `createAgent` graph driven by
 * the REAL runner — the interrupt firing and the decision are two claims and only the pair is the
 * behaviour:
 *
 * 1. **The transition works in the dangerous direction.** Start at `assisted`, switch to
 *    `manual`, call `write_file`: the human is reached and the file tool never runs unapproved.
 * 2. **The transition works in the harmless direction.** Start at `manual`, switch to `write`:
 *    `write_file` is granted silently.
 * 3. **Wiring wider did not gate wider.** At `assisted`, `auto` and `bypass` a gated non-shell
 *    tool is approved with NO rating call and NO human prompt — byte-for-byte the behaviour from
 *    when the interrupt held the shell alone. Widening there would turn every MCP call at the
 *    default rung into a human prompt with no rating, which belongs to [[EXT-30]].
 *
 * The deep backend wires the same set through deepagents' `interruptOn` (asserted in
 * `@gaunt-sloth/agent`'s `GthDeepAgent.spec.ts`) and decides through this same runner, so the
 * decision assertions below cover both backends and the wiring assertions are per-backend.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import { APPROVAL_RUNGS, type ApprovalRung } from '#src/config.js';
import { getNewRunnableConfig } from '#src/utils/llmUtils.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import type { PendingToolInterrupt, ToolApprovalDecision } from '#src/core/types.js';

// The rater is observable rather than real: "no rating call" is half of the scope boundary this
// file exists to pin, and only a spy can say it.
const rateShellCommandMock = vi.fn();
vi.mock('#src/core/shell/rater.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#src/core/shell/rater.js')>()),
  rateShellCommand: rateShellCommandMock,
}));

vi.mock('#src/utils/llmUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/llmUtils.js')>();
  return {
    ...actual,
    buildSystemMessages: vi.fn(() => [{ content: 'SYSTEM PROMPT' }]),
    readChatPrompt: vi.fn(() => 'chat-mode-prompt'),
    readCodePrompt: vi.fn(() => 'code-mode-prompt'),
    readExecPrompt: vi.fn(() => 'exec-mode-prompt'),
  };
});

vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/consoleUtils.js')>();
  return {
    ...actual,
    display: vi.fn(),
    displayInfo: vi.fn(),
    displayWarning: vi.fn(),
    displayError: vi.fn(),
    displaySuccess: vi.fn(),
    displayDebug: vi.fn(),
    displayToolIndication: vi.fn(),
  };
});

/**
 * Scripts one tool call per turn from a queue (no provider / API key): a trailing ToolMessage — a
 * tool result or the HITL reject notice — ends the turn with a final answer.
 */
class ScriptedToolCallingModel extends BaseChatModel {
  callCount = 0;
  private callSeq = 0;
  constructor(private readonly calls: { name: string; args: Record<string, unknown> }[]) {
    super({});
  }
  _llmType(): string {
    return 'scripted';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.callCount++;
    const last = messages[messages.length - 1];
    const next = this.calls[Math.min(this.callSeq, this.calls.length - 1)];
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('final answer')
      : new AIMessage({
          content: '',
          tool_calls: [{ name: next.name, args: next.args, id: `call-${this.callCount}` }],
        });
    if (!ToolMessage.isInstance(last)) this.callSeq++;
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

describe('EXT-80 — a mid-session rung change decides the gate (real createAgent graph)', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  /** What the tools actually did — the security-relevant observable, never mocked away. */
  let ran: string[];

  const BASE_CONFIG = {
    streamOutput: true,
    contentSource: 'file',
    requirementSource: 'file',
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: false,
    writeBinaryOutputsToFile: false,
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: true,
  };

  // Clamp the persisted-grant anchor through the production hook, so nothing here can read or
  // rewrite the allow-list of whoever runs the suite.
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-rung-transition-spec-'));
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    ran = [];
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    setProjectDir(priorProjectDir);
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** Real tools that record their invocation — nothing here touches the filesystem. */
  const makeTools = () => [
    tool(
      async ({ path }: { path: string }) => {
        ran.push(`write_file:${path}`);
        return `wrote ${path}`;
      },
      {
        name: 'write_file',
        description: 'Write a file.',
        schema: z.object({ path: z.string(), content: z.string().optional() }),
      }
    ),
    tool(
      async ({ query }: { query: string }) => {
        ran.push(`mcp__docs__search:${query}`);
        return `found ${query}`;
      },
      {
        name: 'mcp__docs__search',
        description: 'Search the docs.',
        schema: z.object({ query: z.string() }),
      }
    ),
    tool(
      async ({ path }: { path: string }) => {
        ran.push(`read_file:${path}`);
        return `contents of ${path}`;
      },
      {
        name: 'read_file',
        description: 'Read a file.',
        schema: z.object({ path: z.string() }),
      }
    ),
  ];

  const makeRunner = async (
    rung: ApprovalRung,
    calls: { name: string; args: Record<string, unknown> }[]
  ): Promise<InstanceType<typeof GthAgentRunner>> => {
    const runner = new GthAgentRunner(vi.fn(), {
      resolveTools: vi.fn().mockResolvedValue(makeTools()),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    const config = {
      ...BASE_CONFIG,
      llm: new ScriptedToolCallingModel(calls),
      approvals: rung,
    } as unknown as GthConfig;
    // `chat` emits no dev tools, so the shell gate is off: every gated name below is there on its
    // access class alone, which is what makes this a test about the rung and not about the shell.
    await runner.init('chat', config, new MemorySaver());
    return runner;
  };

  const runTurn = async (
    runner: InstanceType<typeof GthAgentRunner>,
    prompt: string
  ): Promise<void> => {
    for await (const _ of runner.processMessagesWithEvents([new HumanMessage(prompt)])) {
      // drained for effect
    }
  };

  describe('the transition toward strictness — the ordinary route to manual', () => {
    /**
     * **The defect this node exists to kill, on the documented in-session path.** The session starts
     * on the DEFAULT rung, where `write_file` is free, and the user types `/approvals manual`.
     * Nothing rebuilds the graph, so if the interrupt carried the rung it would still hold the
     * `assisted` set and the file would be written unprompted — under a notice that had just
     * promised approval for anything else.
     */
    it('assisted then /approvals manual: write_file reaches the human', async () => {
      const runner = await makeRunner('assisted', [
        { name: 'write_file', args: { path: 'notes.md', content: 'hi' } },
      ]);
      const human = vi.fn(async (pending: PendingToolInterrupt): Promise<ToolApprovalDecision> => {
        // Suspended: the prompt fired BEFORE the tool ran.
        expect(ran).toEqual([]);
        expect(pending.name).toBe('write_file');
        return { type: 'reject', message: 'No thanks.' };
      });
      runner.setToolApprovalCallback(human);

      expect(runner.setSessionApprovalRung('manual')).toBe('manual');
      await runTurn(runner, 'write the notes');

      expect(human).toHaveBeenCalledTimes(1);
      expect(ran).toEqual([]);
      // No model call was spent deciding it: `manual` is a deterministic rung.
      expect(rateShellCommandMock).not.toHaveBeenCalled();
    });

    it('assisted then /approvals manual: an MCP tool reaches the human too', async () => {
      const runner = await makeRunner('assisted', [
        { name: 'mcp__docs__search', args: { query: 'gates' } },
      ]);
      const human = vi.fn().mockResolvedValue({ type: 'reject', message: 'No.' });
      runner.setToolApprovalCallback(human);

      runner.setSessionApprovalRung('manual');
      await runTurn(runner, 'search the docs');

      expect(human).toHaveBeenCalledTimes(1);
      expect(ran).toEqual([]);
    });

    it('assisted then /approvals manual: the read built-ins stay free', async () => {
      // The other half of the promise: `manual` says the agent MAY read, so a read tool must not
      // start prompting. A gate that simply escalated everything would pass the two cells above.
      const runner = await makeRunner('assisted', [
        { name: 'read_file', args: { path: 'notes.md' } },
      ]);
      const human = vi.fn().mockResolvedValue({ type: 'reject' });
      runner.setToolApprovalCallback(human);

      runner.setSessionApprovalRung('manual');
      await runTurn(runner, 'read the notes');

      expect(human).not.toHaveBeenCalled();
      expect(ran).toEqual(['read_file:notes.md']);
    });
  });

  describe('the transition away from strictness', () => {
    it('manual then /approvals write: write_file is granted with no prompt', async () => {
      const runner = await makeRunner('manual', [
        { name: 'write_file', args: { path: 'notes.md', content: 'hi' } },
      ]);
      const human = vi.fn().mockResolvedValue({ type: 'reject' });
      runner.setToolApprovalCallback(human);

      runner.setSessionApprovalRung('write');
      await runTurn(runner, 'write the notes');

      expect(human).not.toHaveBeenCalled();
      expect(ran).toEqual(['write_file:notes.md']);
    });

    it('manual then /approvals write: an MCP tool still reaches the human', async () => {
      // `write` frees the file built-ins and nothing else — the control that stops the cell above
      // passing on a gate that simply stopped gating at `write`.
      const runner = await makeRunner('manual', [
        { name: 'mcp__docs__search', args: { query: 'gates' } },
      ]);
      const human = vi.fn().mockResolvedValue({ type: 'reject' });
      runner.setToolApprovalCallback(human);

      runner.setSessionApprovalRung('write');
      await runTurn(runner, 'search the docs');

      expect(human).toHaveBeenCalledTimes(1);
      expect(ran).toEqual([]);
    });
  });

  /**
   * **A surface with no approval drain must not be handed an approval interrupt.** The AG-UI server
   * (`api`) drives the agent directly — `init` + `streamWithEvents` — and never calls
   * `getPendingToolInterrupts`; its resume path serves its own frontend-tool stubs. A gated call
   * there suspends the graph with nobody to resume it, so the tool never runs, the client is never
   * asked, and the turn ends with that tool call unanswered. `commandAnswersApprovals` is what
   * keeps that from shipping, and the cells below drive the agent exactly as the AG-UI module
   * drives it, with no runner in the picture.
   *
   * **Every rung, because the rung is where this hides.** `commands.api.approvals` is a first-class
   * schema field and a root-level `approvals` applies to `api` too, so an ordinary config puts this
   * surface on `manual` or `write`. Those are the two rungs where the LIVE gated set is
   * non-empty — a fallback to it parks the call just as a rung-independent set does. The default
   * rung cannot show that on its own: it is the one rung where every candidate set is empty.
   *
   * **Two scripted calls, because they are gated at different rungs.** `write_file` is granted by
   * its access class at `write`, so it discriminates at `manual` alone; `mcp__docs__search` has
   * no access class and is gated at both deterministic rungs. Neither cell subsumes the other.
   */
  describe('a surface that drains no approvals is handed no approval interrupt', () => {
    const apiAgentCalling = async (
      rung: ApprovalRung,
      call: { name: string; args: Record<string, unknown> }
    ) => {
      const { GthLangChainAgent } = await import('#src/core/GthLangChainAgent.js');
      const agent = new GthLangChainAgent(vi.fn(), {
        resolveTools: async () => makeTools(),
        resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
      } as never);
      const config = {
        ...BASE_CONFIG,
        llm: new ScriptedToolCallingModel([call]),
        approvals: rung,
      } as unknown as GthConfig;
      await agent.init('api', config, new MemorySaver());
      return agent;
    };

    /** Drive one turn the way `apiAgUiModule` does, and report what the graph parked. */
    const runApiTurn = async (
      agent: Awaited<ReturnType<typeof apiAgentCalling>>,
      threadId: string
    ): Promise<PendingToolInterrupt[]> => {
      const runConfig = { ...getNewRunnableConfig(50), configurable: { thread_id: threadId } };
      for await (const _ of agent.streamWithEvents([new HumanMessage('do it')], runConfig)) {
        // drained for effect
      }
      // The observable that made the regression silent: a suspended graph parks the call here, and
      // nothing on this surface ever reads it.
      return agent.getPendingToolInterrupts(runConfig);
    };

    it.each(APPROVAL_RUNGS)(
      'runs write_file on an api session at %s, and parks nothing',
      async (rung) => {
        const agent = await apiAgentCalling(rung, {
          name: 'write_file',
          args: { path: 'notes.md', content: 'hi' },
        });

        const parked = await runApiTurn(agent, `api-write-file-${rung}`);

        expect(ran).toEqual(['write_file:notes.md']);
        expect(parked).toEqual([]);
      }
    );

    it.each(APPROVAL_RUNGS)(
      'runs an MCP tool on an api session at %s, and parks nothing',
      async (rung) => {
        const agent = await apiAgentCalling(rung, {
          name: 'mcp__docs__search',
          args: { query: 'gates' },
        });

        const parked = await runApiTurn(agent, `api-mcp-${rung}`);

        expect(ran).toEqual(['mcp__docs__search:gates']);
        expect(parked).toEqual([]);
      }
    );
  });

  /**
   * **The scope boundary, asserted where it now lives.** The interrupt fires for these calls — it is
   * wired over every tool any rung could gate — so the ONLY thing keeping the rated rungs and
   * `bypass` unchanged is the runner's live-rung check. Three assertions per cell, because
   * "approved" alone would pass on a gate that rated the call first, and "not rated" alone would
   * pass on one that prompted.
   */
  describe('wiring wider did not gate wider — the rated rungs and bypass are unchanged', () => {
    it.each(['assisted', 'auto', 'bypass'] as const)(
      'at %s write_file runs with no rating call and no prompt',
      async (rung) => {
        const runner = await makeRunner(rung, [
          { name: 'write_file', args: { path: 'notes.md', content: 'hi' } },
        ]);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runTurn(runner, 'write the notes');

        expect(ran).toEqual(['write_file:notes.md']);
        expect(human).not.toHaveBeenCalled();
        expect(rateShellCommandMock).not.toHaveBeenCalled();
      }
    );

    it.each(['assisted', 'auto', 'bypass'] as const)(
      'at %s an MCP tool runs with no rating call and no prompt',
      async (rung) => {
        const runner = await makeRunner(rung, [
          { name: 'mcp__docs__search', args: { query: 'gates' } },
        ]);
        const human = vi.fn().mockResolvedValue({ type: 'reject' });
        runner.setToolApprovalCallback(human);

        await runTurn(runner, 'search the docs');

        expect(ran).toEqual(['mcp__docs__search:gates']);
        expect(human).not.toHaveBeenCalled();
        expect(rateShellCommandMock).not.toHaveBeenCalled();
      }
    );

    /**
     * §6.2 — and it must not turn a non-interactive run non-zero either. A rated-rung session with
     * no one to ask ran these tools before this change; an escalation here would break every
     * `gth exec` and CI run that writes a file.
     */
    it.each(['assisted', 'auto', 'bypass'] as const)(
      'at %s write_file runs even with NO approval callback wired',
      async (rung) => {
        const runner = await makeRunner(rung, [
          { name: 'write_file', args: { path: 'notes.md', content: 'hi' } },
        ]);
        // No setToolApprovalCallback — the non-interactive default.

        await expect(runTurn(runner, 'write the notes')).resolves.toBeUndefined();

        expect(ran).toEqual(['write_file:notes.md']);
      }
    );
  });
});
