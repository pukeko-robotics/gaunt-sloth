/**
 * GS2-20 — `GthAgentRunner.resumeConversation`, the ONE seam `--resume <id>` and `/resume <id>`
 * share, asserted on a REAL lean agent over a REAL `node:sqlite` checkpointer.
 *
 * Two acceptance properties, each with its own control so neither can pass vacuously:
 *
 * 1. **The tool result crosses the restart.** A second runner instance, over the same database file
 *    but a fresh thread of its own, is pointed at the first runner's thread through the seam and its
 *    model then reads a tool result it never produced — a value only the tool knows, and the tool
 *    is counted so a silent re-run cannot fake it. The control is a third runner that does NOT
 *    resume and answers `NOTHING`.
 * 2. **The grants cross with it.** A session grant made in one runner, carried through the codec's
 *    shape, silences the prompt in the resumed runner; the control is a fresh runner that prompts.
 *
 * The rest pins the seam's contract: replacement (not accumulation) of session-scoped grants,
 * `always` mirrors left in place, the listener fired on every change but not on the resume itself,
 * and the runnable config's recursion limit surviving the thread swap.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import type { PendingToolInterrupt, ToolApprovalDecision } from '#src/core/types.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { openCheckpointSaver, type GthSqliteSaver } from '#src/history/checkpointSaver.js';
import {
  decodeConversationGrants,
  encodeConversationGrants,
  NO_CONVERSATION_GRANTS,
} from '#src/core/approvals/conversationGrants.js';

vi.mock('#src/core/shell/rater.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#src/core/shell/rater.js')>()),
  rateShellCommand: vi.fn(),
  mapVerdictToAction: vi.fn(),
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

/** The value only the tool knows. Nothing else in the graph can produce it. */
const SECRET = 'ORBIT-4417';
/** What the model answers when the state it was handed contains no tool result at all. */
const NOTHING = 'recall:NOTHING-IN-STATE';

/**
 * A model that reads its answer OUT of the messages it is given: asked to look up the code it calls
 * the tool once; asked anything else it reports the tool result it can see in state, or `NOTHING`.
 */
class RecallingModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted-recall';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const toolResult = [...messages].reverse().find((m) => ToolMessage.isInstance(m));
    const lastHuman = [...messages].reverse().find((m) => HumanMessage.isInstance(m));
    const ask = typeof lastHuman?.content === 'string' ? lastHuman.content : '';
    let message: AIMessage;
    if (ask.includes('look up the code')) {
      message = toolResult
        ? new AIMessage('looked it up')
        : new AIMessage({
            content: '',
            tool_calls: [{ name: 'lookup_code', args: {}, id: 'call-lookup' }],
          });
    } else {
      message = new AIMessage(toolResult ? `recall:${String(toolResult.content)}` : NOTHING);
    }
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

/** Requests `run_shell_command` with the next queued command, then concludes after the tool speaks. */
class ScriptedShellCallingModel extends BaseChatModel {
  private callSeq = 0;
  constructor(private readonly commands: string[]) {
    super({});
  }
  _llmType(): string {
    return 'scripted-shell';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const last = messages[messages.length - 1];
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('final answer')
      : new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'run_shell_command',
              args: { command: this.commands[Math.min(this.callSeq++, this.commands.length - 1)] },
              id: `call-${this.callSeq}`,
            },
          ],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

describe('GS2-20: GthAgentRunner.resumeConversation (real lean agent over node:sqlite)', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  type Runner = InstanceType<typeof GthAgentRunner>;

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
    // `write` gates the shell and consults no model, so a prompt here is the rung's doing alone.
    approvals: 'write',
  };

  // EXT-71 — clamp the anchor the persisted grant store resolves from, or an `always` grant made
  // below lands in the real project allow-list of whoever runs the suite.
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-resume-runner-spec-'));
  let priorProjectDir: string | undefined;
  let dir: string;
  let toolCalls: number;
  let executed: string[];
  const savers: GthSqliteSaver[] = [];

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    dir = mkdtempSync(join(tmpdir(), 'gsloth-resume-runner-'));
    toolCalls = 0;
    executed = [];
    savers.length = 0;
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    for (const saver of savers) saver.close();
    savers.length = 0;
    rmSync(dir, { recursive: true, force: true });
    setProjectDir(priorProjectDir);
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  const lookupCode = () =>
    tool(
      async () => {
        toolCalls++;
        return SECRET;
      },
      { name: 'lookup_code', description: 'Look up the code.', schema: z.object({}) }
    );

  const shellTool = () =>
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
    );

  /** A saver over the test's database file, registered for teardown. */
  const openSaver = (): GthSqliteSaver => {
    const saver = openCheckpointSaver(join(dir, 'history.db'));
    expect(saver).not.toBeNull();
    savers.push(saver!);
    return saver!;
  };

  const makeRunner = async (options: {
    model: BaseChatModel;
    tools: ReturnType<typeof tool>[];
    saver: BaseCheckpointSaver;
    threadId?: string;
    decide?: (pending: PendingToolInterrupt) => ToolApprovalDecision;
  }): Promise<{ runner: Runner; human: ReturnType<typeof vi.fn> }> => {
    const runner = new GthAgentRunner(vi.fn(), {
      resolveTools: vi.fn().mockResolvedValue(options.tools),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    const config = { ...BASE_CONFIG, llm: options.model } as unknown as GthConfig;
    await runner.init('code', config, options.saver, { threadId: options.threadId });
    const human = vi.fn(async (pending: PendingToolInterrupt) =>
      options.decide
        ? options.decide(pending)
        : { type: 'approve' as const, scope: 'once' as const }
    );
    runner.setToolApprovalCallback(human as never);
    return { runner, human };
  };

  const threadOf = (runner: Runner): string | undefined =>
    (runner as unknown as { runConfig: { configurable?: { thread_id?: string } } }).runConfig
      .configurable?.thread_id;

  const recursionLimitOf = (runner: Runner): number | undefined =>
    (runner as unknown as { runConfig: { recursionLimit?: number } }).runConfig.recursionLimit;

  const say = (runner: Runner, text: string) => runner.processMessages([new HumanMessage(text)]);

  it('ACCEPTANCE: a second runner resumed through the seam reads a tool result the first one produced', async () => {
    const storedThread = 'thread-from-session-one';

    // Session one: the model calls the tool; the graph state under `storedThread` now holds SECRET.
    const first = openSaver();
    const one = await makeRunner({
      model: new RecallingModel(),
      tools: [lookupCode()],
      saver: first,
      threadId: storedThread,
    });
    await say(one.runner, 'look up the code');
    expect(toolCalls).toBe(1);
    first.close();

    // Session two: a NEW saver over the same file, a NEW runner on a thread of its own — exactly
    // how a fresh `gth code` process boots — then the seam points it at the stored thread.
    const second = openSaver();
    const two = await makeRunner({
      model: new RecallingModel(),
      tools: [lookupCode()],
      saver: second,
    });
    const ownThread = threadOf(two.runner);
    expect(ownThread).toBeDefined();
    expect(ownThread).not.toBe(storedThread);

    two.runner.resumeConversation({ threadId: storedThread, grants: NO_CONVERSATION_GRANTS });
    expect(threadOf(two.runner)).toBe(storedThread);

    const answer = await say(two.runner, 'what was the code');
    // The tool result reached the second process's model from the CHECKPOINT — the tool was not
    // run again — which is the whole requirement.
    expect(answer).toContain(`recall:${SECRET}`);
    expect(toolCalls).toBe(1);

    // CONTROL: a third runner over the same database that does NOT resume has nothing to recall.
    const three = await makeRunner({
      model: new RecallingModel(),
      tools: [lookupCode()],
      saver: second,
    });
    expect(await say(three.runner, 'what was the code')).toContain(NOTHING);
  });

  it('the resumed thread keeps writing where it reads: a turn after the resume is visible to the next resume', async () => {
    const storedThread = 'thread-grows';
    const saver = openSaver();
    const one = await makeRunner({
      model: new RecallingModel(),
      tools: [lookupCode()],
      saver,
      threadId: storedThread,
    });
    await say(one.runner, 'hello'); // no tool yet: state holds NOTHING worth recalling

    const two = await makeRunner({ model: new RecallingModel(), tools: [lookupCode()], saver });
    two.runner.resumeConversation({ threadId: storedThread, grants: NO_CONVERSATION_GRANTS });
    await say(two.runner, 'look up the code'); // the tool runs INSIDE the resumed conversation

    const three = await makeRunner({ model: new RecallingModel(), tools: [lookupCode()], saver });
    three.runner.resumeConversation({ threadId: storedThread, grants: NO_CONVERSATION_GRANTS });
    expect(await say(three.runner, 'what was the code')).toContain(`recall:${SECRET}`);
    expect(toolCalls).toBe(1);
  });

  it('ACCEPTANCE: a session grant restored through the seam silences the prompt; a fresh runner still asks', async () => {
    // Conversation one: the human grants `git status` for the session.
    const one = await makeRunner({
      model: new ScriptedShellCallingModel(['git status']),
      tools: [shellTool()],
      saver: new MemorySaver(),
      decide: () => ({ type: 'approve', scope: 'session' }),
    });
    await say(one.runner, 'status please');
    expect(one.human).toHaveBeenCalledTimes(1);
    // What the session layer writes against the conversation row, round-tripped through the codec
    // so this test covers the same bytes a resume reads.
    const stored = decodeConversationGrants(
      encodeConversationGrants(one.runner.getSessionScopedGrants())
    );
    expect(stored.allow).toHaveLength(1);

    // CONTROL: a fresh runner — a new process with no resume — prompts for the same command.
    const fresh = await makeRunner({
      model: new ScriptedShellCallingModel(['git status']),
      tools: [shellTool()],
      saver: new MemorySaver(),
    });
    await say(fresh.runner, 'status please');
    expect(fresh.human).toHaveBeenCalledTimes(1);

    // The resumed runner: same fresh process, grants restored through the seam, no prompt.
    const resumed = await makeRunner({
      model: new ScriptedShellCallingModel(['git status']),
      tools: [shellTool()],
      saver: new MemorySaver(),
    });
    resumed.runner.resumeConversation({ threadId: 'thread-x', grants: stored });
    await say(resumed.runner, 'status please');
    expect(resumed.human).not.toHaveBeenCalled();
    expect(executed).toEqual(['git status', 'git status', 'git status']);
  });

  it('a restored session REFUSAL bites too: the refused command never reaches a person', async () => {
    const one = await makeRunner({
      model: new ScriptedShellCallingModel(['rm -rf build']),
      tools: [shellTool()],
      saver: new MemorySaver(),
      decide: () => ({ type: 'reject', scope: 'session' }),
    });
    await say(one.runner, 'clean');
    const stored = one.runner.getSessionScopedGrants();
    expect(stored.deny).toHaveLength(1);
    expect(stored.allow).toEqual([]);

    const resumed = await makeRunner({
      model: new ScriptedShellCallingModel(['rm -rf build']),
      tools: [shellTool()],
      saver: new MemorySaver(),
    });
    resumed.runner.resumeConversation({ threadId: 'thread-y', grants: stored });
    await say(resumed.runner, 'clean');
    expect(resumed.human).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
    expect(resumed.runner.getRefusals().map((r) => r.description)).toEqual(['rm -rf build']);
  });

  it('REPLACES the session-scoped grants rather than adding to them, and leaves `always` mirrors in place', async () => {
    const { runner, human } = await makeRunner({
      model: new ScriptedShellCallingModel(['ls -la', 'pwd']),
      tools: [shellTool()],
      saver: new MemorySaver(),
      decide: (pending) =>
        pending.args.command === 'ls -la'
          ? { type: 'approve', scope: 'session' }
          : { type: 'approve', scope: 'always' },
    });
    await say(runner, 'list'); // ls -la → session grant
    await say(runner, 'where'); // pwd → always grant (project allow-list under the clamped dir)
    expect(human).toHaveBeenCalledTimes(2);
    expect(runner.getSessionScopedGrants().allow.map((g) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'ls -la' },
    ]);
    const before = runner.getGrants();
    expect(before.map((g) => [g.scope, (g.entry as { pattern: string }).pattern])).toEqual([
      ['session', 'ls -la'],
      ['always', 'pwd'],
    ]);

    runner.resumeConversation({
      threadId: 'thread-other',
      grants: {
        allow: [
          {
            entry: { type: 'shell', matcher: 'exact', pattern: 'git log' },
            grantedAt: '2026-01-01T00:00:00.000Z',
            scope: 'session',
          },
        ],
        deny: [],
      },
    });

    const after = runner.getGrants();
    // `ls -la` (this session's grant, made in the conversation being LEFT) is gone; the restored
    // `git log` is in; the `always` mirror of the project file is untouched.
    expect(after.map((g) => [g.scope, (g.entry as { pattern: string }).pattern])).toEqual([
      ['always', 'pwd'],
      ['session', 'git log'],
    ]);
    expect(
      runner.getSessionScopedGrants().allow.map((g) => (g.entry as { pattern: string }).pattern)
    ).toEqual(['git log']);
  });

  it('stamps every restored grant `session`, whatever the document claimed', async () => {
    const { runner } = await makeRunner({
      model: new ScriptedShellCallingModel(['ls']),
      tools: [shellTool()],
      saver: new MemorySaver(),
    });
    runner.resumeConversation({
      threadId: 't',
      grants: {
        allow: [
          {
            entry: { type: 'shell', matcher: 'exact', pattern: 'ls' },
            grantedAt: '2026-01-01T00:00:00.000Z',
            scope: 'always',
          },
        ],
        deny: [
          {
            entry: { type: 'shell', matcher: 'exact', pattern: 'rm' },
            grantedAt: '2026-01-01T00:00:00.000Z',
            scope: 'always',
          },
        ],
      },
    });
    expect(runner.getGrants().map((g) => g.scope)).toEqual(['session']);
    expect(runner.getRefusals().map((r) => r.origin)).toEqual(['session']);
  });

  it('fires the grants listener on approve, refuse and lift — and NOT on the resume itself', async () => {
    const { runner } = await makeRunner({
      model: new ScriptedShellCallingModel(['echo a', 'echo b']),
      tools: [shellTool()],
      saver: new MemorySaver(),
      decide: (pending) =>
        pending.args.command === 'echo a'
          ? { type: 'approve', scope: 'session' }
          : { type: 'reject', scope: 'session' },
    });
    const listener = vi.fn();
    runner.setSessionGrantsListener(listener);

    await say(runner, 'one'); // echo a approved for the session
    expect(listener).toHaveBeenCalledTimes(1);
    await say(runner, 'two'); // echo b refused for the session
    expect(listener).toHaveBeenCalledTimes(2);

    runner.liftRefusal(1);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(runner.getSessionScopedGrants().deny).toEqual([]);

    runner.resumeConversation({ threadId: 'elsewhere', grants: NO_CONVERSATION_GRANTS });
    expect(listener).toHaveBeenCalledTimes(3);

    // A listener that throws is not the gate's problem: the grant still lands. The script repeats
    // its last command (`echo b`), whose refusal was lifted above, so it prompts again.
    runner.setSessionGrantsListener(() => {
      throw new Error('disk full');
    });
    runner.setToolApprovalCallback((async () => ({ type: 'approve', scope: 'session' })) as never);
    await expect(say(runner, 'three')).resolves.toContain('final answer');
    expect(
      runner.getSessionScopedGrants().allow.map((g) => (g.entry as { pattern: string }).pattern)
    ).toContain('echo b');

    runner.setSessionGrantsListener(null);
  });

  it('keeps the recursion limit and the rest of the runnable config across the thread swap', async () => {
    const { runner } = await makeRunner({
      model: new RecallingModel(),
      tools: [lookupCode()],
      saver: new MemorySaver(),
      threadId: 'original',
    });
    const limit = recursionLimitOf(runner);
    expect(limit).toBeGreaterThan(0);
    runner.resumeConversation({ threadId: 'stored', grants: NO_CONVERSATION_GRANTS });
    expect(threadOf(runner)).toBe('stored');
    expect(recursionLimitOf(runner)).toBe(limit);
  });
});
