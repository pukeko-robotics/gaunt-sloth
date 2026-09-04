/**
 * GS2-20 — the resume seam: the five checks in order (each refused with its own reason), what a
 * passing resolution carries, the apply step, the picker's exclusion, the id parser, and the
 * sentences. Real history store and real checkpointer over a temp file; the runner is the one
 * thing faked, because this module's contract with it is one call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import type { ApprovalGrant } from '@gaunt-sloth/core/core/approvals/grants.js';
import {
  applyResumeTarget,
  listResumeCandidates,
  parseResumeId,
  resolveResumeTarget,
  resumedConversationNotice,
  resumePickerNotice,
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
    expect(result).toEqual({ ok: false, refusal: { kind: 'unknown', id: 4242 } });
    const notice = resumeRefusalNotice({ kind: 'unknown', id: 4242 });
    expect(notice.title).toBe('No conversation #4242');
    expect(notice.lines.join(' ')).toContain('`gth history list`');
    // Inside a session the pointer is the slash command, not the shell command.
    expect(
      resumeRefusalNotice({ kind: 'unknown', id: 4242 }, { inSession: true }).lines.join(' ')
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
    expect(
      resumeRefusalNotice({ kind: 'not-resumable', id, reason: 'no-checkpoint' }).lines[0]
    ).toContain('never written');
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

describe('sessionResume — parseResumeId', () => {
  it('accepts the ids history list prints and nothing else', () => {
    expect(parseResumeId('12')).toBe(12);
    expect(parseResumeId(' 12 ')).toBe(12);
    expect(parseResumeId('#12')).toBe(12);
    expect(parseResumeId('0')).toBeNull();
    expect(parseResumeId('-3')).toBeNull();
    expect(parseResumeId('12abc')).toBeNull();
    expect(parseResumeId('1.5')).toBeNull();
    expect(parseResumeId('')).toBeNull();
    expect(parseResumeId(undefined)).toBeNull();
    expect(parseResumeId('99999999999999999999')).toBeNull();
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
    expect(notice.lines[0]).toBe('Started 2026-09-01T10:00:00.000Z in /work/here.');
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

  it('the picker lists the candidates with their ids, or says there are none', () => {
    const notice = resumePickerNotice([target.summary]);
    expect(notice.title).toBe('Conversations you can resume');
    expect(notice.lines[0]).toContain('#12');
    expect(notice.lines[0]).toContain('[code]');
    expect(notice.lines.at(-1)).toContain('/resume <id>');
    const none = resumePickerNotice([]);
    expect(none.title).toBe('No other conversation can be resumed');
    expect(none.lines.join(' ')).toContain('Nothing was changed.');
    expect(resumeSameConversationNotice(12).title).toBe('Already in conversation #12');
  });
});
