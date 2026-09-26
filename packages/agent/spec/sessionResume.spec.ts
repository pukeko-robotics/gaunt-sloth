/**
 * GS2-20 — the resume seam: the five checks in order (each refused with its own reason), what a
 * passing resolution carries, the apply step, the picker's exclusion, the id parser, and the
 * sentences. Real history store and real checkpointer over a temp file; the runner is the one
 * thing faked, because this module's contract with it is one call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  markConversationUnresumableSafe,
  openConversationSafe,
  recordSessionSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import { openSessionCheckpointerSafe } from '@gaunt-sloth/core/history/sessionCheckpointer.js';
import { saveConversationGrantsSafe } from '@gaunt-sloth/core/core/approvals/conversationGrants.js';
import {
  getCurrentWorkDir,
  getProjectDir,
  peekProjectDir,
  setProjectDir,
} from '@gaunt-sloth/core/utils/systemUtils.js';
import type { ApprovalGrant } from '@gaunt-sloth/core/core/approvals/grants.js';
import { parseConversationRef } from '@gaunt-sloth/core/history/conversationRef.js';
import {
  applyResumeTarget,
  listResumeCandidates,
  resolveResumeTarget,
  resumableConversationsNotice,
  resumedConversationNotice,
  resumeRefusalNotice,
  resumeSameConversationNotice,
  type ResumeTarget,
} from '#src/modules/sessionResume.js';
import { isSameWorkspace } from '#src/modules/workspace.js';
import { isSameWorkspace as acpIsSameWorkspace } from '#src/modules/acp/acpCommon.js';

const grant = (pattern: string): ApprovalGrant => ({
  entry: { type: 'shell', matcher: 'exact', pattern },
  grantedAt: '2026-09-01T10:00:00.000Z',
  scope: 'session',
});

/** Write one checkpoint under `threadId`, so the thread has state to re-enter. */
const checkpoint = async (saver: BaseCheckpointSaver, threadId: string): Promise<void> => {
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
};

describe('sessionResume — resolveResumeTarget, the checks in order', () => {
  let dir: string;
  let dbPath: string;
  let config: { history: { dbPath: string; enabled?: boolean } };
  const closers: Array<() => void> = [];

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-resume-seam-'));
    dbPath = resolve(dir, 'history.db');
    config = { history: { dbPath } };
  });
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A durable session checkpointer over the test's database, closed on teardown. */
  const durable = () => {
    const ckpt = openSessionCheckpointerSafe(config, { notify: () => {} });
    closers.push(() => ckpt.close());
    expect(ckpt.durable).toBe(true);
    return ckpt;
  };

  /** A resumable conversation: a row with a thread, two turns, and a checkpoint under the thread. */
  const seedResumable = async (
    saver: BaseCheckpointSaver,
    over: { project?: string; command?: string; threadId?: string } = {}
  ): Promise<number> => {
    const threadId = over.threadId ?? 'thread-ok';
    const id = openConversationSafe(config, {
      command: over.command ?? 'code',
      project: over.project ?? '/work/here',
      model: 'seed-model',
      threadId,
    })!;
    recordSessionSafe(config, { conversationId: id, prompt: 'first', response: 'one' });
    recordSessionSafe(config, { conversationId: id, prompt: 'second', response: 'two' });
    await checkpoint(saver, threadId);
    return id;
  };

  it('1 — history off is refused first, naming the switch, before anything is looked up', async () => {
    const off = { history: { dbPath, enabled: false } };
    // Even with a durable checkpointer handed in, the switch wins: nothing is read.
    const ckpt = durable();
    const id = await seedResumable(ckpt.saver);
    const result = await resolveResumeTarget(
      { config: off, checkpointer: ckpt, workspace: '/work/here' },
      id
    );
    expect(result).toEqual({ ok: false, refusal: { kind: 'history-off' } });
    const notice = resumeRefusalNotice({ kind: 'history-off' });
    expect(notice.title).toBe('Cannot resume: history is off');
    expect(notice.lines.join(' ')).toContain('`history.enabled: false`');
    expect(notice.tone).toBe('warn');
  });

  it('2 — a store that did not open is refused as unavailable, not as an unknown id', async () => {
    const ckpt = durable();
    const id = await seedResumable(ckpt.saver);
    const result = await resolveResumeTarget(
      {
        config,
        checkpointer: { saver: ckpt.saver, durable: false },
        workspace: '/work/here',
      },
      id
    );
    expect(result).toEqual({ ok: false, refusal: { kind: 'store-unavailable' } });
    expect(resumeRefusalNotice({ kind: 'store-unavailable' }).title).toContain('did not open');
  });

  it('3 — an unknown id is refused by name', async () => {
    const ckpt = durable();
    await seedResumable(ckpt.saver);
    const result = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/here' },
      4242
    );
    expect(result).toEqual({ ok: false, refusal: { kind: 'unknown', ref: { kind: 'id', id: 4242 } } });
    const notice = resumeRefusalNotice({ kind: 'unknown', ref: { kind: 'id', id: 4242 } });
    expect(notice.title).toBe('No conversation #4242');
    expect(notice.lines.join(' ')).toContain('`gth history list`');
    // Inside a session the pointer is the slash command, not the shell command.
    expect(
      resumeRefusalNotice(
        { kind: 'unknown', ref: { kind: 'id', id: 4242 } },
        { inSession: true }
      ).lines.join(' ')
    ).toContain('/resume with no id');
  });

  it('4a — a single-shot row (no thread) is refused with its command named', async () => {
    const ckpt = durable();
    const id = recordSessionSafe(config, { command: 'ask', prompt: 'p', response: 'r' })!;
    const result = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/here' },
      id
    );
    expect(result).toEqual({
      ok: false,
      refusal: { kind: 'not-resumable', id, reason: 'single-shot', command: 'ask' },
    });
    const notice = resumeRefusalNotice(
      (result as { refusal: Parameters<typeof resumeRefusalNotice>[0] }).refusal
    );
    expect(notice.title).toBe(`Conversation #${id} cannot be resumed`);
    expect(notice.lines[0]).toContain('`gth ask`');
    expect(notice.lines[0]).toContain('single-shot');
    expect(notice.lines.join(' ')).toContain(`gth history show ${id}`);
  });

  it('4b — an interactive row whose thread was cleared is refused as not resumable', async () => {
    const ckpt = durable();
    const id = await seedResumable(ckpt.saver);
    // What a failed checkpoint write does to the row: the link is cleared on disk.
    markConversationUnresumableSafe(config, id);
    const result = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/here' },
      id
    );
    expect(result).toEqual({
      ok: false,
      refusal: { kind: 'not-resumable', id, reason: 'no-thread', command: 'code' },
    });
    expect(
      resumeRefusalNotice({ kind: 'not-resumable', id, reason: 'no-thread' }).lines[0]
    ).toContain('marked unresumable');
  });

  it('4c — a thread with NO checkpoint is refused exactly like a null thread', async () => {
    const ckpt = durable();
    const id = openConversationSafe(config, {
      command: 'chat',
      project: '/work/here',
      threadId: 'thread-never-written',
    })!;
    recordSessionSafe(config, { conversationId: id, prompt: 'p', response: 'r' });
    const result = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/here' },
      id
    );
    expect(result).toEqual({
      ok: false,
      refusal: { kind: 'not-resumable', id, reason: 'no-checkpoint', command: 'chat' },
    });
    // GS2-107 widened this sentence: `gth history prune` is a second way for a named thread to hold
    // no state, and the row cannot tell the two apart, so the notice claims neither.
    const noCheckpointLine = resumeRefusalNotice({
      kind: 'not-resumable',
      id,
      reason: 'no-checkpoint',
    }).lines[0];
    expect(noCheckpointLine).toContain('is not in the store');
    expect(noCheckpointLine).toContain('gth history prune');
    // CONTROL — the same row with a checkpoint under its thread resolves.
    await checkpoint(ckpt.saver, 'thread-never-written');
    const after = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/here' },
      id
    );
    expect(after.ok).toBe(true);
  });

  it('4d — a checkpoint that cannot be read is refused, not thrown', async () => {
    const ckpt = durable();
    const id = await seedResumable(ckpt.saver);
    const broken = {
      getTuple: async () => {
        throw new Error('disk on fire');
      },
    } as unknown as BaseCheckpointSaver;
    const result = await resolveResumeTarget(
      { config, checkpointer: { saver: broken, durable: true }, workspace: '/work/here' },
      id
    );
    expect(result).toEqual({
      ok: false,
      refusal: { kind: 'not-resumable', id, reason: 'unreadable', command: 'code' },
    });
  });

  it('5 — a conversation recorded in another directory is refused, naming both', async () => {
    const ckpt = durable();
    const id = await seedResumable(ckpt.saver, { project: '/work/here' });
    const result = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/elsewhere' },
      id
    );
    expect(result).toEqual({
      ok: false,
      refusal: {
        kind: 'workspace-mismatch',
        id,
        stored: resolve('/work/here'),
        current: resolve('/work/elsewhere'),
      },
    });
    const notice = resumeRefusalNotice(
      (result as { refusal: Parameters<typeof resumeRefusalNotice>[0] }).refusal
    );
    expect(notice.title).toBe(`Conversation #${id} belongs to another project`);
    expect(notice.lines[0]).toContain(resolve('/work/here'));
    expect(notice.lines[0]).toContain(resolve('/work/elsewhere'));
    expect(notice.lines.join(' ')).toContain('Nothing was changed.');

    // CONTROL — the same row from the directory it was recorded in resolves, with everything a
    // resume needs: the thread, the turns oldest first, and the conversation's grants.
    saveConversationGrantsSafe(config, id, { allow: [grant('git status')], deny: [] });
    const match = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/here' },
      id
    );
    expect(match.ok).toBe(true);
    const target = (match as { target: ResumeTarget }).target;
    expect(target.conversationId).toBe(id);
    expect(target.threadId).toBe('thread-ok');
    expect(target.summary.command).toBe('code');
    expect(target.summary.model).toBe('seed-model');
    expect(target.summary.turnCount).toBe(2);
    expect(target.turns.map((t) => t.prompt)).toEqual(['first', 'second']);
    expect(target.grants.allow.map((g) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'git status' },
    ]);
    expect(target.grants.deny).toEqual([]);
  });

  it('5 — a row with no project on record has nothing to mismatch, and proceeds', async () => {
    const ckpt = durable();
    const id = openConversationSafe(config, { command: 'code', threadId: 'thread-noproj' })!;
    await checkpoint(ckpt.saver, 'thread-noproj');
    const result = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/anywhere' },
      id
    );
    expect(result.ok).toBe(true);
  });

  it('1 before 2 — with history off AND a store that did not open, the history-off sentence wins', async () => {
    // Both conditions true at once is the only input that tells the two checks' order apart: the
    // switch is the person's own setting and names what to change, while "did not open" would send
    // them looking at the disk for a store the switch says not to keep.
    const off = { history: { dbPath, enabled: false } };
    const ckpt = durable();
    const id = await seedResumable(ckpt.saver);
    const result = await resolveResumeTarget(
      { config: off, checkpointer: { saver: ckpt.saver, durable: false }, workspace: '/work/here' },
      id
    );
    expect(result).toEqual({ ok: false, refusal: { kind: 'history-off' } });
  });

  it('5 — the comparison is on RESOLVED paths: a stored project that only differs in spelling matches on POSIX too', async () => {
    // Every other cell here uses canonical absolute paths, on which `resolve()` is the identity on
    // POSIX — so dropping it would survive everywhere but the Windows cell. These spellings name
    // the current directory and match only once resolved; without `resolve()` each is a mismatch.
    const ckpt = durable();
    const spellings = ['/work/here/', '/work/./here', '/work//here', '/work/there/../here'];
    for (const [i, project] of spellings.entries()) {
      const id = await seedResumable(ckpt.saver, { project, threadId: `thread-spelling-${i}` });
      const result = await resolveResumeTarget(
        { config, checkpointer: ckpt, workspace: '/work/here' },
        id
      );
      expect(result.ok, `stored as ${project}`).toBe(true);
    }
    // And the other way round: a canonical stored project against a workspace spelled loosely.
    const id = await seedResumable(ckpt.saver, { project: '/work/here', threadId: 'thread-ws' });
    const loose = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/./here/' },
      id
    );
    expect(loose.ok).toBe(true);
    // CONTROL — a genuinely different directory spelled loosely is still a mismatch.
    const other = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/./elsewhere/' },
      id
    );
    expect(other.ok).toBe(false);
  });

  it('uses the SAME workspace comparison as ACP session/new — one function, case-folded on win32 only', () => {
    expect(acpIsSameWorkspace).toBe(isSameWorkspace);
    expect(isSameWorkspace('C:\\Proj', 'c:\\proj', 'win32')).toBe(true);
    expect(isSameWorkspace('/Proj', '/proj', 'linux')).toBe(false);
    expect(isSameWorkspace('/proj', '/proj', 'linux')).toBe(true);
  });

  it('applyResumeTarget drives the runner seam with the thread and grants, and re-binds the checkpointer', async () => {
    const ckpt = durable();
    const id = await seedResumable(ckpt.saver);
    saveConversationGrantsSafe(config, id, { allow: [], deny: [grant('rm -rf build')] });
    const resolution = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/here' },
      id
    );
    const target = (resolution as { target: ResumeTarget }).target;
    const runner = { resumeConversation: vi.fn() };
    const bindConversation = vi.fn();
    await applyResumeTarget({ runner, checkpointer: { bindConversation } }, target);
    expect(runner.resumeConversation).toHaveBeenCalledTimes(1);
    expect(runner.resumeConversation).toHaveBeenCalledWith({
      threadId: 'thread-ok',
      grants: target.grants,
    });
    expect(target.grants.deny.map((g) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'rm -rf build' },
    ]);
    expect(bindConversation).toHaveBeenCalledWith(id);
    // A checkpointer stub with no bind (a spec's plain object) is fine.
    await expect(applyResumeTarget({ runner, checkpointer: {} }, target)).resolves.toBeUndefined();

    // A runner that refuses (a turn in flight, an approval pending) rejects the apply, and the
    // checkpointer is NOT re-bound: nothing has moved, so nothing is marked.
    const refusing = {
      resumeConversation: vi.fn(async () => {
        throw new Error('A turn is still running; wait for it to finish before resuming.');
      }),
    };
    const untouched = vi.fn();
    await expect(
      applyResumeTarget({ runner: refusing, checkpointer: { bindConversation: untouched } }, target)
    ).rejects.toThrow(/turn is still running/);
    expect(untouched).not.toHaveBeenCalled();
  });

  it('listResumeCandidates offers only resumable conversations and leaves out the current one', async () => {
    const ckpt = durable();
    const a = await seedResumable(ckpt.saver, { threadId: 'thread-a' });
    const b = await seedResumable(ckpt.saver, { threadId: 'thread-b' });
    recordSessionSafe(config, { command: 'ask', prompt: 'p', response: 'r' }); // single-shot
    openConversationSafe(config, { command: 'chat', threadId: 'thread-empty' }); // no turns
    expect(listResumeCandidates(config, undefined).map((c) => c.id)).toEqual([b, a]);
    expect(listResumeCandidates(config, b).map((c) => c.id)).toEqual([a]);
    expect(listResumeCandidates({ history: { dbPath, enabled: false } }, undefined)).toEqual([]);
  });
});

describe('sessionResume — parseConversationRef, the one id parser (GS2-106)', () => {
  it('accepts the integer ids history list prints', () => {
    expect(parseConversationRef('12')).toEqual({ kind: 'id', id: 12 });
    expect(parseConversationRef(' 12 ')).toEqual({ kind: 'id', id: 12 });
    expect(parseConversationRef('#12')).toEqual({ kind: 'id', id: 12 });
  });

  it('accepts a canonical run id, normalised to lower case', () => {
    expect(parseConversationRef('0f8fad5b-d9cb-469f-a165-70867728950e')).toEqual({
      kind: 'run',
      runId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    });
    expect(parseConversationRef(' 0F8FAD5B-D9CB-469F-A165-70867728950E ')).toEqual({
      kind: 'run',
      runId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    });
  });

  it('refuses everything else, including a token that is only partly an id', () => {
    for (const raw of [
      '0',
      '-3',
      '12abc',
      '1.5',
      '',
      '99999999999999999999',
      '#0f8fad5b-d9cb-469f-a165-70867728950e',
      '0f8fad5b-d9cb-469f-a165-70867728950',
      '0f8fad5bd9cb469fa16570867728950e',
      '0f8fad5b-d9cb-469f-a165-70867728950e-1',
      'g f8fad5b-d9cb-469f-a165-70867728950e',
    ]) {
      expect(parseConversationRef(raw), raw).toBeNull();
    }
    expect(parseConversationRef(undefined)).toBeNull();
  });
});

describe('sessionResume — the banner and the picker', () => {
  const target: ResumeTarget = {
    conversationId: 12,
    threadId: 't',
    summary: {
      id: 12,
      startedTs: '2026-09-01T10:00:00.000Z',
      project: '/work/here',
      command: 'code',
      model: 'gemma4:12b',
      turnCount: 2,
      threadId: 't',
    },
    turns: [
      { prompt: 'first', response: 'one' },
      { prompt: 'second', response: 'two' },
    ],
    grants: { allow: [], deny: [] },
  };

  it('the banner names the id, when it started, the turns, the command and the model, and the grants', () => {
    const notice = resumedConversationNotice(target);
    expect(notice.title).toBe('Resumed conversation #12');
    // The stored path is named as the PROJECT ROOT it is, not placed under a preposition — see the
    // GS2-113 cells at the bottom of this file for why the phrasing is load-bearing.
    expect(notice.lines[0]).toBe('Started 2026-09-01T10:00:00.000Z, with project root /work/here.');
    expect(notice.lines[1]).toBe('2 turns recorded under gth code, with gemma4:12b.');
    expect(notice.lines[2]).toContain('recorded turns are shown below');
    expect(notice.lines[3]).toContain('Approvals you granted in it are in force again');
    // A conversation with no turns says so rather than promising a replay.
    const empty = resumedConversationNotice({
      ...target,
      turns: [],
      summary: { ...target.summary, turnCount: 0, model: undefined, project: undefined },
    });
    expect(empty.lines[0]).toBe('Started 2026-09-01T10:00:00.000Z.');
    expect(empty.lines[1]).toBe('0 turns recorded under gth code.');
    expect(empty.lines[2]).toContain('No turns were recorded yet');
  });

  it('the text list names the candidates by id, or says there are none', () => {
    const notice = resumableConversationsNotice([target.summary]);
    expect(notice.title).toBe('Conversations you can resume');
    expect(notice.lines[0]).toContain('#12');
    expect(notice.lines[0]).toContain('[code]');
    expect(notice.lines.at(-1)).toContain('/resume <id>');
    const none = resumableConversationsNotice([]);
    expect(none.title).toBe('No other conversation can be resumed');
    expect(none.lines.join(' ')).toContain('Nothing was changed.');
    expect(resumeSameConversationNotice(12).title).toBe('Already in conversation #12');
  });
});

/**
 * What the banner's first line CLAIMS, read back off the sentence.
 *
 * Parsed rather than compared to a literal, because a literal comparison cannot tell a true
 * sentence from a false one: with the session's working directory EQUAL to its project root — the
 * common case — every phrasing of that line is true, so a cell arranged that way passes whatever
 * the code says. These cells evaluate the claim against the world the line was rendered for
 * instead, and arrange the world so the two directories differ.
 *
 * An unrecognised sentence THROWS rather than falling through to a default, so a later rewording
 * cannot quietly turn these cells into assertions that cannot fail.
 */
type LocationClaim =
  { kind: 'session-was-in'; dir: string } | { kind: 'project-root-is'; dir: string };

const readLocationClaim = (line: string): LocationClaim => {
  const asRoot = /^Started \S+, with project root (.+)\.$/.exec(line);
  if (asRoot) return { kind: 'project-root-is', dir: asRoot[1] };
  const asPlace = /^Started \S+ in (.+)\.$/.exec(line);
  if (asPlace) return { kind: 'session-was-in', dir: asPlace[1] };
  throw new Error(`the banner's first line makes no claim this cell can evaluate: ${line}`);
};

/** Is that claim TRUE of the directories the line was rendered for? */
const claimHolds = (
  claim: LocationClaim,
  world: { workDir: string; projectRoot: string }
): boolean =>
  isSameWorkspace(
    resolve(claim.dir),
    resolve(claim.kind === 'session-was-in' ? world.workDir : world.projectRoot)
  );

describe('sessionResume — GS2-113, what the resumed banner says about the stored path', () => {
  let dir: string;
  let config: { history: { dbPath: string; enabled?: boolean } };
  const closers: Array<() => void> = [];

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-resume-location-'));
    config = { history: { dbPath: resolve(dir, 'history.db') } };
  });
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    rmSync(dir, { recursive: true, force: true });
  });

  const durable = () => {
    const ckpt = openSessionCheckpointerSafe(config, { notify: () => {} });
    closers.push(() => ckpt.close());
    expect(ckpt.durable).toBe(true);
    return ckpt;
  };

  /**
   * Put the process in the state a session opened at `workDir`, under a project config discovered
   * at `projectRoot`, is actually in — and put it back afterwards. These are the two accessors
   * every `project` write site and the resume check read: `setProjectDir` is what config discovery
   * calls with the root it matched, and `INIT_CWD` is what `getCurrentWorkDir()` prefers.
   */
  const inWorld = async <T>(
    world: { projectRoot: string; workDir: string },
    body: () => Promise<T>
  ): Promise<T> => {
    const priorProjectDir = peekProjectDir();
    const priorInitCwd = process.env.INIT_CWD;
    mkdirSync(world.workDir, { recursive: true });
    mkdirSync(world.projectRoot, { recursive: true });
    setProjectDir(world.projectRoot);
    process.env.INIT_CWD = world.workDir;
    try {
      return await body();
    } finally {
      setProjectDir(priorProjectDir);
      if (priorInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = priorInitCwd;
    }
  };

  /** A resumable conversation opened the way production opens one: `project: getProjectDir()`. */
  const openAsProductionDoes = async (
    saver: BaseCheckpointSaver,
    threadId: string,
    project = getProjectDir()
  ): Promise<number> => {
    const id = openConversationSafe(config, {
      command: 'code',
      project,
      model: 'seed-model',
      threadId,
    })!;
    recordSessionSafe(config, { conversationId: id, prompt: 'first', response: 'one' });
    await checkpoint(saver, threadId);
    return id;
  };

  const bannerLine = async (
    ckpt: { saver: BaseCheckpointSaver; durable: boolean },
    id: number
  ): Promise<string> => {
    const resolved = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: getProjectDir() },
      id
    );
    expect(resolved.ok).toBe(true);
    return resumedConversationNotice((resolved as { target: ResumeTarget }).target).lines[0];
  };

  it('the banner is TRUE for a session opened in a SUBDIRECTORY of a configured project', async () => {
    const projectRoot = resolve(dir, 'project');
    const workDir = resolve(projectRoot, 'nested', 'sub');

    await inWorld({ projectRoot, workDir }, async () => {
      // The premise, asserted rather than assumed: the two directories genuinely DIFFER here, and
      // what the write sites record is the project root — not where the session is.
      expect(getProjectDir()).toBe(projectRoot);
      expect(getCurrentWorkDir()).toBe(workDir);
      expect(isSameWorkspace(resolve(getProjectDir()), resolve(getCurrentWorkDir()))).toBe(false);

      const ckpt = durable();
      const id = await openAsProductionDoes(ckpt.saver, 'thread-sub');
      const line = await bannerLine(ckpt, id);

      // The stored path is the project root, and that is what the sentence may claim it is. A
      // sentence placing the session IN it is false here, which is what this arrangement is for.
      expect(claimHolds(readLocationClaim(line), { workDir, projectRoot })).toBe(true);
      expect(readLocationClaim(line)).toEqual({ kind: 'project-root-is', dir: projectRoot });
    });
  });

  it('CONTROL — with the working directory EQUAL to the project root, no phrasing can fail', async () => {
    const projectRoot = resolve(dir, 'project');

    await inWorld({ projectRoot, workDir: projectRoot }, async () => {
      expect(isSameWorkspace(resolve(getProjectDir()), resolve(getCurrentWorkDir()))).toBe(true);

      const ckpt = durable();
      const id = await openAsProductionDoes(ckpt.saver, 'thread-at-root');
      const line = await bannerLine(ckpt, id);
      expect(claimHolds(readLocationClaim(line), { workDir: projectRoot, projectRoot })).toBe(true);

      // The trap itself, as an assertion rather than a comment. The sentence this banner used to
      // render places the session IN the stored path; off the same stored row that sentence is
      // TRUE in this arrangement and FALSE in the one above. So only the unequal arrangement can
      // tell the two phrasings apart, and a cell written here would pass whatever the code said.
      const placed = `Started 2026-09-01T10:00:00.000Z in ${projectRoot}.`;
      expect(claimHolds(readLocationClaim(placed), { workDir: projectRoot, projectRoot })).toBe(
        true
      );
      expect(
        claimHolds(readLocationClaim(placed), {
          workDir: resolve(projectRoot, 'nested', 'sub'),
          projectRoot,
        })
      ).toBe(false);
    });
  });

  it('CONTROL — the workspace refusal is unchanged: it still gates on the PROJECT ROOT, from a subdirectory too', async () => {
    const projectRoot = resolve(dir, 'project');
    const workDir = resolve(projectRoot, 'nested', 'sub');
    const otherRoot = resolve(dir, 'other');

    await inWorld({ projectRoot, workDir }, async () => {
      mkdirSync(otherRoot, { recursive: true });
      const ckpt = durable();
      const mine = await openAsProductionDoes(ckpt.saver, 'thread-mine');
      const theirs = await openAsProductionDoes(ckpt.saver, 'thread-theirs', otherRoot);

      // Recorded under THIS session's project root: it resumes, even though the session is two
      // levels below that root. Being below the root is not a mismatch, and this ticket does not
      // make it one.
      const allowed = await resolveResumeTarget(
        { config, checkpointer: ckpt, workspace: getProjectDir() },
        mine
      );
      expect(allowed.ok).toBe(true);

      // Recorded under another project root: still refused, still naming both paths.
      const refused = await resolveResumeTarget(
        { config, checkpointer: ckpt, workspace: getProjectDir() },
        theirs
      );
      expect(refused).toEqual({
        ok: false,
        refusal: {
          kind: 'workspace-mismatch',
          id: theirs,
          stored: otherRoot,
          current: projectRoot,
        },
      });

      // …and neither answer was decided by the working directory: it is neither of the two roots,
      // so moving either side of the comparison onto it would flip both of the cells above.
      expect(isSameWorkspace(resolve(getCurrentWorkDir()), projectRoot)).toBe(false);
      expect(isSameWorkspace(resolve(getCurrentWorkDir()), otherRoot)).toBe(false);
    });
  });

  it('GS2-114 — the workspace refusal states the rule and claims no mechanism the code lacks', async () => {
    const projectRoot = resolve(dir, 'project');
    const workDir = resolve(projectRoot, 'nested', 'sub');
    const otherRoot = resolve(dir, 'other');

    // Arranged with the working directory BELOW the project root, for the reason the cells above
    // are: with the two equal, a sentence about where the conversation's tools and file paths
    // point is accidentally true, and a cell written that way passes whatever the code says.
    await inWorld({ projectRoot, workDir }, async () => {
      mkdirSync(otherRoot, { recursive: true });
      const ckpt = durable();
      const theirs = await openAsProductionDoes(ckpt.saver, 'thread-other-114', otherRoot);
      const refused = await resolveResumeTarget(
        { config, checkpointer: ckpt, workspace: getProjectDir() },
        theirs
      );
      expect(refused).toEqual({
        ok: false,
        refusal: {
          kind: 'workspace-mismatch',
          id: theirs,
          stored: otherRoot,
          current: projectRoot,
        },
      });
      const notice = resumeRefusalNotice(
        (refused as { refusal: Parameters<typeof resumeRefusalNotice>[0] }).refusal
      );

      // The sentence, pinned whole: this is what reds if the removed clause comes back.
      expect(notice.lines[1]).toBe(
        'A conversation is resumed from the directory it was recorded in. Change to that ' +
          'directory and run it again.'
      );
      // …and the claim named as well as pinned, so a reworded return of it anywhere in the notice
      // reds too. The two rendered paths come out first: they are a temp directory this cell does
      // not choose the spelling of, and matching words against them would be matching noise.
      const body = notice.lines
        .join(' ')
        .replaceAll(otherRoot, '<stored>')
        .replaceAll(projectRoot, '<current>');
      expect(body).not.toContain('tools');
      expect(body).not.toContain('file paths');

      // Why that claim had to go, as an assertion rather than a comment: tools and file paths
      // resolve against the session's WORKING directory, and here that is neither the stored
      // directory the removed clause pointed them at nor the project root the refusal compared.
      // So the claim was false in this world — and only an arrangement like this one can see it.
      expect(getCurrentWorkDir()).toBe(workDir);
      expect(isSameWorkspace(resolve(getCurrentWorkDir()), otherRoot)).toBe(false);
      expect(isSameWorkspace(resolve(getCurrentWorkDir()), projectRoot)).toBe(false);
    });
  });
});
