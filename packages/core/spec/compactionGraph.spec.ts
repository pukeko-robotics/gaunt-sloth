/**
 * GS2-23 — the compaction mechanism applied to a REAL graph, in the two places a pure-function
 * test cannot reach:
 *
 * 1. **Durability.** `replaceGraphMessages` writes through the graph's own `updateState`, so the
 *    compacted history is a checkpoint. Proven the way GS2-20 proves resume: the saver is closed,
 *    a NEW saver is opened over the same SQLite file under a fresh graph, and that graph's state is
 *    the compacted list — and its next model request begins with the summary.
 *
 * 2. **The size measurement.** Through the real `GthAgentRunner` and the lean `GthLangChainAgent`,
 *    the next model request after `compactConversation` — read at `lastModelRequest`, the same
 *    snapshot `/debug-dump` reads — carries fewer messages and fewer characters than the request
 *    before it. With a CONTROL: an identical session whose compaction is a no-op (below the kept
 *    tail) produces a next request identical in size to a session that never compacted.
 *
 * Also here, because they need the runner: it refuses while a turn is running, and it refuses an
 * agent that exposes no conversation state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import type { GthAbstractAgent } from '#src/core/GthAbstractAgent.js';
import type { GthAgentInterface } from '#src/core/types.js';
import { openCheckpointSaver, type GthSqliteSaver } from '#src/history/checkpointSaver.js';
import {
  compactMessages,
  conversationSize,
  isCompactionSummary,
  replaceGraphMessages,
} from '#src/core/compaction.js';

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
 * A scripted model that also answers the compaction summariser. The summariser invokes the model
 * with the prompt as a single human message, and that prompt opens with the `<role>` block — so a
 * request whose last message starts that way is a summary request and is answered `SUMMARY`. Every
 * other request is a turn: a prompt beginning `tool` asks for the tool once, anything else gets a
 * text answer. `seen` records the turn requests as the model received them.
 */
class ScriptedModel extends BaseChatModel {
  seen: BaseMessage[][] = [];
  summaryPrompts: string[] = [];
  /** When set, every turn waits on it — the way a turn is held "running" for the refusal cell. */
  gate: Promise<void> | null = null;

  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const last = messages[messages.length - 1];
    const lastText = typeof last.content === 'string' ? last.content : '';
    if (HumanMessage.isInstance(last) && lastText.startsWith('<role>')) {
      this.summaryPrompts.push(lastText);
      return { generations: [{ message: new AIMessage('SUMMARY'), text: 'SUMMARY' }] };
    }
    if (this.gate) await this.gate;
    this.seen.push(messages);
    const lastHuman = [...messages].reverse().find((m) => HumanMessage.isInstance(m));
    const ask = typeof lastHuman?.content === 'string' ? lastHuman.content : '';
    const message =
      ask.startsWith('tool') && !ToolMessage.isInstance(last)
        ? new AIMessage({
            content: '',
            tool_calls: [{ name: 'lookup', args: {}, id: `call-${this.seen.length}` }],
          })
        : new AIMessage(`answer: ${ask.slice(0, 12)}`);
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

const lookup = tool(async () => 'LOOKED-UP', {
  name: 'lookup',
  description: 'Look something up.',
  schema: z.object({}),
});

const typesOf = (messages: readonly BaseMessage[]) => messages.map((m) => m.getType());

describe('GS2-23 — durability: the compacted list is what a fresh graph over the same saver holds', () => {
  let dir: string;
  const savers: GthSqliteSaver[] = [];
  const openSaver = (dbPath: string): GthSqliteSaver => {
    const saver = openCheckpointSaver(dbPath);
    expect(saver).not.toBeNull();
    savers.push(saver!);
    return saver!;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gth-compaction-spec-'));
    savers.length = 0;
  });
  afterEach(() => {
    for (const saver of savers) saver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives closing the saver: a new saver, a new graph, the compacted state', async () => {
    const dbPath = join(dir, 'history.db');
    const cfg = { configurable: { thread_id: 'thread-under-test' } };

    // Session one: four turns, one of them a tool call, then a compaction.
    const first = openSaver(dbPath);
    const model = new ScriptedModel();
    const graph = createAgent({ model, tools: [lookup], checkpointer: first, systemPrompt: 'SYS' });
    for (const text of ['one', 'tool two', 'three', 'four']) {
      await graph.invoke({ messages: [new HumanMessage(text)] }, cfg);
    }
    const before = (await graph.getState(cfg)).values.messages as BaseMessage[];
    expect(typesOf(before)).toEqual([
      'human', 'ai', 'human', 'ai', 'tool', 'ai', 'human', 'ai', 'human', 'ai',
    ]);

    const out = await compactMessages({
      messages: before,
      summarize: async () => 'SUMMARY',
      keepRecent: 4,
    });
    expect(out.changed).toBe(true);
    await replaceGraphMessages(graph, cfg, out.messages);
    first.close();

    // Session two: nothing in memory joins the two but the database file.
    const second = openSaver(dbPath);
    const freshModel = new ScriptedModel();
    const fresh = createAgent({
      model: freshModel,
      tools: [lookup],
      checkpointer: second,
      systemPrompt: 'SYS',
    });
    const after = (await fresh.getState(cfg)).values.messages as BaseMessage[];
    expect(after.length).toBe(out.messages.length);
    expect(after.length).toBeLessThan(before.length);
    expect(typesOf(after)).toEqual(typesOf(out.messages));
    expect(isCompactionSummary(after[0])).toBe(true);
    expect(after.slice(1).map((m) => m.id)).toEqual(before.slice(-4).map((m) => m.id));

    // And the fresh graph's next request is built from the compacted state: system prompt,
    // summary, the kept tail, the new turn — nothing of the folded span.
    await fresh.invoke({ messages: [new HumanMessage('five')] }, cfg);
    const request = freshModel.seen[0];
    expect(request[0].getType()).toBe('system');
    expect(isCompactionSummary(request[1])).toBe(true);
    expect(request.length).toBe(1 + out.messages.length + 1);
    expect(request.some((m) => typeof m.content === 'string' && m.content === 'one')).toBe(false);
  });
});

describe('GS2-23 — GthAgentRunner.compactConversation, measured at lastModelRequest', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;

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

  beforeEach(async () => {
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  const makeRunner = async (model: ScriptedModel) => {
    const runner = new GthAgentRunner(vi.fn(), {
      resolveTools: vi.fn().mockResolvedValue([lookup]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    const config = { ...BASE_CONFIG, llm: model } as unknown as GthConfig;
    await runner.init('chat', config, new MemorySaver());
    return runner;
  };

  const turn = async (runner: InstanceType<typeof GthAgentRunner>, text: string) => {
    for await (const _ of runner.processMessagesWithEvents([new HumanMessage(text)])) {
      // drained for effect
    }
  };

  /** The as-sent messages of the most recent model call — what `/debug-dump` reads too. */
  const lastRequest = (runner: InstanceType<typeof GthAgentRunner>): BaseMessage[] => {
    const request = (runner.getAgent() as GthAbstractAgent).lastModelRequest;
    expect(request).toBeDefined();
    return request!.messages;
  };

  it('the next request after a compaction carries fewer messages and fewer characters', async () => {
    const model = new ScriptedModel();
    const runner = await makeRunner(model);
    const padding = ' ' + 'x'.repeat(300);
    for (const text of ['one', 'tool two', 'three', 'four', 'five']) {
      await turn(runner, text + padding);
    }
    const requestBefore = lastRequest(runner);
    const sizeBefore = conversationSize(requestBefore);

    const outcome = await runner.compactConversation({ focus: 'the file names' });

    expect(outcome.changed).toBe(true);
    expect(outcome.removedCount).toBe(6);
    expect(outcome.keptCount).toBe(6);
    expect(outcome.after.messages).toBe(7);
    expect(outcome.after.messages).toBeLessThan(outcome.before.messages);
    expect(outcome.after.characters).toBeLessThan(outcome.before.characters);
    expect(outcome.summaryText).toBe('SUMMARY');
    // The summariser was the session model, called once, with the focus in its prompt.
    expect(model.summaryPrompts).toHaveLength(1);
    expect(model.summaryPrompts[0]).toContain('pay particular attention to: the file names');

    await turn(runner, 'six');
    const requestAfter = lastRequest(runner);
    const sizeAfter = conversationSize(requestAfter);
    expect(sizeAfter.messages).toBeLessThan(sizeBefore.messages);
    expect(sizeAfter.characters).toBeLessThan(sizeBefore.characters);
    // Its shape: the system prompt, the summary, the kept tail, then the new turn.
    expect(requestAfter[0].getType()).toBe('system');
    expect(isCompactionSummary(requestAfter[1])).toBe(true);
    expect(requestAfter[requestAfter.length - 1].content).toBe('six');
    expect(requestAfter.some((m) => typeof m.content === 'string' && m.content.startsWith('one '))).toBe(false);

    await runner.cleanup();
  });

  it('CONTROL — a no-op compaction below the kept tail leaves the next request equal to an uncompacted session', async () => {
    const compactedModel = new ScriptedModel();
    const controlModel = new ScriptedModel();
    const compacted = await makeRunner(compactedModel);
    const control = await makeRunner(controlModel);
    await turn(compacted, 'one');
    await turn(control, 'one');

    const outcome = await compacted.compactConversation();
    expect(outcome.changed).toBe(false);
    expect(outcome.removedCount).toBe(0);
    expect(outcome.keptCount).toBe(2);
    expect(outcome.after).toEqual(outcome.before);
    expect(compactedModel.summaryPrompts).toHaveLength(0);

    await turn(compacted, 'two');
    await turn(control, 'two');
    expect(typesOf(lastRequest(compacted))).toEqual(typesOf(lastRequest(control)));
    expect(conversationSize(lastRequest(compacted))).toEqual(conversationSize(lastRequest(control)));

    await compacted.cleanup();
    await control.cleanup();
  });

  it('refuses while a turn is running, and works again once it has finished', async () => {
    const model = new ScriptedModel();
    const runner = await makeRunner(model);
    let release!: () => void;
    model.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = turn(runner, 'one');
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(runner.compactConversation()).rejects.toThrow(/turn is still running/);
    expect(model.summaryPrompts).toHaveLength(0);

    release();
    await running;
    await expect(runner.compactConversation()).resolves.toMatchObject({ changed: false });
    await runner.cleanup();
  });

  it('refuses an agent that exposes no conversation state, rather than reporting a fold of nothing', async () => {
    const stateless: GthAgentInterface = {
      init: vi.fn(async () => undefined),
      invoke: vi.fn(),
      stream: vi.fn(),
      streamWithEvents: vi.fn(),
      streamWithEventsResume: vi.fn(),
    };
    const runner = new GthAgentRunner(vi.fn(), undefined, () => stateless);
    await runner.init('chat', { ...BASE_CONFIG, llm: new ScriptedModel() } as unknown as GthConfig);
    await expect(runner.compactConversation()).rejects.toThrow(/does not expose its conversation state/);
  });
});
