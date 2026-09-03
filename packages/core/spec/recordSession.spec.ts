import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  listResumableConversationsSafe,
  lookupConversationSafe,
  lookupConversationThreadSafe,
  openConversationSafe,
  readConversationGrantsSafe,
  recordSessionSafe,
  writeConversationGrantsSafe,
} from '#src/history/recordSession.js';
import { openHistoryStore } from '#src/history/historyStore.js';

/**
 * GS2-7 (B20) / GS2-20 — the recorder bridge and the single switch that governs it.
 *
 * The two cases that carry the behaviour are asserted separately and must stay that way: an ABSENT
 * `history` key records (the default is on), and an explicit `history.enabled: false` does not
 * (the opt-out is the only thing that turns it off). Collapsing them into one "history is on" test
 * would pass against a reader that ignored the config entirely.
 *
 * Every case pins `dbPath` at a temp directory. Without that the bridge resolves the REAL
 * `~/.gsloth/history.db` and creates `~/.gsloth`, so the suite would write into the user's own
 * store — which the default-off reading used to make impossible and the flip does not.
 */
describe('history/recordSessionSafe', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-rec-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('RECORDS when history config is absent (the default run)', () => {
    const dbPath = resolve(dir, 'history.db');
    const id = recordSessionSafe(
      { history: { dbPath } },
      { command: 'ask', prompt: 'default-on-token', response: 'a' }
    );
    expect(id).toBeTypeOf('number');
    expect(existsSync(dbPath)).toBe(true);

    const store = openHistoryStore(dbPath, { create: false })!;
    expect(store.search('default-on-token')).toHaveLength(1);
    store.close();
  });

  it('RECORDS when history is an empty object (no `enabled` key at all)', () => {
    const dbPath = resolve(dir, 'history.db');
    // The same case reached through the other spelling: `history: {}` with dbPath supplied via the
    // resolver's own default would hit the real home, so this drives the store directly instead.
    const id = recordSessionSafe(
      { history: { enabled: undefined, dbPath } },
      { command: 'chat', prompt: 'undefined-enabled-token' }
    );
    expect(id).toBeTypeOf('number');
    const store = openHistoryStore(dbPath, { create: false })!;
    expect(store.search('undefined-enabled-token')).toHaveLength(1);
    store.close();
  });

  it('does NOTHING when history.enabled is false, and creates no DB file', () => {
    const dbPath = resolve(dir, 'history.db');
    const id = recordSessionSafe(
      { history: { enabled: false, dbPath } },
      { command: 'ask', prompt: 'q', response: 'a' }
    );
    expect(id).toBeNull();
    expect(existsSync(dbPath)).toBe(false);
  });

  it('records (and creates the DB) when history.enabled is explicitly true', () => {
    const dbPath = resolve(dir, 'history.db');
    const id = recordSessionSafe(
      { history: { enabled: true, dbPath } },
      { command: 'ask', prompt: 'searchable-token', response: 'answer', tokensInput: 10 }
    );
    expect(id).toBeTypeOf('number');
    expect(existsSync(dbPath)).toBe(true);

    const store = openHistoryStore(dbPath, { create: false })!;
    const hits = store.search('searchable-token');
    expect(hits).toHaveLength(1);
    expect(hits[0].command).toBe('ask');
    expect(store.insights().totalTokensInput).toBe(10);
    store.close();
  });

  it('persists token/tool/duration analytics and reads them back (GS2-16)', () => {
    const dbPath = resolve(dir, 'history.db');
    const id = recordSessionSafe(
      { history: { enabled: true, dbPath } },
      {
        command: 'code',
        prompt: 'do the thing',
        response: 'did it',
        tokensInput: 120,
        tokensOutput: 45,
        tools: ['read_file', 'run_shell_command'],
        durationMs: 1234,
      }
    );
    expect(id).toBeTypeOf('number');

    const store = openHistoryStore(dbPath, { create: false })!;
    const recent = store.listRecent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].tokensInput).toBe(120);
    expect(recent[0].tokensOutput).toBe(45);
    expect(recent[0].tools).toEqual(['read_file', 'run_shell_command']);
    expect(recent[0].durationMs).toBe(1234);

    const insights = store.insights();
    expect(insights.totalTokens).toBe(165);
    expect(insights.topTools.map((t) => t.tool).sort()).toEqual(['read_file', 'run_shell_command']);
    store.close();
  });

  it('fails soft (returns null, no throw) when enabled but the DB path is unusable', () => {
    // Point at a path whose parent is a file, so opening/creating the DB fails.
    const unusable = resolve(dir, 'history.db');
    // dir itself exists; use dir as the DB path (a directory) → open must fail soft.
    const id = recordSessionSafe(
      { history: { enabled: true, dbPath: dir } },
      { command: 'ask', prompt: 'q' }
    );
    expect(id).toBeNull();
    // The sibling real path was never created.
    expect(existsSync(unusable)).toBe(false);
  });
});

/**
 * GS2-20 — the conversation-to-thread link: the trip from an id `gth history list` prints to the
 * LangGraph thread whose checkpoint holds that conversation's state.
 *
 * **The lookup is exact, and never falls back.** A resume answered with "the most recent
 * conversation" when the id it was given names nothing would drop someone into another
 * conversation's state under the id they typed, which is the failure this whole link exists to make
 * impossible — so the discriminating case here is an unknown id asked of a store that HAS
 * neighbours to wrongly return.
 */
describe('history: the conversation-to-thread link', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-thr-'));
    dbPath = resolve(dir, 'history.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips the thread id a session opened its conversation with', () => {
    const conversationId = openConversationSafe(
      { history: { dbPath } },
      { command: 'chat', threadId: 'thread-xyz' }
    );
    expect(conversationId).toBeTypeOf('number');
    expect(lookupConversationThreadSafe({ history: { dbPath } }, conversationId!)).toBe(
      'thread-xyz'
    );
  });

  it('answers an UNKNOWN id with null, not with a neighbouring conversation', () => {
    const first = openConversationSafe({ history: { dbPath } }, { threadId: 'thread-one' })!;
    const second = openConversationSafe({ history: { dbPath } }, { threadId: 'thread-two' })!;
    expect(lookupConversationThreadSafe({ history: { dbPath } }, first)).toBe('thread-one');
    expect(lookupConversationThreadSafe({ history: { dbPath } }, second)).toBe('thread-two');

    // An id past the end, and one before the beginning — a fallback of either polarity is caught.
    expect(lookupConversationThreadSafe({ history: { dbPath } }, second + 1000)).toBeNull();
    expect(lookupConversationThreadSafe({ history: { dbPath } }, 0)).toBeNull();
    expect(lookupConversationThreadSafe({ history: { dbPath } }, -1)).toBeNull();
  });

  it('answers null for a conversation recorded without a thread (listable, not resumable)', () => {
    const conversationId = openConversationSafe({ history: { dbPath } }, { command: 'chat' })!;
    expect(conversationId).toBeTypeOf('number');
    expect(lookupConversationThreadSafe({ history: { dbPath } }, conversationId)).toBeNull();
  });

  it('surfaces the thread id on the conversation listing', () => {
    const conversationId = openConversationSafe(
      { history: { dbPath } },
      { command: 'chat', threadId: 'thread-listed' }
    )!;
    recordSessionSafe({ history: { dbPath } }, { conversationId, command: 'chat', prompt: 'q' });

    const store = openHistoryStore(dbPath, { create: false })!;
    const listed = store.listConversations(10).find((c) => c.id === conversationId);
    expect(listed?.threadId).toBe('thread-listed');
    store.close();
  });

  it('opens nothing and looks up nothing when history.enabled is false', () => {
    expect(openConversationSafe({ history: { enabled: false, dbPath } }, {})).toBeNull();
    expect(lookupConversationThreadSafe({ history: { enabled: false, dbPath } }, 1)).toBeNull();
    expect(existsSync(dbPath)).toBe(false);
  });

  it('adds the thread column to a database written before it existed', () => {
    // A pre-GS2-20 store: conversations with no thread_id column at all. The migration must add it
    // in place, leave the existing rows readable, and record a thread on new ones — the same
    // in-place ALTER precedent the conversation grouping already set.
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
         model TEXT
       )`
    );
    raw.exec(
      `INSERT INTO conversations (started_ts, command) VALUES ('2020-01-01T00:00:00Z', 'chat')`
    );
    raw.close();

    const migrated = openHistoryStore(dbPath, { create: false })!;
    expect(migrated.getConversationThreadId(1)).toBeNull();
    const fresh = migrated.openConversation({ command: 'chat', threadId: 'thread-after-migrate' })!;
    expect(migrated.getConversationThreadId(fresh)).toBe('thread-after-migrate');
    migrated.close();
  });
});

/**
 * GS2-20 — the reads a resume makes through the bridge: the conversation row and its turns, the
 * picker's candidates, and the grants document. All governed by the one switch, all fail-soft.
 */
describe('history/recordSession — resume lookups', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-resume-lookup-'));
    dbPath = resolve(dir, 'history.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = () => {
    const config = { history: { dbPath } };
    const resumable = openConversationSafe(config, {
      command: 'code',
      project: '/proj/a',
      model: 'm',
      threadId: 'thread-a',
    })!;
    recordSessionSafe(config, { conversationId: resumable, prompt: 'first', response: 'one' });
    recordSessionSafe(config, { conversationId: resumable, prompt: 'second', response: 'two' });
    // A single-shot run: a 1-turn conversation with no thread.
    recordSessionSafe(config, { command: 'ask', prompt: 'ask-only', response: 'r' });
    // A session that opened and exited without an exchange: a thread and zero turns.
    const empty = openConversationSafe(config, { command: 'chat', threadId: 'thread-empty' })!;
    return { config, resumable, empty };
  };

  it('lookupConversationSafe returns the row and its turns oldest-first, or null for an unknown id', () => {
    const { config, resumable, empty } = seed();
    const found = lookupConversationSafe(config, resumable)!;
    expect(found.summary.id).toBe(resumable);
    expect(found.summary.project).toBe('/proj/a');
    expect(found.summary.command).toBe('code');
    expect(found.summary.threadId).toBe('thread-a');
    expect(found.summary.turnCount).toBe(2);
    expect(found.turns.map((t) => t.prompt)).toEqual(['first', 'second']);
    // The empty one is FOUND (so it can be refused for its real reason), with no turns.
    expect(lookupConversationSafe(config, empty)!.turns).toEqual([]);
    expect(lookupConversationSafe(config, empty + 1000)).toBeNull();
    expect(lookupConversationSafe(config, 0)).toBeNull();
  });

  it('listResumableConversationsSafe offers only threaded conversations, newest first, minus the excluded one', () => {
    const { config, resumable } = seed();
    const second = openConversationSafe(config, { command: 'chat', threadId: 'thread-b' })!;
    recordSessionSafe(config, { conversationId: second, prompt: 'b1', response: 'r' });

    const all = listResumableConversationsSafe(config);
    // The single-shot `ask` (no thread) and the empty conversation (no turns) are not offered.
    expect(all.map((c) => c.id)).toEqual([second, resumable]);
    expect(all.every((c) => c.threadId !== undefined)).toBe(true);
    // The conversation the session is already in is left out.
    expect(listResumableConversationsSafe(config, { exclude: second }).map((c) => c.id)).toEqual([
      resumable,
    ]);
    expect(listResumableConversationsSafe(config, { limit: 1 }).map((c) => c.id)).toEqual([second]);
  });

  it('reads and writes the grants document against one conversation', () => {
    const { config, resumable, empty } = seed();
    expect(readConversationGrantsSafe(config, resumable)).toBeNull();
    expect(writeConversationGrantsSafe(config, resumable, '{"version":1}')).toBe(true);
    expect(readConversationGrantsSafe(config, resumable)).toBe('{"version":1}');
    // Written against THAT conversation only.
    expect(readConversationGrantsSafe(config, empty)).toBeNull();
    expect(writeConversationGrantsSafe(config, resumable, null)).toBe(true);
    expect(readConversationGrantsSafe(config, resumable)).toBeNull();
  });

  it('answers nothing, offers nothing and writes nothing when history.enabled is false', () => {
    const { resumable } = seed();
    const off = { history: { enabled: false, dbPath } };
    expect(lookupConversationSafe(off, resumable)).toBeNull();
    expect(listResumableConversationsSafe(off)).toEqual([]);
    expect(writeConversationGrantsSafe(off, resumable, '{"version":1}')).toBe(false);
    expect(readConversationGrantsSafe(off, resumable)).toBeNull();
    // The control: the same row, read with the switch on, is there and unchanged.
    expect(readConversationGrantsSafe({ history: { dbPath } }, resumable)).toBeNull();
    expect(lookupConversationSafe({ history: { dbPath } }, resumable)).not.toBeNull();
  });

  it('answers nothing when there is no store to open, and creates none', () => {
    const missing = { history: { dbPath: resolve(dir, 'never-created.db') } };
    expect(lookupConversationSafe(missing, 1)).toBeNull();
    expect(listResumableConversationsSafe(missing)).toEqual([]);
    expect(readConversationGrantsSafe(missing, 1)).toBeNull();
    expect(writeConversationGrantsSafe(missing, 1, '{}')).toBe(false);
    expect(existsSync(missing.history.dbPath)).toBe(false);
  });
});
