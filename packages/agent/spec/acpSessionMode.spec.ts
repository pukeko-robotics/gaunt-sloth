/**
 * EXT-117 — **what an editor actually gets when it opens an ACP session.**
 *
 * ## Why this is a file of its own
 *
 * `acpServer.spec.ts` and `acpServerV1.spec.ts` build their config by hand (`configWith(...)`) and
 * inject it through the `loadConfig` seam. That is right for what those files are about — the
 * protocol — and it makes them structurally blind to this one: a hand-built config cannot observe
 * a change in how a DEFAULT is resolved, so the whole of this node could land inert with both of
 * those suites green. Every cell here therefore runs the **production** loader over a real config
 * file on disk, and asserts on the toolset that resolution produces rather than on a config object
 * the test wrote.
 *
 * ## What each half catches
 *
 * - The **toolset** cells are the substance: under default config an ACP session resolves under
 *   `code` and its toolset carries `run_shell_command` and `write_file`; with `acp: { mode: 'chat' }`
 *   in the config file it carries neither. The second half is what proves the config key is really
 *   plumbed — schema, loader and read site — rather than the default merely being flipped.
 * - The **v1 cell** exists because the two dialects resolve the session independently. With coverage
 *   only on v2, `acpAgentAppV1.ts` could be reverted to a hardcoded command and nothing would go
 *   red. It asserts the command the v1 app resolves, which is enough to catch that drift.
 * - The **approvals** cells answer the question the toolset cells raise. A shell tool the model can
 *   call is only half of an editor's approve/deny flow; the other half is whether the gate asks the
 *   client under DEFAULT config — the rung then is `assisted` (`DEFAULT_APPROVAL_RUNG`), not the
 *   `write` the protocol suites set by hand, and `assisted` routes through the rater rather than
 *   asking outright. Both arms are driven, so what the editor sees is measured rather than assumed.
 *
 * ## What is faked, and what is not
 *
 * There is no `vi.mock` here. The real `GthAgentRunner`, the real approvals gate, the real config
 * loader and the real tool resolvers run. Only the model-facing agent is scripted — and in the
 * approvals cells the session MODEL, so the rater's answer is chosen rather than fetched over the
 * network from whatever credentials the host happens to have.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acpV1 from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { SHELL_TOOL_NAME } from '@gaunt-sloth/core/config/shell-policy.js';
import { WRITE_FILE_TOOL_NAME } from '@gaunt-sloth/core/config/filesystem-tools.js';
import { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import type {
  AgentStreamEvent,
  GthAgentInterface,
  GthCommand,
  PendingToolInterrupt,
  ToolApprovalDecision,
} from '@gaunt-sloth/core/core/types.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { createAcpAgentApp } from '#src/modules/acp/acpAgentApp.js';
import { createAcpV1AgentApp } from '#src/modules/acp/acpAgentAppV1.js';
import { loadConfigForCwd } from '#src/modules/acp/acpCommon.js';
import { createResolvers } from '#src/resolvers.js';

/**
 * The grant store anchors at the project dir, and the approvals cells drive a gated call — so this
 * must be clamped or they read (and write) the real allow-list of whoever runs the suite.
 */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-acp-mode-spec-'));

/**
 * A real project directory with a real config file, for the production loader to discover.
 *
 * `.git` stops the upward walk inside the fixture, and `llm.type` is present because a config
 * without it is one the loader rejects. Nothing else is set unless a case asks for it: the point of
 * every cell here is what happens when the user has said NOTHING about the key under test.
 */
function workspaceWith(name: string, config: Record<string, unknown> = {}): string {
  const dir = join(projectDir, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(
    join(dir, '.gsloth.config.json'),
    JSON.stringify({ llm: { type: 'vertexai' }, ...config })
  );
  return dir;
}

/**
 * A backend that stops at the tool list.
 *
 * It extends the production {@link GthAbstractAgent} rather than reimplementing it, so the step
 * between `runner.init` and a toolset — `getEffectiveConfig`, which is what folds `commands.<cmd>`
 * over the root — is the shipped one. A hand-rolled equivalent here would be a second copy of the
 * very resolution under test, agreeing with itself.
 */
class ToolResolvingAgent extends GthAbstractAgent {
  /** The command the ACP app resolved this session under. */
  seenCommand: GthCommand | undefined;
  /** The names of the tools that resolution produced. */
  toolNames: string[] = [];

  async init(command: GthCommand | undefined, configIn: GthConfig): Promise<void> {
    this.seenCommand = command;
    const effective = this.getEffectiveConfig(configIn, command);
    const tools = (await this.resolvers?.resolveTools?.(effective, command)) ?? [];
    this.toolNames = tools.map((tool) => tool.name);
  }
}

/** Opens one v2 session against `cwd` and returns the backend it built. */
async function v2Session(cwd: string): Promise<ToolResolvingAgent> {
  let captured: ToolResolvingAgent | undefined;
  const agentApp = createAcpAgentApp({
    // `loadConfig` deliberately NOT injected. Injecting it is what makes the protocol suites blind
    // to this node, and a cell that hands the session a config it wrote cannot see a default.
    agentFactory: () => (statusUpdate, resolvers) => {
      captured = new ToolResolvingAgent(statusUpdate, resolvers);
      return captured;
    },
    resolvers: createResolvers(),
  });

  await acpV2.client({ name: 'ext-117-v2-client' }).connectWith(agentApp, async (ctx) => {
    await ctx.request(acpV2.AGENT_METHODS.initialize, {
      protocolVersion: acpV2.PROTOCOL_VERSION,
      info: { name: 'ext-117-v2-client', version: '0.0.0' },
    });
    await ctx.request(acpV2.AGENT_METHODS.session_new, { cwd });
  });

  if (!captured) throw new Error('the session never built a backend');
  return captured;
}

/** Opens one v1 session against `cwd` and returns the backend it built. */
async function v1Session(cwd: string): Promise<ToolResolvingAgent> {
  let captured: ToolResolvingAgent | undefined;
  const agentApp = createAcpV1AgentApp({
    agentFactory: () => (statusUpdate, resolvers) => {
      captured = new ToolResolvingAgent(statusUpdate, resolvers);
      return captured;
    },
    resolvers: createResolvers(),
  });

  await acpV1.client({ name: 'ext-117-v1-client' }).connectWith(agentApp, async (ctx) => {
    await ctx.request(acpV1.AGENT_METHODS.initialize, {
      protocolVersion: acpV1.PROTOCOL_VERSION,
      clientInfo: { name: 'ext-117-v1-client', version: '0.0.0' },
    });
    await ctx.request(acpV1.AGENT_METHODS.session_new, { cwd, mcpServers: [] });
  });

  if (!captured) throw new Error('the session never built a backend');
  return captured;
}

/**
 * A scripted backend that reports one suspended `run_shell_command`, which is the state a gated
 * call leaves the graph in. The approvals cells need the gate to have something to decide about;
 * they are not about tool resolution, so nothing here resolves tools.
 */
class GatedShellAgent implements GthAgentInterface {
  /** What the gate decided, as handed back on resume. */
  readonly decisions: ToolApprovalDecision[] = [];
  private reported = false;

  constructor(private readonly command: string) {}

  async init(): Promise<void> {}
  async invoke(): Promise<string> {
    return '';
  }
  async stream(): Promise<never> {
    throw new Error('the ACP surface drives the event stream, never the text stream');
  }

  async *streamWithEvents(): AsyncGenerator<AgentStreamEvent> {
    yield { type: 'tool_start', id: 'call-1', name: SHELL_TOOL_NAME } as AgentStreamEvent;
    yield {
      type: 'tool_args',
      id: 'call-1',
      delta: JSON.stringify({ command: this.command }),
    } as AgentStreamEvent;
    yield { type: 'tool_end', id: 'call-1' } as AgentStreamEvent;
  }

  async getPendingToolInterrupts(): Promise<PendingToolInterrupt[]> {
    // Reported ONCE, so the runner's drain loop terminates on the next poll.
    if (this.reported) return [];
    this.reported = true;
    return [{ name: SHELL_TOOL_NAME, args: { command: this.command } }];
  }

  async *streamWithEventsResume(resumeValue: unknown): AsyncGenerator<AgentStreamEvent> {
    this.decisions.push(
      ...((resumeValue as { decisions: ToolApprovalDecision[] }).decisions ?? [])
    );
    yield { type: 'text', delta: 'done' } as AgentStreamEvent;
  }

  async cleanup(): Promise<void> {}
}

/**
 * A session model whose only job is to answer the rater.
 *
 * `rateShellCommand` reaches for `withStructuredOutput` on `config.llm` when no rater profile is
 * configured, and treats a model that has no such method as no rater at all. Passing `undefined`
 * for the verdict is therefore not "a broken fake" but the second real arm of the question: what
 * the gate does when nothing can rate the command.
 */
function raterModel(verdict?: { outcome: string; reason: string }): unknown {
  const base = { _llmType: () => 'test', verbose: false, bindTools: () => base };
  if (!verdict) return base;
  return { ...base, withStructuredOutput: () => ({ invoke: async () => verdict }) };
}

/**
 * The production loader with only the session MODEL replaced.
 *
 * Everything the approvals question turns on stays real: `approvals` is absent from the config file
 * and so resolves through `resolveApprovals` exactly as it would for a user, and `commands.code`
 * is merged by the real loader. Swapping the model is what keeps a unit test from making a network
 * call to whatever provider credentials the host has lying around.
 */
function loadWithRaterModel(model: unknown): (cwd: string) => Promise<GthConfig> {
  return async (cwd: string) => ({ ...(await loadConfigForCwd(cwd)), llm: model }) as GthConfig;
}

/** Drives one v2 turn that suspends on a gated shell call, and reports what the client saw. */
async function gatedTurn(
  cwd: string,
  model: unknown,
  answer?: (request: acpV2.RequestPermissionRequest) => acpV2.RequestPermissionOutcome
): Promise<{ permissionRequests: acpV2.RequestPermissionRequest[]; agent: GatedShellAgent }> {
  const agent = new GatedShellAgent('echo hi');
  const permissionRequests: acpV2.RequestPermissionRequest[] = [];
  const states: Array<Record<string, unknown>> = [];

  const agentApp = createAcpAgentApp({
    loadConfig: loadWithRaterModel(model),
    agentFactory: () => () => agent,
    resolvers: {},
  });

  await acpV2
    .client({ name: 'ext-117-gate-client' })
    .onNotification(acpV2.CLIENT_METHODS.session_update, ({ params }) => {
      if (params.update.sessionUpdate === 'state_update') {
        states.push(params.update as unknown as Record<string, unknown>);
      }
    })
    .onRequest(acpV2.CLIENT_METHODS.session_request_permission, async ({ params }) => {
      permissionRequests.push(params);
      if (!answer) throw new Error('the client was asked for permission with no answer scripted');
      return { outcome: answer(params) };
    })
    .connectWith(agentApp, async (ctx) => {
      await ctx.request(acpV2.AGENT_METHODS.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: 'ext-117-gate-client', version: '0.0.0' },
      });
      const created = await ctx.request(acpV2.AGENT_METHODS.session_new, { cwd });
      await ctx.request(acpV2.AGENT_METHODS.session_prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'run it' }],
      });
      const deadline = Date.now() + 10000;
      while (!states.some((state) => state.state === 'idle')) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the turn to go idle');
        await new Promise((r) => setTimeout(r, 5));
      }
    });

  return { permissionRequests, agent };
}

/**
 * The same turn in the v1 dialect, because **v1 is the dialect Zed speaks** — which makes it the one
 * the "an editor can now approve a shell command" claim is actually about. Asserting it across
 * dialects from the v2 cell would be an inference: the two apps build their sessions independently,
 * and only the runner underneath them is shared.
 *
 * Simpler than its v2 twin for one protocol reason: v1 has no `state_update`, so there is nothing to
 * poll for. The `session/prompt` request itself stays open until the turn ends, and awaiting it is
 * the whole synchronisation.
 */
async function gatedTurnV1(
  cwd: string,
  model: unknown,
  answer?: (request: acpV1.RequestPermissionRequest) => acpV1.RequestPermissionOutcome
): Promise<{ permissionRequests: acpV1.RequestPermissionRequest[]; agent: GatedShellAgent }> {
  const agent = new GatedShellAgent('echo hi');
  const permissionRequests: acpV1.RequestPermissionRequest[] = [];

  const agentApp = createAcpV1AgentApp({
    loadConfig: loadWithRaterModel(model),
    agentFactory: () => () => agent,
    resolvers: {},
  });

  await acpV1
    .client({ name: 'ext-117-gate-v1-client' })
    .onRequest(acpV1.CLIENT_METHODS.session_request_permission, async ({ params }) => {
      permissionRequests.push(params);
      if (!answer) throw new Error('the client was asked for permission with no answer scripted');
      return { outcome: answer(params) };
    })
    .connectWith(agentApp, async (ctx) => {
      await ctx.request(acpV1.AGENT_METHODS.initialize, {
        protocolVersion: acpV1.PROTOCOL_VERSION,
        clientInfo: { name: 'ext-117-gate-v1-client', version: '0.0.0' },
      });
      const created = await ctx.request(acpV1.AGENT_METHODS.session_new, { cwd, mcpServers: [] });
      await ctx.request(acpV1.AGENT_METHODS.session_prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'run it' }],
      });
    });

  return { permissionRequests, agent };
}

let priorProjectDir: string | undefined;
let priorInitCwd: string | undefined;

beforeEach(() => {
  priorProjectDir = peekProjectDir();
  priorInitCwd = process.env.INIT_CWD;
  setProjectDir(projectDir);
  // A DIFFERENT directory from any workspace, so a loader reading the ambient cwd would find the
  // wrong config rather than accidentally agreeing with the right answer.
  process.env.INIT_CWD = projectDir;
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  // The production loader assigns INIT_CWD, a process-global that outlives the connection.
  if (priorInitCwd === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = priorInitCwd;
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

describe('the command an ACP session resolves under', () => {
  it('is code under default config, and the editor gets the do-the-job tools', async () => {
    const agent = await v2Session(workspaceWith('v2-default'));

    expect(agent.seenCommand).toBe('code');
    // The two tools an editor session was missing: the shell, and any way to change a file.
    expect(agent.toolNames).toContain(SHELL_TOOL_NAME);
    expect(agent.toolNames).toContain(WRITE_FILE_TOOL_NAME);
  });

  it('is chat when the config says so, and the editor gets a read-only agent', async () => {
    const agent = await v2Session(workspaceWith('v2-chat', { acp: { mode: 'chat' } }));

    expect(agent.seenCommand).toBe('chat');
    expect(agent.toolNames).not.toContain(SHELL_TOOL_NAME);
    expect(agent.toolNames).not.toContain(WRITE_FILE_TOOL_NAME);
    // Still an agent, just one that can only look: the read tools survive the mode.
    expect(agent.toolNames).toContain('read_file');
  });

  /**
   * The v1 app resolves its own sessions, so without a cell of its own it could keep a hardcoded
   * command while v2 was fixed and nothing would say so. Zed speaks v1 today, which makes this the
   * dialect the product decision is actually about.
   */
  it('is the same in the v1 dialect, which cannot be allowed to drift from v2', async () => {
    const agent = await v1Session(workspaceWith('v1-default'));

    expect(agent.seenCommand).toBe('code');
    expect(agent.toolNames).toContain(SHELL_TOOL_NAME);
  });

  it('honours acp.mode in the v1 dialect too', async () => {
    const agent = await v1Session(workspaceWith('v1-chat', { acp: { mode: 'chat' } }));

    expect(agent.seenCommand).toBe('chat');
    expect(agent.toolNames).not.toContain(SHELL_TOOL_NAME);
    // As in the v2 twin: an EMPTY resolution would satisfy the absence above, so the cell needs
    // something present to prove tools resolved at all. The root default `filesystem` is `none`;
    // only the `commands.chat` fold produces read tools, so this also proves the fold ran.
    expect(agent.toolNames).toContain('read_file');
  });
});

describe('the approvals gate on an ACP session under default config', () => {
  /**
   * The half that makes the editor's approve/deny flow performable at all.
   *
   * No `approvals` key anywhere, so the rung is `assisted` — which does not ask outright, it asks
   * the rater and escalates what the rater will not clear. With nothing able to rate the command
   * the gate fails closed to `destructive`, and `destructive` at `assisted` is an escalation: the
   * request reaches the client.
   */
  it('reaches session/request_permission when the command cannot be cleared', async () => {
    const { permissionRequests, agent } = await gatedTurn(
      workspaceWith('gate-unrated'),
      raterModel(),
      () => ({ outcome: 'selected', optionId: 'reject-once' }) as acpV2.RequestPermissionOutcome
    );

    expect(permissionRequests).toHaveLength(1);
    expect(JSON.stringify(permissionRequests[0])).toContain('echo hi');
    // `reject-once` is one of the four ids the agent OFFERS, and the message pins which arm of
    // `decisionForOutcome` ran: its unknown-option fallback also returns `type: 'reject'`, so a
    // type-only assertion cannot tell "the user said no" from "the client sent a bad id".
    expect(agent.decisions[0]).toEqual({
      type: 'reject',
      message: 'The user rejected this tool call.',
    });
  });

  /**
   * The same arm in **v1**, the dialect Zed speaks — see {@link gatedTurnV1}. Without this the
   * claim that an editor can now approve or deny a shell command is measured on the draft protocol
   * and inferred on the shipping one.
   */
  it('reaches session/request_permission in the v1 dialect too', async () => {
    const { permissionRequests, agent } = await gatedTurnV1(
      workspaceWith('gate-unrated-v1'),
      raterModel(),
      () => ({ outcome: 'selected', optionId: 'reject-once' }) as acpV1.RequestPermissionOutcome
    );

    expect(permissionRequests).toHaveLength(1);
    expect(JSON.stringify(permissionRequests[0])).toContain('echo hi');
    // v1 offers the same menu, and the request carries the tool call the client is already drawing.
    expect(permissionRequests[0].options.map((option) => option.optionId)).toEqual([
      'allow-once',
      'allow-always',
      'reject-once',
      'reject-always',
    ]);
    expect(agent.decisions[0]).toEqual({
      type: 'reject',
      message: 'The user rejected this tool call.',
    });
  });

  /**
   * And the other arm, or the first one would read as "the default rung always asks", which is
   * false and would make the next reader expect a prompt for every command. At `assisted` a `safe`
   * rating is the rater doing its job: the call runs and the client is never interrupted.
   */
  it('does not ask when the rater clears the command', async () => {
    const { permissionRequests, agent } = await gatedTurn(
      workspaceWith('gate-safe'),
      raterModel({ outcome: 'safe', reason: 'prints a string' })
    );

    expect(permissionRequests).toHaveLength(0);
    expect(agent.decisions[0]?.type).toBe('approve');
  });
});
