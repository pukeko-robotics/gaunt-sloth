/**
 * @packageDocumentation
 * GS2-20 — a **durable LangGraph checkpointer** over the same local SQLite file the session
 * history store uses, so a past conversation can be resumed with the graph state it actually had.
 *
 * Resuming by replaying stored messages into a fresh agent rebuilds a transcript and discards
 * everything the LangGraph graph was holding — pending writes, a suspended interrupt, the channel
 * versions that make `add_messages` reconcile rather than append. What a resume has to produce is
 * that, from the agent's side, no interruption happened, and only a saver whose checkpoints outlive
 * the process can produce it.
 *
 * **Written against the built-in `node:sqlite`, deliberately.** Gaunt Sloth is installed globally
 * with `npm i -g`, and the history store (`historyStore.ts`) states the constraint this inherits:
 * zero native dependency, no build step. The published LangGraph SQLite savers are built on
 * `better-sqlite3`, a native module with a compile step, which would put a node-gyp build in the
 * path of every install of the CLI.
 *
 * **Storage layout.** Two tables of this module's own — `checkpoints` and `checkpoint_writes` —
 * created idempotently on open, in the same file as the store's `sessions` / `conversations`.
 * One file, one opt-out, one thing to delete. The store owns its tables and this owns these; there
 * is no shared DDL, so the store's per-call open (which re-runs its own migration every time)
 * cannot race this module's long-lived connection over the same schema.
 *
 * **Failure posture: degrade, loudly.** {@link openCheckpointSaver} is fail-soft — it returns `null`
 * rather than throwing when the DB cannot be opened or the tables cannot be created, which is what
 * lets the session fall back to a `MemorySaver` (see `openSessionCheckpointerSafe` in
 * `sessionCheckpointer.ts`). A write that fails AFTER that — a full disk, a filesystem that went
 * read-only under a live handle — is caught here and reported through
 * {@link CheckpointSaverOptions.onWriteFailure} instead of propagating.
 *
 * Neither of the two obvious postures is right, and the reason is worth keeping. **Swallowing**
 * would report a resumed session as empty and turn a suspended tool approval into a graph nobody
 * can resume — silent and wrong. **Throwing** propagates out of `agent.invoke()` into the session's
 * outer catch and ends the session, which since GS2-20 made history the default would mean a full
 * disk takes down the live session of a user who never asked for the feature; recording a
 * conversation must not become a new way to lose one. So the third posture: the write is dropped,
 * the turn continues, the user is told once, and the conversation is marked **unresumable on disk**
 * — that last part is what stops a silent drop from becoming a resume of a truncated conversation,
 * and it is why this differs from the history RECORDER, which merely swallows. A missing turn in a
 * listing is a gap; a half-restored graph presented as whole is a lie.
 *
 * Reads are still loud: nothing is degraded by a failed `getTuple`, and a resume that cannot read
 * must not pretend the thread was empty.
 */
import { DatabaseSync } from 'node:sqlite';
import { BaseCheckpointSaver, copyCheckpoint } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  collectCheckpointStoreStats,
  deleteThreads,
  reclaimUnresumableThreads,
  type CheckpointStoreStats,
  type ReclaimSummary,
} from '#src/history/checkpointRetention.js';

/**
 * The abstract members' own parameter types, read off the base class rather than imported.
 * `@langchain/langgraph` re-exports `BaseCheckpointSaver` (and `Checkpoint`, `CheckpointMetadata`,
 * `CheckpointTuple`) but not `ChannelVersions`, `CheckpointListOptions` or `PendingWrite`, which
 * live only in `@langchain/langgraph-checkpoint` — a package this one does not depend on. Deriving
 * them keeps the signatures exactly the base class's without adding a dependency whose second
 * physical copy could disagree with the one LangGraph itself loads. `put`'s fourth parameter is
 * derived inline at its signature for the same reason, kept out of this list so the alias does not
 * surface as an undocumented type in the rendered API reference.
 */
type ListOptions = NonNullable<Parameters<BaseCheckpointSaver['list']>[1]>;
type PendingWrites = Parameters<BaseCheckpointSaver['putWrites']>[1];
type PendingWritesOut = NonNullable<CheckpointTuple['pendingWrites']>;

/**
 * LangGraph's reserved channel names and the fixed NEGATIVE slot each takes in a task's writes.
 *
 * A saver's `putWrites` is insert-once for ordinary writes (a retried super-step must not duplicate
 * them) but replace-on-write for these four, which is why they need slots that cannot collide with
 * a positional index. `__interrupt__` and `__resume__` are the pair the tool-approval gate rides on,
 * so getting this wrong is not academic: a stale `__interrupt__` write kept beside a fresh one is a
 * suspended approval that resumes twice.
 *
 * Mirrors `WRITES_IDX_MAP` in `@langchain/langgraph-checkpoint`, which does not re-export through
 * `@langchain/langgraph`. Copied rather than depended on — see the note on the derived types above.
 * A reserved name added upstream and missed here degrades to a positional slot: that write becomes
 * insert-once instead of replace, which is visible only on a resume, so re-check this list when the
 * LangGraph major moves.
 */
const WRITES_IDX_MAP: Readonly<Record<string, number>> = Object.freeze({
  __error__: -1,
  __scheduled__: -2,
  __interrupt__: -3,
  __resume__: -4,
});

/**
 * How long a statement waits for another connection's lock before giving up. The history recorder
 * opens the same file for a moment at the end of every turn, so two writers on one file is the
 * ordinary case here, not the exceptional one; without this a routine overlap surfaces as a
 * `SQLITE_BUSY` that aborts a turn.
 */
const BUSY_TIMEOUT_MS = 5000;

/** The checkpoint id named by a config, using LangGraph's own precedence (`thread_ts` is legacy). */
function checkpointIdOf(config: RunnableConfig): string {
  const configurable = config.configurable as Record<string, unknown> | undefined;
  const id = configurable?.checkpoint_id ?? configurable?.thread_ts;
  return typeof id === 'string' ? id : '';
}

/** Read a `configurable` field as a string, or `undefined` when it is absent / not a string. */
function stringField(config: RunnableConfig, key: string): string | undefined {
  const value = (config.configurable as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** A stored checkpoint row, as the two tables shape it. */
interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
}

/**
 * Narrow one raw SQLite row to {@link CheckpointRow}. Written out rather than cast because
 * `node:sqlite` types every column as `SQLOutputValue`, so a blanket assertion would also hide a
 * genuine column/shape mismatch — including the BLOB columns, which are the ones a wrong value
 * would break silently inside the deserializer rather than here.
 */
function toCheckpointRow(row: Record<string, unknown>): CheckpointRow {
  return {
    thread_id: String(row.thread_id),
    checkpoint_ns: row.checkpoint_ns != null ? String(row.checkpoint_ns) : '',
    checkpoint_id: String(row.checkpoint_id),
    parent_checkpoint_id:
      row.parent_checkpoint_id != null ? String(row.parent_checkpoint_id) : null,
    type: row.type != null ? String(row.type) : null,
    checkpoint: row.checkpoint as Uint8Array,
    metadata: row.metadata as Uint8Array,
  };
}

/** Options for {@link openCheckpointSaver}. */
export interface CheckpointSaverOptions {
  /**
   * Called when a `put` / `putWrites` could not reach the database. The write is dropped and the
   * turn continues; the handler's job is to tell the user and to record that this conversation can
   * no longer be resumed. Called on EVERY failed write — the once-per-session rule belongs to the
   * handler, which is the layer that knows what a session is.
   */
  onWriteFailure?: (error: unknown) => void;
}

/**
 * A LangGraph `BaseCheckpointSaver` persisting to a `node:sqlite` database.
 *
 * Obtain one through {@link openCheckpointSaver}, which is fail-soft; the constructor is private so
 * there is no way to hold one whose tables were never created.
 */
export class GthSqliteSaver extends BaseCheckpointSaver {
  private db: DatabaseSync;

  private onWriteFailure: (error: unknown) => void;

  private constructor(db: DatabaseSync, onWriteFailure?: (error: unknown) => void) {
    super();
    this.db = db;
    this.onWriteFailure = onWriteFailure ?? (() => {});
  }

  /**
   * Report a dropped write, and never let the reporting itself become the failure. A handler that
   * throws here would land back inside `agent.invoke()` and end the turn — the exact outcome the
   * degrade posture exists to avoid, arriving from the code that implements it.
   */
  private reportWriteFailure(error: unknown): void {
    try {
      this.onWriteFailure(error);
    } catch {
      /* ignore */
    }
  }

  /**
   * Open (and lazily initialise) the checkpoint tables at `dbPath`. Returns `null` on any failure —
   * an unopenable, read-only or corrupt DB — so the caller can fall back to a `MemorySaver` without
   * a try/catch of its own.
   */
  static open(dbPath: string, options: CheckpointSaverOptions = {}): GthSqliteSaver | null {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath);
      // GS2-42's lesson applied here too: SQLite does not validate the file header until the first
      // statement runs, so a garbage file opens cleanly and fails on the DDL below. Everything from
      // the constructor to the last `exec` is therefore inside one try, and the handle is closed on
      // the way out — on win32 an unclosed handle blocks the file from being replaced or reopened
      // until the process exits.
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          thread_id TEXT NOT NULL,
          checkpoint_ns TEXT NOT NULL DEFAULT '',
          checkpoint_id TEXT NOT NULL,
          parent_checkpoint_id TEXT,
          type TEXT,
          checkpoint BLOB,
          metadata BLOB,
          PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
        );
        CREATE TABLE IF NOT EXISTS checkpoint_writes (
          thread_id TEXT NOT NULL,
          checkpoint_ns TEXT NOT NULL DEFAULT '',
          checkpoint_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          idx INTEGER NOT NULL,
          channel TEXT NOT NULL,
          type TEXT,
          value BLOB,
          PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
        );
      `);
      return new GthSqliteSaver(db, options.onWriteFailure);
    } catch {
      try {
        db?.close();
      } catch {
        /* ignore: the connection may already be in a broken state */
      }
      return null;
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

  /** Rebuild one stored row into the tuple LangGraph reads, pending writes and parent included. */
  private async toTuple(row: CheckpointRow, config: RunnableConfig): Promise<CheckpointTuple> {
    const type = row.type ?? 'json';
    const checkpoint = (await this.serde.loadsTyped(type, row.checkpoint)) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(type, row.metadata)) as CheckpointMetadata;
    const writeRows = this.db
      .prepare(
        `SELECT task_id, channel, type, value
           FROM checkpoint_writes
          WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
          ORDER BY task_id ASC, idx ASC`
      )
      .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as Record<string, unknown>[];
    const pendingWrites: PendingWritesOut = [];
    for (const w of writeRows) {
      pendingWrites.push([
        String(w.task_id),
        String(w.channel),
        await this.serde.loadsTyped(String(w.type ?? 'json'), w.value as Uint8Array),
      ]);
    }
    const tuple: CheckpointTuple = { config, checkpoint, metadata, pendingWrites };
    // The parent link is part of the interface, not optional decoration:
    // `BaseCheckpointSaver.getDeltaChannelHistory` reconstructs a DELTA channel by walking
    // `getTuple` → `parentConfig` up the ancestor chain, and a tuple without it terminates that walk
    // at the first checkpoint.
    //
    // **What that costs depends on the state schema, and on THIS graph it costs less than it looks.**
    // The agent's `messages` channel stores a full array in `channel_values`, not a delta, so every
    // checkpoint already carries the whole transcript and a broken walk cannot produce the
    // "transcript present, tool result missing" shape. Dropping the link here reddens the
    // parent-link test and nothing else — measured, not assumed. The reason to keep returning it is
    // the conditional one: a state schema that puts any channel behind a binary operator (a reducer
    // accumulating deltas, which `add_messages` is NOT under the current serialization) would
    // reconstruct that channel from the ancestor chain, and then a missing parent silently seeds it
    // empty. Correct now, and load-bearing the moment the schema changes.
    if (row.parent_checkpoint_id != null) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      };
    }
    return tuple;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = stringField(config, 'thread_id');
    if (threadId === undefined) return undefined;
    const checkpointNs = stringField(config, 'checkpoint_ns') ?? '';
    const checkpointId = checkpointIdOf(config);

    // Checkpoint ids are uuid6, which sort lexicographically in creation order, so "the latest
    // checkpoint on this thread" is a plain DESC on the id — the same ordering MemorySaver gets
    // from sorting its keys.
    const raw = (
      checkpointId
        ? this.db
            .prepare(
              `SELECT * FROM checkpoints
                WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
            )
            .get(threadId, checkpointNs, checkpointId)
        : this.db
            .prepare(
              `SELECT * FROM checkpoints
                WHERE thread_id = ? AND checkpoint_ns = ?
                ORDER BY checkpoint_id DESC
                LIMIT 1`
            )
            .get(threadId, checkpointNs)
    ) as Record<string, unknown> | undefined;
    if (raw === undefined) return undefined;
    const row = toCheckpointRow(raw);

    // When the caller named a checkpoint, echo their config back (they may carry other
    // `configurable` fields); when they asked for the latest, name the one we actually found.
    const tupleConfig: RunnableConfig = checkpointId
      ? config
      : {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: row.checkpoint_id,
          },
        };
    return this.toTuple(row, tupleConfig);
  }

  async *list(config: RunnableConfig, options?: ListOptions): AsyncGenerator<CheckpointTuple> {
    const { before, limit, filter } = options ?? {};
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const threadId = stringField(config, 'thread_id');
    if (threadId !== undefined) {
      clauses.push('thread_id = ?');
      params.push(threadId);
    }
    const checkpointNs = stringField(config, 'checkpoint_ns');
    if (checkpointNs !== undefined) {
      clauses.push('checkpoint_ns = ?');
      params.push(checkpointNs);
    }
    const checkpointId = checkpointIdOf(config);
    if (checkpointId) {
      clauses.push('checkpoint_id = ?');
      params.push(checkpointId);
    }
    const beforeId = before ? checkpointIdOf(before) : '';
    if (beforeId) {
      clauses.push('checkpoint_id < ?');
      params.push(beforeId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM checkpoints
         ${where}
         ORDER BY thread_id ASC, checkpoint_ns ASC, checkpoint_id DESC`
        )
        .all(...params) as Record<string, unknown>[]
    ).map(toCheckpointRow);

    // `limit` counts rows that SURVIVE `filter`, so it is applied here rather than as SQL LIMIT —
    // a metadata filter is evaluated on the deserialized object, which SQL cannot see.
    let remaining = limit;
    for (const row of rows) {
      if (remaining !== undefined && remaining <= 0) return;
      const tuple = await this.toTuple(row, {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      });
      if (filter) {
        const metadata = (tuple.metadata ?? {}) as Record<string, unknown>;
        if (!Object.entries(filter).every(([key, value]) => metadata[key] === value)) continue;
      }
      if (remaining !== undefined) remaining -= 1;
      yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Parameters<BaseCheckpointSaver['put']>[3]
  ): Promise<RunnableConfig> {
    const threadId = stringField(config, 'thread_id');
    if (threadId === undefined) {
      throw new Error(
        'Failed to put checkpoint: the RunnableConfig is missing a "thread_id" in its ' +
          '"configurable" property. A checkpointer needs a thread_id to know which conversation ' +
          'to persist state for.'
      );
    }
    const checkpointNs = stringField(config, 'checkpoint_ns') ?? '';
    try {
      const [checkpointType, serializedCheckpoint] = await this.serde.dumpsTyped(
        copyCheckpoint(checkpoint)
      );
      const [metadataType, serializedMetadata] = await this.serde.dumpsTyped(metadata);
      if (checkpointType !== metadataType) {
        throw new Error('Failed to serialize the checkpoint and its metadata to the same type.');
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          threadId,
          checkpointNs,
          checkpoint.id,
          checkpointIdOf(config) || null,
          checkpointType,
          serializedCheckpoint,
          serializedMetadata
        );
    } catch (error) {
      this.reportWriteFailure(error);
    }
    // Returned whether or not the row landed, and that is not an oversight. LangGraph takes this
    // config as the parent of the NEXT super-step, so a failure here leaves the next successful
    // write pointing at a `parent_checkpoint_id` that was never stored — a chain with a hole in it.
    // What makes that safe is the handler above, which marks the conversation unresumable on disk:
    // nothing will ever walk this chain again. Returning a config that names a checkpoint we did
    // not write is the lesser evil against throwing, which ends the user's session.
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrites, taskId: string): Promise<void> {
    const threadId = stringField(config, 'thread_id');
    if (threadId === undefined) {
      throw new Error(
        'Failed to put writes: the RunnableConfig is missing a "thread_id" in its ' +
          '"configurable" property.'
      );
    }
    const checkpointId = checkpointIdOf(config);
    if (!checkpointId) {
      throw new Error(
        'Failed to put writes: the RunnableConfig is missing a "checkpoint_id" in its ' +
          '"configurable" property.'
      );
    }
    const checkpointNs = stringField(config, 'checkpoint_ns') ?? '';
    try {
      // Two statements, chosen per write by the sign of its slot, because the two halves of the
      // contract differ: an ordinary write (idx >= 0) is insert-ONCE, so a retried super-step
      // writing the same slot again must leave the first value alone, while a reserved channel
      // ({@link WRITES_IDX_MAP}) is replace-on-write, so the newest error / interrupt / resume wins.
      // One blanket `INSERT OR REPLACE` would get the ordinary case wrong and one blanket
      // `INSERT OR IGNORE` the reserved one, and either divergence is visible only on a resume.
      const insertOnce = this.db.prepare(
        `INSERT OR IGNORE INTO checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const replace = this.db.prepare(
        `INSERT OR REPLACE INTO checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      // **Not wrapped in a transaction, deliberately.** A failure partway through this loop leaves
      // the earlier writes of the same task committed, which LangGraph tolerates: `putWrites` is
      // insert-once per (task, idx), so the retry that follows re-writes the same slots and the
      // survivors are ignored rather than duplicated. A transaction would buy atomicity across the
      // task's slots at the cost of holding a write lock across `dumpsTyped` — serialization, inside
      // the lock, on a file the history recorder also opens every turn. That is the trade to revisit
      // if a reserved-channel write ever has to land atomically with an ordinary one; today none
      // does. Under the degrade posture a torn task is doubly harmless: the conversation is marked
      // unresumable, so nothing will read these rows again.
      for (let position = 0; position < writes.length; position++) {
        const [channel, value] = writes[position];
        // `Object.hasOwn`, not a plain index, because a channel name is arbitrary text arriving
        // from the graph: `WRITES_IDX_MAP['constructor']` resolves up the PROTOTYPE CHAIN to
        // `Object`, and `toString` / `valueOf` likewise, so a plain read would hand `idx` a function
        // and take the reserved-vs-positional branch on it. `Object.freeze` does not help — it seals
        // the own properties and leaves the prototype reachable. Upstream's `WRITES_IDX_MAP` has the
        // same shape; that is a reason to keep the mirror, not to keep the defect.
        const reserved = Object.hasOwn(WRITES_IDX_MAP, channel)
          ? WRITES_IDX_MAP[channel]
          : undefined;
        const idx = reserved ?? position;
        const [type, serialized] = await this.serde.dumpsTyped(value);
        const statement = idx < 0 ? replace : insertOnce;
        statement.run(
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          idx,
          channel,
          type,
          serialized as Uint8Array
        );
      }
    } catch (error) {
      this.reportWriteFailure(error);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    deleteThreads(this.db, [threadId]);
  }

  /**
   * GS2-107 — delete every thread no conversation row names, past the grace window. The retention
   * module owns the policy and the reasoning; this is the saver's own connection lent to it, so a
   * session that already has the store open can reclaim without opening it again.
   */
  reclaimUnresumableThreads(
    options: { now?: number; graceMs?: number; excludeThreadIds?: readonly string[] } = {}
  ): ReclaimSummary {
    return reclaimUnresumableThreads(this.db, options);
  }

  /** GS2-107 — what the checkpoint tables hold, over this saver's open connection. */
  storeStats(dbPath: string, topN?: number): CheckpointStoreStats {
    return collectCheckpointStoreStats(this.db, dbPath, topN);
  }
}

/**
 * Fail-soft open of the durable checkpoint saver. Returns `null` (never throws) when the DB cannot
 * be opened or its tables cannot be created.
 */
export function openCheckpointSaver(
  dbPath: string,
  options: CheckpointSaverOptions = {}
): GthSqliteSaver | null {
  return GthSqliteSaver.open(dbPath, options);
}
