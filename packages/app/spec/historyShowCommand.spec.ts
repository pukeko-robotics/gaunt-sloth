/**
 * GS2-106 — `gth history show <id>` resolves the id through the shared parser and the store's
 * exact-match lookup. Either form resolves; a token that is not an id, an id that names no row, and
 * a run id minted by a DIFFERENT database are each refused with a warning naming what was typed, and
 * nothing is printed for a neighbouring row.
 *
 * Real store over temp files, passed with `--db`: this verb never reads the config, so without
 * `--db` it would open the real `~/.gsloth/history.db` — and this branch migrates any DB it opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Command } from 'commander';

const consoleMock = vi.hoisted(() => ({
  display: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleMock,
}));

describe('gth history show <id> — one parser, exact match (GS2-106)', () => {
  let dir: string;
  let dbPath: string;
  let otherDbPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-history-show-'));
    dbPath = resolve(dir, 'history.db');
    otherDbPath = resolve(dir, 'other.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `count` one-turn conversations in `path`, the n-th with prompt `<label> prompt n`. Returns each
   * row's integer id and run id, in order.
   */
  const seed = async (path: string, count: number, label: string) => {
    const { recordSessionTurnSafe } = await import('@gaunt-sloth/core/history/recordSession.js');
    const rows: { conversationId: number; runId: string }[] = [];
    for (let n = 1; n <= count; n++) {
      const r = recordSessionTurnSafe(
        { history: { dbPath: path } },
        { command: 'ask', prompt: `${label} prompt ${n}`, response: `${label} answer ${n}` }
      )!;
      rows.push({ conversationId: r.conversationId, runId: r.runId! });
    }
    return rows;
  };

  /** A fresh program per invocation — commander refuses to register `history` twice. */
  const show = async (id: string, db: string = dbPath) => {
    const { historyCommand } = await import('#src/commands/historyCommand.js');
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    historyCommand(program, {});
    await program.parseAsync(['node', 'gth', 'history', 'show', id, '--db', db]);
  };

  const printed = () => consoleMock.display.mock.calls.map(([line]) => String(line)).join('\n');
  const warnings = () => consoleMock.displayWarning.mock.calls.map(([line]) => String(line));

  it('resolves the integer form and prints that conversation', async () => {
    const rows = await seed(dbPath, 3, 'here');
    await show(String(rows[1].conversationId));
    expect(warnings()).toEqual([]);
    expect(consoleMock.displayInfo).toHaveBeenCalledWith(
      `Conversation #${rows[1].conversationId}:`
    );
    expect(printed()).toContain('here prompt 2');
    expect(printed()).not.toContain('here prompt 1');
  });

  it('resolves the run id form to the same conversation', async () => {
    const rows = await seed(dbPath, 3, 'here');
    await show(rows[2].runId);
    expect(warnings()).toEqual([]);
    expect(consoleMock.displayInfo).toHaveBeenCalledWith(
      `Conversation #${rows[2].conversationId}:`
    );
    expect(printed()).toContain('here prompt 3');
  });

  it('refuses `12abc` by name, and does not print conversation 12', async () => {
    // Row 12 exists, so a parser that read `12abc` as 12 would print it.
    const rows = await seed(dbPath, 12, 'here');
    expect(rows[11].conversationId).toBe(12);
    await show('12abc');
    expect(warnings()).toEqual(['Invalid conversation id "12abc".']);
    expect(consoleMock.display).not.toHaveBeenCalled();
    expect(consoleMock.displayInfo).not.toHaveBeenCalled();
  });

  it('refuses an unknown integer by name', async () => {
    await seed(dbPath, 2, 'here');
    await show('4242');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('No conversation #4242');
    expect(consoleMock.display).not.toHaveBeenCalled();
  });

  it('refuses an unknown run id by name', async () => {
    await seed(dbPath, 2, 'here');
    const unknown = '0f8fad5b-d9cb-469f-a165-70867728950e';
    await show(unknown);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(`No conversation ${unknown}`);
    expect(consoleMock.display).not.toHaveBeenCalled();
  });

  it('refuses a run id from a DIFFERENT database, even when this one has a row at the same integer', async () => {
    const [elsewhere] = await seed(otherDbPath, 1, 'elsewhere');
    const [here] = await seed(dbPath, 1, 'here');
    expect(here.conversationId).toBe(elsewhere.conversationId);
    await show(elsewhere.runId);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(`No conversation ${elsewhere.runId}`);
    expect(printed()).not.toContain('here prompt 1');
    // CONTROL — the same run id resolves in the database that minted it.
    vi.resetAllMocks();
    await show(elsewhere.runId, otherDbPath);
    expect(warnings()).toEqual([]);
    expect(printed()).toContain('elsewhere prompt 1');
  });

  it('a row written before run ids existed still resolves by its integer', async () => {
    // The pre-GS2-106 conversations table: no run_id column. The migration adds it on open, and
    // the row keeps run_id NULL — it is reachable by its integer only.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_ts TEXT NOT NULL,
        project TEXT,
        command TEXT,
        model TEXT,
        thread_id TEXT,
        grants TEXT
      );
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
        duration_ms INTEGER,
        conversation_id INTEGER
      );
      CREATE VIRTUAL TABLE sessions_fts USING fts5(prompt, response, command, project);
      INSERT INTO conversations (id, started_ts, command) VALUES (5, '2026-08-01T00:00:00.000Z', 'ask');
      INSERT INTO sessions (ts, command, prompt, response, conversation_id)
        VALUES ('2026-08-01T00:00:00.000Z', 'ask', 'legacy prompt', 'legacy answer', 5);
    `);
    legacy.close();

    await show('5');
    expect(warnings()).toEqual([]);
    expect(consoleMock.displayInfo).toHaveBeenCalledWith('Conversation #5:');
    expect(printed()).toContain('legacy prompt');

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare(`SELECT run_id FROM conversations WHERE id = 5`).get()).toEqual({
        run_id: null,
      });
    } finally {
      db.close();
    }
  });
});
