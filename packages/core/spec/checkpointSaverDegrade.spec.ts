/**
 * GS2-117 — a durable checkpoint write that fails mid-run must never change what the running graph
 * sees, asserted on a REAL `GthAgentRunner` over a REAL `node:sqlite` checkpointer.
 *
 * **Why the runner and not a bare `createAgent`.** Every tool call a command that answers approvals
 * makes is interrupt-gated, even at `bypass`: the graph suspends on `__interrupt__`, the runner reads
 * the state back to find it (`getState` → `getTuple`), and a new `Command({ resume })` invocation
 * reads the saver again at loop start. That invocation boundary is where a dropped write used to
 * surface, as a tool that never ran and a turn that died. A graph with no HITL middleware has no
 * such boundary inside a turn, so a tool case over it passes whether or not the saver is fixed.
 *
 * **Failures are injected below the saver, on its real code path**, never by replacing its methods:
 * a `BEFORE INSERT … RAISE(ABORT)` trigger on `checkpoint_writes` (writes only) or `checkpoints`
 * (checkpoints only), or `PRAGMA query_only` (both). Each fails the saver's own statement inside its
 * own `catch`, keeps reads working the way a full or read-only disk does, and is portable to win32.
 * They are armed from the model's first call, so the turn's opening checkpoints have landed and the
 * failure truncates a real chain mid-run.
 *
 * **The assertions are on what the MODEL received**, not only on the returned text: the model's
 * final call must carry a `ToolMessage` with the tool's result after the human turn that asked for
 * it. A runner that returned the right string from some fallback would not satisfy that.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import type { GthCommand } from '#src/core/types.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { openCheckpointSaver, type GthSqliteSaver } from '#src/history/checkpointSaver.js';
import { openSessionCheckpointerSafe } from '#src/history/sessionCheckpointer.js';
import { openConversationSafe } from '#src/history/recordSession.js';
import { openHistoryStore } from '#src/history/historyStore.js';

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

/** The index of the last human message, or -1. */
function lastHumanIndexOf(messages: readonly BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (HumanMessage.isInstance(messages[i])) return i;
  }
  return -1;
}

/**
 * The `RecallingModel` of `resumeConversationRunner.spec.ts`, with two additions a failure case
 * needs: it RECORDS every message list it is handed, so a test asserts on what the model actually
 * received, and it runs a hook on its first call, which is where the failure is armed.
 *
 * One behavioural difference, needed for a turn that runs the tool on a thread that already holds a
 * tool result: "look up the code" calls the tool unless a tool result follows the LATEST human turn,
 * rather than unless one exists anywhere. On a fresh thread the two rules agree.
 */
class RecordingModel extends BaseChatModel {
  /** Every message list the model was handed, in call order. */
  readonly calls: BaseMessage[][] = [];
  /** Run once, before the first generation — where a test arms its failure. */
  beforeFirstCall?: () => void;
  private toolCallSeq = 0;

  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted-recording-recall';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    if (this.calls.length === 0 && this.beforeFirstCall) this.beforeFirstCall();
    this.calls.push([...messages]);
    const lastHumanIndex = lastHumanIndexOf(messages);
    const lastHuman = messages[lastHumanIndex];
    const ask = typeof lastHuman?.content === 'string' ? lastHuman.content : '';
    const toolAfterAsk = messages.slice(lastHumanIndex + 1).find((m) => ToolMessage.isInstance(m));
    const anyTool = [...messages].reverse().find((m) => ToolMessage.isInstance(m));
    let message: AIMessage;
    if (ask.includes('look up the code')) {
      message = toolAfterAsk
        ? new AIMessage(`looked it up: ${String(toolAfterAsk.content)}`)
        : new AIMessage({
            content: '',
            tool_calls: [
              { name: 'lookup_code', args: {}, id: `call-lookup-${++this.toolCallSeq}` },
            ],
          });
    } else {
      message = new AIMessage(anyTool ? `recall:${String(anyTool.content)}` : NOTHING);
    }
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }

  /** The message types of the model's LAST call, e.g. `system,human,ai,tool`. */
  lastCallShape(): string {
    return (this.calls[this.calls.length - 1] ?? []).map((m) => m.getType()).join(',');
  }

  /** Whether the last call carried the tool result AFTER the human turn that asked for it. */
  lastCallSawToolResult(): boolean {
    const last = this.calls[this.calls.length - 1] ?? [];
    const lastHumanIndex = lastHumanIndexOf(last);
    return last
      .slice(lastHumanIndex + 1)
      .some((m) => ToolMessage.isInstance(m) && String(m.content) === SECRET);
  }
}

/** The three ways a durable write can fail: its pending writes, its checkpoints, or both. */
type FailureMode = 'putWrites-only' | 'put-only' | 'both';
const FAILURE_MODES: readonly FailureMode[] = ['putWrites-only', 'put-only', 'both'];

/** The saver's own connection — the one the failure has to reach. White-box, like `.db` elsewhere. */
const connectionOf = (saver: unknown): DatabaseSync => (saver as { db: DatabaseSync }).db;

/** Make the saver's writes fail in `mode`, leaving reads working. */
function armFailure(saver: unknown, mode: FailureMode): void {
  const db = connectionOf(saver);
  if (mode === 'both') {
    db.exec('PRAGMA query_only = 1');
    return;
  }
  const table = mode === 'put-only' ? 'checkpoints' : 'checkpoint_writes';
  db.exec(
    `CREATE TRIGGER gs2_117_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END`
  );
}

/** Rows in a table, counted over a SEPARATE connection so the file, not the saver, answers. */
function countRows(dbPath: string, table: 'checkpoints' | 'checkpoint_writes'): number {
  const audit = new DatabaseSync(dbPath);
  try {
    return Number((audit.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    audit.close();
  }
}

/**
 * The `thread_id` stored for a conversation, read by a SEPARATE NODE PROCESS over the file. The same
 * helper as `sessionCheckpointer.spec.ts`'s degrade suite: a flag in this process would satisfy an
 * in-process read and still let the next process load a truncated conversation as complete.
 */
function threadIdInNewProcess(dbPath: string, conversationId: number): string | null {
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
}

/**
 * Every case here compiles and drives a real graph over a real sqlite file, some several times, so
 * each costs whole seconds on a slow CI runner rather than milliseconds. Wall-clock budget only: no
 * assertion is relaxed by it, and a hang still fails.
 */
const REAL_AGENT_TIMEOUT_MS = 30_000;

describe('GS2-117: a checkpoint write that fails mid-run does not change what the graph sees', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  type Runner = InstanceType<typeof GthAgentRunner>;

  const BASE_CONFIG = {
    contentSource: 'file',
    requirementSource: 'file',
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: false,
    writeBinaryOutputsToFile: false,
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: true,
    commands: {},
  };

  // EXT-71 — clamp the anchor the persisted grant store resolves from, so nothing a runner here
  // does can land in the real project allow-list of whoever runs the suite.
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-degrade-runner-spec-'));
  let priorProjectDir: string | undefined;
  let dir: string;
  let dbPath: string;
  let toolCalls: number;
  const closers: (() => void)[] = [];

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    dir = mkdtempSync(join(tmpdir(), 'gsloth-degrade-runner-'));
    dbPath = join(dir, 'history.db');
    toolCalls = 0;
    closers.length = 0;
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    for (const close of closers) close();
    closers.length = 0;
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

  /** A durable saver over the test's file, reporting into `failures`, registered for teardown. */
  const openSaver = (failures: unknown[] = []): GthSqliteSaver => {
    const saver = openCheckpointSaver(dbPath, { onWriteFailure: (e) => failures.push(e) });
    expect(saver).not.toBeNull();
    closers.push(() => saver!.close());
    return saver!;
  };

  const makeRunner = async (options: {
    command: GthCommand;
    streamOutput: boolean;
    model: RecordingModel;
    saver: unknown;
    threadId?: string;
    approvals?: string;
    decide?: () => Promise<unknown>;
  }): Promise<Runner> => {
    const runner = new GthAgentRunner(vi.fn(), {
      resolveTools: vi.fn().mockResolvedValue([lookupCode()]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    const config = {
      ...BASE_CONFIG,
      streamOutput: options.streamOutput,
      approvals: options.approvals ?? 'bypass',
      llm: options.model,
    } as unknown as GthConfig;
    await runner.init(options.command, config, options.saver as never, {
      threadId: options.threadId,
    });
    runner.setToolApprovalCallback(
      vi.fn(
        options.decide ?? (async () => ({ type: 'approve' as const, scope: 'once' as const }))
      ) as never
    );
    return runner;
  };

  const say = (runner: Runner, text: string) => runner.processMessages([new HumanMessage(text)]);

  /**
   * Tests 1 and 2 of the brief: every failure mode, on the interactive command (`code`, streaming)
   * and on the single-shot command set driven through the runner (`ask` and `exec`). Single-shot
   * builds its own `MemorySaver` today; what these cells pin is that the runner's commands survive
   * a failing durable saver, which is what a single-shot run inherits once it is wired onto one.
   */
  const CELLS: readonly { command: GthCommand; streamOutput: boolean }[] = [
    { command: 'code', streamOutput: true },
    { command: 'ask', streamOutput: false },
    { command: 'exec', streamOutput: false },
    { command: 'exec', streamOutput: true },
  ];

  for (const { command, streamOutput } of CELLS) {
    for (const mode of FAILURE_MODES) {
      it(
        `ACCEPTANCE: a ${command} tool turn (stream=${streamOutput}) completes when ${mode} fails mid-run, and the model sees the tool result`,
        async () => {
          const failures: unknown[] = [];
          const saver = openSaver(failures);
          const model = new RecordingModel();
          // Armed at the model's first call: the input checkpoint has landed by then (asserted
          // below), so the failure truncates a real chain rather than an empty one.
          let checkpointsBeforeArming = -1;
          model.beforeFirstCall = () => {
            checkpointsBeforeArming = countRows(dbPath, 'checkpoints');
            armFailure(saver, mode);
          };
          const runner = await makeRunner({ command, streamOutput, model, saver });

          const answer = await say(runner, 'look up the code');

          expect(checkpointsBeforeArming).toBeGreaterThan(0);
          expect(answer).toContain(`looked it up: ${SECRET}`);
          expect(model.lastCallSawToolResult()).toBe(true);
          expect(toolCalls).toBe(1);
          // The injection reached the saver's own `catch`, and the cut reports it once, not once
          // per dropped write.
          expect(failures).toHaveLength(1);
        },
        REAL_AGENT_TIMEOUT_MS
      );
    }
  }

  it(
    'the refused write IS the `__interrupt__` one: memory still holds it, so the approval is found and the tool runs',
    async () => {
      // The sharpest case of the putWrites-only mode. Writes the graph has already applied to its
      // channels are carried forward by the next checkpoint anyway; the one write nothing else
      // carries is the pending interrupt, so the failure is aimed at exactly that write.
      const failures: unknown[] = [];
      const saver = openSaver(failures);
      connectionOf(saver).exec(
        `CREATE TRIGGER gs2_117_fail BEFORE INSERT ON checkpoint_writes
           WHEN NEW.channel = '__interrupt__' BEGIN SELECT RAISE(ABORT, 'injected'); END`
      );
      const model = new RecordingModel();
      const runner = await makeRunner({ command: 'code', streamOutput: true, model, saver });
      expect(await say(runner, 'look up the code')).toContain(`looked it up: ${SECRET}`);
      expect(model.lastCallSawToolResult()).toBe(true);
      expect(toolCalls).toBe(1);
      expect(failures).toHaveLength(1);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'CONTROL: the same tool turn with no failure — nothing reported, and the model saw the result',
    async () => {
      const failures: unknown[] = [];
      const saver = openSaver(failures);
      const model = new RecordingModel();
      const runner = await makeRunner({ command: 'code', streamOutput: true, model, saver });
      expect(await say(runner, 'look up the code')).toContain(`looked it up: ${SECRET}`);
      expect(model.lastCallSawToolResult()).toBe(true);
      expect(failures).toHaveLength(0);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'later turns keep the context written after the failure, on the runner',
    async () => {
      const failures: unknown[] = [];
      const saver = openSaver(failures);
      const model = new RecordingModel();
      const runner = await makeRunner({ command: 'code', streamOutput: true, model, saver });
      expect(await say(runner, 'hello')).toContain(NOTHING);
      armFailure(saver, 'both');
      expect(await say(runner, 'look up the code')).toContain(`looked it up: ${SECRET}`);
      // The third turn sees the tool result the second one produced after writes broke — state that
      // exists only in memory now.
      expect(await say(runner, 'what was the code')).toContain(`recall:${SECRET}`);
      expect(model.lastCallShape()).toBe('system,human,ai,human,ai,tool,ai,human');
      expect(toolCalls).toBe(1);
      expect(failures).toHaveLength(1);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  /** Test 4: the thread link is still cut, through the session seam the surfaces use. */
  for (const mode of FAILURE_MODES) {
    it(
      `after ${mode} fails on a tool turn, the conversation's thread link is NULL in a new process and the user is told once`,
      async () => {
        const config = { history: { dbPath } };
        const notify = vi.fn();
        const checkpointer = openSessionCheckpointerSafe(config, { notify });
        closers.push(() => checkpointer.close());
        expect(checkpointer.durable).toBe(true);
        const conversationId = openConversationSafe(config, {
          command: 'code',
          model: 'test-model',
          threadId: checkpointer.threadId,
        })!;
        expect(conversationId).toBeTypeOf('number');
        checkpointer.bindConversation?.(conversationId);

        const model = new RecordingModel();
        model.beforeFirstCall = () => armFailure(checkpointer.saver, mode);
        const runner = await makeRunner({
          command: 'code',
          streamOutput: true,
          model,
          saver: checkpointer.saver,
          threadId: checkpointer.threadId,
        });

        expect(await say(runner, 'look up the code')).toContain(`looked it up: ${SECRET}`);
        expect(model.lastCallSawToolResult()).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toContain('resumable');

        checkpointer.close();
        expect(threadIdInNewProcess(dbPath, conversationId)).toBeNull();
      },
      REAL_AGENT_TIMEOUT_MS
    );
  }

  /** Test 5: a resumed thread whose writes fail from the very first one. */
  for (const mode of FAILURE_MODES) {
    it(
      `a thread resumed in a new saver completes a tool turn when ${mode} fails from the start, with the pre-resume transcript`,
      async () => {
        const thread = 'thread-resumed-then-failed';
        const first = openSaver();
        const one = await makeRunner({
          command: 'code',
          streamOutput: true,
          model: new RecordingModel(),
          saver: first,
          threadId: thread,
        });
        expect(await say(one, 'look up the code')).toContain(`looked it up: ${SECRET}`);
        first.close();

        const failures: unknown[] = [];
        const second = openSaver(failures);
        armFailure(second, mode);
        const model = new RecordingModel();
        const two = await makeRunner({
          command: 'code',
          streamOutput: true,
          model,
          saver: second,
          threadId: thread,
        });
        expect(await say(two, 'look up the code again')).toContain(`looked it up: ${SECRET}`);
        expect(model.lastCallSawToolResult()).toBe(true);
        // The pre-resume transcript, then the new turn and its tool result.
        expect(model.lastCallShape()).toBe('system,human,ai,tool,ai,human,ai,tool');
        expect(toolCalls).toBe(2);
        expect(failures).toHaveLength(1);
      },
      REAL_AGENT_TIMEOUT_MS
    );
  }

  /**
   * Test 6: a graph closed while suspended on an approval, reopened, and answered with writes
   * failing. No shipped surface answers an approval left pending by an earlier process — `/resume`
   * refuses a suspended graph — so this drives the runner's own drain loop, which is what answers
   * every approval inside a turn.
   */
  it(
    'a thread suspended on an approval, reopened with writes failing, runs the tool when the approval is answered',
    async () => {
      const thread = 'thread-suspended-on-approval';
      const first = openSaver();
      const one = await makeRunner({
        command: 'code',
        streamOutput: true,
        model: new RecordingModel(),
        saver: first,
        threadId: thread,
        approvals: 'write',
        decide: async () => {
          throw new Error('the human walked away');
        },
      });
      await expect(say(one, 'look up the code')).rejects.toThrow();
      expect(toolCalls).toBe(0);
      first.close();

      const failures: unknown[] = [];
      const second = openSaver(failures);
      armFailure(second, 'both');
      const model = new RecordingModel();
      const two = await makeRunner({
        command: 'code',
        streamOutput: true,
        model,
        saver: second,
        threadId: thread,
        approvals: 'write',
      });
      const drain = (two as unknown as { resolveToolInterrupts: () => Promise<string> })
        .resolveToolInterrupts;
      const resumed = await drain.call(two);
      expect(toolCalls).toBe(1);
      expect(resumed).toContain(`looked it up: ${SECRET}`);
      expect(model.lastCallSawToolResult()).toBe(true);
      // And the turn after it reads the result back — from memory, since nothing reached disk.
      expect(await say(two, 'what was the code')).toContain(`recall:${SECRET}`);
      expect(failures).toHaveLength(1);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  /**
   * Test 7's checked-in guard. The measured drift from writing the mirror ahead of the durable path
   * was exactly this row: the input `HumanMessage` write gained an `id` that LangGraph stamps onto
   * the message object in place after it hands the write over without awaiting it. The row must
   * carry what it carried before the mirror existed — no id. The input carries no id of its own,
   * because a fixed id would hide the effect.
   */
  it(
    'persists the input HumanMessage write WITHOUT an id — the durable write is serialized before LangGraph stamps one',
    async () => {
      const saver = openSaver();
      const runner = await makeRunner({
        command: 'code',
        streamOutput: true,
        model: new RecordingModel(),
        saver,
        threadId: 't1',
      });
      expect(await say(runner, 'look up the code')).toContain(`looked it up: ${SECRET}`);
      saver.close();

      const audit = new DatabaseSync(dbPath);
      const rows = audit
        .prepare(`SELECT value FROM checkpoint_writes WHERE channel = 'messages'`)
        .all() as { value: Uint8Array }[];
      audit.close();
      // The input write is the one `messages` write holding the human turn ALONE; every later
      // `messages` write carries the whole list, by which point the reducer has stamped the id.
      const inputWrites = rows
        .map((row) => new TextDecoder().decode(row.value))
        .filter((text) => {
          const value = JSON.parse(text) as { id?: string[] }[];
          return value.length === 1 && value[0].id?.includes('HumanMessage') === true;
        });
      // The control for the assertion below: the row exists, so "no id" is not "no row".
      expect(inputWrites).toHaveLength(1);
      expect(inputWrites[0]).not.toMatch(/"id":"/);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  /**
   * Healthy sessions read through the in-memory copy, so on the no-failure path it must hand the
   * graph exactly what SQLite would: same checkpoint, same metadata, same pending writes IN THE
   * SAME ORDER, same config and parent link. Compared against a second saver over the same file,
   * whose empty memory makes it read SQLite.
   */
  it(
    'the in-memory copy answers exactly what SQLite answers — after a completed turn and while suspended on an approval',
    async () => {
      const saver = openSaver();
      const runner = await makeRunner({
        command: 'code',
        streamOutput: true,
        model: new RecordingModel(),
        saver,
        threadId: 'thread-done',
      });
      await say(runner, 'look up the code');
      const reader = openSaver();
      const done = { configurable: { thread_id: 'thread-done' } };
      expect(await saver.getTuple(done)).toEqual(await reader.getTuple(done));

      const suspended = await makeRunner({
        command: 'code',
        streamOutput: true,
        model: new RecordingModel(),
        saver,
        threadId: 'thread-suspended',
        approvals: 'write',
        decide: async () => {
          throw new Error('the human walked away');
        },
      });
      await expect(say(suspended, 'look up the code')).rejects.toThrow();
      const pending = { configurable: { thread_id: 'thread-suspended' } };
      const fromMemory = await saver.getTuple(pending);
      const fromDisk = await openSaver().getTuple(pending);
      expect(fromMemory?.pendingWrites?.some(([, channel]) => channel === '__interrupt__')).toBe(
        true
      );
      expect(fromMemory).toEqual(fromDisk);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'holds ONE checkpoint per thread in memory, however many tool turns the thread runs',
    async () => {
      const saver = openSaver();
      const runner = await makeRunner({
        command: 'code',
        streamOutput: true,
        model: new RecordingModel(),
        saver,
        threadId: 'thread-long',
      });
      for (let turn = 0; turn < 3; turn++) {
        expect(await say(runner, `look up the code ${turn}`)).toContain(`looked it up: ${SECRET}`);
      }
      expect(toolCalls).toBe(3);
      // The control: the file holds the whole chain, so "one" is the bound, not a short chain.
      expect(countRows(dbPath, 'checkpoints')).toBeGreaterThan(10);
      const mirror = (saver as unknown as { mirror: { checkpointCount(): number } }).mirror;
      expect(mirror.checkpointCount()).toBe(1);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  /** Test 9: the retention invariant, for the two ways a thread enters memory without a durable write. */
  describe('retention never reclaims a thread this session holds in memory', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const far = () => Date.now() + 30 * DAY;

    beforeEach(() => {
      // Both halves of the schema, as the product creates them: the store owns `conversations`.
      openHistoryStore(dbPath, { create: true })!.close();
    });

    const writeOrphan = async (thread: string): Promise<void> => {
      const writer = openSaver();
      const runner = await makeRunner({
        command: 'code',
        streamOutput: true,
        model: new RecordingModel(),
        saver: writer,
        threadId: thread,
      });
      await say(runner, 'hello');
      writer.close();
    };

    it(
      'a thread only READ (seeded into memory) is excluded; the control without the read reclaims it',
      async () => {
        await writeOrphan('thread-read-only');
        const reader = openSaver();
        expect(
          await reader.getTuple({ configurable: { thread_id: 'thread-read-only' } })
        ).toBeDefined();
        expect(reader.reclaimUnresumableThreads({ now: far() }).threadCount).toBe(0);

        const control = openSaver();
        expect(control.reclaimUnresumableThreads({ now: far() }).threadCount).toBe(1);
      },
      REAL_AGENT_TIMEOUT_MS
    );

    it(
      'a thread written only AFTER the cut is excluded; the control reclaims it',
      async () => {
        await writeOrphan('thread-after-cut');
        const failures: unknown[] = [];
        const saver = openSaver(failures);
        // A checkpoint-only trigger, not `query_only`: reclamation deletes rows, and a read-only
        // connection would make the control fail for the wrong reason.
        armFailure(saver, 'put-only');
        const checkpoint = (id: string) => ({
          v: 4,
          id,
          ts: new Date().toISOString(),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        });
        const meta = { source: 'loop' as const, step: 0, parents: {} };
        // The cut, on another thread first…
        await saver.put(
          { configurable: { thread_id: 'thread-cut-here' } },
          checkpoint('a'),
          meta,
          {}
        );
        expect(failures).toHaveLength(1);
        // …then the thread under test, written only after it.
        await saver.put(
          { configurable: { thread_id: 'thread-after-cut' } },
          checkpoint('b'),
          meta,
          {}
        );
        expect(failures).toHaveLength(1);
        connectionOf(saver).exec('DROP TRIGGER gs2_117_fail');
        expect(saver.reclaimUnresumableThreads({ now: far() }).threadCount).toBe(0);

        const control = openSaver();
        expect(control.reclaimUnresumableThreads({ now: far() }).threadCount).toBe(1);
      },
      REAL_AGENT_TIMEOUT_MS
    );
  });
});
