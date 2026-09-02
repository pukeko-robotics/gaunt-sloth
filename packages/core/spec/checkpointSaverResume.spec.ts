/**
 * GS2-20 acceptance bar: prove that a conversation's LangGraph state SURVIVES the process, in a
 * REAL `createAgent` ReAct graph driven by a scripted model and a real tool, through the durable
 * SQLite saver.
 *
 * **The central assertion is a tool-RESULT one, not a transcript one, and that is deliberate.** The
 * ruling this ticket implements is that a resume must look, from the agent's side, as though no
 * interruption happened — and an implementation that resumed by replaying stored MESSAGES into a
 * fresh agent would satisfy "the messages are all present" while having thrown away everything the
 * graph was holding. So the scripted model does not return a canned answer on the second turn: it
 * COMPUTES its answer from the tool result it finds in the messages it was handed. A saver that
 * lost the state cannot produce that string, and the test says so by name
 * (`recall:NOTHING-IN-STATE`) rather than merely failing an equality.
 *
 * Ending the session is modelled by closing the saver and opening a NEW one over the same file,
 * with a fresh graph and a fresh model instance — every in-process handle to the first turn is
 * gone, and the only thing joining the two turns is the database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { openCheckpointSaver, type GthSqliteSaver } from '#src/history/checkpointSaver.js';

/** The value only the tool knows. Nothing else in the graph can produce it. */
const SECRET = 'ORBIT-4417';
/** What the model answers when the state it was handed contains no tool result at all. */
const NOTHING = 'recall:NOTHING-IN-STATE';

/**
 * A model that reads its answer OUT of the messages it is given.
 *
 * Turn one it asks for the tool, then acknowledges the result. Any later turn it reports the tool
 * result it can see in state — which is the whole assertion: this string is not in the script, it
 * is in the checkpoint.
 */
class RecallingModel extends BaseChatModel {
  /** How many times the model was called (a re-run of the tool would show up here too). */
  callCount = 0;

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
    this.callCount++;
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

describe('GS2-20: durable checkpointer (real createAgent graph over node:sqlite)', () => {
  let dir: string;
  /** Every tool invocation across the whole test, so a silent re-run is visible. */
  let toolCalls: number;
  const savers: GthSqliteSaver[] = [];

  const lookupCode = tool(
    async () => {
      toolCalls++;
      return SECRET;
    },
    {
      name: 'lookup_code',
      description: 'Look up the code.',
      schema: z.object({}),
    }
  );

  /** A saver over `dbPath`, registered for teardown. Fails the test rather than returning null. */
  const openSaver = (dbPath: string): GthSqliteSaver => {
    const saver = openCheckpointSaver(dbPath);
    expect(saver).not.toBeNull();
    savers.push(saver!);
    return saver!;
  };

  const agentOn = (saver: GthSqliteSaver) =>
    createAgent({ model: new RecallingModel(), tools: [lookupCode], checkpointer: saver });

  const say = async (saver: GthSqliteSaver, threadId: string, text: string): Promise<string> => {
    const result = await agentOn(saver).invoke(
      { messages: [new HumanMessage(text)] },
      { configurable: { thread_id: threadId } }
    );
    const messages = result.messages as BaseMessage[];
    const last = messages[messages.length - 1];
    return typeof last.content === 'string' ? last.content : '';
  };

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-ckpt-'));
    toolCalls = 0;
    savers.length = 0;
  });

  afterEach(() => {
    for (const saver of savers) saver.close();
    savers.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a resumed thread can build on a tool result from BEFORE the saver was closed', async () => {
    const dbPath = resolve(dir, 'history.db');
    const thread = 'thread-under-test';

    // Session one: the model calls the tool and the graph state now holds its result.
    const first = openSaver(dbPath);
    await say(first, thread, 'look up the code');
    first.close();
    expect(toolCalls).toBe(1);

    // Session two: a NEW saver over the same file, a NEW graph, a NEW model. Only the DB connects
    // them, and the next turn carries nothing but the new question.
    const second = openSaver(dbPath);
    const answer = await say(second, thread, 'what was the code');

    // The tool result reached the second turn's model, which is the requirement. A replay-only
    // implementation, or a saver that dropped the state, yields NOTHING here.
    expect(answer).toBe(`recall:${SECRET}`);
    // And it came from the CHECKPOINT rather than from running the tool again.
    expect(toolCalls).toBe(1);
  });

  it('a DIFFERENT thread in the same database sees none of it', async () => {
    const dbPath = resolve(dir, 'history.db');
    const first = openSaver(dbPath);
    await say(first, 'thread-a', 'look up the code');
    first.close();

    const second = openSaver(dbPath);
    // The same question, one thread over. Nothing may leak sideways, and nothing may fall back to
    // "the most recent thread" — that fallback is how a stale id serves someone else's state.
    expect(await say(second, 'thread-b', 'what was the code')).toBe(NOTHING);
  });

  it('a thread id that was never written resumes EMPTY, and does not adopt a neighbour', async () => {
    const dbPath = resolve(dir, 'history.db');
    const first = openSaver(dbPath);
    await say(first, 'thread-real-1', 'look up the code');
    await say(first, 'thread-real-2', 'look up the code');
    first.close();

    const second = openSaver(dbPath);
    // Unknown ids find nothing — asked directly of the saver, so this is not an artefact of how the
    // graph happens to seed a fresh run.
    expect(
      await second.getTuple({ configurable: { thread_id: 'no-such-thread' } })
    ).toBeUndefined();
    expect(await say(second, 'no-such-thread', 'what was the code')).toBe(NOTHING);
    // A config with no thread at all is likewise a miss, not "whatever was stored last".
    expect(await second.getTuple({ configurable: {} })).toBeUndefined();
  });

  it('a different database file sees none of it', async () => {
    const first = openSaver(resolve(dir, 'one.db'));
    await say(first, 'shared-thread', 'look up the code');
    first.close();

    const second = openSaver(resolve(dir, 'two.db'));
    expect(await say(second, 'shared-thread', 'what was the code')).toBe(NOTHING);
  });

  it('stores the parent link, so the ancestor walk that rebuilds channels can proceed', async () => {
    const dbPath = resolve(dir, 'history.db');
    const saver = openSaver(dbPath);
    await say(saver, 'thread-parent', 'look up the code');

    // A completed turn is several checkpoints deep. The newest must name its parent, and that
    // parent must resolve — `BaseCheckpointSaver.getDeltaChannelHistory` walks exactly this chain
    // to reconstruct a channel, and a broken link comes back as an empty channel rather than an
    // error, i.e. as a transcript that is present but has lost its tool result.
    const latest = await saver.getTuple({ configurable: { thread_id: 'thread-parent' } });
    expect(latest).toBeDefined();
    expect(latest!.parentConfig?.configurable?.checkpoint_id).toBeTypeOf('string');

    const parent = await saver.getTuple(latest!.parentConfig!);
    expect(parent).toBeDefined();
    expect(parent!.checkpoint.id).toBe(latest!.parentConfig!.configurable!.checkpoint_id);

    // The chain reaches a root, and every link on the way resolves.
    let hops = 0;
    let cursor = latest;
    while (cursor?.parentConfig) {
      cursor = await saver.getTuple(cursor.parentConfig);
      expect(cursor).toBeDefined();
      hops++;
      expect(hops).toBeLessThan(50);
    }
    expect(hops).toBeGreaterThan(0);
  });

  it('lists a thread newest-first, and honours a limit', async () => {
    const dbPath = resolve(dir, 'history.db');
    const saver = openSaver(dbPath);
    await say(saver, 'thread-list', 'look up the code');

    const all = [];
    for await (const t of saver.list({ configurable: { thread_id: 'thread-list' } })) all.push(t);
    expect(all.length).toBeGreaterThan(1);
    const ids = all.map((t) => t.checkpoint.id);
    expect([...ids].sort().reverse()).toEqual(ids);

    const capped = [];
    for await (const t of saver.list(
      { configurable: { thread_id: 'thread-list' } },
      { limit: 1 }
    )) {
      capped.push(t);
    }
    expect(capped).toHaveLength(1);
    expect(capped[0].checkpoint.id).toBe(ids[0]);
  });

  it('deleteThread removes one thread and leaves the others', async () => {
    const dbPath = resolve(dir, 'history.db');
    const saver = openSaver(dbPath);
    await say(saver, 'thread-keep', 'look up the code');
    await say(saver, 'thread-drop', 'look up the code');

    await saver.deleteThread('thread-drop');
    expect(await saver.getTuple({ configurable: { thread_id: 'thread-drop' } })).toBeUndefined();
    expect(await saver.getTuple({ configurable: { thread_id: 'thread-keep' } })).toBeDefined();
  });

  it('does not open a database it cannot create, and says so by returning null', () => {
    // A parent directory that does not exist: SQLite cannot create the file, on every platform.
    expect(openCheckpointSaver(resolve(dir, 'no-such-dir', 'history.db'))).toBeNull();
  });
});

/**
 * The write-slot contract, asserted directly because it is invisible from the graph until a resume:
 * an ordinary write is insert-ONCE (a retried super-step must not duplicate or clobber it) while
 * LangGraph's reserved channels are replace-on-write (the newest interrupt is the live one).
 */
describe('GS2-20: checkpoint write slots', () => {
  let dir: string;
  let saver: GthSqliteSaver;
  const config = {
    configurable: { thread_id: 'writes', checkpoint_ns: '', checkpoint_id: 'cp-1' },
  };

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-ckptw-'));
    saver = openCheckpointSaver(resolve(dir, 'history.db'))!;
    expect(saver).not.toBeNull();
  });

  afterEach(() => {
    saver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The pending writes stored under `cp-1`, as `[channel, value]` pairs. */
  const storedWrites = async (): Promise<[string, unknown][]> => {
    await saver.put(
      { configurable: { thread_id: 'writes', checkpoint_ns: '' } },
      {
        v: 4,
        id: 'cp-1',
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'loop', step: 0, parents: {} },
      {}
    );
    const tuple = await saver.getTuple(config);
    return (tuple?.pendingWrites ?? []).map(([, channel, value]) => [channel, value]);
  };

  it('keeps the FIRST value of an ordinary write when the same slot is written again', async () => {
    await saver.putWrites(config, [['messages', 'first']], 'task-1');
    await saver.putWrites(config, [['messages', 'second']], 'task-1');
    expect(await storedWrites()).toEqual([['messages', 'first']]);
  });

  it('keeps the LATEST value of a reserved channel, so a stale interrupt cannot survive', async () => {
    await saver.putWrites(config, [['__interrupt__', 'stale']], 'task-1');
    await saver.putWrites(config, [['__interrupt__', 'live']], 'task-1');
    expect(await storedWrites()).toEqual([['__interrupt__', 'live']]);
  });

  it('keeps writes from different tasks side by side', async () => {
    await saver.putWrites(config, [['messages', 'from-a']], 'task-a');
    await saver.putWrites(config, [['messages', 'from-b']], 'task-b');
    const stored = await storedWrites();
    expect(stored).toHaveLength(2);
    expect(stored.map(([, value]) => value).sort()).toEqual(['from-a', 'from-b']);
  });
});
