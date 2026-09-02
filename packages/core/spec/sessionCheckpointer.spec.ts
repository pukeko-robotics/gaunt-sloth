/**
 * GS2-20 — the bridge from config to the session's checkpointer.
 *
 * Three outcomes, and the difference between two of them is the whole point: history OFF is a
 * choice the user made and gets no notice, while a database that would not open is a promise the
 * product could not keep and must say so. The third — history on and the DB opens — is the one that
 * makes a session resumable at all.
 *
 * **It always returns a usable saver.** With a tool-approval interrupt installed and no checkpointer
 * at all, LangGraph throws MISSING_CHECKPOINTER on the first gated tool call, mid-turn, for reasons
 * a user cannot connect to anything they did. So the fallback is a MemorySaver, and these tests
 * drive a real graph through the fallback to prove the session still runs on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { openSessionCheckpointerSafe } from '#src/history/sessionCheckpointer.js';
import { lookupConversationThreadSafe, openConversationSafe } from '#src/history/recordSession.js';
import { GthSqliteSaver } from '#src/history/checkpointSaver.js';
import type { SessionCheckpointer } from '#src/history/sessionCheckpointer.js';

/** A model that answers with the number of messages it was handed, so state growth is observable. */
class CountingModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'counting';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const message = new AIMessage(`saw ${messages.length}`);
    return { generations: [{ message, text: message.content as string }] };
  }
}

/** Run one turn through a saver, returning the assistant's text. Proves the saver is usable. */
async function turn(checkpointer: SessionCheckpointer, text: string): Promise<string> {
  const agent = createAgent({
    model: new CountingModel(),
    tools: [],
    checkpointer: checkpointer.saver,
  });
  const result = await agent.invoke(
    { messages: [new HumanMessage(text)] },
    { configurable: { thread_id: checkpointer.threadId } }
  );
  const messages = result.messages as BaseMessage[];
  const last = messages[messages.length - 1];
  return typeof last.content === 'string' ? last.content : '';
}

describe('GS2-20: openSessionCheckpointerSafe', () => {
  let dir: string;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-sess-'));
    notify = vi.fn();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is DURABLE with no history config at all (the default run), silently', async () => {
    const dbPath = resolve(dir, 'history.db');
    const checkpointer = openSessionCheckpointerSafe({ history: { dbPath } }, { notify });

    expect(checkpointer.durable).toBe(true);
    expect(checkpointer.saver).toBeInstanceOf(GthSqliteSaver);
    expect(existsSync(dbPath)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(await turn(checkpointer, 'hello')).toBe('saw 1');
    checkpointer.close();
  });

  it('is IN MEMORY when history.enabled is false, writes no DB, and says nothing', async () => {
    const dbPath = resolve(dir, 'history.db');
    const checkpointer = openSessionCheckpointerSafe(
      { history: { enabled: false, dbPath } },
      { notify }
    );

    expect(checkpointer.durable).toBe(false);
    expect(checkpointer.saver).toBeInstanceOf(MemorySaver);
    // The opt-out means nothing reaches disk: no checkpoint, and no database to hold one.
    expect(existsSync(dbPath)).toBe(false);
    // And no notice — the user asked for this; telling them off for it would be noise.
    expect(notify).not.toHaveBeenCalled();
    // The session still runs.
    expect(await turn(checkpointer, 'hello')).toBe('saw 1');
    checkpointer.close();
    expect(existsSync(dbPath)).toBe(false);
  });

  it('falls back to memory WITH a notice when the database cannot be opened', async () => {
    // A parent directory that does not exist — SQLite cannot create the file, on any platform.
    const dbPath = resolve(dir, 'no-such-dir', 'history.db');
    const checkpointer = openSessionCheckpointerSafe({ history: { dbPath } }, { notify });

    expect(checkpointer.durable).toBe(false);
    expect(checkpointer.saver).toBeInstanceOf(MemorySaver);
    // The session runs — a checkpointer problem must not become a new critical path.
    expect(await turn(checkpointer, 'hello')).toBe('saw 1');

    // …and the user is told, in terms of what it costs them.
    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0][0] as string;
    expect(message).toContain('resumable');
    expect(message).toContain(dbPath);
    checkpointer.close();
  });

  it('mints a fresh thread id, and honours one it is given', () => {
    const dbPath = resolve(dir, 'history.db');
    const a = openSessionCheckpointerSafe({ history: { dbPath } }, { notify });
    const b = openSessionCheckpointerSafe({ history: { dbPath } }, { notify });
    expect(a.threadId).toBeTypeOf('string');
    expect(a.threadId.length).toBeGreaterThan(0);
    expect(a.threadId).not.toBe(b.threadId);
    a.close();
    b.close();

    // Supplying one is how a resume re-enters a stored thread.
    const resumed = openSessionCheckpointerSafe(
      { history: { dbPath } },
      { threadId: 'a-stored-thread', notify }
    );
    expect(resumed.threadId).toBe('a-stored-thread');
    resumed.close();
  });

  it('closing twice is safe, on both the durable and the in-memory path', () => {
    const durable = openSessionCheckpointerSafe(
      { history: { dbPath: resolve(dir, 'history.db') } },
      { notify }
    );
    expect(() => {
      durable.close();
      durable.close();
    }).not.toThrow();

    const memory = openSessionCheckpointerSafe({ history: { enabled: false } }, { notify });
    expect(() => {
      memory.close();
      memory.close();
    }).not.toThrow();
  });

  /**
   * GS2-20 — the assertion the double-close test above cannot make. `not.toThrow()` is satisfied by
   * a `close()` that does nothing at all, so on its own it is evidence that closing is harmless
   * rather than evidence that it happens.
   *
   * This matters off-Linux and not in an abstract way: on win32 a file with a live handle cannot be
   * deleted or replaced, so a `close()` that quietly stopped releasing the connection would leave
   * every session's database locked for as long as the process ran, and the first thing to notice
   * would be a PTY suite failing to remove its throwaway HOME. Asking the saver to read *after* the
   * close is what distinguishes the two: it succeeds while the connection is open and fails once it
   * is gone.
   */
  it('close() releases the connection rather than merely dropping the reference', async () => {
    const dbPath = resolve(dir, 'history.db');
    const checkpointer = openSessionCheckpointerSafe({ history: { dbPath } }, { notify });
    expect(checkpointer.durable).toBe(true);
    const config = { configurable: { thread_id: checkpointer.threadId } };

    // Open: the saver answers (an empty thread is `undefined`, which is an answer).
    await expect(checkpointer.saver.getTuple(config)).resolves.toBeUndefined();

    checkpointer.close();

    // Closed: the same call now fails, because the connection it needs is gone.
    await expect(checkpointer.saver.getTuple(config)).rejects.toThrow();
  });
});

/**
 * GS2-20 — the degrade posture for a write that fails AFTER the store opened.
 *
 * Two postures were rejected and it is worth saying why here, because a future reader will be
 * tempted by both. **Swallowing** hands the user a resume that looks complete and is not.
 * **Throwing** propagates out of `agent.invoke()` and ends the session — which, now that history is
 * on by default, would mean a full disk takes down the live session of someone who never asked for
 * the feature. The third posture keeps the turn and writes the loss down.
 *
 * **The injection is `PRAGMA query_only`, and the choice is load-bearing.** It fails writes while
 * leaving reads working, which is exactly what a full or read-only disk does — and it is the only
 * shape that reaches the code under test, because reads are deliberately NOT degraded: an injection
 * that broke the connection outright would end the turn on the graph's first `getTuple`, before any
 * write was attempted, and the test would pass for the wrong reason. It also throws from `.run()`
 * rather than `.prepare()`, which is where a real disk failure surfaces. `chmod` was rejected
 * outright: it is a no-op on win32, which is the exact shape of Windows-only red this repo keeps
 * hitting.
 */
describe('GS2-20: a checkpoint write that fails mid-session', () => {
  let dir: string;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-degrade-'));
    notify = vi.fn();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Make every WRITE on the saver's own connection fail, leaving reads intact. */
  const breakWrites = (checkpointer: SessionCheckpointer): void => {
    const { db } = checkpointer.saver as unknown as { db: DatabaseSync };
    db.exec('PRAGMA query_only = 1');
  };

  /** The `thread_id` stored for a conversation, read by a SEPARATE NODE PROCESS over the file. */
  const threadIdInNewProcess = (dbPath: string, conversationId: number): string | null => {
    const source = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      const row = db.prepare('SELECT thread_id FROM conversations WHERE id = ?').get(Number(process.argv[2]));
      process.stdout.write(JSON.stringify(row === undefined ? 'NO-SUCH-ROW' : row.thread_id ?? null));
      db.close();
    `;
    const out = execFileSync(process.execPath, ['-e', source, dbPath, String(conversationId)], {
      encoding: 'utf8',
    });
    return JSON.parse(out) as string | null;
  };

  it('keeps the session alive, tells the user ONCE, and marks the conversation unresumable ON DISK — provable in a NEW PROCESS', async () => {
    const dbPath = resolve(dir, 'history.db');
    const config = { history: { dbPath } };
    const checkpointer = openSessionCheckpointerSafe(config, { notify });
    expect(checkpointer.durable).toBe(true);

    // The session as the surfaces build it: a conversation row carrying the thread id, bound to the
    // checkpointer so a failure knows where to write itself down.
    const conversationId = openConversationSafe(config, {
      command: 'chat',
      model: 'test-model',
      threadId: checkpointer.threadId,
    })!;
    expect(conversationId).toBeTypeOf('number');
    checkpointer.bindConversation?.(conversationId);

    // One good turn first: this is what makes the failure below TRUNCATE a real chain rather than
    // fail an empty one, which is the case the durable mark exists for.
    expect(await turn(checkpointer, 'hello')).toBe('saw 1');
    expect(lookupConversationThreadSafe(config, conversationId)).toBe(checkpointer.threadId);

    breakWrites(checkpointer);

    // The turn still completes. This is the whole claim: the user keeps their work.
    expect(await turn(checkpointer, 'again')).toBe('saw 3');

    // Told once, in terms of what it costs them — not once per failed super-step.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('resumable');

    // Unresumable through the API a resume would use…
    expect(lookupConversationThreadSafe(config, conversationId)).toBeNull();

    // …and, the part that matters, unresumable on DISK. A flag in this process would satisfy the
    // line above and still let the NEXT process load the truncated conversation as complete. The
    // row is read here by a separate node process over the same file, which is the only way to
    // assert durability rather than memory.
    checkpointer.close();
    expect(threadIdInNewProcess(dbPath, conversationId)).toBeNull();
  });

  it('records the failure even when it happens BEFORE the conversation is bound', async () => {
    const dbPath = resolve(dir, 'history.db');
    const config = { history: { dbPath } };
    const checkpointer = openSessionCheckpointerSafe(config, { notify });
    const conversationId = openConversationSafe(config, {
      command: 'chat',
      model: 'test-model',
      threadId: checkpointer.threadId,
    })!;

    // Binding happens after `openConversationSafe` at every call site, so a write CAN fail first.
    // Nothing in production writes a checkpoint that early today; this pins the gap shut anyway,
    // because the failure mode if it ever opens is a silent one.
    breakWrites(checkpointer);
    expect(await turn(checkpointer, 'hello')).toBe('saw 1');
    expect(notify).toHaveBeenCalledTimes(1);
    // Not yet recorded — there was nowhere to record it.
    expect(lookupConversationThreadSafe(config, conversationId)).toBe(checkpointer.threadId);

    checkpointer.bindConversation?.(conversationId);
    expect(lookupConversationThreadSafe(config, conversationId)).toBeNull();
    checkpointer.close();
    expect(threadIdInNewProcess(dbPath, conversationId)).toBeNull();
  });

  it('degrades on a write that throws from prepare(), not only from run()', async () => {
    const dbPath = resolve(dir, 'history.db');
    const config = { history: { dbPath } };
    const checkpointer = openSessionCheckpointerSafe(config, { notify });
    const conversationId = openConversationSafe(config, {
      command: 'chat',
      model: 'test-model',
      threadId: checkpointer.threadId,
    })!;
    checkpointer.bindConversation?.(conversationId);

    // A closed connection throws at `prepare()` — a different statement in `put`/`putWrites` than
    // the one `query_only` reaches, so the guard is proven to span both. The graph is not driven
    // here: a closed connection fails the READ too, and reads are loud on purpose.
    checkpointer.close();
    await checkpointer.saver.put(
      { configurable: { thread_id: checkpointer.threadId, checkpoint_ns: '' } },
      {
        v: 4,
        id: 'cp-after-close',
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'loop', step: 0, parents: {} },
      {}
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(threadIdInNewProcess(dbPath, conversationId)).toBeNull();
  });

  it('leaves a healthy session alone — no notice, and the thread link intact in a new process', async () => {
    // The control. Every assertion above is about a failure being noticed; this one fails if the
    // degrade path fires when nothing went wrong, which no amount of failure-case coverage can see.
    const dbPath = resolve(dir, 'history.db');
    const config = { history: { dbPath } };
    const checkpointer = openSessionCheckpointerSafe(config, { notify });
    const conversationId = openConversationSafe(config, {
      command: 'chat',
      model: 'test-model',
      threadId: checkpointer.threadId,
    })!;
    checkpointer.bindConversation?.(conversationId);

    expect(await turn(checkpointer, 'hello')).toBe('saw 1');
    expect(await turn(checkpointer, 'again')).toBe('saw 3');
    expect(notify).not.toHaveBeenCalled();
    expect(lookupConversationThreadSafe(config, conversationId)).toBe(checkpointer.threadId);
    checkpointer.close();
    expect(threadIdInNewProcess(dbPath, conversationId)).toBe(checkpointer.threadId);
  });
});
