/**
 * GS2-107 — the retention policy asserted at its BOUNDARY, on a REAL lean agent over a REAL
 * `node:sqlite` file, composed the way `resumeConversationRunner.spec.ts` (GS2-20) composes a
 * resume. "Rows disappeared" is not the property under test; "the conversation reclamation left
 * alone still resumes, with the tool result it had" is.
 *
 * Three things are pinned here, each with a control that must fail:
 *
 * 1. **The boundary holds.** A conversation a row names survives a reclamation pass that deletes an
 *    orphan thread of the same age, and a fresh runner resumed onto it reads a `ToolMessage` the
 *    first runner produced. The control is the orphan: it was deleted, and a runner pointed at it
 *    answers from nothing.
 * 2. **The `parentConfig` walk finding.** The node supposed that truncating the middle of a thread
 *    could leave "the transcript is there but the tool result is missing". Measured here: it cannot,
 *    for this graph, because `channelsFromCheckpoint` walks ancestors only for a `DeltaChannel`
 *    absent from `channel_values` and this state schema has none — `getDeltaChannelHistory` is never
 *    called on a resume. The control is deleting the whole thread, which DOES break the resume.
 *    The whole-thread rule stands regardless; this records why it is not the walk that forces it.
 * 3. **Where reclamation is hooked.** The session checkpointer reclaims on the orderly close of a
 *    session that actually ran, and not on the close of one that never got past the resume checks.
 *
 * Every path here uses a temp `history.dbPath`. Nothing resolves a path from `HOME`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { openCheckpointSaver, type GthSqliteSaver } from '#src/history/checkpointSaver.js';
import { openHistoryStore } from '#src/history/historyStore.js';
import { openSessionCheckpointerSafe } from '#src/history/sessionCheckpointer.js';
import { NO_CONVERSATION_GRANTS } from '#src/core/approvals/conversationGrants.js';

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
/** What the model answers when the state it was handed holds no tool result at all. */
const NOTHING = 'recall:NOTHING-IN-STATE';

/** Reads its answer OUT of the messages it is handed — so the answer is evidence about state. */
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

const DAY = 24 * 60 * 60 * 1000;

describe('GS2-107 — retention at the policy boundary, on a real runner', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GthAgentRunner: any;
  const BASE_CONFIG = {
    llm: undefined,
    contentProvider: 'file',
    requirementsProvider: 'file',
    projectGuidelines: '.gsloth.guidelines.md',
    projectReviewInstructions: '.gsloth.review.md',
    commands: {},
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: false,
    writeBinaryOutputsToFile: false,
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: true,
    approvals: 'write',
  };

  const projectDir = mkdtempSync(join(tmpdir(), 'gth-retention-project-'));
  let priorProjectDir: string | undefined;
  let dir: string;
  let dbPath: string;
  let toolCalls: number;
  const savers: GthSqliteSaver[] = [];

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    dir = mkdtempSync(join(tmpdir(), 'gsloth-retention-resume-'));
    dbPath = join(dir, 'history.db');
    toolCalls = 0;
    savers.length = 0;
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
    // Both halves of the schema, created the way the product creates them: the store owns
    // `conversations`, the saver owns `checkpoints`.
    openHistoryStore(dbPath, { create: true })!.close();
  });

  afterEach(() => {
    for (const saver of savers) saver.close();
    savers.length = 0;
    rmSync(dir, { recursive: true, force: true });
    setProjectDir(priorProjectDir);
  });

  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  const lookupCode = () =>
    tool(
      async () => {
        toolCalls++;
        return SECRET;
      },
      { name: 'lookup_code', description: 'Look up the code.', schema: z.object({}) }
    );

  const openSaver = (): GthSqliteSaver => {
    const saver = openCheckpointSaver(dbPath);
    expect(saver).not.toBeNull();
    savers.push(saver!);
    return saver!;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeRunner = async (saver: unknown, threadId?: string): Promise<any> => {
    const runner = new GthAgentRunner(vi.fn(), {
      resolveTools: vi.fn().mockResolvedValue([lookupCode()]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    const config = { ...BASE_CONFIG, llm: new RecallingModel() } as unknown as GthConfig;
    await runner.init('code', config, saver, { threadId });
    runner.setToolApprovalCallback(
      vi.fn(async () => ({ type: 'approve' as const, scope: 'once' as const }))
    );
    return runner;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const say = (runner: any, text: string): Promise<string> =>
    runner.processMessages([new HumanMessage(text)]);

  /** A conversation row naming `threadId`, exactly as an interactive session opens one. */
  const nameThread = (threadId: string, command = 'code'): number => {
    const store = openHistoryStore(dbPath, { create: true })!;
    const id = store.openConversation({ command, project: projectDir, threadId })!;
    store.record({ conversationId: id, command, prompt: 'p', response: 'r' });
    store.close();
    return id;
  };

  const countCheckpoints = (threadId: string): number => {
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?`)
      .get(threadId) as Record<string, unknown>;
    db.close();
    return Number(row.n);
  };

  it('ACCEPTANCE: reclamation deletes the thread no conversation names and leaves the named one resumable, tool result and all', async () => {
    const named = 'thread-named-by-a-conversation';
    const orphan = 'thread-nothing-names';

    // Two real sessions, one of each kind, both with a completed tool call in their state.
    const first = openSaver();
    await say(await makeRunner(first, named), 'look up the code');
    await say(await makeRunner(first, orphan), 'look up the code');
    expect(toolCalls).toBe(2);
    nameThread(named);
    first.close();

    expect(countCheckpoints(named)).toBeGreaterThan(0);
    expect(countCheckpoints(orphan)).toBeGreaterThan(0);

    // A pass from far enough in the future that BOTH threads are past the grace window — so what
    // protects the named one is the predicate, not its age.
    const sweeper = openSaver();
    const removed = sweeper.reclaimUnresumableThreads({ now: Date.now() + 30 * DAY });
    expect(removed.threadCount).toBe(1);
    expect(removed.checkpointCount).toBeGreaterThan(0);
    expect(countCheckpoints(orphan)).toBe(0);
    expect(countCheckpoints(named)).toBeGreaterThan(0);

    // THE PROPERTY: a fresh runner — a new process, its own thread — resumed onto the surviving
    // conversation is handed the tool result the first session produced. Not "the rows are there":
    // the model answers with a value only the tool knew, and the tool is not run again.
    const second = openSaver();
    const resumed = await makeRunner(second);
    await resumed.resumeConversation({ threadId: named, grants: NO_CONVERSATION_GRANTS });
    expect(await say(resumed, 'what was the code')).toContain(`recall:${SECRET}`);
    expect(toolCalls).toBe(2);

    // CONTROL: the same move onto the thread reclamation DID delete answers from nothing, which is
    // what makes the assertion above about state rather than about the model.
    const control = await makeRunner(second);
    await control.resumeConversation({ threadId: orphan, grants: NO_CONVERSATION_GRANTS });
    expect(await say(control, 'what was the code')).toContain(NOTHING);
  });

  it('a conversation whose thread link was CUT loses its protection, and a resume of it was already refused', async () => {
    const thread = 'thread-write-failed';
    const saver = openSaver();
    await say(await makeRunner(saver, thread), 'look up the code');
    const conversationId = nameThread(thread);
    saver.close();

    // What `clearConversationThread` writes when a checkpoint write fails mid-session. From here the
    // conversation names no thread — `getConversationThreadId` answers null, which is the refusal
    // every resume path already makes, proven behaviourally in the agent package's own spec.
    const store = openHistoryStore(dbPath)!;
    store.clearConversationThread(conversationId);
    expect(store.getConversationThreadId(conversationId)).toBeNull();
    store.close();

    const sweeper = openSaver();
    const removed = sweeper.reclaimUnresumableThreads({ now: Date.now() + 30 * DAY });
    expect(removed.threadCount).toBe(1);
    expect(countCheckpoints(thread)).toBe(0);
  });

  describe('the parentConfig walk — the node`s supposition, measured', () => {
    it('a hole in the MIDDLE of a thread does not break the resume: the ancestor walk is never reached', async () => {
      const thread = 'thread-with-a-hole';
      const first = openSaver();
      const one = await makeRunner(first, thread);
      await say(one, 'look up the code');
      await say(one, 'and again');
      await say(one, 'a third super-step');
      nameThread(thread);
      first.close();

      const db = new DatabaseSync(dbPath);
      const ids = (
        db
          .prepare(
            `SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id ASC`
          )
          .all(thread) as Record<string, unknown>[]
      ).map((r) => String(r.checkpoint_id));
      expect(ids.length).toBeGreaterThan(4);
      const middle = ids[Math.floor(ids.length / 2)];
      db.prepare(`DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id = ?`).run(
        thread,
        middle
      );
      db.prepare(`DELETE FROM checkpoint_writes WHERE thread_id = ? AND checkpoint_id = ?`).run(
        thread,
        middle
      );
      db.close();

      // Count the ancestor walk directly: `channelsFromCheckpoint` calls this only for a
      // `DeltaChannel` missing from `channel_values`, and this graph's `messages` is a
      // `BinaryOperatorAggregate` whose full array is in every checkpoint. Zero calls is the reason
      // a middle hole cannot produce "transcript present, tool result missing".
      const second = openSaver();
      let deltaWalks = 0;
      const original = second.getDeltaChannelHistory.bind(second);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (second as any).getDeltaChannelHistory = async (options: unknown) => {
        deltaWalks++;
        return original(options as never);
      };

      const resumed = await makeRunner(second);
      await resumed.resumeConversation({ threadId: thread, grants: NO_CONVERSATION_GRANTS });
      expect(await say(resumed, 'what was the code')).toContain(`recall:${SECRET}`);
      expect(deltaWalks).toBe(0);
      expect(toolCalls).toBe(1);

      // CONTROL — the same resume once the whole thread is gone answers from nothing, so the
      // assertion above is about what the checkpoints hold and not about the model's habits.
      const db2 = new DatabaseSync(dbPath);
      db2.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(thread);
      db2.prepare(`DELETE FROM checkpoint_writes WHERE thread_id = ?`).run(thread);
      db2.close();
      const third = await makeRunner(second);
      await third.resumeConversation({ threadId: thread, grants: NO_CONVERSATION_GRANTS });
      expect(await say(third, 'what was the code')).toContain(NOTHING);
    });
  });

  describe('where the automatic reclamation is hooked', () => {
    const configFor = () => ({ history: { dbPath } }) as never;

    it('reclaims on the orderly close of a session that ran, using the connection it already had', async () => {
      // An old orphan, written by a session that is long gone.
      const stale = openSaver();
      await say(await makeRunner(stale, 'stale-orphan'), 'look up the code');
      stale.close();
      const db = new DatabaseSync(dbPath);
      // Age it past the grace window by rewriting the `ts` the saver stored — the field the age gate
      // reads, left exactly as the serializer shapes it.
      const rows = db
        .prepare(`SELECT checkpoint_id, checkpoint FROM checkpoints WHERE thread_id = 'stale-orphan'`)
        .all() as Record<string, unknown>[];
      const update = db.prepare(
        `UPDATE checkpoints SET checkpoint = ? WHERE thread_id = 'stale-orphan' AND checkpoint_id = ?`
      );
      for (const row of rows) {
        const body = JSON.parse(new TextDecoder().decode(row.checkpoint as Uint8Array)) as Record<
          string,
          unknown
        >;
        body.ts = new Date(Date.now() - 30 * DAY).toISOString();
        update.run(new TextEncoder().encode(JSON.stringify(body)), String(row.checkpoint_id));
      }
      db.close();
      expect(countCheckpoints('stale-orphan')).toBeGreaterThan(0);

      const checkpointer = openSessionCheckpointerSafe(configFor(), { notify: () => {} });
      expect(checkpointer.durable).toBe(true);
      checkpointer.bindConversation?.(1); // the session got past the resume checks and ran
      checkpointer.close();
      expect(countCheckpoints('stale-orphan')).toBe(0);
    });

    it('CONTROL: a checkpointer closed before the session ran — the --resume refusal path — deletes nothing', async () => {
      const stale = openSaver();
      await say(await makeRunner(stale, 'stale-orphan-2'), 'look up the code');
      stale.close();
      const db = new DatabaseSync(dbPath);
      const rows = db
        .prepare(
          `SELECT checkpoint_id, checkpoint FROM checkpoints WHERE thread_id = 'stale-orphan-2'`
        )
        .all() as Record<string, unknown>[];
      const update = db.prepare(
        `UPDATE checkpoints SET checkpoint = ? WHERE thread_id = 'stale-orphan-2' AND checkpoint_id = ?`
      );
      for (const row of rows) {
        const body = JSON.parse(new TextDecoder().decode(row.checkpoint as Uint8Array)) as Record<
          string,
          unknown
        >;
        body.ts = new Date(Date.now() - 30 * DAY).toISOString();
        update.run(new TextEncoder().encode(JSON.stringify(body)), String(row.checkpoint_id));
      }
      db.close();

      const checkpointer = openSessionCheckpointerSafe(configFor(), { notify: () => {} });
      // No `bindConversation`: this is the shape of a boot that refused the `--resume` id and left.
      checkpointer.close();
      expect(countCheckpoints('stale-orphan-2')).toBeGreaterThan(0);
    });

    it('does not reclaim twice, and a second close is harmless', async () => {
      const checkpointer = openSessionCheckpointerSafe(configFor(), { notify: () => {} });
      checkpointer.bindConversation?.(1);
      checkpointer.close();
      expect(() => checkpointer.close()).not.toThrow();
    });
  });
});
