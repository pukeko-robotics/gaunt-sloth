/**
 * GS2-107 — **the deletion is justified by behaviour, not by a comment.**
 *
 * Automatic reclamation removes threads no conversation row names, on the argument that no id a
 * person could type reaches them. This asserts that argument the only way it can be asserted:
 * by *attempting a resume* of each class through the real seam, over a real store and a real
 * checkpointer, and getting a refusal — and then showing the same seam resolving a conversation the
 * policy leaves alone, so the refusals are not the harness refusing everything.
 *
 * A temp `history.dbPath` throughout; nothing here resolves a path from `HOME`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  markConversationUnresumableSafe,
  openConversationSafe,
  recordSessionSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import { openSessionCheckpointerSafe } from '@gaunt-sloth/core/history/sessionCheckpointer.js';
import { findUnaddressableThreads } from '@gaunt-sloth/core/history/checkpointRetention.js';
import { resolveResumeTarget } from '#src/modules/sessionResume.js';

/** One checkpoint under `threadId`, carrying the `ts` the age gate reads. */
const checkpoint = async (
  saver: BaseCheckpointSaver,
  threadId: string,
  ts = new Date().toISOString()
): Promise<void> => {
  await saver.put(
    { configurable: { thread_id: threadId, checkpoint_ns: '' } },
    {
      v: 4,
      id: `cp-${threadId}`,
      ts,
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    },
    { source: 'loop', step: 0, parents: {} },
    {}
  );
};

describe('GS2-107 — what automatic reclamation deletes was already unresumable', () => {
  let dir: string;
  let dbPath: string;
  let config: { history: { dbPath: string } };
  const closers: Array<() => void> = [];

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-retention-refusal-'));
    dbPath = resolve(dir, 'history.db');
    config = { history: { dbPath } };
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

  const threadsInStore = (): string[] => {
    const db = new DatabaseSync(dbPath);
    const rows = db
      .prepare(`SELECT DISTINCT thread_id FROM checkpoints ORDER BY thread_id`)
      .all() as Record<string, unknown>[];
    db.close();
    return rows.map((r) => String(r.thread_id));
  };

  const unaddressable = (): string[] => {
    const db = new DatabaseSync(dbPath);
    const found = findUnaddressableThreads(db, { includeWithinGrace: true });
    db.close();
    return found.sort();
  };

  it('CLASS 1 — a thread no conversation row names cannot be reached by any id, and the store agrees', async () => {
    const ckpt = durable();
    // The shape `/clear` leaves behind, and the shape an abandoned boot leaves behind: checkpoints
    // under a thread that no row anywhere points at.
    await checkpoint(ckpt.saver, 'thread-nothing-names');
    // A control conversation, so the store is not simply empty.
    const liveId = openConversationSafe(config, {
      command: 'code',
      project: '/work/here',
      threadId: 'thread-live',
    })!;
    recordSessionSafe(config, { conversationId: liveId, command: 'code', prompt: 'p', response: 'r' });
    await checkpoint(ckpt.saver, 'thread-live');

    // There is no id whose resume reaches the orphan: a resume travels conversation → thread, and
    // every id in the store resolves to a thread that is NOT it.
    const reachable: string[] = [];
    for (let id = 1; id <= liveId + 3; id++) {
      const resolution = await resolveResumeTarget(
        { config, checkpointer: ckpt, workspace: '/work/here' },
        id
      );
      if (resolution.ok) reachable.push(resolution.target.threadId);
    }
    expect(reachable).toEqual(['thread-live']);
    expect(reachable).not.toContain('thread-nothing-names');

    // And that is exactly the set retention names.
    expect(unaddressable()).toEqual(['thread-nothing-names']);
    expect(threadsInStore()).toEqual(['thread-live', 'thread-nothing-names']);
  });

  it('CLASS 2 — a conversation whose thread link was cut refuses its own id, and its thread becomes unaddressable', async () => {
    const ckpt = durable();
    const id = openConversationSafe(config, {
      command: 'code',
      project: '/work/here',
      threadId: 'thread-write-failed',
    })!;
    recordSessionSafe(config, { conversationId: id, command: 'code', prompt: 'p', response: 'r' });
    await checkpoint(ckpt.saver, 'thread-write-failed');

    // CONTROL — before the link is cut, this exact id resolves. So the refusal below is the cut's
    // doing, not the seam refusing whatever it is handed.
    const before = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/here' },
      id
    );
    expect(before.ok).toBe(true);
    expect(unaddressable()).toEqual([]);

    // What GS2-20 writes when a checkpoint write fails mid-session.
    markConversationUnresumableSafe(config, id);

    const after = await resolveResumeTarget(
      { config, checkpointer: ckpt, workspace: '/work/here' },
      id
    );
    expect(after).toEqual({
      ok: false,
      refusal: { kind: 'not-resumable', id, reason: 'no-thread', command: 'code' },
    });
    // The rows are still there — and nothing can address them, which is what makes deleting them
    // free rather than a loss.
    expect(threadsInStore()).toEqual(['thread-write-failed']);
    expect(unaddressable()).toEqual(['thread-write-failed']);
  });

  it('the conversation the policy LEAVES ALONE still resolves after a reclamation pass', async () => {
    const ckpt = durable();
    const id = openConversationSafe(config, {
      command: 'code',
      project: '/work/here',
      threadId: 'thread-live',
    })!;
    recordSessionSafe(config, { conversationId: id, command: 'code', prompt: 'p', response: 'r' });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await checkpoint(ckpt.saver, 'thread-live', old);
    await checkpoint(ckpt.saver, 'thread-orphan', old);

    const db = new DatabaseSync(dbPath);
    // Both threads are equally old, so only the predicate separates them.
    expect(findUnaddressableThreads(db, {})).toEqual(['thread-orphan']);
    db.close();

    expect(
      (await resolveResumeTarget({ config, checkpointer: ckpt, workspace: '/work/here' }, id)).ok
    ).toBe(true);
  });
});
