import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HistoryStore, openHistoryStore } from '#src/history/historyStore.js';
import { openConversationSafe, recordSessionSafe } from '#src/history/recordSession.js';

/**
 * GS2-19 — conversation grouping acceptance tests. GS2-7 stored one flat row per turn with no
 * grouping key; this fixes that with a `conversations` table + a `conversation_id` on each turn.
 * The four goals proven here:
 *  1. grouping — N turns of one interactive session → ONE conversation with N turns.
 *  2. list-shows-conversations — `listConversations` returns conversation-grained rows (count /
 *     last message / timespan), not per-turn rows.
 *  3. search-hit-resolves-parent — a search hit carries its parent `conversationId`, and the whole
 *     thread can be pulled back in order.
 *  4. back-fill — opening a pre-GS2-19 flat DB (rows with no conversation_id) migrates each into its
 *     own 1-turn conversation in place, without error, and they appear in `list`.
 */
describe('history/conversations (GS2-19)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-conv-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('grouping: one session opens one conversation, every turn stamps it', () => {
    it('groups N turns under one conversation at the store level', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      const conversationId = store.openConversation({ command: 'chat', model: 'gpt-5' })!;
      expect(conversationId).toBeTypeOf('number');
      store.record({ conversationId, command: 'chat', prompt: 'turn one', response: 'a1' });
      store.record({ conversationId, command: 'chat', prompt: 'turn two', response: 'a2' });
      store.record({ conversationId, command: 'chat', prompt: 'turn three', response: 'a3' });

      const conversations = store.listConversations();
      expect(conversations).toHaveLength(1);
      expect(conversations[0].id).toBe(conversationId);
      expect(conversations[0].turnCount).toBe(3);
      // Each recorded turn belongs to the same parent conversation.
      const thread = store.getConversationThread(conversationId);
      expect(thread.map((t) => t.prompt)).toEqual(['turn one', 'turn two', 'turn three']);
      expect(thread.every((t) => t.conversationId === conversationId)).toBe(true);
      store.close();
    });

    it('groups N turns through the opt-in bridge (openConversationSafe + recordSessionSafe)', () => {
      const dbPath = resolve(dir, 'history.db');
      const config = { history: { enabled: true, dbPath } };
      const conversationId = openConversationSafe(config, { command: 'code', model: 'gpt-5' });
      expect(conversationId).toBeTypeOf('number');
      recordSessionSafe(config, { conversationId: conversationId!, command: 'code', prompt: 'q1' });
      recordSessionSafe(config, { conversationId: conversationId!, command: 'code', prompt: 'q2' });

      const store = openHistoryStore(dbPath, { create: false })!;
      const conversations = store.listConversations();
      expect(conversations).toHaveLength(1);
      expect(conversations[0].turnCount).toBe(2);
      store.close();
    });

    it('a single-shot record (no conversationId) becomes its OWN 1-turn conversation', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      store.record({ command: 'ask', prompt: 'one-shot' });
      store.record({ command: 'ask', prompt: 'another one-shot' });
      const conversations = store.listConversations();
      // Two independent single-shot runs = two separate 1-turn conversations (not grouped).
      expect(conversations).toHaveLength(2);
      expect(conversations.every((c) => c.turnCount === 1)).toBe(true);
      store.close();
    });
  });

  describe('list-shows-conversations: conversation-grained rows (count / last / timespan)', () => {
    it('returns one row per conversation carrying turn count, last message and timespan', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      const a = store.openConversation({ command: 'chat', model: 'gpt-5' })!;
      store.record({ conversationId: a, command: 'chat', prompt: 'a-first', response: 'r1' });
      store.record({ conversationId: a, command: 'chat', prompt: 'a-last', response: 'r2' });
      const b = store.openConversation({ command: 'ask', model: 'gpt-5' })!;
      store.record({ conversationId: b, command: 'ask', prompt: 'b-only', response: 'rb' });

      const conversations = store.listConversations();
      // Newest conversation first (b, then a) — NOT three flat per-turn rows.
      expect(conversations.map((c) => c.id)).toEqual([b, a]);
      const rowA = conversations.find((c) => c.id === a)!;
      expect(rowA.turnCount).toBe(2);
      expect(rowA.lastPrompt).toBe('a-last'); // last message of the conversation
      expect(rowA.firstTs).toBeDefined();
      expect(rowA.lastTs).toBeDefined(); // timespan endpoints present
      const rowB = conversations.find((c) => c.id === b)!;
      expect(rowB.turnCount).toBe(1);
      expect(rowB.lastPrompt).toBe('b-only');
      store.close();
    });
  });

  describe('search-hit-resolves-parent: a hit maps to its conversation and the thread prints', () => {
    it('resolves a search hit to its parent conversation and returns the full thread in order', () => {
      const store = HistoryStore.open(':memory:', { create: true })!;
      const conversationId = store.openConversation({ command: 'chat', model: 'gpt-5' })!;
      store.record({
        conversationId,
        command: 'chat',
        prompt: 'tell me about widgets',
        response: 'ok',
      });
      store.record({
        conversationId,
        command: 'chat',
        prompt: 'and the sprocket detail?',
        response: 'sprockets explained',
      });

      const hits = store.search('sprocket');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      // The hit carries the parent conversation id, not just an isolated turn.
      expect(hits[0].conversationId).toBe(conversationId);

      // Which lets the whole thread be pulled back, in order.
      const thread = store.getConversationThread(hits[0].conversationId!);
      expect(thread.map((t) => t.prompt)).toEqual([
        'tell me about widgets',
        'and the sprocket detail?',
      ]);
      store.close();
    });
  });

  describe('back-fill: a pre-GS2-19 flat DB migrates in place on open', () => {
    it('turns ungrouped flat rows into 1-turn conversations without error, appearing in list', () => {
      const dbPath = resolve(dir, 'legacy.db');
      // Build the OLD GS2-7 schema by hand: `sessions` with NO conversation_id column, plus its
      // FTS index, and two flat rows. This is exactly what a DB from before GS2-19 looks like.
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE sessions (
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
          duration_ms INTEGER
        );
        CREATE VIRTUAL TABLE sessions_fts USING fts5(prompt, response, command, project);
      `);
      const ins = legacy.prepare(
        `INSERT INTO sessions (ts, command, prompt, response) VALUES (?, ?, ?, ?)`
      );
      const fts = legacy.prepare(
        `INSERT INTO sessions_fts (rowid, prompt, response, command, project) VALUES (?, ?, ?, ?, ?)`
      );
      const r1 = ins.run('2026-07-01T00:00:00.000Z', 'ask', 'legacy one', 'ans one');
      fts.run(Number(r1.lastInsertRowid), 'legacy one', 'ans one', 'ask', '');
      const r2 = ins.run('2026-07-02T00:00:00.000Z', 'chat', 'legacy two', 'ans two');
      fts.run(Number(r2.lastInsertRowid), 'legacy two', 'ans two', 'chat', '');
      legacy.close();

      // Open the read-only way a `history list` / `search` command does — migration must run here
      // and must NOT throw on the pre-existing DB.
      let store: HistoryStore | null = null;
      expect(() => {
        store = openHistoryStore(dbPath, { create: false });
      }).not.toThrow();
      expect(store).not.toBeNull();

      // Each legacy flat row is now its own 1-turn conversation, and they show up in list.
      const conversations = store!.listConversations();
      expect(conversations).toHaveLength(2);
      expect(conversations.every((c) => c.turnCount === 1)).toBe(true);
      // last message previews come from the back-filled rows.
      expect(conversations.map((c) => c.lastPrompt).sort()).toEqual(['legacy one', 'legacy two']);

      // The turns are stamped with a real conversation_id, and search still resolves to it.
      const hits = store!.search('legacy');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits.every((h) => h.conversationId != null)).toBe(true);
      store!.close();

      // Idempotent: reopening again does not double-create conversations.
      const reopened = openHistoryStore(dbPath, { create: false })!;
      expect(reopened.listConversations()).toHaveLength(2);
      reopened.close();
    });
  });
});
