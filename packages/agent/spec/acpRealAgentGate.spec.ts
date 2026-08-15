/**
 * EXT-119 — **an ACP session builds a REAL LangGraph agent, so it must be handed a checkpointer.**
 *
 * ## Why this file exists beside the two ACP specs rather than inside them
 *
 * `acpServer.spec.ts` and `acpServerV1.spec.ts` drive both dialects with a hand-written
 * `GthAgentInterface` injected through the `agentFactory` seam, one that *emits* a pending tool
 * interrupt directly. Everything downstream of that stub is real — the runner, the approvals gate,
 * the permission mapping, the update mappers — but the **LangGraph agent is never constructed on
 * this surface at all**, and the graph is the one component that needs a checkpointer in order to
 * interrupt. So a session opened with no saver looked healthy to every cell in those files while
 * every gated shell call in a real editor died before the client was ever asked.
 *
 * This file replaces the stub with the **production agent factory**: the app's own default
 * (`resolveAgentFactory` → the lean `GthLangChainAgent`), a real `createAgent` graph, the real
 * approvals gate, and a real recording `run_shell_command` tool. Only the MODEL is faked — a
 * scripted `BaseChatModel`, no key and no network — plus the CFG-26 rater's two decision functions,
 * which at the default rung would otherwise ask that same fake model to rate a command.
 *
 * It is a separate file because that fixture stack is a different one from the two spec files'
 * (each of which states that nothing in it is mocked), and because ONE harness here serves BOTH
 * dialects, which would otherwise be written twice.
 *
 * ## The rung is the default one
 *
 * Nothing in the config below names `approvals`, so the shell gates at `assisted` — the posture a
 * session gets with no configuration, which is the posture the reported failure ran on. The
 * interrupt is installed rung-independently and fires before the gate decides anything, so the
 * crash reproduces with no rung tuning at all; the rater stubs exist only so the run continues past
 * the gate to the client once a checkpointer is present.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as acpV1 from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import { MemorySaver } from '@langchain/langgraph';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { AgentResolvers, GthAgentInterface } from '@gaunt-sloth/core/core/types.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';

// CFG-26 rater — the two DECISION functions are scripted; everything else in the module stays real
// via importOriginal, for the reason the core gate spec gives: listing exports by hand is what
// makes such a mock go stale the moment the module grows one. Without this the rated rung would
// hand the scripted model a rating prompt it was never written to answer.
const rateShellCommandMock = vi.fn();
const mapVerdictToActionMock = vi.fn();
vi.mock('@gaunt-sloth/core/core/shell/rater.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/core/shell/rater.js')>()),
  rateShellCommand: rateShellCommandMock,
  mapVerdictToAction: mapVerdictToActionMock,
}));

/**
 * A minimal chat model that scripts a ReAct conversation with no provider and no key: while the
 * trailing message is not a tool result it asks for `run_shell_command`, and once one comes back it
 * concludes with text. The same shape the core approval-gate spec uses.
 */
class ScriptedShellCallingModel extends BaseChatModel {
  callCount = 0;
  constructor(private readonly command: string) {
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
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('done')
      : new AIMessage({
          content: '',
          tool_calls: [
            { name: 'run_shell_command', args: { command: this.command }, id: 'call-1' },
          ],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

/**
 * The persisted grant store anchors at the project dir, so a spec driving a gated call must clamp
 * it or it reads (and writes) the real allow-list of whoever runs the suite.
 */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-acp-real-agent-spec-'));
const workspace = join(projectDir, 'workspace');

/**
 * Minimal but complete-enough config, carrying the scripted model.
 *
 * `approvals` is deliberately absent — the default rung is the subject. `canInterruptInferenceWithEsc`
 * is off because raw-mode stdin does not exist under vitest.
 */
function realAgentConfig(llm: BaseChatModel): GthConfig {
  return {
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
    llm,
  } as unknown as GthConfig;
}

/**
 * Resolvers carrying one real `run_shell_command` tool that records what it ran.
 *
 * Explicit rather than `createResolvers()`, which would load the production toolset — including a
 * shell tool that runs commands for real — and contact MCP servers from a unit spec.
 */
function makeResolvers(executed: string[]): AgentResolvers {
  return {
    resolveTools: async () => [
      tool(
        async ({ command }: { command: string }) => {
          executed.push(command);
          return `ran: ${command}`;
        },
        {
          name: 'run_shell_command',
          description: 'Run a shell command.',
          schema: z.object({ command: z.string() }),
        }
      ),
    ],
    resolveMiddleware: async (middleware: unknown[] | undefined) => middleware ?? [],
  } as unknown as AgentResolvers;
}

/** What one dialect's drive reports back. */
interface RealRun {
  /** Commands the tool ACTUALLY executed. */
  executed: string[];
  /** Every `session/request_permission` the client was asked, in arrival order. */
  requests: Array<Record<string, unknown>>;
  /** How the turn ended, as the CLIENT sees it in this dialect. */
  failure: string | undefined;
  /** Text of the agent messages the client rendered. */
  text: string;
}

let createAcpV1AgentApp: typeof import('#src/modules/acp/acpAgentAppV1.js').createAcpV1AgentApp;
let createAcpAgentApp: typeof import('#src/modules/acp/acpAgentApp.js').createAcpAgentApp;

/**
 * Drives one gated shell call over ACP **v1** — the dialect Zed speaks — against the real agent.
 *
 * v1 answers `session/prompt` with the stop reason, so a crashed turn arrives as the rejection of
 * that request; that rejection message is the failure this run reports.
 */
async function runV1(command: string, approve: boolean): Promise<RealRun> {
  const executed: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  // No `agentFactory`: the app's production default builds the real lean agent, which is the
  // whole point of this file.
  const agentApp = createAcpV1AgentApp({
    loadConfig: async () => realAgentConfig(new ScriptedShellCallingModel(command)),
    resolvers: makeResolvers(executed),
  });
  const client = acpV1
    .client({ name: 'ext-119-v1-client' })
    .onNotification(acpV1.CLIENT_METHODS.session_update, ({ params }) => {
      const update = params.update as unknown as Record<string, unknown>;
      if (
        update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_message'
      )
        texts.push(renderContent(update.content));
    })
    .onRequest(acpV1.CLIENT_METHODS.session_request_permission, async ({ params }) => {
      requests.push(params as unknown as Record<string, unknown>);
      return {
        outcome: { outcome: 'selected', optionId: approve ? 'allow-once' : 'reject-once' },
      } as acpV1.RequestPermissionResponse;
    });

  const failure = await client.connectWith(agentApp, async (ctx) => {
    await ctx.request(acpV1.AGENT_METHODS.initialize, {
      protocolVersion: acpV1.PROTOCOL_VERSION,
      clientInfo: { name: 'ext-119-v1-client', version: '0.0.0' },
    });
    const created = await ctx.request(acpV1.AGENT_METHODS.session_new, {
      cwd: workspace,
      mcpServers: [],
    });
    return ctx
      .request(acpV1.AGENT_METHODS.session_prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'run it' }],
      })
      .then(
        () => undefined,
        (error: unknown) => (error as Error).message
      );
  });

  return { executed, requests, failure, text: texts.join('') };
}

/**
 * The same drive over ACP **v2**.
 *
 * v2 acknowledges the prompt immediately and reports the outcome on a later idle `state_update`, so
 * a crashed turn is a `_error` stop reason with the message carried as an agent message — not a
 * rejected request. One assertion shape cannot serve both dialects.
 */
async function runV2(
  command: string,
  approve: boolean
): Promise<RealRun & { stopReason: unknown }> {
  const executed: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  const states: Array<Record<string, unknown>> = [];
  const agentApp = createAcpAgentApp({
    loadConfig: async () => realAgentConfig(new ScriptedShellCallingModel(command)),
    resolvers: makeResolvers(executed),
  });
  const client = acpV2
    .client({ name: 'ext-119-v2-client' })
    .onNotification(acpV2.CLIENT_METHODS.session_update, ({ params }) => {
      const update = params.update as unknown as Record<string, unknown>;
      if (update.sessionUpdate === 'state_update') states.push(update);
      if (
        update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_message'
      )
        texts.push(renderContent(update.content));
    })
    .onRequest(acpV2.CLIENT_METHODS.session_request_permission, async ({ params }) => {
      requests.push(params as unknown as Record<string, unknown>);
      return {
        outcome: { outcome: 'selected', optionId: approve ? 'allow-once' : 'reject-once' },
      } as acpV2.RequestPermissionResponse;
    });

  const idle = await client.connectWith(agentApp, async (ctx) => {
    await ctx.request(acpV2.AGENT_METHODS.initialize, {
      protocolVersion: acpV2.PROTOCOL_VERSION,
      info: { name: 'ext-119-v2-client', version: '0.0.0' },
    });
    const created = await ctx.request(acpV2.AGENT_METHODS.session_new, { cwd: workspace });
    await ctx.request(acpV2.AGENT_METHODS.session_prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run it' }],
    });
    const deadline = Date.now() + 20000;
    for (;;) {
      const found = states.find((state) => state.state === 'idle');
      if (found) return found;
      if (Date.now() > deadline) throw new Error('timed out waiting for the idle state update');
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  const stopReason = idle.stopReason;
  const text = texts.join('');
  return {
    executed,
    requests,
    // v2 has no error response for a turn: the failure is the `_error` stop reason, and what went
    // wrong is in the message the client rendered.
    failure: stopReason === '_error' ? text : undefined,
    text,
    stopReason,
  };
}

/** The text of one update's content, whatever block shape the dialect used. */
function renderContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((block) => (block as { text?: string })?.text ?? '').join('');
}

let priorProjectDir: string | undefined;
let priorInitCwd: string | undefined;

beforeEach(async () => {
  vi.resetAllMocks();
  priorProjectDir = peekProjectDir();
  priorInitCwd = process.env.INIT_CWD;
  setProjectDir(projectDir);
  // The rated rung's two decisions, scripted so the gate escalates to the human deterministically.
  const verdict = { outcome: 'destructive', reason: 'writes outside the project' };
  rateShellCommandMock.mockResolvedValue(verdict);
  mapVerdictToActionMock.mockReturnValue({ action: 'escalate', verdict });
  ({ createAcpV1AgentApp } = await import('#src/modules/acp/acpAgentAppV1.js'));
  ({ createAcpAgentApp } = await import('#src/modules/acp/acpAgentApp.js'));
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  // The production config loader assigns INIT_CWD, a process-global that outlives the connection.
  if (priorInitCwd === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = priorInitCwd;
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('EXT-119: a gated shell call on the ACP surface, driven through the REAL agent', () => {
  /**
   * The reported regression, on the dialect it was reported from.
   *
   * Without a checkpointer the graph cannot suspend, so the interrupt throws before anything is
   * asked of the client: the turn fails with `No checkpointer set` and no permission request is
   * ever raised. With one, the same run reaches `session/request_permission` and the approved
   * command actually executes.
   */
  it('v1 (Zed): asks the client for permission and runs the approved command', async () => {
    const run = await runV1('ls -la', true);

    // Named rather than left to a bare "the turn failed": a real-agent run has a dozen other ways
    // to throw, and only this assertion makes a red run say it is THE reported regression.
    expect(run.failure ?? '').not.toContain('No checkpointer set');
    expect(run.failure).toBeUndefined();
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]).toMatchObject({
      toolCall: { name: 'run_shell_command', rawInput: { command: 'ls -la' } },
    });
    // The gate was REACHED through the rated rung, rather than the tool slipping past ungated.
    expect(rateShellCommandMock).toHaveBeenCalled();
    expect(run.executed).toEqual(['ls -la']);
    expect(run.text).toContain('done');
  }, 30000);

  /** The client's "no" is an answer here too: nothing runs, and the turn still ends cleanly. */
  it('v1 (Zed): honours a rejection without executing the command', async () => {
    const run = await runV1('rm -rf /tmp/nope', false);

    expect(run.failure ?? '').not.toContain('No checkpointer set');
    expect(run.failure).toBeUndefined();
    expect(run.requests).toHaveLength(1);
    expect(run.executed).toEqual([]);
  }, 30000);

  /** The same property on the draft dialect, whose failures arrive as a stop reason instead. */
  it('v2: asks the client for permission and runs the approved command', async () => {
    const run = await runV2('ls -la', true);

    expect(run.failure ?? '').not.toContain('No checkpointer set');
    expect(run.failure).toBeUndefined();
    expect(run.stopReason).toBe('end_turn');
    expect(run.requests).toHaveLength(1);
    // v2 carries the shell call as a STRUCTURED subject rather than in the tool-call row's prose,
    // so the command the human is being asked about is assertable as data.
    expect(run.requests[0]).toMatchObject({
      subject: { type: 'command', command: 'ls -la', toolCallId: 'call-1' },
    });
    expect(rateShellCommandMock).toHaveBeenCalled();
    expect(run.executed).toEqual(['ls -la']);
  }, 30000);

  /**
   * The property the cases above cannot see, because one session cannot show it: the saver is
   * created **per session**, not once per process.
   *
   * Sessions share a process and the `sessions` map holds several at once, so a module-level saver
   * would pool their checkpoint threads — and the cases above would still pass, since a single
   * session is exactly the shape a shared saver looks correct in. This one records what each
   * session's agent was handed, which is the only place the distinction is observable.
   */
  it('gives every session its own checkpoint saver, on both dialects', async () => {
    for (const dialect of ['v1', 'v2'] as const) {
      const savers: unknown[] = [];
      const recordAgent = (): GthAgentInterface =>
        ({
          init: async (_command: unknown, _config: unknown, saver: unknown) => {
            savers.push(saver);
          },
          invoke: async () => '',
          stream: async () => {
            throw new Error('unused');
          },
          streamWithEvents: async function* () {},
          getPendingToolInterrupts: async () => [],
          streamWithEventsResume: async function* () {},
          cleanup: async () => {},
        }) as unknown as GthAgentInterface;
      const options = {
        loadConfig: async () => realAgentConfig(new ScriptedShellCallingModel('ls')),
        agentFactory: () => () => recordAgent(),
        resolvers: {} as AgentResolvers,
      };

      if (dialect === 'v1') {
        await acpV1
          .client({ name: 'ext-119-v1-savers' })
          .connectWith(createAcpV1AgentApp(options), async (ctx) => {
            await ctx.request(acpV1.AGENT_METHODS.initialize, {
              protocolVersion: acpV1.PROTOCOL_VERSION,
              clientInfo: { name: 'ext-119-v1-savers', version: '0.0.0' },
            });
            for (let i = 0; i < 2; i++) {
              await ctx.request(acpV1.AGENT_METHODS.session_new, {
                cwd: workspace,
                mcpServers: [],
              });
            }
          });
      } else {
        await acpV2
          .client({ name: 'ext-119-v2-savers' })
          .connectWith(createAcpAgentApp(options), async (ctx) => {
            await ctx.request(acpV2.AGENT_METHODS.initialize, {
              protocolVersion: acpV2.PROTOCOL_VERSION,
              info: { name: 'ext-119-v2-savers', version: '0.0.0' },
            });
            for (let i = 0; i < 2; i++) {
              await ctx.request(acpV2.AGENT_METHODS.session_new, { cwd: workspace });
            }
          });
      }

      expect(savers, dialect).toHaveLength(2);
      expect(savers[0], dialect).toBeInstanceOf(MemorySaver);
      expect(savers[1], dialect).toBeInstanceOf(MemorySaver);
      expect(savers[0], dialect).not.toBe(savers[1]);
    }
  });
});
