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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { openSessionCheckpointerSafe } from '#src/history/sessionCheckpointer.js';
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
