/**
 * @packageDocumentation
 * GS2-7 (B20) — local, opt-in session history store.
 *
 * A **local SQLite** store that persists a compact record of each run BESIDE the existing
 * per-run `.md` logs, so `gth history search` / `gth insights` can look back over past sessions.
 * It is a **side-benefit, never a critical path**:
 *
 * - **Local only.** Nothing leaves the machine. The DB lives under the user's global `~/.gsloth`
 *   dir (cross-project history), overridable via `history.dbPath`.
 * - **Opt-in.** The recorder only writes when `history.enabled` is true (see
 *   {@link recordSessionSafe}); default runs persist nothing and behave exactly as before.
 * - **Fail-soft.** {@link openHistoryStore} returns `null` if the DB can't be opened, and every
 *   {@link HistoryStore} method catches its own errors and returns a safe default. A malformed or
 *   locked DB therefore can never abort or alter a run — it just means no history for that run.
 *
 * Uses the built-in `node:sqlite` (Node ≥ 24) — zero native dependency, no build step — and its
 * bundled **FTS5** extension for full-text search (verified available at build time via an
 * `fts5` virtual table). No fallback path is needed on this runtime.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getGlobalGslothDir, ensureGlobalGslothDir } from '#src/utils/globalConfigUtils.js';

/** Filename of the global history DB inside `~/.gsloth`. */
export const HISTORY_DB_FILENAME = 'history.db';

/** A single persisted session record (all analytics fields optional; populated when available). */
export interface SessionRecord {
  /** ISO-8601 timestamp; defaults to now when omitted. */
  ts?: string;
  /** Project / working directory the run happened in. */
  project?: string;
  /** Originating command (ask/chat/code/exec/…). */
  command?: string;
  /** Human-readable model/provider label. */
  model?: string;
  /** The user prompt / source that started the run (full-text indexed). */
  prompt?: string;
  /** The final assistant response text (full-text indexed). */
  response?: string;
  /** Prompt/input token count, when known. */
  tokensInput?: number;
  /** Completion/output token count, when known. */
  tokensOutput?: number;
  /** Estimated cost in USD, when known. */
  costUsd?: number;
  /** Names of tools invoked during the run, when known. */
  tools?: string[];
  /** Wall-clock duration of the run in milliseconds, when known. */
  durationMs?: number;
}

/** A search hit: the stored record plus its id and a highlighted snippet. */
export interface SessionSearchResult extends SessionRecord {
  id: number;
  ts: string;
  /** FTS5 snippet around the match (may be empty). */
  snippet: string;
}

/** Aggregate analytics over the whole store (local only). */
export interface HistoryInsights {
  sessionCount: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalTokens: number;
  totalCostUsd: number;
  /** Tool-name → invocation count, most-used first. */
  topTools: { tool: string; count: number }[];
  /** Command → run count, most-used first. */
  perCommand: { command: string; count: number }[];
  firstTs?: string;
  lastTs?: string;
}

/** Options for opening a store. */
export interface OpenHistoryStoreOptions {
  /**
   * When false (the default for read-only callers), a missing DB file yields `null` instead of
   * creating an empty database. Read commands pass `create: false` so `gth insights` never
   * materialises a DB as a side effect; the recorder passes `create: true`.
   */
  create?: boolean;
}

/** Escape a value for use inside an FTS5 double-quoted string token. */
function ftsQuote(term: string): string {
  return '"' + term.replace(/"/g, '""') + '"';
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression: each whitespace-separated token is
 * wrapped as a quoted string and AND-ed together. This avoids FTS5 syntax errors from stray
 * operators (`AND`, `*`, `:`, parentheses, unbalanced quotes) in a user's query while still
 * matching all of their words.
 */
export function toFtsMatchQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map(ftsQuote).join(' AND ');
}

/**
 * A thin, fail-soft wrapper over a `node:sqlite` connection holding the session history.
 *
 * Obtain one via {@link openHistoryStore} (which returns `null` if the DB can't be opened). Every
 * method is defensive: on any SQLite error it returns a safe empty/zero result rather than
 * throwing, so callers on a run's hot path never have to guard.
 */
export class HistoryStore {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Open (and lazily initialise) the store at `dbPath`. Returns `null` on any failure — a missing
   * file when `create` is false, an unopenable/locked/corrupt DB, or a schema-init error — so the
   * caller can simply skip history without a try/catch.
   */
  static open(dbPath: string, options: OpenHistoryStoreOptions = {}): HistoryStore | null {
    const create = options.create ?? false;
    if (!create && dbPath !== ':memory:' && !existsSync(dbPath)) {
      return null;
    }
    try {
      const db = new DatabaseSync(dbPath);
      const store = new HistoryStore(db);
      store.initSchema();
      return store;
    } catch {
      return null;
    }
  }

  private initSchema(): void {
    this.db.exec(`
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
        duration_ms INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        prompt, response, command, project
      );
    `);
  }

  /**
   * Persist one session and its full-text index entry. Returns the new row id, or `null` on any
   * error (the run continues regardless). The two inserts run in a transaction so a failure can't
   * leave the FTS index out of sync with the base table.
   */
  record(rec: SessionRecord): number | null {
    try {
      const ts = rec.ts ?? new Date().toISOString();
      const tools = rec.tools && rec.tools.length > 0 ? JSON.stringify(rec.tools) : null;
      this.db.exec('BEGIN');
      try {
        const insert = this.db.prepare(
          `INSERT INTO sessions
             (ts, project, command, model, prompt, response,
              tokens_input, tokens_output, cost_usd, tools, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const info = insert.run(
          ts,
          rec.project ?? null,
          rec.command ?? null,
          rec.model ?? null,
          rec.prompt ?? null,
          rec.response ?? null,
          rec.tokensInput ?? null,
          rec.tokensOutput ?? null,
          rec.costUsd ?? null,
          tools,
          rec.durationMs ?? null
        );
        const id = Number(info.lastInsertRowid);
        this.db
          .prepare(
            `INSERT INTO sessions_fts (rowid, prompt, response, command, project)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(id, rec.prompt ?? '', rec.response ?? '', rec.command ?? '', rec.project ?? '');
        this.db.exec('COMMIT');
        return id;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    } catch {
      return null;
    }
  }

  /**
   * Full-text search over prompt/response/command/project, best match first (FTS5 `rank`). User
   * text is sanitised via {@link toFtsMatchQuery}; an empty or all-punctuation query returns `[]`.
   * Any SQLite error yields `[]` (fail-soft).
   */
  search(query: string, limit = 20): SessionSearchResult[] {
    const match = toFtsMatchQuery(query);
    if (!match) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT s.id AS id, s.ts AS ts, s.project AS project, s.command AS command,
                  s.model AS model, s.prompt AS prompt, s.response AS response,
                  s.tokens_input AS tokens_input, s.tokens_output AS tokens_output,
                  s.cost_usd AS cost_usd, s.tools AS tools, s.duration_ms AS duration_ms,
                  snippet(sessions_fts, 0, '[', ']', '…', 12) AS snippet
             FROM sessions_fts f
             JOIN sessions s ON s.id = f.rowid
            WHERE sessions_fts MATCH ?
            ORDER BY rank
            LIMIT ?`
        )
        .all(match, limit) as Record<string, unknown>[];
      return rows.map((r) => ({
        ...rowToRecord(r),
        id: Number(r.id),
        ts: String(r.ts),
        snippet: String(r.snippet ?? ''),
      }));
    } catch {
      return [];
    }
  }

  /** Most recent sessions, newest first. Fail-soft ([] on error). */
  listRecent(limit = 20): SessionSearchResult[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, ts, project, command, model, prompt, response,
                  tokens_input, tokens_output, cost_usd, tools, duration_ms
             FROM sessions
            ORDER BY id DESC
            LIMIT ?`
        )
        .all(limit) as Record<string, unknown>[];
      return rows.map((r) => ({
        ...rowToRecord(r),
        id: Number(r.id),
        ts: String(r.ts),
        snippet: '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Aggregate token/cost totals, a top-tool tally, and a per-command breakdown over the whole
   * store. Tool tallying reads each row's JSON `tools` array in JS (robust to nulls). Fail-soft:
   * returns a zeroed summary on any error.
   */
  insights(topN = 10): HistoryInsights {
    const empty: HistoryInsights = {
      sessionCount: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      topTools: [],
      perCommand: [],
    };
    try {
      const agg = this.db
        .prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(tokens_input), 0) AS ti,
                  COALESCE(SUM(tokens_output), 0) AS to_,
                  COALESCE(SUM(cost_usd), 0) AS cost,
                  MIN(ts) AS first_ts,
                  MAX(ts) AS last_ts
             FROM sessions`
        )
        .get() as Record<string, unknown>;

      const perCommandRows = this.db
        .prepare(
          `SELECT command, COUNT(*) AS n
             FROM sessions
            WHERE command IS NOT NULL AND command <> ''
            GROUP BY command
            ORDER BY n DESC, command ASC`
        )
        .all() as Record<string, unknown>[];

      const toolRows = this.db
        .prepare(`SELECT tools FROM sessions WHERE tools IS NOT NULL AND tools <> ''`)
        .all() as Record<string, unknown>[];

      const toolCounts = new Map<string, number>();
      for (const row of toolRows) {
        let names: unknown;
        try {
          names = JSON.parse(String(row.tools));
        } catch {
          continue;
        }
        if (!Array.isArray(names)) continue;
        for (const name of names) {
          if (typeof name !== 'string' || name.length === 0) continue;
          toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        }
      }
      const topTools = [...toolCounts.entries()]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
        .slice(0, topN);

      const ti = Number(agg.ti ?? 0);
      const to = Number(agg.to_ ?? 0);
      return {
        sessionCount: Number(agg.n ?? 0),
        totalTokensInput: ti,
        totalTokensOutput: to,
        totalTokens: ti + to,
        totalCostUsd: Number(agg.cost ?? 0),
        topTools,
        perCommand: perCommandRows.map((r) => ({
          command: String(r.command),
          count: Number(r.n),
        })),
        firstTs: agg.first_ts ? String(agg.first_ts) : undefined,
        lastTs: agg.last_ts ? String(agg.last_ts) : undefined,
      };
    } catch {
      return empty;
    }
  }

  /** Close the underlying connection (fail-soft). */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Map a raw DB row (snake_case columns) to a {@link SessionRecord}. */
function rowToRecord(r: Record<string, unknown>): SessionRecord {
  let tools: string[] | undefined;
  if (r.tools != null && r.tools !== '') {
    try {
      const parsed = JSON.parse(String(r.tools));
      if (Array.isArray(parsed)) tools = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      /* ignore malformed tools JSON */
    }
  }
  return {
    ts: r.ts != null ? String(r.ts) : undefined,
    project: r.project != null ? String(r.project) : undefined,
    command: r.command != null ? String(r.command) : undefined,
    model: r.model != null ? String(r.model) : undefined,
    prompt: r.prompt != null ? String(r.prompt) : undefined,
    response: r.response != null ? String(r.response) : undefined,
    tokensInput: r.tokens_input != null ? Number(r.tokens_input) : undefined,
    tokensOutput: r.tokens_output != null ? Number(r.tokens_output) : undefined,
    costUsd: r.cost_usd != null ? Number(r.cost_usd) : undefined,
    tools,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
  };
}

/**
 * Resolve the on-disk path of the history DB. Honors an explicit `dbPath` (from `history.dbPath`
 * or a `--db` flag); otherwise the global `~/.gsloth/history.db`. When `dbPath` is omitted and
 * `ensureDir` is true, the global dir is created so the recorder can write.
 */
export function resolveHistoryDbPath(dbPath?: string, ensureDir = false): string {
  if (dbPath && dbPath.trim().length > 0) return dbPath;
  const dir = ensureDir ? ensureGlobalGslothDir() : getGlobalGslothDir();
  return resolve(dir, HISTORY_DB_FILENAME);
}

/**
 * Fail-soft open of the history store. Returns `null` (never throws) when the DB can't be opened
 * or, for read-only callers (`create: false`, the default), when the file does not yet exist.
 */
export function openHistoryStore(
  dbPath: string,
  options: OpenHistoryStoreOptions = {}
): HistoryStore | null {
  return HistoryStore.open(dbPath, options);
}
