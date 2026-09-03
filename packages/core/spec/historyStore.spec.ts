import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  HistoryStore,
  openHistoryStore,
  toFtsMatchQuery,
  type SessionRecord,
} from '#src/history/historyStore.js';

/**
 * GS2-7 (B20) acceptance tests for the local SQLite history store:
 * index a session and search it (FTS5), ranking is sensible, insights aggregate token/cost + a
 * top-tool tally, and a malformed/missing/locked DB fails soft (returns null / empty, never throws).
 */
describe('history/historyStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-history-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (store: HistoryStore, recs: SessionRecord[]) => recs.map((r) => store.record(r));

  describe('store + FTS5 search', () => {
    it('indexes a session and finds it by a full-text term', () => {
      const store = HistoryStore.open(':memory:', { create: true });
      expect(store).not.toBeNull();
      const id = store!.record({
        command: 'ask',
        prompt: 'How do I refactor the widget factory?',
        response: 'Extract a builder and inject dependencies.',
        model: 'gpt-5',
      });
      expect(id).toBeTypeOf('number');

      const hits = store!.search('widget');
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe(id);
      expect(hits[0].command).toBe('ask');
      // Snippet highlights the matched term.
      expect(hits[0].snippet.toLowerCase()).toContain('widget');
      store!.close();
    });

    it('ranks the more relevant session first', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      seed(store, [
        { command: 'ask', prompt: 'database indexing tips', response: 'use an index once' },
        {
          command: 'ask',
          prompt: 'database database database indexing indexing',
          response: 'index index index',
        },
      ]);
      const hits = store.search('database indexing');
      expect(hits.length).toBeGreaterThanOrEqual(2);
      // The denser document (more term occurrences) ranks first under FTS5 bm25.
      expect(hits[0].prompt).toContain('database database database');
      store.close();
    });

    it('returns no hits for a term that is not present', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      store.record({ command: 'ask', prompt: 'hello', response: 'world' });
      expect(store.search('nonexistentterm')).toEqual([]);
      store.close();
    });

    it('never throws on a query full of FTS operators (sanitised MATCH)', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      store.record({ command: 'ask', prompt: 'a AND b OR c', response: 'text' });
      // A raw FTS query like this could be a syntax error; toFtsMatchQuery quotes each token.
      expect(() => store.search('AND OR ( "unbalanced')).not.toThrow();
      expect(store.search('   ')).toEqual([]); // empty/whitespace query
      store.close();
    });

    it('listRecent returns newest first', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      store.record({ command: 'ask', prompt: 'first' });
      store.record({ command: 'code', prompt: 'second' });
      const recent = store.listRecent();
      expect(recent.map((r) => r.prompt)).toEqual(['second', 'first']);
      store.close();
    });
  });

  describe('insights aggregation', () => {
    it('sums tokens/cost and tallies top tools + per-command over seeded sessions', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      seed(store, [
        {
          command: 'ask',
          prompt: 'q1',
          tokensInput: 100,
          tokensOutput: 50,
          costUsd: 0.01,
          tools: ['read_file', 'run_shell_command'],
        },
        {
          command: 'code',
          prompt: 'q2',
          tokensInput: 200,
          tokensOutput: 80,
          costUsd: 0.02,
          tools: ['read_file'],
        },
        {
          command: 'ask',
          prompt: 'q3',
          tokensInput: 0,
          tokensOutput: 0,
          costUsd: 0,
          tools: ['read_file', 'write_file'],
        },
      ]);

      const insights = store.insights();
      expect(insights.sessionCount).toBe(3);
      expect(insights.totalTokensInput).toBe(300);
      expect(insights.totalTokensOutput).toBe(130);
      expect(insights.totalTokens).toBe(430);
      expect(insights.totalCostUsd).toBeCloseTo(0.03, 6);

      // Top tools: read_file appears in 3 sessions, others once each.
      expect(insights.topTools[0]).toEqual({ tool: 'read_file', count: 3 });
      const toolMap = Object.fromEntries(insights.topTools.map((t) => [t.tool, t.count]));
      expect(toolMap['run_shell_command']).toBe(1);
      expect(toolMap['write_file']).toBe(1);

      // Per-command: ask (2) before code (1).
      expect(insights.perCommand).toEqual([
        { command: 'ask', count: 2 },
        { command: 'code', count: 1 },
      ]);

      expect(insights.firstTs).toBeDefined();
      expect(insights.lastTs).toBeDefined();
      store.close();
    });

    it('returns a zeroed summary for an empty store', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      const insights = store.insights();
      expect(insights.sessionCount).toBe(0);
      expect(insights.totalTokens).toBe(0);
      expect(insights.totalCostUsd).toBe(0);
      expect(insights.topTools).toEqual([]);
      expect(insights.perCommand).toEqual([]);
      store.close();
    });

    it('tolerates rows with missing token/cost/tool fields (nulls treated as absent)', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      store.record({ command: 'ask', prompt: 'no analytics' });
      const insights = store.insights();
      expect(insights.sessionCount).toBe(1);
      expect(insights.totalTokens).toBe(0);
      expect(insights.topTools).toEqual([]);
      store.close();
    });
  });

  describe('fail-soft', () => {
    it('returns null when the DB file is missing and create is false', () => {
      const missing = resolve(dir, 'does-not-exist.db');
      expect(openHistoryStore(missing, { create: false })).toBeNull();
    });

    // GS2-42: previously skipped on win32 — opening a corrupt DB threw inside initSchema(),
    // and the outer catch in HistoryStore.open() returned null without closing the DatabaseSync
    // handle it had already created, leaking an OS-level file handle. On Windows that leak blocked
    // afterEach's rmSync(dir) with EPERM (POSIX allows unlinking an open fd, which is why the leak
    // was invisible there). open() now closes the handle in the catch before returning null, so
    // this runs unconditionally on every platform, including win32.
    it('returns null (does not throw) when opening a corrupt DB file', () => {
      const corrupt = resolve(dir, 'corrupt.db');
      writeFileSync(corrupt, 'this is not a sqlite database at all, just text\n');
      // create:false so we open the existing (garbage) file; must fail soft, not throw.
      expect(() => openHistoryStore(corrupt, { create: false })).not.toThrow();
      expect(openHistoryStore(corrupt, { create: false })).toBeNull();
    });

    it('persists to a file and reopens it read-only across store instances', () => {
      const dbPath = resolve(dir, 'history.db');
      const w = openHistoryStore(dbPath, { create: true })!;
      w.record({ command: 'ask', prompt: 'persisted question', response: 'answer' });
      w.close();

      // A later read-only open (create:false) sees the persisted row.
      const r = openHistoryStore(dbPath, { create: false });
      expect(r).not.toBeNull();
      expect(r!.search('persisted')).toHaveLength(1);
      r!.close();
    });

    it('search/insights on a closed store return empty rather than throwing', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      store.record({ command: 'ask', prompt: 'x' });
      store.close();
      expect(() => store.search('x')).not.toThrow();
      expect(store.search('x')).toEqual([]);
      expect(() => store.insights()).not.toThrow();
      expect(store.insights().sessionCount).toBe(0);
      // record after close is a no-op that returns null, not a throw.
      expect(store.record({ command: 'ask', prompt: 'y' })).toBeNull();
    });
  });

  /**
   * GS2-20 — the two reads a resume makes of one conversation, and the grants column it writes.
   */
  describe('resume: one conversation, and its grants document', () => {
    it('getConversation returns a row WITH zero turns, which listConversations hides', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      const emptyId = store.openConversation({ command: 'code', threadId: 'thread-empty' })!;
      const fullId = store.openConversation({ command: 'chat', threadId: 'thread-full' })!;
      store.record({ conversationId: fullId, command: 'chat', prompt: 'p1', response: 'r1' });
      store.record({ conversationId: fullId, command: 'chat', prompt: 'p2', response: 'r2' });

      // The listing excludes the empty one (its existing contract), the point read does not: a
      // resume has to see it to refuse it for the RIGHT reason.
      expect(store.listConversations().map((c) => c.id)).toEqual([fullId]);
      const empty = store.getConversation(emptyId);
      expect(empty).not.toBeNull();
      expect(empty!.turnCount).toBe(0);
      expect(empty!.threadId).toBe('thread-empty');
      expect(empty!.command).toBe('code');

      const full = store.getConversation(fullId)!;
      expect(full.turnCount).toBe(2);
      expect(full.lastPrompt).toBe('p2');
      expect(full.threadId).toBe('thread-full');
      // An unknown id is null, never a neighbour — probed past both ends.
      expect(store.getConversation(fullId + 1000)).toBeNull();
      expect(store.getConversation(0)).toBeNull();
      expect(store.getConversation(-1)).toBeNull();
      store.close();
    });

    it('getConversation reports no thread for a cleared link and for an empty string', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      const id = store.openConversation({ command: 'code', threadId: 'thread-x' })!;
      store.clearConversationThread(id);
      expect(store.getConversation(id)!.threadId).toBeUndefined();
      const blank = store.openConversation({ command: 'code', threadId: '' })!;
      expect(store.getConversation(blank)!.threadId).toBeUndefined();
      store.close();
    });

    it('stores and returns the grants document verbatim, and clears it with null', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      const id = store.openConversation({ command: 'code', threadId: 't' })!;
      expect(store.getConversationGrants(id)).toBeNull();
      expect(store.setConversationGrants(id, '{"version":1,"allow":[],"deny":[]}')).toBe(true);
      expect(store.getConversationGrants(id)).toBe('{"version":1,"allow":[],"deny":[]}');
      expect(store.setConversationGrants(id, null)).toBe(true);
      expect(store.getConversationGrants(id)).toBeNull();
      // An unknown id updates nothing and says so.
      expect(store.setConversationGrants(id + 1000, '{}')).toBe(false);
      expect(store.getConversationGrants(id + 1000)).toBeNull();
      store.close();
    });

    it('adds the grants column to a database written before it existed', () => {
      const dbPath = resolve(dir, 'pre-grants.db');
      const legacy = openHistoryStore(dbPath, { create: true })!;
      legacy.close();
      const raw = new DatabaseSync(dbPath);
      raw.exec('DROP TABLE conversations');
      raw.exec(
        `CREATE TABLE conversations (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           started_ts TEXT NOT NULL,
           project TEXT,
           command TEXT,
           model TEXT,
           thread_id TEXT
         )`
      );
      raw.exec(
        `INSERT INTO conversations (started_ts, command, thread_id)
         VALUES ('2020-01-01T00:00:00Z', 'chat', 'old-thread')`
      );
      raw.close();

      const migrated = openHistoryStore(dbPath, { create: false })!;
      // The old row is readable, has no grants, and can be given some.
      expect(migrated.getConversation(1)!.threadId).toBe('old-thread');
      expect(migrated.getConversationGrants(1)).toBeNull();
      expect(migrated.setConversationGrants(1, '{"version":1,"allow":[],"deny":[]}')).toBe(true);
      expect(migrated.getConversationGrants(1)).toContain('"version":1');
      migrated.close();
    });
  });

  describe('toFtsMatchQuery', () => {
    it('quotes each token and AND-joins them', () => {
      expect(toFtsMatchQuery('foo bar')).toBe('"foo" AND "bar"');
    });
    it('escapes embedded quotes and returns empty for blank input', () => {
      expect(toFtsMatchQuery('a"b')).toBe('"a""b"');
      expect(toFtsMatchQuery('   ')).toBe('');
    });
  });
});
