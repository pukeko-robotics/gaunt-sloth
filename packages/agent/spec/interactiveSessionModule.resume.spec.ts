/**
 * GS2-20 — resume on the readline (`--no-tui`) surface, through both spellings: `--resume <id>` at
 * boot and `/resume [<id>]` mid-session. The history store and the checkpointer are REAL over a
 * temp file — the checks read them — and the runner is mocked, because its half of the seam
 * (`resumeConversation`) is asserted on the real lean agent in core's `resumeConversationRunner`
 * spec. What this file proves is the session layer: the checks refuse with their sentences, a
 * landed resume drives the runner seam, moves the recorder, shows the banner and the restored
 * turns, and keeps a grant made afterwards with the conversation it was made in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';
import type { ConversationGrants } from '@gaunt-sloth/core/core/approvals/conversationGrants.js';

// readline / stdin — the `>` prompt returns each scripted user turn in order, then 'exit'.
let turnsAsked = 0;
let scriptedTurns: string[] = [];
const rlQuestionMock = vi.fn(async (prompt: string) => {
  if (typeof prompt === 'string' && prompt.includes('>')) {
    const turn = scriptedTurns[turnsAsked] ?? 'exit';
    turnsAsked += 1;
    return turn;
  }
  return '';
});
const systemUtilsMock = {
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  error: vi.fn(),
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  getUseColour: vi.fn(() => false),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: false, columns: 80 },
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

const consoleUtilsMock = {
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayDialogLine: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayLaunchBanner: vi.fn(),
  displayNotice: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const initConfigMock = vi.fn();
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

/** The runner, faked at the seam: what the session asks of it is recorded, nothing runs. */
const runnerInstanceMock = {
  init: vi.fn(),
  processMessages: vi.fn(),
  getRunStats: vi.fn(() => ({ tools: [] })),
  resumeConversation: vi.fn(),
  setSessionGrantsListener: vi.fn(),
  getSessionScopedGrants: vi.fn((): ConversationGrants => ({ allow: [], deny: [] })),
  compactConversation: vi.fn(),
  setApprovalOutcomeCallback: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  setAttackHaltCallback: vi.fn(),
  setNegotiationDisplay: vi.fn(),
  getTerminationReason: vi.fn(() => null),
  cleanup: vi.fn(),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn(() => ({})) }));
vi.mock('#src/core/resolveAgentFactory.js', () => ({ resolveAgentFactory: vi.fn(() => vi.fn()) }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

const grant = (pattern: string) => ({
  entry: { type: 'shell' as const, matcher: 'exact' as const, pattern },
  grantedAt: '2026-09-01T10:00:00.000Z',
  scope: 'session' as const,
});

describe('interactiveSessionModule — resume (GS2-20)', () => {
  let dir: string;
  let dbPath: string;
  let config: { history: { dbPath: string; enabled?: boolean } };

  beforeEach(() => {
    vi.clearAllMocks();
    turnsAsked = 0;
    scriptedTurns = [];
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-readline-resume-'));
    dbPath = resolve(dir, 'history.db');
    config = { history: { dbPath } };
    systemUtilsMock.getProjectDir.mockReturnValue('/proj');
    initConfigMock.mockResolvedValue({
      streamSessionInferenceLog: false,
      modelDisplayName: 'test-model',
      history: { dbPath },
    });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('the answer');
    // `clearAllMocks` keeps implementations: a test that makes the seam throw must not leak it.
    runnerInstanceMock.resumeConversation.mockImplementation(() => undefined);
    runnerInstanceMock.getRunStats.mockReturnValue({ tools: [] });
    runnerInstanceMock.getSessionScopedGrants.mockReturnValue({ allow: [], deny: [] });
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const core = async () => ({
    ...(await import('@gaunt-sloth/core/history/recordSession.js')),
    ...(await import('@gaunt-sloth/core/history/checkpointSaver.js')),
    ...(await import('@gaunt-sloth/core/history/historyStore.js')),
    ...(await import('@gaunt-sloth/core/core/approvals/conversationGrants.js')),
  });

  /**
   * A recorded conversation, as a finished session leaves one: a row with a thread and a project,
   * its turns, a checkpoint under the thread, and optionally the grants made in it.
   */
  const seed = async (over: {
    command?: string;
    project?: string;
    threadId?: string;
    turns?: [string, string][];
    checkpoint?: boolean;
    grants?: ConversationGrants;
  }): Promise<number> => {
    const c = await core();
    const threadId = over.threadId ?? 'thread-seeded';
    const command = over.command ?? 'code';
    const id = c.openConversationSafe(config, {
      command,
      project: over.project ?? '/proj',
      model: 'seed-model',
      threadId,
    })!;
    for (const [prompt, response] of over.turns ?? [
      ['first prompt', 'first answer'],
      ['second prompt', 'second answer'],
    ]) {
      c.recordSessionSafe(config, { conversationId: id, command, prompt, response });
    }
    if (over.checkpoint !== false) {
      const saver = c.openCheckpointSaver(dbPath)!;
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_ns: '' } },
        {
          v: 4,
          id: `cp-${threadId}`,
          ts: new Date().toISOString(),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: 0, parents: {} },
        {}
      );
      saver.close();
    }
    if (over.grants) c.saveConversationGrantsSafe(config, id, over.grants);
    return id;
  };

  const startSession = async (options?: { resumeConversationId?: number }) => {
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {}, undefined, options);
  };

  const notices = () =>
    consoleUtilsMock.displayNotice.mock.calls.map(([title, lines, options]) => ({
      title: title as string,
      lines: lines as string[],
      tone: (options as { tone?: string } | undefined)?.tone,
    }));
  const displayed = () => consoleUtilsMock.display.mock.calls.map(([line]) => String(line));

  const threadOf = async (id: number) => {
    const { openHistoryStore } = await core();
    const store = openHistoryStore(dbPath, { create: false })!;
    try {
      return {
        turns: store.getConversationThread(id),
        conversations: store.listConversations(50),
        grants: store.getConversationGrants(id),
      };
    } finally {
      store.close();
    }
  };

  it('--resume: drives the runner seam with the stored thread and grants, shows the banner and the turns, and keeps recording under that conversation', async () => {
    const id = await seed({ grants: { allow: [grant('git status')], deny: [] } });
    scriptedTurns = ['a third question'];

    await startSession({ resumeConversationId: id });

    // The ONE seam: the runner is told the stored thread and the conversation's grants.
    expect(runnerInstanceMock.resumeConversation).toHaveBeenCalledTimes(1);
    const [[seam]] = runnerInstanceMock.resumeConversation.mock.calls;
    expect(seam.threadId).toBe('thread-seeded');
    expect(seam.grants.allow.map((g: { entry: unknown }) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'git status' },
    ]);
    expect(seam.grants.deny).toEqual([]);
    // …after the runner was built on a thread of its own, so init and apply are two calls.
    expect(runnerInstanceMock.init).toHaveBeenCalledTimes(1);
    expect(runnerInstanceMock.init.mock.invocationCallOrder[0]).toBeLessThan(
      runnerInstanceMock.resumeConversation.mock.invocationCallOrder[0]
    );

    // The banner, then the recorded turns replayed with the prompt marker.
    const banner = notices().find((n) => n.title === `Resumed conversation #${id}`);
    expect(banner).toBeDefined();
    expect(banner!.lines.join(' ')).toContain('2 turns recorded under gth code, with seed-model');
    expect(banner!.lines.join(' ')).toContain('in /proj');
    expect(banner!.lines.join(' ')).toContain('Approvals you granted in it are in force again');
    const shown = displayed();
    expect(shown).toContain('  > first prompt');
    expect(shown).toContain('first answer');
    expect(shown).toContain('  > second prompt');
    expect(shown).toContain('second answer');
    // The greeting for a NEW session is not what a resumed one opens with… but the ready line and
    // the exit hint still print, because the prompt is the same prompt.
    expect(shown.indexOf('  > first prompt')).toBeLessThan(shown.indexOf('ready'));

    // The new turn was recorded under the RESUMED conversation — no new row was opened.
    const after = await threadOf(id);
    expect(after.turns.map((t) => t.prompt)).toEqual([
      'first prompt',
      'second prompt',
      'a third question',
    ]);
    expect(after.conversations.map((c) => c.id)).toEqual([id]);
    expect(systemUtilsMock.exit).not.toHaveBeenCalledWith(1);
  });

  it('--resume: /status names the resumed conversation, and its turn count continues from the record', async () => {
    const id = await seed({});
    scriptedTurns = ['/status'];
    await startSession({ resumeConversationId: id });
    const status = notices().find((n) => n.title === 'Session status');
    expect(status).toBeDefined();
    expect(status!.lines).toContain('Turns so far: 2');
    expect(status!.lines.join(' ')).toContain(`Conversation: #${id}`);
    expect(status!.lines.join(' ')).toContain(`gth history resume ${id}`);
  });

  describe('--resume refusals, each fail-soft with its own message and nothing changed', () => {
    const refused = async (id: number) => {
      await startSession({ resumeConversationId: id });
      // Refused BEFORE the runner exists: no init, no seam call, exit status 1.
      expect(runnerInstanceMock.init).not.toHaveBeenCalled();
      expect(runnerInstanceMock.resumeConversation).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
      expect(notices()).toHaveLength(1);
      return notices()[0];
    };

    it('history off — names the switch', async () => {
      const id = await seed({});
      initConfigMock.mockResolvedValue({
        streamSessionInferenceLog: false,
        modelDisplayName: 'test-model',
        history: { dbPath, enabled: false },
      });
      const notice = await refused(id);
      expect(notice.title).toBe('Cannot resume: history is off');
      expect(notice.lines.join(' ')).toContain('`history.enabled: false`');
      expect(notice.tone).toBe('warn');
      // Nothing was recorded, and the store was not created either.
      expect(existsSync(dbPath)).toBe(true); // seeded above, unchanged
      expect((await threadOf(id)).conversations).toHaveLength(1);
    });

    it('unknown id', async () => {
      await seed({});
      const notice = await refused(9999);
      expect(notice.title).toBe('No conversation #9999');
      expect(notice.lines.join(' ')).toContain('`gth history list`');
    });

    it('a single-shot run has no state to re-enter', async () => {
      const { recordSessionSafe } = await core();
      const askId = recordSessionSafe(config, { command: 'ask', prompt: 'p', response: 'r' })!;
      const notice = await refused(askId);
      expect(notice.title).toBe(`Conversation #${askId} cannot be resumed`);
      expect(notice.lines[0]).toContain('`gth ask`');
      expect(notice.lines[0]).toContain('single-shot');
    });

    it('a conversation marked unresumable (null thread)', async () => {
      const id = await seed({});
      const { markConversationUnresumableSafe } = await core();
      markConversationUnresumableSafe(config, id);
      const notice = await refused(id);
      expect(notice.title).toBe(`Conversation #${id} cannot be resumed`);
      expect(notice.lines[0]).toContain('marked unresumable');
    });

    it('a thread with no checkpoint, refused like a null thread', async () => {
      const id = await seed({ checkpoint: false });
      const notice = await refused(id);
      expect(notice.title).toBe(`Conversation #${id} cannot be resumed`);
      // GS2-107 widened this sentence: a prune is a second way for a named thread to hold no state,
      // and the row cannot tell the two apart, so the notice claims neither.
      expect(notice.lines[0]).toContain('is not in the store');
      expect(notice.lines[0]).toContain('gth history prune');
    });

    it('a conversation recorded in another directory — both directories named', async () => {
      const id = await seed({ project: '/elsewhere' });
      const notice = await refused(id);
      expect(notice.title).toBe(`Conversation #${id} belongs to another project`);
      expect(notice.lines[0]).toContain(resolve('/elsewhere'));
      expect(notice.lines[0]).toContain(resolve('/proj'));
    });
  });

  it('/resume <id> mid-session: same seam call, the recorder moves, the banner and turns show, and the old conversation keeps its record', async () => {
    const stored = await seed({ grants: { allow: [], deny: [grant('rm -rf build')] } });
    scriptedTurns = ['hello from the new session', `/resume ${stored}`, 'and after the resume'];

    await startSession();

    // The session opened a conversation of its own and recorded the first turn under it.
    const { openHistoryStore } = await core();
    const store = openHistoryStore(dbPath, { create: false })!;
    const rows = store.listConversations(50);
    store.close();
    const own = rows.find((c) => c.id !== stored)!;
    expect(own).toBeDefined();
    expect(own.turnCount).toBe(1);
    expect(own.lastPrompt).toBe('hello from the new session');

    // The seam, once, with the stored thread and the stored refusal.
    expect(runnerInstanceMock.resumeConversation).toHaveBeenCalledTimes(1);
    const [[seam]] = runnerInstanceMock.resumeConversation.mock.calls;
    expect(seam.threadId).toBe('thread-seeded');
    expect(seam.grants.deny.map((g: { entry: unknown }) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'rm -rf build' },
    ]);

    // Banner and replay.
    expect(notices().some((n) => n.title === `Resumed conversation #${stored}`)).toBe(true);
    expect(displayed()).toContain('  > second prompt');

    // The turn AFTER the resume went to the resumed conversation, and the first stayed put.
    const resumed = await threadOf(stored);
    expect(resumed.turns.map((t) => t.prompt)).toEqual([
      'first prompt',
      'second prompt',
      'and after the resume',
    ]);
    expect(rows.find((c) => c.id === stored)!.turnCount).toBe(3);
    // The command was never sent to the model.
    expect(runnerInstanceMock.processMessages).toHaveBeenCalledTimes(2);
  });

  it('bare /resume lists only the resumable conversations, and not the one this session is in', async () => {
    const resumable = await seed({ threadId: 'thread-r' });
    const { recordSessionSafe, openConversationSafe } = await core();
    const askId = recordSessionSafe(config, { command: 'ask', prompt: 'single', response: 'r' })!;
    const empty = openConversationSafe(config, { command: 'chat', threadId: 'thread-empty' })!;
    scriptedTurns = ['a first turn', '/resume'];

    await startSession();

    const picker = notices().find((n) => n.title === 'Conversations you can resume');
    expect(picker).toBeDefined();
    const body = picker!.lines.join('\n');
    expect(body).toContain(`#${resumable}`);
    expect(body).not.toContain(`#${askId}`);
    expect(body).not.toContain(`#${empty}`);
    // The current conversation — the one the first turn was recorded under — is left out.
    const { openHistoryStore } = await core();
    const store = openHistoryStore(dbPath, { create: false })!;
    const current = store.listConversations(50).find((c) => c.lastPrompt === 'a first turn')!;
    store.close();
    expect(current).toBeDefined();
    expect(body).not.toContain(`#${current.id}`);
    expect(runnerInstanceMock.resumeConversation).not.toHaveBeenCalled();
  });

  it('/resume naming the current conversation is a no-op with a notice; a refusal mid-session leaves the session where it was', async () => {
    const other = await seed({ project: '/elsewhere' });
    scriptedTurns = ['first', '/resume 9999', `/resume ${other}`, '/status'];

    await startSession();

    // The session's own id, to name it.
    const { openHistoryStore } = await core();
    const store = openHistoryStore(dbPath, { create: false })!;
    const own = store.listConversations(50).find((c) => c.lastPrompt === 'first')!;
    store.close();
    scriptedTurns = [];

    expect(notices().find((n) => n.title === 'No conversation #9999')).toBeDefined();
    const mismatch = notices().find(
      (n) => n.title === `Conversation #${other} belongs to another project`
    );
    expect(mismatch).toBeDefined();
    // Still in its own conversation: /status says so, and the seam was never driven.
    const status = notices().find((n) => n.title === 'Session status');
    expect(status!.lines.join(' ')).toContain(`Conversation: #${own.id}`);
    expect(runnerInstanceMock.resumeConversation).not.toHaveBeenCalled();
  });

  it('/resume <current id> says it is already there', async () => {
    scriptedTurns = ['first', '/status'];
    await startSession();
    const status = notices().find((n) => n.title === 'Session status')!;
    const own = Number(/Conversation: #(\d+)/.exec(status.lines.join(' '))![1]);
    vi.clearAllMocks();
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('the answer');
    // A second session resumed into `own`, then asked to resume `own` again.
    await (async () => {
      const c = await core();
      const saver = c.openCheckpointSaver(dbPath)!;
      const threadId = c.lookupConversationThreadSafe(config, own)!;
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_ns: '' } },
        {
          v: 4,
          id: 'cp-own',
          ts: new Date().toISOString(),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: 0, parents: {} },
        {}
      );
      saver.close();
    })();
    turnsAsked = 0;
    scriptedTurns = [`/resume ${own}`];
    await startSession({ resumeConversationId: own });
    expect(notices().find((n) => n.title === `Already in conversation #${own}`)).toBeDefined();
    expect(runnerInstanceMock.resumeConversation).toHaveBeenCalledTimes(1); // the boot one only
  });

  it('the two spellings share the seam: a runner that cannot resume fails both', async () => {
    const id = await seed({});
    runnerInstanceMock.resumeConversation.mockImplementation(() => {
      throw new Error('thread rotation refused');
    });

    // Mid-session: the failure is a notice and the session goes on.
    scriptedTurns = ['first', `/resume ${id}`, 'still here'];
    await startSession();
    const failed = notices().find((n) => n.title === 'Resume did not happen');
    expect(failed).toBeDefined();
    expect(failed!.lines[0]).toContain('thread rotation refused');
    expect(runnerInstanceMock.processMessages).toHaveBeenCalledTimes(2);

    // At boot: the same seam throws inside the session's guard, which ends the session.
    vi.clearAllMocks();
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.resumeConversation.mockImplementation(() => {
      throw new Error('thread rotation refused');
    });
    turnsAsked = 0;
    scriptedTurns = [];
    await startSession({ resumeConversationId: id });
    expect(systemUtilsMock.error).toHaveBeenCalledWith(
      expect.stringContaining('thread rotation refused')
    );
    expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
  });

  it('Ruling 3: a grant made after the resume is written against the RESUMED conversation', async () => {
    const stored = await seed({});
    scriptedTurns = ['first', `/resume ${stored}`];
    await startSession();

    // The listener the session registered, fed a grant the runner now holds.
    expect(runnerInstanceMock.setSessionGrantsListener).toHaveBeenCalledTimes(1);
    const [[listener]] = runnerInstanceMock.setSessionGrantsListener.mock.calls;
    runnerInstanceMock.getSessionScopedGrants.mockReturnValue({
      allow: [grant('npm test')],
      deny: [],
    });
    listener();

    const { openHistoryStore } = await core();
    const store = openHistoryStore(dbPath, { create: false })!;
    const own = store.listConversations(50).find((c) => c.lastPrompt === 'first')!;
    const resumedGrants = store.getConversationGrants(stored);
    const ownGrants = store.getConversationGrants(own.id);
    store.close();
    expect(resumedGrants).toContain('npm test');
    expect(ownGrants).toBeNull();
  });
});
