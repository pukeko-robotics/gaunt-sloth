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
  UNADDRESSABLE_THREADS_SQL,
} from '#src/history/checkpointRetention.js';
import { openHistoryStore } from '#src/history/historyStore.js';
import { openCheckpointSaver } from '#src/history/checkpointSaver.js';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/**
 * An age measured from the REAL clock, for the cells that run the pass with no injected `now`. The
 * fixed `NOW` above cannot be used there: it is a written-down instant, so as real time moves past
 * it every fixture placed against it silently gets older, and a cell meant to sit just inside the
 * window would drift out of it.
 */
const realAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

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
      insert.run(
        threadId,
        id,
        i === 0 ? null : `ckpt-${String(i - 1).padStart(4, '0')}`,
        body,
        new TextEncoder().encode(JSON.stringify({ step: i }))
      );
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

  /** How many rows one table holds for a thread — `checkpoints` and `checkpoint_writes` alike. */
  const rowsFor = (db: DatabaseSync, table: string, threadId: string): number =>
    Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = ?`)
          .get(threadId) as Record<string, unknown>
      ).n
    );

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
      expect(findUnaddressableThreads(db, { now: NOW, includeWithinGrace: true }).sort()).toEqual([
        'finished',
        'live-after-clear',
      ]);
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

    /**
     * GS2-107 fix round, finding D — the two deletes are one transaction, pinned by making the
     * SECOND one fail.
     *
     * The failure is produced by the engine rather than by a proxy or a mocked statement: a
     * `BEFORE DELETE` trigger that raises makes `DELETE FROM checkpoint_writes` abort exactly where
     * a disk error, a lock or a corrupt page would, with the first delete already issued. Without
     * the transaction the checkpoints are gone and the pending writes remain — and they remain
     * FOREVER, because every candidate query in this module reads `FROM checkpoints`, so nothing
     * can ever name that thread again while the readout goes on counting its bytes.
     */
    it('rolls the whole delete back when the second table refuses — no orphaned pending writes', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'both-tables', { count: 3 });
      db.exec(
        `CREATE TRIGGER refuse_write_deletes BEFORE DELETE ON checkpoint_writes
         BEGIN SELECT RAISE(ABORT, 'blocked'); END`
      );

      expect(deleteThreads(db, ['both-tables'])).toMatchObject({
        threadCount: 0,
        checkpointCount: 0,
        writeCount: 0,
      });
      expect(rowsFor(db, 'checkpoints', 'both-tables')).toBe(3);
      expect(rowsFor(db, 'checkpoint_writes', 'both-tables')).toBe(3);

      // CONTROL: with the refusal lifted the same call removes both halves, so the assertion above
      // is about the rollback and not about a delete that never worked.
      db.exec(`DROP TRIGGER refuse_write_deletes`);
      expect(deleteThreads(db, ['both-tables'])).toMatchObject({
        threadCount: 1,
        checkpointCount: 3,
        writeCount: 3,
      });
      expect(rowsFor(db, 'checkpoints', 'both-tables')).toBe(0);
      expect(rowsFor(db, 'checkpoint_writes', 'both-tables')).toBe(0);
      db.close();
    });

    it('a refusal on one thread leaves the threads deleted before it in the same call intact — nothing half-applied', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'first', { count: 2 });
      seedThread(db, 'second', { count: 2 });
      db.exec(
        `CREATE TRIGGER refuse_second BEFORE DELETE ON checkpoint_writes
         WHEN OLD.thread_id = 'second'
         BEGIN SELECT RAISE(ABORT, 'blocked'); END`
      );
      expect(deleteThreads(db, ['first', 'second'])).toMatchObject({ threadCount: 0 });
      // The batch is atomic across threads too, which is what makes the reported summary true: a
      // caller told "0 threads removed" can read the store and find every one of them still there.
      expect(rowsFor(db, 'checkpoints', 'first')).toBe(2);
      expect(rowsFor(db, 'checkpoints', 'second')).toBe(2);
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

    /**
     * GS2-107 fix round, finding F — the typed command has neither of the automatic pass's guards,
     * and the shape that exposes it is `--keep-last`: an age bound cannot select a conversation
     * that is active right now, but `--keep-last 1` with three windows open selects two of them.
     *
     * The choice made here is to SAY so rather than to hold the rows back. Silently keeping a
     * conversation inside the bound the person typed would make the bound mean something other than
     * what it says, and liveness in another process is not knowable from this connection anyway —
     * a refusal would be a guess presented as a guarantee.
     */
    it('marks a candidate whose last turn is inside the grace window as recently active', () => {
      const db = openStoreAndSaver();
      for (const t of ['t-newest', 't-minutes-ago', 't-ancient']) seedThread(db, t);
      seedConversation(db, { threadId: 't-newest', lastTs: ago(5 * 60_000) });
      const recent = seedConversation(db, { threadId: 't-minutes-ago', lastTs: ago(20 * 60_000) });
      const ancient = seedConversation(db, { threadId: 't-ancient', lastTs: ago(40 * DAY) });

      const picked = selectPrunableConversations(db, { keepLast: 1, now: NOW });
      const byId = new Map(picked.map((c) => [c.conversationId, c]));
      expect([...byId.keys()].sort()).toEqual([recent, ancient].sort());
      expect(byId.get(recent)?.recentlyActive).toBe(true);
      expect(byId.get(ancient)?.recentlyActive).toBe(false);
      db.close();
    });

    it('reads the flag off the same window the automatic pass uses, on both sides of it', () => {
      const db = openStoreAndSaver();
      for (const t of ['t-kept', 't-inside', 't-outside']) seedThread(db, t);
      seedConversation(db, { threadId: 't-kept', lastTs: ago(60_000) });
      const inside = seedConversation(db, {
        threadId: 't-inside',
        lastTs: ago(RECLAIM_GRACE_MS - 60_000),
      });
      const outside = seedConversation(db, {
        threadId: 't-outside',
        lastTs: ago(RECLAIM_GRACE_MS + 60_000),
      });
      const picked = selectPrunableConversations(db, { keepLast: 1, now: NOW });
      const byId = new Map(picked.map((c) => [c.conversationId, c]));
      expect(byId.get(inside)?.recentlyActive).toBe(true);
      expect(byId.get(outside)?.recentlyActive).toBe(false);
      db.close();
    });
  });

  /**
   * GS2-107 fix round, finding B — **the values that actually ship, exercised with nothing
   * injected.** Every other grace cell in this file passes its own `now` and `graceMs`, which is
   * right for testing the gate and useless for testing the constant: the reviewer zeroed
   * `RECLAIM_GRACE_MS` and all 70 cells stayed green. These two run the pass the way the close hook
   * runs it — no arguments at all — so the shipped number is the only thing deciding, and a change
   * to it in either direction reds one of them.
   */
  describe('the constants that ship', () => {
    it('a bare pass keeps a thread written 23 hours ago and reclaims one written 25 hours ago', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'inside-the-window', { ts: realAgo(23 * HOUR) });
      seedThread(db, 'past-the-window', { ts: realAgo(25 * HOUR) });

      expect(reclaimUnresumableThreads(db)).toMatchObject({ threadCount: 1 });

      expect(rowsFor(db, 'checkpoints', 'inside-the-window')).toBe(3);
      expect(rowsFor(db, 'checkpoints', 'past-the-window')).toBe(0);
      db.close();
    });

    it('a saver never reclaims a thread it has written, however old that thread is', async () => {
      const path = join(dir, 'writeset.db');
      openHistoryStore(path, { create: true })!.close();
      const saver = openCheckpointSaver(path)!;

      // A thread left by a session that is gone, and one this saver writes itself. Both are
      // unaddressable and both are far past the window, so the exclusion is the only difference.
      const seeder = new DatabaseSync(path);
      seedThread(seeder, 'left-by-someone-else', { ts: realAgo(30 * DAY) });
      seeder.close();
      await saver.put(
        { configurable: { thread_id: 'written-by-this-saver', checkpoint_ns: '' } },
        {
          v: 4,
          id: 'cp-1',
          ts: realAgo(30 * DAY),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: 0, parents: {} },
        {}
      );

      // No arguments: the shipped grace window and the saver's own write set, exactly as the close
      // hook calls it.
      expect(saver.reclaimUnresumableThreads()).toMatchObject({ threadCount: 1 });
      saver.close();

      const check = new DatabaseSync(path);
      expect(rowsFor(check, 'checkpoints', 'written-by-this-saver')).toBe(1);
      expect(rowsFor(check, 'checkpoints', 'left-by-someone-else')).toBe(0);
      check.close();
    });

    it("a caller's exclusion adds to the saver's own and can never subtract from it", async () => {
      const path = join(dir, 'writeset-union.db');
      openHistoryStore(path, { create: true })!.close();
      const saver = openCheckpointSaver(path)!;
      const seeder = new DatabaseSync(path);
      seedThread(seeder, 'named-by-the-caller', { ts: realAgo(30 * DAY) });
      seedThread(seeder, 'nobody-protects-this', { ts: realAgo(30 * DAY) });
      seeder.close();
      await saver.put(
        { configurable: { thread_id: 'written-by-this-saver', checkpoint_ns: '' } },
        {
          v: 4,
          id: 'cp-1',
          ts: realAgo(30 * DAY),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: 0, parents: {} },
        {}
      );

      expect(
        saver.reclaimUnresumableThreads({ excludeThreadIds: ['named-by-the-caller'] })
      ).toMatchObject({ threadCount: 1 });
      saver.close();

      const check = new DatabaseSync(path);
      expect(rowsFor(check, 'checkpoints', 'written-by-this-saver')).toBe(1);
      expect(rowsFor(check, 'checkpoints', 'named-by-the-caller')).toBe(3);
      expect(rowsFor(check, 'checkpoints', 'nobody-protects-this')).toBe(0);
      check.close();
    });
  });

  /**
   * GS2-107 fix round, finding C — the predicate asks `conversations` a question once per thread in
   * the store, so it is quadratic without an index on `conversations.thread_id` (measured: 3.18s at
   * 6,000 threads, 13ms with it) and it runs at every session exit.
   *
   * Pinned by the query plan rather than by a clock: a timing assertion on a shared CI runner is a
   * flake generator, while the plan is a deterministic statement about the same property. It is
   * matched on the index NAME — text SQLite takes from the schema — and not on the wording around
   * it, which varies between SQLite versions and therefore between the matrix cells.
   */
  describe('the index the predicate rides on', () => {
    it('the store creates it, and the predicate plans a lookup through it rather than a scan', () => {
      const db = openStoreAndSaver();
      seedThread(db, 'a');
      seedConversation(db, { threadId: 'a' });
      expect(
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
          .get('idx_conversations_thread_id')
      ).toBeDefined();

      const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${UNADDRESSABLE_THREADS_SQL}`).all() as Record<
          string,
          unknown
        >[]
      )
        .map((r) => String(r.detail))
        .join('\n');
      expect(plan).toContain('idx_conversations_thread_id');
      // `v`, the alias the subquery gives `conversations` — the plan never names the table, so an
      // assertion written against `SCAN conversations` matches nothing in either direction and
      // cannot fail. Without the index this line reads exactly `SCAN v`.
      expect(plan).not.toContain('SCAN v');
      db.close();
    });

    it('a database written before the thread column existed gets the column, the grants column AND the index', () => {
      // The ordering constraint, pinned: the index covers a column the ALTER in `migrate` adds, and
      // the whole migration is fail-soft — so creating the index first would throw, be swallowed,
      // and quietly leave a legacy database without `grants`. Only the ALTERs landing alongside the
      // index proves the order is right.
      const legacyPath = join(dir, 'legacy.db');
      const legacy = new DatabaseSync(legacyPath);
      legacy.exec(`
        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_ts TEXT NOT NULL, project TEXT, command TEXT, model TEXT
        );
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL, project TEXT, command TEXT, model TEXT,
          prompt TEXT, response TEXT
        );
      `);
      legacy.close();

      openHistoryStore(legacyPath, { create: true })!.close();

      const check = new DatabaseSync(legacyPath);
      const columns = (
        check.prepare(`PRAGMA table_info(conversations)`).all() as Record<string, unknown>[]
      ).map((c) => String(c.name));
      expect(columns).toContain('thread_id');
      expect(columns).toContain('grants');
      expect(
        check
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
          .get('idx_conversations_thread_id')
      ).toBeDefined();
      check.close();
    });
  });

  /**
   * The fixture here is sized by measurement, not by intuition, because this case is the suite's
   * file-I/O outlier: `VACUUM` rewrites the WHOLE database into a new file and swaps it, and
   * `node:sqlite`'s `DatabaseSync` is synchronous, so a fixture bigger than the statement needs
   * costs wall-clock on every runner and cannot be interrupted by the suite's timer if it goes
   * long.
   *
   * What the mechanism actually requires: `page_size` is 4096 and `auto_vacuum` is 0, so a delete
   * only makes space reclaimable once the bulk rows own whole pages outright. Measured at four
   * checkpoints, the freelist stays EMPTY at payload 500 and holds 4 pages at payload 1,000 —
   * that step is the floor, below which the two assertions below stop discriminating. The chosen
   * 4 x 4,000 sits a step above it (9 free pages, 36,864 reclaimable bytes against 16,000 seeded)
   * because SQLite's packing is lumpy rather than monotonic — payload 4,500 frees 8 pages where
   * 4,000 frees 9 — and a fixture hugging the floor would be one packing decision away from
   * proving nothing on a matrix cell with a different SQLite build.
   */
  describe('VACUUM — the part that gives the disk space back', () => {
    const BULK_CHECKPOINTS = 4;
    const BULK_PAYLOAD = 4_000;
    /** What the bulk thread seeds, and the yardstick every size assertion is written against. */
    const BULK_BYTES = BULK_CHECKPOINTS * BULK_PAYLOAD;

    it('shrinks the file, and the CONTROL shows a delete alone does not', () => {
      const db = openStoreAndSaver();
      const pageBytes = Number(
        (db.prepare(`PRAGMA page_size`).get() as Record<string, unknown>).page_size
      );
      const reclaimableBytes = (): number =>
        Number(
          (db.prepare(`PRAGMA freelist_count`).get() as Record<string, unknown>).freelist_count
        ) * pageBytes;

      const emptyStore = statSync(dbPath).size;
      seedThread(db, 'bulk', { count: BULK_CHECKPOINTS, payload: BULK_PAYLOAD });
      seedConversation(db, { threadId: 'keeper' });
      seedThread(db, 'keeper', { count: 1, payload: 100 });
      // Inert under the store's `journal_mode = delete`; it matters only if the store ever moves
      // to WAL, where the seeded pages would otherwise still be sitting in the `-wal` file and
      // the size read below would be of a file that never grew.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const grown = statSync(dbPath).size;
      expect(grown - emptyStore).toBeGreaterThanOrEqual(BULK_BYTES);

      deleteThreads(db, ['bulk']);
      // CONTROL — the rows are gone and the file has not moved. This is why the VACUUM is not
      // optional: without it a prune reports bytes removed that a user cannot see come back. It
      // is also the line that reds if `auto_vacuum` is ever switched on in the store, which would
      // hand those pages back without anyone asking.
      const afterDelete = statSync(dbPath).size;
      expect(afterDelete).toBe(grown);
      // And the file has not moved DESPITE whole pages being free — which is the half that makes
      // the CONTROL a statement rather than a tautology. A delete does not shrink a file that had
      // nothing reclaimable in it either, so on a fixture below the floor above the CONTROL goes
      // on passing while proving nothing; this is the line that reds there instead.
      const reclaimable = reclaimableBytes();
      expect(reclaimable).toBeGreaterThanOrEqual(BULK_BYTES);

      expect(vacuumStore(db)).toBe(true);
      const afterVacuum = statSync(dbPath).size;
      expect(grown - afterVacuum).toBeGreaterThanOrEqual(BULK_BYTES);
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
      expect(
        stats.largestThreads.find((t) => t.threadId === 'orphaned')?.conversationId
      ).toBeUndefined();
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
