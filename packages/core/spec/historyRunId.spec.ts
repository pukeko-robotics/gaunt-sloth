/**
 * GS2-106 — `conversations.run_id`: a stable id minted for every conversation row the store
 * creates, from each of the three sites that create one, and a database written before the column
 * existed opening, gaining it with its UNIQUE index, and keeping its rows with `run_id` NULL.
 *
 * `migrate()` swallows every error, so "the store opened" proves nothing about the migration; the
 * schema itself is read back with `PRAGMA table_info` / `PRAGMA index_list`.
 *
 * Every database here is a temp file or `:memory:`. Nothing resolves a path from `HOME`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
/** The module under test, imported inside each test. */
const history = () => import('#src/history/historyStore.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The schema as it was on gaunt-sloth `main` immediately before GS2-106 (`7b098019`): the
 * `conversations` table with `thread_id` and `grants` and no `run_id`. Copied from that commit's
 * `initSchema`, so a DB built from it is exactly what an existing user has on disk.
 */
const PRE_RUN_ID_SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_ts TEXT NOT NULL,
    project TEXT,
    command TEXT,
    model TEXT,
    thread_id TEXT,
    grants TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    project TEXT,
    command TEXT,
    model TEXT,
    prompt TEXT,
    response TEXT,
    tokens_input INTEGER,
    tokens_output INTEGER,
    cost_usd REAL,
    tools TEXT,
    duration_ms INTEGER,
    conversation_id INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    prompt, response, command, project
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_thread_id ON conversations(thread_id);
`;

type Row = Record<string, unknown>;

const runIds = (dbPath: string): Row[] => {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT id, run_id FROM conversations ORDER BY id`).all() as Row[];
  } finally {
    db.close();
  }
};

describe('GS2-106 — every new conversation row is minted a run id', () => {
  let dir: string;
  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-run-id-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('openConversation mints a distinct canonical UUID for each row it creates', async () => {
    const dbPath = resolve(dir, 'history.db');
    const store = (await history()).openHistoryStore(dbPath, { create: true })!;
    const ids = [
      store.openConversation({ command: 'chat', threadId: 'thread-a' })!,
      store.openConversation({ command: 'code', threadId: 'thread-b' })!,
      store.openConversation({ command: 'chat' })!,
    ];
    store.close();

    const rows = runIds(dbPath);
    expect(rows.map((r) => Number(r.id))).toEqual(ids);
    for (const r of rows) expect(String(r.run_id)).toMatch(UUID);
    expect(new Set(rows.map((r) => r.run_id)).size).toBe(3);
  });

  it('recordTurn mints one when it opens a fresh conversation, and hands it back', async () => {
    const dbPath = resolve(dir, 'history.db');
    const store = (await history()).openHistoryStore(dbPath, { create: true })!;
    const a = store.recordTurn({ command: 'ask', prompt: 'one', response: 'r' })!;
    const b = store.recordTurn({ command: 'exec', prompt: 'two', response: 'r', threadId: 't' })!;
    store.close();

    expect(a.runId).toMatch(UUID);
    expect(b.runId).toMatch(UUID);
    expect(a.runId).not.toBe(b.runId);
    const rows = runIds(dbPath);
    expect(rows).toEqual([
      { id: a.conversationId, run_id: a.runId },
      { id: b.conversationId, run_id: b.runId },
    ]);
  });

  it('recordTurn under an existing conversation mints nothing, and reports that row’s own run id', async () => {
    const dbPath = resolve(dir, 'history.db');
    const store = (await history()).openHistoryStore(dbPath, { create: true })!;
    const conversationId = store.openConversation({ command: 'chat', threadId: 'thread-c' })!;
    const first = store.recordTurn({
      conversationId,
      command: 'chat',
      prompt: 'p',
      response: 'r',
    })!;
    const second = store.recordTurn({
      conversationId,
      command: 'chat',
      prompt: 'q',
      response: 's',
    })!;
    store.close();

    const rows = runIds(dbPath);
    expect(rows).toHaveLength(1);
    expect(first.runId).toBe(rows[0].run_id);
    expect(second.runId).toBe(rows[0].run_id);
    expect(first.conversationId).toBe(conversationId);
  });

  it('the orphan backfill in migrate() mints one for each conversation row it creates', async () => {
    const dbPath = resolve(dir, 'legacy.db');
    // Turns with no conversation: what a pre-GS2-19 DB holds once its column has been added.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(PRE_RUN_ID_SCHEMA);
    const ins = legacy.prepare(`INSERT INTO sessions (ts, command, prompt) VALUES (?, ?, ?)`);
    ins.run('2026-07-01T00:00:00.000Z', 'ask', 'orphan one');
    ins.run('2026-07-02T00:00:00.000Z', 'chat', 'orphan two');
    legacy.close();

    const store = (await history()).openHistoryStore(dbPath, { create: false })!;
    expect(store).not.toBeNull();
    store.close();

    const db = new DatabaseSync(dbPath);
    try {
      const stamped = db
        .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE conversation_id IS NULL`)
        .get() as Row;
      expect(Number(stamped.n)).toBe(0);
    } finally {
      db.close();
    }
    const rows = runIds(dbPath);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(String(r.run_id)).toMatch(UUID);
    expect(rows[0].run_id).not.toBe(rows[1].run_id);
  });
});

describe('GS2-106 — a database from before run ids migrates in place', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-run-id-migrate-'));
    dbPath = resolve(dir, 'history.db');
    // Two grouped conversations, one with a thread: every turn already has its conversation, so
    // the orphan backfill has nothing to do and cannot blur what the migration did to these rows.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(PRE_RUN_ID_SCHEMA);
    legacy
      .prepare(`INSERT INTO conversations (id, started_ts, command, thread_id) VALUES (?, ?, ?, ?)`)
      .run(7, '2026-08-01T00:00:00.000Z', 'chat', 'thread-legacy');
    legacy
      .prepare(`INSERT INTO conversations (id, started_ts, command) VALUES (?, ?, ?)`)
      .run(8, '2026-08-02T00:00:00.000Z', 'ask');
    const turn = legacy.prepare(
      `INSERT INTO sessions (ts, command, prompt, response, conversation_id) VALUES (?, ?, ?, ?, ?)`
    );
    turn.run('2026-08-01T00:00:00.000Z', 'chat', 'legacy prompt', 'legacy answer', 7);
    turn.run('2026-08-02T00:00:00.000Z', 'ask', 'legacy ask', 'legacy ask answer', 8);
    legacy.close();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('gains the column and its UNIQUE index, keeps its rows, and leaves their run_id NULL', async () => {
    const store = (await history()).openHistoryStore(dbPath, { create: false })!;
    expect(store).not.toBeNull();
    store.close();

    const db = new DatabaseSync(dbPath);
    try {
      const cols = db.prepare(`PRAGMA table_info(conversations)`).all() as Row[];
      expect(cols.map((c) => c.name)).toContain('run_id');
      const indexes = db.prepare(`PRAGMA index_list(conversations)`).all() as Row[];
      const runIdIndex = indexes.find((i) => i.name === 'idx_conversations_run_id');
      expect(runIdIndex, 'the run_id index exists').toBeDefined();
      expect(Number(runIdIndex!.unique)).toBe(1);
      const indexed = db.prepare(`PRAGMA index_info(idx_conversations_run_id)`).all() as Row[];
      expect(indexed.map((c) => c.name)).toEqual(['run_id']);

      const rows = db
        .prepare(`SELECT id, command, thread_id, run_id FROM conversations ORDER BY id`)
        .all() as Row[];
      expect(rows).toEqual([
        { id: 7, command: 'chat', thread_id: 'thread-legacy', run_id: null },
        { id: 8, command: 'ask', thread_id: null, run_id: null },
      ]);
      const turns = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as Row;
      expect(Number(turns.n)).toBe(2);
    } finally {
      db.close();
    }
  });

  it('a pre-migration row still resolves by its integer, and a row created afterwards gets a run id', async () => {
    const store = (await history()).openHistoryStore(dbPath, { create: false })!;
    try {
      expect(store.resolveConversationRef({ kind: 'id', id: 7 })).toBe(7);
      expect(store.getConversationThread(7).map((t) => t.prompt)).toEqual(['legacy prompt']);
      const fresh = store.recordTurn({ command: 'ask', prompt: 'after', response: 'r' })!;
      expect(fresh.runId).toMatch(UUID);
      expect(store.resolveConversationRef({ kind: 'run', runId: fresh.runId! })).toBe(
        fresh.conversationId
      );
    } finally {
      store.close();
    }
  });

  it('opening it a second time is a no-op: the index is not duplicated and the rows stay NULL', async () => {
    (await history()).openHistoryStore(dbPath, { create: false })!.close();
    (await history()).openHistoryStore(dbPath, { create: false })!.close();
    const rows = runIds(dbPath);
    expect(rows).toEqual([
      { id: 7, run_id: null },
      { id: 8, run_id: null },
    ]);
  });
});

describe('GS2-106 — resolveConversationRef matches exactly, in THIS database only', () => {
  it('resolves an integer and a run id to their row, and names nothing for an unknown one or another database’s run id', async () => {
    const a = (await history()).HistoryStore.open(':memory:', { create: true })!;
    const b = (await history()).HistoryStore.open(':memory:', { create: true })!;
    try {
      const inA = a.recordTurn({ command: 'ask', prompt: 'a', response: 'r' })!;
      // B has a row at the SAME integer, so a lookup that fell back to the integer would find one.
      const inB = b.recordTurn({ command: 'ask', prompt: 'b', response: 'r' })!;
      expect(inB.conversationId).toBe(inA.conversationId);

      expect(a.resolveConversationRef({ kind: 'id', id: inA.conversationId })).toBe(
        inA.conversationId
      );
      expect(a.resolveConversationRef({ kind: 'run', runId: inA.runId! })).toBe(inA.conversationId);
      expect(a.resolveConversationRef({ kind: 'id', id: 4242 })).toBeNull();
      expect(
        a.resolveConversationRef({ kind: 'run', runId: '0f8fad5b-d9cb-469f-a165-70867728950e' })
      ).toBeNull();
      expect(b.resolveConversationRef({ kind: 'run', runId: inA.runId! })).toBeNull();
    } finally {
      a.close();
      b.close();
    }
  });
});
