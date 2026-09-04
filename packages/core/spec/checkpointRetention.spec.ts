/**
 * GS2-107 — the retention policy over a REAL `node:sqlite` file: the predicate that decides what
 * automatic reclamation may delete, the grace window that keeps it off a live session, the prune
 * selection and its bounds, the VACUUM that actually gives the disk space back, and the readout.
 *
 * Every test builds its own database under a temp dir; nothing here can reach `~/.gsloth/history.db`
 * — the paths are constructed, never resolved from `HOME`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  collectCheckpointStoreStats,
  deleteThreads,
  findUnaddressableThreads,
  openCheckpointMaintenance,
  reclaimUnresumableThreads,
  retentionTablesReady,
  selectPrunableConversations,
  vacuumStore,
  RECLAIM_GRACE_MS,
} from '#src/history/checkpointRetention.js';
import { openHistoryStore } from '#src/history/historyStore.js';
import { openCheckpointSaver } from '#src/history/checkpointSaver.js';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('GS2-107 checkpoint retention', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gsloth-retention-'));
    dbPath = join(dir, 'history.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Create both halves of the schema the way the product does — the store owns `conversations`, the
   * saver owns `checkpoints` — then hand back a plain connection to write fixtures through.
   */
  const openStoreAndSaver = (): DatabaseSync => {
    const store = openHistoryStore(dbPath, { create: true });
    store!.close();
    const saver = openCheckpointSaver(dbPath);
    saver!.close();
    return new DatabaseSync(dbPath);
  };

  /**
   * Write `count` checkpoints for a thread, each carrying the serializer's real shape: plain JSON
   * with a top-level ISO `ts`, which is where the age gate reads a thread's age from. `payload` pads
   * the blob so byte accounting has something to count.
   */
  const seedThread = (
    db: DatabaseSync,
    threadId: string,
    options: { count?: number; ts?: string; payload?: number } = {}
  ): void => {
    const count = options.count ?? 3;
    const ts = options.ts ?? ago(10 * DAY);
    const payload = 'x'.repeat(options.payload ?? 64);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO checkpoints
       (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES (?, '', ?, ?, 'json', ?, ?)`
    );
    const insertWrite = db.prepare(
      `INSERT OR REPLACE INTO checkpoint_writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, '', ?, 'task', ?, 'messages', 'json', ?)`
    );
    for (let i = 0; i < count; i++) {
      const id = `ckpt-${String(i).padStart(4, '0')}`;
      const body = new TextEncoder().encode(
        JSON.stringify({ v: 4, id, ts, channel_values: { messages: payload } })
      );
      insert.run(threadId, id, i === 0 ? null : `ckpt-${String(i - 1).padStart(4, '0')}`, body,
        new TextEncoder().encode(JSON.stringify({ step: i })));
      insertWrite.run(threadId, id, i, new TextEncoder().encode(JSON.stringify(payload)));
    }
  };

  /** A conversation row naming `threadId`, with `turns` recorded turns at `lastTs`. */
  const seedConversation = (
    db: DatabaseSync,
    options: { threadId: string | null; command?: string; lastTs?: string; turns?: number }
  ): number => {
    const lastTs = options.lastTs ?? ago(10 * DAY);
    const info = db
      .prepare(
        `INSERT INTO conversations (started_ts, project, command, model, thread_id)
         VALUES (?, '/work', ?, 'm', ?)`
      )
      .run(lastTs, options.command ?? 'chat', options.threadId);
    const id = Number(info.lastInsertRowid);
    for (let i = 0; i < (options.turns ?? 1); i++) {
      db.prepare(
        `INSERT INTO sessions (ts, project, command, model, prompt, response, conversation_id)
         VALUES (?, '/work', ?, 'm', 'p', 'r', ?)`
      ).run(lastTs, options.command ?? 'chat', id);
    }
    return id;
  };

  describe('the predicate — a thread no conversation row names', () => {
    it('finds an orphan thread and leaves a named one alone', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'named');
      seedThread(db, 'orphan');
      seedConversation(db, { threadId: 'named' });

      expect(findUnaddressableThreads(db, { now: NOW })).toEqual(['orphan']);
      db.close();
    });

    it('a conversation whose thread_id was NULLed leaves its thread unaddressable — the two classes are one', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'was-linked');
      const id = seedConversation(db, { threadId: 'was-linked' });
      expect(findUnaddressableThreads(db, { now: NOW })).toEqual([]);

      // What `clearConversationThread` does after a failed checkpoint write. The link is destroyed,
      // so the thread it named becomes an orphan by the same predicate — there is no second query.
      db.prepare(`UPDATE conversations SET thread_id = NULL WHERE id = ?`).run(id);
      expect(findUnaddressableThreads(db, { now: NOW })).toEqual(['was-linked']);
      db.close();
    });

    it('holds a thread inside the grace window, and releases it once past — the /clear case', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'live-after-clear', { ts: ago(RECLAIM_GRACE_MS - 60_000) });
      seedThread(db, 'finished', { ts: ago(RECLAIM_GRACE_MS + 60_000) });

      expect(findUnaddressableThreads(db, { now: NOW })).toEqual(['finished']);
      // The readout asks a different question — what is unaddressable at all — and sees both.
      expect(
        findUnaddressableThreads(db, { now: NOW, includeWithinGrace: true }).sort()
      ).toEqual(['finished', 'live-after-clear']);
      db.close();
    });

    it('never offers the caller its own thread', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'mine', { ts: ago(30 * DAY) });
      expect(findUnaddressableThreads(db, { now: NOW })).toEqual(['mine']);
      expect(findUnaddressableThreads(db, { now: NOW, excludeThreadIds: ['mine'] })).toEqual([]);
      db.close();
    });

    it('leaves a thread whose age cannot be read alone — an unknown age is never old enough', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'unreadable', { ts: ago(30 * DAY) });
      db.prepare(`UPDATE checkpoints SET checkpoint = ? WHERE thread_id = 'unreadable'`).run(
        new TextEncoder().encode('not json at all')
      );
      expect(findUnaddressableThreads(db, { now: NOW })).toEqual([]);
      db.close();
    });

    it('does nothing at all when the conversations table is absent, rather than calling everything an orphan', () => {
      // The saver creates its tables without the store's; in that state every thread would satisfy
      // "no conversation row names it", and a sweep would delete the whole store.
      const saver = openCheckpointSaver(dbPath);
      saver!.close();
      const db = new DatabaseSync(dbPath);
      seedThread(db, 'a', { ts: ago(30 * DAY) });
      expect(retentionTablesReady(db)).toBe(false);
      expect(findUnaddressableThreads(db, { now: NOW })).toEqual([]);
      expect(reclaimUnresumableThreads(db, { now: NOW })).toMatchObject({ threadCount: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM checkpoints`).get()).toMatchObject({ n: 3 });
      db.close();
    });
  });

  describe('deletion', () => {
    it('removes exactly the named threads, their pending writes included, and reports the bytes', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'gone', { count: 4, payload: 500 });
      seedThread(db, 'kept', { count: 2, payload: 500 });

      const summary = deleteThreads(db, ['gone']);
      expect(summary.threadCount).toBe(1);
      expect(summary.checkpointCount).toBe(4);
      expect(summary.writeCount).toBe(4);
      expect(summary.bytes).toBeGreaterThan(4 * 500);

      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = 'gone'`).get()
      ).toMatchObject({ n: 0 });
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM checkpoint_writes WHERE thread_id = 'gone'`).get()
      ).toMatchObject({ n: 0 });
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = 'kept'`).get()
      ).toMatchObject({ n: 2 });
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM checkpoint_writes WHERE thread_id = 'kept'`).get()
      ).toMatchObject({ n: 2 });
      db.close();
    });

    it('the saver-level single-thread spelling and the batch are the same delete', async () => {
      const saverPath = join(dir, 'saver.db');
      const store = openHistoryStore(saverPath, { create: true });
      store!.close();
      const saver = openCheckpointSaver(saverPath)!;
      const db = new DatabaseSync(saverPath);
      seedThread(db, 'one');
      db.close();
      await saver.deleteThread('one');
      saver.close();
      const check = new DatabaseSync(saverPath);
      expect(check.prepare(`SELECT COUNT(*) AS n FROM checkpoints`).get()).toMatchObject({ n: 0 });
      expect(check.prepare(`SELECT COUNT(*) AS n FROM checkpoint_writes`).get()).toMatchObject({
        n: 0,
      });
      check.close();
    });
  });

  describe('prune selection', () => {
    it('selects nothing at all when neither bound is given — there is no silent default', () => {
      const db = openStoreAndSaver();
      seedThread(db, 't-old');
      seedConversation(db, { threadId: 't-old', lastTs: ago(400 * DAY) });
      expect(selectPrunableConversations(db, { now: NOW })).toEqual([]);
      db.close();
    });

    it('an age bound selects the conversations past it and no others', () => {
      const db = openStoreAndSaver();
      seedThread(db, 't-old');
      seedThread(db, 't-recent');
      const oldId = seedConversation(db, { threadId: 't-old', lastTs: ago(40 * DAY) });
      seedConversation(db, { threadId: 't-recent', lastTs: ago(2 * DAY) });

      const picked = selectPrunableConversations(db, { olderThanDays: 30, now: NOW });
      expect(picked.map((c) => c.conversationId)).toEqual([oldId]);
      expect(picked[0].checkpointCount).toBe(3);
      expect(picked[0].bytes).toBeGreaterThan(0);
      db.close();
    });

    it('a count bound keeps the N most recently active conversations WHOLE and prunes the rest', () => {
      const db = openStoreAndSaver();
      const ids: number[] = [];
      for (let i = 0; i < 4; i++) {
        seedThread(db, `t${i}`);
        ids.push(seedConversation(db, { threadId: `t${i}`, lastTs: ago((i + 1) * DAY) }));
      }
      // ids[0] is the most recent. Keeping 2 prunes the two oldest, entire.
      const picked = selectPrunableConversations(db, { keepLast: 2, now: NOW });
      expect(picked.map((c) => c.conversationId).sort()).toEqual([ids[2], ids[3]].sort());
      // Whole threads: every checkpoint of a selected conversation goes, none of a kept one.
      expect(picked.every((c) => c.checkpointCount === 3)).toBe(true);
      db.close();
    });

    it('both bounds compose as a conjunction', () => {
      const db = openStoreAndSaver();
      seedThread(db, 't-old');
      seedThread(db, 't-older');
      const older = seedConversation(db, { threadId: 't-older', lastTs: ago(90 * DAY) });
      seedConversation(db, { threadId: 't-old', lastTs: ago(40 * DAY) });
      // Old enough for the age bound, but `keepLast: 1` protects the newest of the two.
      const picked = selectPrunableConversations(db, {
        olderThanDays: 30,
        keepLast: 1,
        now: NOW,
      });
      expect(picked.map((c) => c.conversationId)).toEqual([older]);
      db.close();
    });

    it('never offers a conversation whose thread holds nothing to remove', () => {
      const db = openStoreAndSaver();
      seedConversation(db, { threadId: 'empty-thread', lastTs: ago(400 * DAY) });
      expect(selectPrunableConversations(db, { olderThanDays: 1, now: NOW })).toEqual([]);
      db.close();
    });
  });

  describe('VACUUM — the part that gives the disk space back', () => {
    it('shrinks the file, and the CONTROL shows a delete alone does not', () => {
      const db = openStoreAndSaver();
      // Enough payload that a page-level shrink is visible rather than lost in rounding.
      seedThread(db, 'bulk', { count: 40, payload: 20_000 });
      seedConversation(db, { threadId: 'keeper' });
      seedThread(db, 'keeper', { count: 1, payload: 100 });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const grown = statSync(dbPath).size;
      expect(grown).toBeGreaterThan(500_000);

      deleteThreads(db, ['bulk']);
      // CONTROL — the rows are gone and the file has not moved. This is why the VACUUM is not
      // optional: without it a prune reports bytes removed that a user cannot see come back.
      const afterDelete = statSync(dbPath).size;
      expect(afterDelete).toBe(grown);

      expect(vacuumStore(db)).toBe(true);
      const afterVacuum = statSync(dbPath).size;
      expect(afterVacuum).toBeLessThan(grown / 2);
      // And the conversation that was not named survived the compaction.
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = 'keeper'`).get()
      ).toMatchObject({ n: 1 });
      db.close();
    });
  });

  describe('the readout', () => {
    it('reports the shape the store was built to', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'big', { count: 5, payload: 4000 });
      seedThread(db, 'small', { count: 2, payload: 10 });
      seedThread(db, 'orphaned', { count: 1, payload: 100 });
      seedConversation(db, { threadId: 'big', command: 'code' });
      seedConversation(db, { threadId: 'small', command: 'chat' });
      db.close();

      const maintenance = openCheckpointMaintenance(dbPath)!;
      const stats = maintenance.stats(dbPath);
      expect(stats.checkpointCount).toBe(8);
      expect(stats.writeCount).toBe(8);
      expect(stats.threadCount).toBe(3);
      expect(stats.unresumableThreadCount).toBe(1);
      expect(stats.unresumableBytes).toBeGreaterThan(0);
      // The file holds the transcripts and the FTS index too, so the two numbers are distinct and
      // the checkpoint share is the smaller one.
      expect(stats.fileBytes).toBeGreaterThan(stats.checkpointBytes);
      expect(stats.largestThreads[0].threadId).toBe('big');
      expect(stats.largestThreads[0].command).toBe('code');
      expect(stats.largestThreads.find((t) => t.threadId === 'orphaned')?.conversationId)
        .toBeUndefined();
      maintenance.close();
    });

    it('MUTATION CONTROL: the counts come from the rows, not from a constant', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'a', { count: 2 });
      seedConversation(db, { threadId: 'a' });
      const before = collectCheckpointStoreStats(db, dbPath);
      seedThread(db, 'b', { count: 7 });
      const after = collectCheckpointStoreStats(db, dbPath);
      expect(before.checkpointCount).toBe(2);
      expect(after.checkpointCount).toBe(9);
      expect(after.threadCount).toBe(2);
      expect(after.unresumableThreadCount).toBe(1);
      db.close();
    });

    it('opens nothing when there is no store, rather than creating one', () => {
      expect(openCheckpointMaintenance(join(dir, 'absent.db'))).toBeNull();
      expect(() => statSync(join(dir, 'absent.db'))).toThrow();
    });
  });
});
