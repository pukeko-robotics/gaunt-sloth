/**
 * GS2-20 fix round, finding 2 — **the Ink session module's own half of the resume seam**, which
 * `AppResume.spec.tsx` cannot see because it mocks `agent.resumeConversation` outright.
 *
 * Two lines live only here, and the reviewer's mutations deleted both without turning the suite
 * red: the boot `applyResumeTarget` (a `--resume` that shows the banner and the restored turns
 * while the model sits on a fresh thread — the message-replay shape ruling 1 forbids) and the
 * recorder move after a mid-session `/resume` (every later turn recorded under the conversation
 * that was left). The default surface is the one most people resume on, so both are pinned here.
 *
 * The store and the checkpointer are REAL over a temp file — the checks read them — and the runner
 * is the fake, because its half of the seam is asserted on a real lean agent in core's
 * `resumeConversationRunner` spec and composed with this module's seam in the agent package's
 * `resumeComposed` spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import type { ResumeResolution, ResumeTarget } from '@gaunt-sloth/agent/modules/sessionResume.js';
import type { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';

// ── ink render: held open, so a test can drive the mounted session before it ends ─────────────
const renderMock = vi.fn();
let releaseSession: (() => void) | undefined;
vi.mock('ink', () => ({ render: renderMock }));

const initConfigMock = vi.fn();
vi.mock('@gaunt-sloth/core/config.js', () => ({ initConfig: initConfigMock }));

/** The runner, faked at the seam. What the module asks of it is the subject. */
const runnerMock = vi.hoisted(() => ({
  init: vi.fn(),
  getAgent: vi.fn(() => ({})),
  cleanup: vi.fn(),
  processMessagesWithEvents: vi.fn(),
  resetThread: vi.fn(),
  resumeConversation: vi.fn(),
  setSessionGrantsListener: vi.fn(),
  getSessionScopedGrants: vi.fn(() => ({ allow: [], deny: [] })),
  setToolApprovalCallback: vi.fn(),
  setApprovalOutcomeCallback: vi.fn(),
  setAttackHaltCallback: vi.fn(),
  setNegotiationDisplay: vi.fn(),
  getSessionApprovals: vi.fn(() => ({
    mode: 'ask',
    rater: { enabled: false, strictness: 'standard', escalate: 'danger' },
    allowlist: true,
    persistAllowlist: true,
  })),
  getAllowlistCounts: vi.fn(() => ({ session: 0, always: undefined })),
  getApprovalCaptures: vi.fn(() => []),
  getRunStats: vi.fn(() => ({ tools: [] })),
  getTerminationReason: vi.fn(() => null),
}));
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerMock;
  }),
}));

vi.mock('@gaunt-sloth/core/core/types.js', () => ({ StatusLevel: {} }));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  flushSessionLog: vi.fn(),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
  beginWarningCapture: vi.fn(),
  endWarningCapture: vi.fn(() => []),
  displayNotice: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn(() => undefined),
}));

const systemUtilsMock = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  stdout: { isTTY: true, rows: 24, write: vi.fn() },
  // Mouse is off in every config below, so nothing subscribes; these are the members the module
  // touches on the way past. A plain object rather than a stream, because `vi.hoisted` runs before
  // this file's imports and a `new PassThrough()` here would read an uninitialised binding.
  stdin: {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  },
}));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({ createResolvers: vi.fn(() => ({})) }));
vi.mock('@gaunt-sloth/agent/core/resolveAgentFactory.js', () => ({
  resolveAgentFactory: vi.fn(() => vi.fn()),
}));
vi.mock('#src/tui/components/App.js', () => ({ App: vi.fn(() => null) }));
vi.mock('#src/tui/debugRender.js', () => ({
  renderHistory: vi.fn(),
  renderSystemDetails: vi.fn(),
  renderToolDetails: vi.fn(),
  renderResponse: vi.fn(),
  collectMcpOverview: vi.fn(() => ({ servers: [], instructions: [], failures: [] })),
  renderMcpDetails: vi.fn(),
}));

const sessionConfig = {
  mode: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as SessionConfig;
const overrides = {} as CommandLineConfigOverrides;

interface AppProps {
  agent: {
    resumeConversation?(id: number): Promise<ResumeResolution>;
  };
  conversationId?: number;
  resumed?: ResumeTarget;
  onTurnComplete(prompt: string, response: string): void;
  listResumeCandidates?(): { id: number }[];
}

describe('createTuiSession — resume (GS2-20 finding 2)', () => {
  let dir: string;
  let dbPath: string;
  let config: { history: { dbPath: string } };

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-tui-resume-'));
    dbPath = resolve(dir, 'history.db');
    config = { history: { dbPath } };
    systemUtilsMock.env = {};
    systemUtilsMock.stdout.isTTY = true;
    systemUtilsMock.getProjectDir.mockReturnValue('/proj');
    initConfigMock.mockResolvedValue({ modelDisplayName: 'test-model', history: { dbPath } });
    runnerMock.init.mockResolvedValue(undefined);
    runnerMock.cleanup.mockResolvedValue(undefined);
    runnerMock.getAgent.mockReturnValue({});
    runnerMock.resumeConversation.mockImplementation(() => undefined);
    runnerMock.getSessionScopedGrants.mockReturnValue({ allow: [], deny: [] });
    renderMock.mockImplementation(() => ({
      clear: vi.fn(),
      waitUntilExit: () =>
        new Promise<void>((resolveExit) => {
          releaseSession = resolveExit;
        }),
    }));
  });
  afterEach(() => {
    releaseSession?.();
    releaseSession = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const core = async () => ({
    ...(await import('@gaunt-sloth/core/history/recordSession.js')),
    ...(await import('@gaunt-sloth/core/history/checkpointSaver.js')),
    ...(await import('@gaunt-sloth/core/history/historyStore.js')),
    ...(await import('@gaunt-sloth/core/core/approvals/conversationGrants.js')),
  });

  /** A recorded, resumable conversation: a row with a thread and a project, turns, a checkpoint. */
  const seed = async (over: { threadId?: string; grantPattern?: string } = {}): Promise<number> => {
    const c = await core();
    const threadId = over.threadId ?? 'thread-seeded';
    const id = c.openConversationSafe(config, {
      command: 'code',
      project: '/proj',
      model: 'seed-model',
      threadId,
    })!;
    c.recordSessionSafe(config, {
      conversationId: id,
      command: 'code',
      prompt: 'old prompt',
      response: 'old answer',
    });
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
    if (over.grantPattern) {
      c.saveConversationGrantsSafe(config, id, {
        allow: [
          {
            entry: { type: 'shell', matcher: 'exact', pattern: over.grantPattern },
            grantedAt: '2026-09-01T10:00:00.000Z',
            scope: 'session',
          },
        ],
        deny: [],
      });
    }
    return id;
  };

  /**
   * Start the session and hand back its App props while it is still mounted (Ink's `waitUntilExit`
   * is held open above). `end()` releases it and awaits the module's own teardown.
   */
  const mount = async (options?: {
    resumeConversationId?: number;
  }): Promise<{ props: AppProps; end: () => Promise<void> }> => {
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');
    const session = createTuiSession(sessionConfig, overrides, undefined, undefined, options);
    await vi.waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const element = renderMock.mock.calls[0][0] as { props: AppProps };
    return {
      props: element.props,
      end: async () => {
        releaseSession?.();
        releaseSession = undefined;
        await session;
      },
    };
  };

  const conversationsIn = async () => {
    const { openHistoryStore } = await core();
    const store = openHistoryStore(dbPath, { create: false })!;
    try {
      return store.listConversations(50);
    } finally {
      store.close();
    }
  };

  it('--resume drives the runner seam at boot with the stored thread and grants, after init built a thread of its own', async () => {
    const id = await seed({ grantPattern: 'git status' });

    const { props, end } = await mount({ resumeConversationId: id });

    // THE PIN for M20b — without the boot `applyResumeTarget` the banner and the restored turns
    // would still reach <App> (they come from the `resumed` prop) while the model sat on the fresh
    // thread `init` minted, which is replay pretending to be state.
    expect(runnerMock.resumeConversation).toHaveBeenCalledTimes(1);
    const [[seam]] = runnerMock.resumeConversation.mock.calls;
    expect(seam.threadId).toBe('thread-seeded');
    expect(seam.grants.allow.map((g: { entry: unknown }) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'git status' },
    ]);
    expect(runnerMock.init).toHaveBeenCalledTimes(1);
    expect(runnerMock.init.mock.invocationCallOrder[0]).toBeLessThan(
      runnerMock.resumeConversation.mock.invocationCallOrder[0]
    );
    // The App is told which conversation it is in, and given the turns to seed the transcript.
    expect(props.conversationId).toBe(id);
    expect(props.resumed?.conversationId).toBe(id);
    expect(props.resumed?.turns.map((t) => t.prompt)).toEqual(['old prompt']);
    // No second row was opened for the resumed session.
    expect((await conversationsIn()).map((c) => c.id)).toEqual([id]);
    await end();
  });

  it('a completed turn after a boot resume is recorded under the resumed conversation', async () => {
    const id = await seed();
    const { props, end } = await mount({ resumeConversationId: id });

    props.onTurnComplete('a new question', 'a new answer');

    const rows = await conversationsIn();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].turnCount).toBe(2);
    expect(rows[0].lastPrompt).toBe('a new question');
    await end();
  });

  it('/resume moves the recorder: the next turn is recorded under the conversation switched TO, and the one left keeps its own', async () => {
    const stored = await seed({ threadId: 'thread-stored', grantPattern: 'npm test' });
    const { props, end } = await mount();

    // The session opened a row of its own, and its first turn belongs to it.
    props.onTurnComplete('before the resume', 'answer one');
    const own = (await conversationsIn()).find((c) => c.id !== stored)!;
    expect(own.turnCount).toBe(1);

    const resolution = await props.agent.resumeConversation!(stored);
    expect(resolution.ok).toBe(true);
    // The seam was driven with the stored thread and the conversation's grants…
    expect(runnerMock.resumeConversation).toHaveBeenCalledTimes(1);
    const [[seam]] = runnerMock.resumeConversation.mock.calls;
    expect(seam.threadId).toBe('thread-stored');
    expect(seam.grants.allow.map((g: { entry: unknown }) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'npm test' },
    ]);

    // THE PIN for M20a — the turn after the switch is recorded under the RESUMED conversation.
    props.onTurnComplete('after the resume', 'answer two');
    const rows = await conversationsIn();
    expect(rows.find((c) => c.id === stored)!.turnCount).toBe(2);
    expect(rows.find((c) => c.id === stored)!.lastPrompt).toBe('after the resume');
    expect(rows.find((c) => c.id === own.id)!.turnCount).toBe(1);
    expect(rows.find((c) => c.id === own.id)!.lastPrompt).toBe('before the resume');
    await end();
  });

  it('a refused /resume changes nothing: no seam call, and the recorder stays where it was', async () => {
    const { props, end } = await mount();
    props.onTurnComplete('first', 'answer');
    const own = (await conversationsIn())[0];

    const resolution = await props.agent.resumeConversation!(4242);
    expect(resolution).toEqual({ ok: false, refusal: { kind: 'unknown', id: 4242 } });
    expect(runnerMock.resumeConversation).not.toHaveBeenCalled();

    props.onTurnComplete('second', 'answer');
    const rows = await conversationsIn();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(own.id);
    expect(rows[0].turnCount).toBe(2);
    await end();
  });

  it('a boot refusal ends the session before a runner exists, with the refusal on the plain console', async () => {
    const { displayNotice } = await import('@gaunt-sloth/core/utils/consoleUtils.js');
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides, undefined, undefined, {
      resumeConversationId: 77,
    });

    expect(renderMock).not.toHaveBeenCalled();
    expect(runnerMock.init).not.toHaveBeenCalled();
    expect(runnerMock.resumeConversation).not.toHaveBeenCalled();
    expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    expect(displayNotice).toHaveBeenCalledWith(
      'No conversation #77',
      expect.arrayContaining([expect.stringContaining('gth history list')]),
      expect.objectContaining({ tone: 'warn' })
    );
  });

  it('the grants listener writes against the conversation the session is in, before and after a /resume', async () => {
    const stored = await seed({ threadId: 'thread-listener' });
    const { props, end } = await mount();
    expect(runnerMock.setSessionGrantsListener).toHaveBeenCalledTimes(1);
    const [[listener]] = runnerMock.setSessionGrantsListener.mock.calls;
    props.onTurnComplete('first', 'answer');
    const own = (await conversationsIn()).find((c) => c.id !== stored)!;

    const grant = (pattern: string) => ({
      allow: [
        {
          entry: { type: 'shell' as const, matcher: 'exact' as const, pattern },
          grantedAt: '2026-09-01T10:00:00.000Z',
          scope: 'session' as const,
        },
      ],
      deny: [],
    });
    runnerMock.getSessionScopedGrants.mockReturnValue(grant('before'));
    listener();
    await props.agent.resumeConversation!(stored);
    runnerMock.getSessionScopedGrants.mockReturnValue(grant('after'));
    listener();

    const { openHistoryStore } = await core();
    const store = openHistoryStore(dbPath, { create: false })!;
    const ownGrants = store.getConversationGrants(own.id);
    const storedGrants = store.getConversationGrants(stored);
    store.close();
    expect(ownGrants).toContain('before');
    expect(ownGrants).not.toContain('after');
    expect(storedGrants).toContain('after');
    await end();
  });

  it('a bare /resume is offered the resumable conversations this session is not in, read live', async () => {
    const stored = await seed({ threadId: 'thread-live' });
    const { props, end } = await mount();
    props.onTurnComplete('first', 'answer');
    const own = (await conversationsIn()).find((c) => c.id !== stored)!;

    expect(props.listResumeCandidates!().map((c) => c.id)).toEqual([stored]);
    // After moving there, the list is read against the NEW id — the session is never offered the
    // conversation it is now in, and the one it left is offered again.
    await props.agent.resumeConversation!(stored);
    expect(props.listResumeCandidates!().map((c) => c.id)).toEqual([own.id]);
    await end();
  });
});
