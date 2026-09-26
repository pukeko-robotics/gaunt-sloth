/**
 * GS2-106 — a single-shot run checkpoints DURABLY when it is recorded, on a REAL lean agent over a
 * REAL `node:sqlite` file.
 *
 * The property under test is the one a transcript replay cannot have: the recorded conversation
 * links a thread whose stored state holds the TOOL RESULT the run produced, not only the prompt and
 * the answer. The rest pins the fail-soft half: a store that will not open, and a checkpoint write
 * that fails mid-run, must leave the run's output exactly as it was and leave the conversation
 * unresumable rather than truncated. Retention is asserted at its boundary: a linked single-shot
 * thread survives the automatic pass, and the same thread with its link cut does not.
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
import type { AgentResolvers } from '#src/core/types.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { openHistoryStore } from '#src/history/historyStore.js';
import * as consoleUtils from '#src/utils/consoleUtils.js';

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
    displayNotice: vi.fn(),
    displayToolIndication: vi.fn(),
    defaultStatusCallback: vi.fn(),
  };
});

/**
 * The two faults a spec can inject into the saver `runSingleShot` opens, through the real module:
 * the open failing outright, and every write after the first one failing.
 */
const faults = vi.hoisted(() => ({ failOpen: false, failWritesAfterFirst: false }));
vi.mock('#src/history/checkpointSaver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/history/checkpointSaver.js')>();
  return {
    ...actual,
    openCheckpointSaver: (...args: Parameters<typeof actual.openCheckpointSaver>) => {
      if (faults.failOpen) return null;
      const saver = actual.openCheckpointSaver(...args);
      if (saver && faults.failWritesAfterFirst) {
        // One checkpoint lands, then the connection turns read-only: a real SQLite write failure
        // arriving MID-RUN, which the saver catches and reports through its degrade callback.
        const { db } = saver as unknown as { db: DatabaseSync };
        const put = saver.put.bind(saver);
        let puts = 0;
        saver.put = async (...putArgs: Parameters<typeof put>) => {
          const out = await put(...putArgs);
          if (++puts === 1) db.exec('PRAGMA query_only = 1');
          return out;
        };
      }
      return saver;
    },
  };
});

/** The value only the tool knows. Nothing else in the graph can produce it. */
const SECRET = 'ORBIT-4417';
const ANSWER = 'looked it up';

/** Calls the tool once, then answers. */
class LookupModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted-lookup';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const toolResult = messages.find((m) => ToolMessage.isInstance(m));
    const message = toolResult
      ? new AIMessage(ANSWER)
      : new AIMessage({
          content: '',
          tool_calls: [{ name: 'lookup_code', args: {}, id: 'call-lookup' }],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

const DAY = 24 * 60 * 60 * 1000;
/** A real graph over a real sqlite file costs seconds, not milliseconds; see the GS2-107 spec. */
const REAL_AGENT_TIMEOUT_MS = 30_000;

describe('GS2-106 — a recorded single-shot run checkpoints durably', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-singleshot-project-'));
  let priorProjectDir: string | undefined;
  let dir: string;
  let dbPath: string;
  let toolCalls: number;

  beforeEach(() => {
    vi.clearAllMocks();
    faults.failOpen = false;
    faults.failWritesAfterFirst = false;
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    dir = mkdtempSync(join(tmpdir(), 'gsloth-singleshot-durable-'));
    dbPath = join(dir, 'history.db');
    toolCalls = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setProjectDir(priorProjectDir);
  });

  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  const resolvers = (): AgentResolvers =>
    ({
      resolveTools: vi.fn().mockResolvedValue([
        tool(
          async () => {
            toolCalls++;
            return SECRET;
          },
          { name: 'lookup_code', description: 'Look up the code.', schema: z.object({}) }
        ),
      ]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    }) as unknown as AgentResolvers;

  const configFor = (history: Record<string, unknown> = { dbPath }): GthConfig =>
    ({
      llm: new LookupModel(),
      contentProvider: 'file',
      requirementsProvider: 'file',
      projectGuidelines: '.gsloth.guidelines.md',
      projectReviewInstructions: '.gsloth.review.md',
      commands: {},
      filesystem: 'none',
      useColour: false,
      streamOutput: true,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: false,
      canInterruptInferenceWithEsc: false,
      includeCurrentDateAfterGuidelines: true,
      approvals: 'bypass',
      modelDisplayName: 'scripted-lookup',
      history,
    }) as unknown as GthConfig;

  const run = async (config: GthConfig = configFor(), prompt = 'look up the code') => {
    const { runSingleShot } = await import('#src/runtime/singleShot.js');
    return runSingleShot('SINGLE-SHOT', '', prompt, config, resolvers(), 'ask');
  };

  /** Row counts of every table a recorded run writes to, read straight off the file. */
  const tableCounts = (): Record<string, number> => {
    const db = new DatabaseSync(dbPath);
    try {
      const out: Record<string, number> = {};
      for (const table of ['conversations', 'sessions', 'checkpoints', 'checkpoint_writes']) {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown>;
        out[table] = Number(r.n);
      }
      return out;
    } finally {
      db.close();
    }
  };

  const row = (conversationId: number): Record<string, unknown> | undefined => {
    const db = new DatabaseSync(dbPath);
    try {
      return db
        .prepare(`SELECT thread_id, run_id, command FROM conversations WHERE id = ?`)
        .get(conversationId) as Record<string, unknown> | undefined;
    } finally {
      db.close();
    }
  };

  const countWhere = (table: string, threadId: string): number => {
    const db = new DatabaseSync(dbPath);
    try {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = ?`)
        .get(threadId) as Record<string, unknown>;
      return Number(r.n);
    } finally {
      db.close();
    }
  };

  /** The messages in the newest checkpoint of `threadId`, read back through a fresh saver. */
  const latestMessages = async (threadId: string): Promise<BaseMessage[]> => {
    const { openCheckpointSaver } = await import('#src/history/checkpointSaver.js');
    const saver = openCheckpointSaver(dbPath)!;
    try {
      const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
      expect(tuple, 'the linked thread has a checkpoint').toBeDefined();
      return (tuple!.checkpoint.channel_values.messages ?? []) as BaseMessage[];
    } finally {
      saver.close();
    }
  };

  /** What went to stdout: everything `display` printed. The notices all go through stderr. */
  const stdoutLines = (): unknown[] => vi.mocked(consoleUtils.display).mock.calls.map((c) => c[0]);

  it(
    'ACCEPTANCE: the conversation links a thread whose stored state holds the tool result and the answer',
    async () => {
      const result = await run();

      expect(result.ok).toBe(true);
      expect(result.answer).toBe(ANSWER);
      expect(toolCalls).toBe(1);
      expect(result.conversation).toBeDefined();
      const { conversationId, runId } = result.conversation!;

      const stored = row(conversationId)!;
      expect(stored.command).toBe('ask');
      expect(typeof stored.thread_id).toBe('string');
      expect(stored.run_id).toBe(runId);
      expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const messages = await latestMessages(String(stored.thread_id));
      // The tool result is what a replayed transcript cannot restore — assert it by its content.
      const toolResult = messages.find((m) => ToolMessage.isInstance(m));
      expect(toolResult, 'the checkpoint holds the tool result').toBeDefined();
      expect(String(toolResult!.content)).toBe(SECRET);
      // And the final answer is in the NEWEST checkpoint, so nothing was still in flight when the
      // run closed the saver straight after it finished.
      const last = messages[messages.length - 1];
      expect(AIMessage.isInstance(last)).toBe(true);
      expect(last.content).toBe(ANSWER);
      expect(HumanMessage.isInstance(messages[0])).toBe(true);

      expect(consoleUtils.displayWarning).not.toHaveBeenCalled();
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'every run gets its own conversation, thread and run id',
    async () => {
      const a = await run();
      const b = await run();
      expect(a.conversation!.conversationId).not.toBe(b.conversation!.conversationId);
      expect(a.conversation!.runId).not.toBe(b.conversation!.runId);
      expect(row(a.conversation!.conversationId)!.thread_id).not.toBe(
        row(b.conversation!.conversationId)!.thread_id
      );
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'a store that will not open leaves the output unchanged and the conversation with no thread',
    async () => {
      // The control: the same run, healthy, so "unchanged" is compared against something.
      const control = await run();
      const controlStdout = stdoutLines();
      vi.clearAllMocks();

      faults.failOpen = true;
      const result = await run();

      expect(result.ok).toBe(true);
      expect(result.answer).toBe(control.answer);
      expect(stdoutLines()).toEqual(controlStdout);
      // Said once, on stderr, in terms of what it costs.
      expect(consoleUtils.displayWarning).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consoleUtils.displayWarning).mock.calls[0][0]).toContain('resumable');
      // Recorded, and honestly unresumable.
      expect(result.conversation).toBeDefined();
      expect(row(result.conversation!.conversationId)!.thread_id).toBeNull();
      expect(row(control.conversation!.conversationId)!.thread_id).not.toBeNull();
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'a checkpoint write failing mid-run cuts the link, and the run finishes with the same output',
    async () => {
      const control = await run();
      const controlStdout = stdoutLines();
      vi.clearAllMocks();

      faults.failWritesAfterFirst = true;
      const result = await run();

      // Two halves, asserted softly so a failure of one still reports the other.
      // The run half: it finishes, with the output the healthy run had and no error of its own.
      expect.soft(vi.mocked(consoleUtils.displayError).mock.calls).toEqual([]);
      expect.soft(result.ok).toBe(true);
      expect.soft(result.answer).toBe(control.answer);
      expect.soft(stdoutLines()).toEqual(controlStdout);
      // The link half: told once, and the conversation no longer names the truncated thread.
      expect(consoleUtils.displayWarning).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consoleUtils.displayWarning).mock.calls[0][0]).toContain('resumable');
      expect(result.conversation).toBeDefined();
      // The first checkpoint did land — so this is a TRUNCATED chain, the case the cut exists for.
      const threads = (() => {
        const db = new DatabaseSync(dbPath);
        try {
          return (
            db.prepare(`SELECT DISTINCT thread_id FROM checkpoints`).all() as Record<
              string,
              unknown
            >[]
          ).map((r) => String(r.thread_id));
        } finally {
          db.close();
        }
      })();
      const controlThread = String(row(control.conversation!.conversationId)!.thread_id);
      const truncated = threads.filter((t) => t !== controlThread);
      expect(truncated).toHaveLength(1);
      expect(countWhere('checkpoints', truncated[0])).toBeGreaterThan(0);
      // …and the conversation no longer names it.
      expect(row(result.conversation!.conversationId)!.thread_id).toBeNull();
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'retention keeps a linked single-shot thread, and reclaims the same thread once its link is cut',
    async () => {
      const kept = await run();
      const cut = await run();
      const keptThread = String(row(kept.conversation!.conversationId)!.thread_id);
      const cutThread = String(row(cut.conversation!.conversationId)!.thread_id);
      expect(countWhere('checkpoints', keptThread)).toBeGreaterThan(0);
      expect(countWhere('checkpoints', cutThread)).toBeGreaterThan(0);

      // The control: cut one link, exactly as a failed write would.
      const store = openHistoryStore(dbPath)!;
      store.clearConversationThread(cut.conversation!.conversationId);
      store.close();

      // The automatic pass, a month from now so the grace window is out of the picture.
      const { openCheckpointSaver } = await import('#src/history/checkpointSaver.js');
      const sweeper = openCheckpointSaver(dbPath)!;
      try {
        sweeper.reclaimUnresumableThreads({ now: Date.now() + 30 * DAY });
      } finally {
        sweeper.close();
      }

      expect(countWhere('checkpoints', keptThread)).toBeGreaterThan(0);
      expect(countWhere('checkpoints', cutThread)).toBe(0);
      expect((await latestMessages(keptThread)).some((m) => ToolMessage.isInstance(m))).toBe(true);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'ACCEPTANCE: with history.enabled false, a run writes no checkpoint rows and no conversation row',
    async () => {
      // The control, in the same file: a recorded run creates the store and writes every table, so
      // the counts below are read off a real database that a run with history on DOES write to.
      const control = await run();
      expect(control.conversation).toBeDefined();
      const before = tableCounts();
      expect(before.conversations).toBe(1);
      expect(before.checkpoints).toBeGreaterThan(0);
      vi.clearAllMocks();

      const result = await run(configFor({ dbPath, enabled: false }));

      expect(result.ok).toBe(true);
      expect(result.answer).toBe(ANSWER);
      expect(toolCalls).toBe(2);
      expect(result.conversation).toBeUndefined();
      expect(tableCounts()).toEqual(before);
      // Silent: history off is a choice, not a fault to be warned about.
      expect(consoleUtils.displayWarning).not.toHaveBeenCalled();
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'two runs at once on one database, as batch -j runs them, each keep their own conversation, thread and state',
    async () => {
      // `batch -j` runs its cells in one process, concurrently, through `runSingleShot` — which is
      // what Promise.all does here. Each run has its own prompt so its state can be told apart.
      const [a, b] = await Promise.all([
        run(configFor(), 'first concurrent prompt'),
        run(configFor(), 'second concurrent prompt'),
      ]);

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(toolCalls).toBe(2);
      expect(a.conversation!.conversationId).not.toBe(b.conversation!.conversationId);
      expect(a.conversation!.runId).not.toBe(b.conversation!.runId);
      const threadA = String(row(a.conversation!.conversationId)!.thread_id);
      const threadB = String(row(b.conversation!.conversationId)!.thread_id);
      expect(threadA).not.toBe(threadB);

      // Neither run's state landed under the other's thread: each newest checkpoint holds its OWN
      // prompt, its own tool result and its own answer, and only its own.
      for (const [thread, own, other] of [
        [threadA, 'first concurrent prompt', 'second concurrent prompt'],
        [threadB, 'second concurrent prompt', 'first concurrent prompt'],
      ] as const) {
        const messages = await latestMessages(thread);
        const humans = messages.filter((m) => HumanMessage.isInstance(m)).map((m) => m.content);
        expect(humans).toEqual([own]);
        expect(humans).not.toContain(other);
        expect(messages.filter((m) => ToolMessage.isInstance(m))).toHaveLength(1);
        expect(messages[messages.length - 1].content).toBe(ANSWER);
      }
      // And no checkpoint was written under a thread that no conversation names.
      const db = new DatabaseSync(dbPath);
      try {
        const threads = (
          db.prepare(`SELECT DISTINCT thread_id FROM checkpoints`).all() as Record<
            string,
            unknown
          >[]
        ).map((r) => String(r.thread_id));
        expect(threads.sort()).toEqual([threadA, threadB].sort());
      } finally {
        db.close();
      }
    },
    REAL_AGENT_TIMEOUT_MS
  );
});
