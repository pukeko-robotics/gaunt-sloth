/**
 * GS2-20 fix round, finding 3 — **the composed path, with nothing faked**: the seam module
 * (`resolveResumeTarget` → `applyResumeTarget`), a real `GthAgentRunner` over a real lean agent,
 * and a real history store and checkpointer over one SQLite file.
 *
 * The runner spec proves the runner's half by calling `resumeConversation` directly; every session
 * spec mocks the runner. Neither composes them, so a seam that resolved correctly and applied to
 * nothing — or applied to a runner it never reached — would pass both. What is asserted here is
 * ruling 1 end to end: the tool result recorded in "process one" is in the model's input in
 * "process two" because the seam put it there, with a control that has no seam and sees nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { openSessionCheckpointerSafe } from '@gaunt-sloth/core/history/sessionCheckpointer.js';
import {
  openConversationSafe,
  recordSessionSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import { saveConversationGrantsSafe } from '@gaunt-sloth/core/core/approvals/conversationGrants.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { applyResumeTarget, resolveResumeTarget } from '#src/modules/sessionResume.js';

vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>()),
  buildSystemMessages: vi.fn(() => [{ content: 'SYSTEM PROMPT' }]),
}));

/** The value only the tool knows; nothing else in the graph can produce it. */
const SECRET = 'ORBIT-4417';
/** What the model answers when the state it was handed holds no tool result at all. */
const NOTHING = 'recall:NOTHING-IN-STATE';

/** Calls the tool when asked to look the code up; otherwise reports the tool result it can see. */
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

describe('GS2-20: the seam module composed with a real runner over a real store', () => {
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
    approvals: 'write',
  };

  // EXT-71 — clamp the anchor the persisted grant store resolves from, so nothing here can reach
  // the allow-list of whoever runs the suite.
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-resume-composed-project-'));
  let priorProjectDir: string | undefined;
  let dir: string;
  let dbPath: string;
  let config: GthConfig & { history: { dbPath: string } };
  let toolCalls: number;
  const closers: Array<() => void> = [];

  beforeEach(() => {
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    dir = mkdtempSync(join(tmpdir(), 'gsloth-resume-composed-'));
    dbPath = join(dir, 'history.db');
    toolCalls = 0;
    config = { ...BASE_CONFIG, history: { dbPath } } as unknown as GthConfig & {
      history: { dbPath: string };
    };
  });
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    rmSync(dir, { recursive: true, force: true });
    setProjectDir(priorProjectDir);
  });
  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** A session's checkpointer over the test's database, closed on teardown. */
  const openCheckpointer = () => {
    const checkpointer = openSessionCheckpointerSafe(config, { notify: () => {} });
    closers.push(() => checkpointer.close());
    expect(checkpointer.durable).toBe(true);
    return checkpointer;
  };

  const lookupCode = () =>
    tool(
      async () => {
        toolCalls++;
        return SECRET;
      },
      { name: 'lookup_code', description: 'Look up the code.', schema: z.object({}) }
    );

  /** A runner as a session builds one: the lean agent, this session's saver and its own thread. */
  const startRunner = async (saver: unknown, threadId: string) => {
    const runner = new GthAgentRunner(vi.fn(), {
      resolveTools: vi.fn().mockResolvedValue([lookupCode()]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    await runner.init(
      'code',
      { ...config, llm: new RecallingModel() } as unknown as GthConfig,
      saver as never,
      { threadId }
    );
    // The `write` rung gates a custom tool, and a runner with no human wired refuses outright —
    // approvals are not this file's subject, so one is wired and answers once, as a session's
    // dialog would. What crosses the resume is the tool's RESULT, not the approval.
    runner.setToolApprovalCallback(
      vi.fn(async () => ({ type: 'approve' as const, scope: 'once' as const })) as never
    );
    closers.push(() => void runner.cleanup());
    return runner;
  };

  const say = (runner: GthAgentRunner, text: string) =>
    runner.processMessages([new HumanMessage(text)]);

  it('ACCEPTANCE: a tool result recorded in one process reaches the next process model through resolve + apply', async () => {
    // ── Process one: a real session records a real tool result under a real conversation row.
    const one = openCheckpointer();
    const conversationId = openConversationSafe(config, {
      command: 'code',
      project: projectDir,
      model: 'scripted-recall',
      threadId: one.threadId,
    })!;
    const first = await startRunner(one.saver, one.threadId);
    await say(first, 'look up the code');
    expect(toolCalls).toBe(1);
    recordSessionSafe(config, {
      conversationId,
      command: 'code',
      prompt: 'look up the code',
      response: 'looked it up',
    });
    one.close();

    // ── Process two: a fresh checkpointer and a fresh runner on a thread of its own, then the
    // seam — resolve the stored conversation, apply it — and nothing else.
    const two = openCheckpointer();
    const second = await startRunner(two.saver, two.threadId);
    const resolution = await resolveResumeTarget(
      { config, checkpointer: two, workspace: projectDir },
      conversationId
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.target.threadId).toBe(one.threadId);
    await applyResumeTarget({ runner: second, checkpointer: two }, resolution.target);

    const answer = await say(second, 'what was the code');
    expect(answer).toContain(`recall:${SECRET}`);
    // The tool did not run again: what the model read came from the checkpoint.
    expect(toolCalls).toBe(1);

    // ── CONTROL: a third runner over the same database that never goes through the seam.
    const three = await startRunner(two.saver, two.threadId + '-control');
    expect(await say(three, 'what was the code')).toContain(NOTHING);
  });

  it('the conversation grants cross with it: what the row holds is what the resumed runner holds', async () => {
    const one = openCheckpointer();
    const conversationId = openConversationSafe(config, {
      command: 'code',
      project: projectDir,
      threadId: one.threadId,
    })!;
    const first = await startRunner(one.saver, one.threadId);
    await say(first, 'look up the code');
    recordSessionSafe(config, {
      conversationId,
      command: 'code',
      prompt: 'look up the code',
      response: 'looked it up',
    });
    saveConversationGrantsSafe(config, conversationId, {
      allow: [
        {
          entry: { type: 'shell', matcher: 'exact', pattern: 'git status' },
          grantedAt: '2026-09-01T10:00:00.000Z',
          scope: 'session',
        },
      ],
      deny: [
        {
          entry: { type: 'shell', matcher: 'exact', pattern: 'rm -rf build' },
          grantedAt: '2026-09-01T10:00:00.000Z',
          scope: 'session',
        },
      ],
    });
    one.close();

    const two = openCheckpointer();
    const second = await startRunner(two.saver, two.threadId);
    // CONTROL — before the seam, the fresh runner holds nothing.
    expect(second.getSessionScopedGrants()).toEqual({ allow: [], deny: [] });

    const resolution = await resolveResumeTarget(
      { config, checkpointer: two, workspace: projectDir },
      conversationId
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    await applyResumeTarget({ runner: second, checkpointer: two }, resolution.target);

    const held = second.getSessionScopedGrants();
    expect(held.allow.map((g) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'git status' },
    ]);
    expect(held.deny.map((g) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'rm -rf build' },
    ]);
  });

  it('a runner that is not idle refuses through the composed path too, and nothing is bound', async () => {
    const one = openCheckpointer();
    const conversationId = openConversationSafe(config, {
      command: 'code',
      project: projectDir,
      threadId: one.threadId,
    })!;
    const first = await startRunner(one.saver, one.threadId);
    await say(first, 'look up the code');
    recordSessionSafe(config, {
      conversationId,
      command: 'code',
      prompt: 'p',
      response: 'r',
    });

    const resolution = await resolveResumeTarget(
      { config, checkpointer: one, workspace: projectDir },
      conversationId
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // The runner's guard reaches the caller as a rejection of the apply — which is what lets both
    // session surfaces report it as "Resume did not happen" instead of half-moving.
    const busy = {
      resumeConversation: async () => {
        throw new Error('A turn is still running; wait for it to finish before resuming.');
      },
    };
    const bindConversation = vi.fn();
    await expect(
      applyResumeTarget({ runner: busy, checkpointer: { bindConversation } }, resolution.target)
    ).rejects.toThrow(/turn is still running/);
    expect(bindConversation).not.toHaveBeenCalled();
  });
});
