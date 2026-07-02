import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { recordSessionSafe } from '#src/history/recordSession.js';
import { openHistoryStore } from '#src/history/historyStore.js';

/**
 * GS2-7 (B20) — the opt-in bridge. These assertions are the guarantee that history changes NOTHING
 * about a default run: with history absent or disabled, recordSessionSafe writes nothing, creates
 * no DB, and returns null. With it enabled it records; and even then any DB problem fails soft.
 */
describe('history/recordSessionSafe', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-rec-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOTHING when history config is absent (default run)', () => {
    const dbPath = resolve(dir, 'history.db');
    const id = recordSessionSafe({}, { command: 'ask', prompt: 'q', response: 'a' });
    expect(id).toBeNull();
    expect(existsSync(dbPath)).toBe(false);
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

  it('records (and creates the DB) only when history.enabled is true', () => {
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
