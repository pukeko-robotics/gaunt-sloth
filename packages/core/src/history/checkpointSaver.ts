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
 * conversation must not become a new way to lose one. So the third posture: the write is lost to
 * the DISK and to nothing else, the user is told once, and the conversation is marked
 * **unresumable on disk** — that last part is what stops a lost write from becoming a resume of a
 * truncated conversation, and it is why this differs from the history RECORDER, which merely
 * swallows. A missing turn in a listing is a gap; a half-restored graph presented as whole is a lie.
 *
 * **What keeps the RUN whole is the in-memory copy** (see {@link CheckpointMirror}). The graph reads
 * the saver back inside a turn, at every approval-gated tool call: `getState` finds the pending
 * interrupt and a new `Command({ resume })` invocation starts from `getTuple`. A write that reached
 * neither the disk nor anything else would hand those reads a stale step, and the gated tool would
 * never run. So every write also lands in memory, reads go there first, and on the first failed
 * write the saver stops writing to the database and carries on from memory for the rest of the
 * process.
 *
 * Reads that reach SQLite are still loud: nothing is degraded by a failed `getTuple`, and a resume
 * that cannot read must not pretend the thread was empty.
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

/** One stored pending write, as `checkpoint_writes` shapes it and as memory holds it. */
interface WriteRow {
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: Uint8Array;
}

/** Narrow one raw SQLite write row to {@link WriteRow}; see {@link toCheckpointRow} for why. */
function toWriteRow(row: Record<string, unknown>): WriteRow {
  return {
    task_id: String(row.task_id),
    idx: Number(row.idx),
    channel: String(row.channel),
    type: row.type != null ? String(row.type) : 'json',
    value: row.value as Uint8Array,
  };
}

/**
 * The serializer's output as bytes this module owns. `dumpsTyped` hands a `Uint8Array` value back
 * as itself (type `bytes`), so without a copy memory would hold the caller's live object, and a
 * later mutation of it would change what a read returns.
 */
function ownedBytes(type: string, serialized: unknown): Uint8Array {
  const bytes = serialized as Uint8Array;
  return type === 'bytes' ? new Uint8Array(bytes) : bytes;
}

/**
 * GS2-117 — the latest checkpoint of each (thread, namespace), with that checkpoint's pending
 * writes, held in memory. It is what the running graph reads, so a write the disk refused never
 * changes what the graph sees.
 *
 * **Why it exists.** The graph reads its own state back from the saver at every approval-gated
 * tool call, which at default config is every tool call that is not a built-in read: `getState`
 * finds the `__interrupt__` write, then a `Command({ resume })` invocation starts from `getTuple`.
 * A checkpoint or an `__interrupt__` write that never landed makes both reads stale, so the tool
 * never runs and the turn dies, and every later turn restarts from the last write that did land.
 * Reading memory first makes the durable store irrelevant to the running graph.
 *
 * **Only the latest checkpoint per (thread, namespace).** Every read the graph makes in a run is a
 * latest read (no `checkpoint_id`); an older, named read misses here and goes to SQLite. One tool
 * turn writes a dozen or more checkpoints, each carrying the whole transcript, so keeping the
 * chain would hold in process memory what the checkpoint tables hold on disk.
 *
 * **Pruned by checkpoint-id order, never by arrival order.** LangGraph chains each `put` behind the
 * previous one but dispatches `putWrites` immediately, so the writes for a checkpoint can arrive
 * before the checkpoint does. Ids are uuid6 and sort in creation order, so a new latest drops only
 * the writes of STRICTLY older ids, a write for a newer id waits for its checkpoint, and a `put` of
 * an id older than the latest does not displace it. Pruning by arrival would throw away exactly the
 * `__interrupt__` write the next read has to find — the defect this exists to prevent, with nothing
 * failing.
 *
 * **Bytes, never live objects.** LangGraph mutates messages in place after handing them over (the
 * reducer stamps ids), so a reference kept here would return those later mutations on the next
 * read. It holds the exact bytes the durable path serialized, which also makes a read from here
 * identical to a read of the row on disk.
 *
 * The write-slot rule is the table's: insert-once for an ordinary write, replace-on-write for a
 * reserved channel ({@link WRITES_IDX_MAP}). `Map`s rather than plain objects, so a thread id or a
 * channel name cannot reach an `Object` prototype member.
 *
 * Deliberately not `MemorySaver`: it serializes again at its own call time, which is later than the
 * durable path and so after the in-place mutation above; it reads every value back as `json`
 * whatever type it was written as; it indexes `WRITES_IDX_MAP` with a plain lookup that walks the
 * prototype chain; and it returns pending writes in arrival order rather than in the
 * `task_id, idx` order SQLite answers in, which on a healthy session would change what the graph
 * reads.
 */
class CheckpointMirror {
  private readonly lanes = new Map<
    string,
    { threadId: string; latest?: CheckpointRow; writes: Map<string, Map<string, WriteRow>> }
  >();

  private lane(threadId: string, checkpointNs: string) {
    const key = JSON.stringify([threadId, checkpointNs]);
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { threadId, writes: new Map() };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /** Hold `row` as the latest checkpoint of its lane, unless the lane already holds a newer one. */
  put(row: CheckpointRow): void {
    const lane = this.lane(row.thread_id, row.checkpoint_ns);
    if (lane.latest && row.checkpoint_id < lane.latest.checkpoint_id) return;
    lane.latest = row;
    for (const checkpointId of [...lane.writes.keys()]) {
      if (checkpointId < row.checkpoint_id) lane.writes.delete(checkpointId);
    }
  }

  /**
   * Hold one pending write for `checkpointId`. `mode` is the slot rule: `slot` applies the table's
   * insert-once / replace-reserved rule; `seed` never overwrites, because a seed comes from disk and
   * whatever memory already holds is at least as new.
   */
  putWrite(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
    write: WriteRow,
    mode: 'slot' | 'seed'
  ): void {
    const lane = this.lane(threadId, checkpointNs);
    if (lane.latest && checkpointId < lane.latest.checkpoint_id) return;
    let slots = lane.writes.get(checkpointId);
    if (!slots) {
      slots = new Map();
      lane.writes.set(checkpointId, slots);
    }
    const slot = `${write.task_id}\u0000${write.idx}`;
    const replace = mode === 'slot' && write.idx < 0;
    if (!replace && slots.has(slot)) return;
    slots.set(slot, write);
  }

  /** The lane's latest checkpoint and its writes in `task_id, idx` order, or `undefined`. */
  latest(
    threadId: string,
    checkpointNs: string
  ): { row: CheckpointRow; writes: WriteRow[] } | undefined {
    const lane = this.lanes.get(JSON.stringify([threadId, checkpointNs]));
    if (!lane?.latest) return undefined;
    const writes = [...(lane.writes.get(lane.latest.checkpoint_id)?.values() ?? [])].sort((a, b) =>
      a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : a.idx - b.idx
    );
    return { row: lane.latest, writes };
  }

  deleteThread(threadId: string): void {
    for (const [key, lane] of this.lanes) {
      if (lane.threadId === threadId) this.lanes.delete(key);
    }
  }

  clear(): void {
    this.lanes.clear();
  }

  /** How many checkpoints are held, across every lane. */
  checkpointCount(): number {
    let count = 0;
    for (const lane of this.lanes.values()) if (lane.latest) count += 1;
    return count;
  }
}

/** Options for {@link openCheckpointSaver}. */
export interface CheckpointSaverOptions {
  /**
   * Called when a `put` / `putWrites` could not reach the database. The handler's job is to tell
   * the user and to record that this conversation can no longer be resumed. Called ONCE, on the
   * first failed write: from then on the saver writes nothing to the database and the session runs
   * from memory, so there is no later failure to report.
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

  /**
   * GS2-107 — every thread this saver has written to, which is what automatic reclamation excludes.
   *
   * The thread a session writes to is not fixed at open: `clearConversation()` mints a fresh one on
   * `/clear`, `resetThread()` does the same before every turn on the conversational surfaces, and
   * `resumeConversation` rebinds onto a stored one — none of them tells this object. An
   * exclusion built from the id the session started with therefore names a thread nobody is writing
   * and misses the one that is — which on the `/clear` path is a thread no conversation row names,
   * i.e. exactly a reclamation candidate. Recording the ids as they arrive needs no notification at
   * all: whatever the runner rotated onto, the write came through here.
   *
   * GS2-117 — it also holds every thread {@link mirror} holds: a thread written after the cut (the
   * write reaches memory only) and a thread seeded into memory by a read. Protecting a thread is
   * the safe direction; reclaiming one this session still reads would pull its rows out from under
   * a later named read.
   */
  private readonly writtenThreads = new Set<string>();

  /** GS2-117 — what the running graph reads. See {@link CheckpointMirror}. */
  private readonly mirror = new CheckpointMirror();

  /**
   * GS2-117 — set on the first failed durable write. From then on `put` and `putWrites` skip the
   * SQL and write memory only: every later write would fail the same way on a full or read-only
   * disk, and one that happened to land would extend a chain the handler has just marked
   * unresumable.
   */
  private cut = false;

  private constructor(db: DatabaseSync, onWriteFailure?: (error: unknown) => void) {
    super();
    this.db = db;
    this.onWriteFailure = onWriteFailure ?? (() => {});
  }

  /**
   * Stop writing to the database and report why, once. The reporting must never become the
   * failure itself: a handler that throws here would land back inside `agent.invoke()` and end the
   * turn — the exact outcome the degrade posture exists to avoid, arriving from the code that
   * implements it.
   */
  private cutDurableWrites(error: unknown): void {
    if (this.cut) return;
    this.cut = true;
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

  /**
   * Close the underlying connection (fail-soft), and drop the in-memory copy with it, so a closed
   * saver answers no read from memory that it could not answer from disk.
   */
  close(): void {
    this.mirror.clear();
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /** The pending writes stored on disk for one checkpoint, in the order a tuple lists them. */
  private readWriteRows(row: CheckpointRow): WriteRow[] {
    return (
      this.db
        .prepare(
          `SELECT task_id, idx, channel, type, value
             FROM checkpoint_writes
            WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
            ORDER BY task_id ASC, idx ASC`
        )
        .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as Record<string, unknown>[]
    ).map(toWriteRow);
  }

  /**
   * Rebuild one stored checkpoint into the tuple LangGraph reads, pending writes and parent
   * included. Both sources — SQLite and memory — go through here, so a tuple read from memory
   * cannot differ in shape from the same checkpoint read from disk.
   */
  private async toTuple(
    row: CheckpointRow,
    writeRows: readonly WriteRow[],
    config: RunnableConfig
  ): Promise<CheckpointTuple> {
    const type = row.type ?? 'json';
    const checkpoint = (await this.serde.loadsTyped(type, row.checkpoint)) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(type, row.metadata)) as CheckpointMetadata;
    const pendingWrites: PendingWritesOut = [];
    for (const w of writeRows) {
      pendingWrites.push([w.task_id, w.channel, await this.serde.loadsTyped(w.type, w.value)]);
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

    // GS2-117 — memory first: it holds what this process wrote, including what the disk refused.
    // A named read answers from memory only when it names the checkpoint memory holds.
    const held = this.mirror.latest(threadId, checkpointNs);
    if (held && (!checkpointId || checkpointId === held.row.checkpoint_id)) {
      return this.toTuple(held.row, held.writes, this.tupleConfig(config, held.row));
    }

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
    const writeRows = this.readWriteRows(row);

    // Seed memory from a LATEST read only — a resumed thread's first read, or a `/resume` peek — so
    // the next read of this thread sees what this process writes on top of it even if the disk
    // stops taking writes. Never from a named read: an older checkpoint seeded here would become
    // memory's latest and hide everything after it. The thread joins `writtenThreads` because
    // memory now holds it.
    if (!checkpointId) {
      this.mirror.put(row);
      for (const write of writeRows) {
        this.mirror.putWrite(threadId, checkpointNs, row.checkpoint_id, write, 'seed');
      }
      this.writtenThreads.add(threadId);
    }
    return this.toTuple(row, writeRows, this.tupleConfig(config, row));
  }

  /**
   * When the caller named a checkpoint, echo their config back (they may carry other
   * `configurable` fields); when they asked for the latest, name the one actually found.
   */
  private tupleConfig(config: RunnableConfig, row: CheckpointRow): RunnableConfig {
    return checkpointIdOf(config)
      ? config
      : {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        };
  }

  /**
   * History, read from SQLite only. Nothing in this repo lists a thread's checkpoints
   * (`getStateHistory` is never called), and memory holds only each thread's latest checkpoint, so
   * after a cut this omits what reached memory alone.
   */
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
      const tuple = await this.toTuple(row, this.readWriteRows(row), {
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
    // Recorded BEFORE the write is attempted, and kept even when it fails. A thread whose write was
    // dropped is one the degrade path has just marked unresumable, and a live session is still
    // sitting on it; excluding it costs a delete that the next process's pass will make anyway.
    this.writtenThreads.add(threadId);
    const checkpointNs = stringField(config, 'checkpoint_ns') ?? '';
    // GS2-117 — **the durable path first, and nothing awaited ahead of it.** The checkpoint is
    // serialized synchronously inside this call, before its first `await`, exactly as it was before
    // memory existed; memory is then handed the SAME bytes. LangGraph does not wait for a saver
    // write before it goes on mutating the objects it handed over (the messages reducer stamps ids
    // onto them in place), so any `await` placed ahead of this serialization — updating memory
    // first, say — would move it past those mutations and change what reaches the disk. That was
    // measured: memory first put an `id` onto the stored input `HumanMessage` write.
    let stored: CheckpointRow | undefined;
    try {
      const [checkpointType, serializedCheckpoint] = await this.serde.dumpsTyped(
        copyCheckpoint(checkpoint)
      );
      const [metadataType, serializedMetadata] = await this.serde.dumpsTyped(metadata);
      if (checkpointType !== metadataType) {
        throw new Error('Failed to serialize the checkpoint and its metadata to the same type.');
      }
      stored = {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
        parent_checkpoint_id: checkpointIdOf(config) || null,
        type: checkpointType,
        checkpoint: ownedBytes(checkpointType, serializedCheckpoint),
        metadata: ownedBytes(metadataType, serializedMetadata),
      };
      if (!this.cut) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO checkpoints
             (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            stored.thread_id,
            stored.checkpoint_ns,
            stored.checkpoint_id,
            stored.parent_checkpoint_id,
            stored.type,
            stored.checkpoint,
            stored.metadata
          );
      }
    } catch (error) {
      this.cutDurableWrites(error);
    }
    // Memory takes the checkpoint whether or not the row landed: that is what keeps a refused write
    // from changing what the graph reads next.
    if (stored) this.mirror.put(stored);
    // Returned whether or not the row landed, and that is not an oversight. LangGraph takes this
    // config as the parent of the NEXT super-step. The running graph reads the checkpoint from
    // memory, so for the run the chain is whole; on disk it has a hole from the first failure on,
    // and what makes that safe is the handler, which marks the conversation unresumable: nothing
    // will ever walk the disk chain again.
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
    this.writtenThreads.add(threadId);
    const checkpointNs = stringField(config, 'checkpoint_ns') ?? '';
    // GS2-117 — the same order as `put`, for the same reason: the first write is serialized
    // synchronously inside this call, exactly as before memory existed, and memory is handed the
    // bytes afterwards. LangGraph dispatches this call without awaiting it and then mutates the
    // message objects it passed, so nothing may be awaited ahead of the serialization below.
    //
    // Two statements, chosen per write by the sign of its slot, because the two halves of the
    // contract differ: an ordinary write (idx >= 0) is insert-ONCE, so a retried super-step writing
    // the same slot again must leave the first value alone, while a reserved channel
    // ({@link WRITES_IDX_MAP}) is replace-on-write, so the newest error / interrupt / resume wins.
    // One blanket `INSERT OR REPLACE` would get the ordinary case wrong and one blanket
    // `INSERT OR IGNORE` the reserved one, and either divergence is visible only on a resume.
    type Statement = ReturnType<DatabaseSync['prepare']>;
    let insertOnce: Statement | undefined;
    let replace: Statement | undefined;
    if (!this.cut) {
      try {
        insertOnce = this.db.prepare(
          `INSERT OR IGNORE INTO checkpoint_writes
           (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        replace = this.db.prepare(
          `INSERT OR REPLACE INTO checkpoint_writes
           (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
      } catch (error) {
        this.cutDurableWrites(error);
      }
    }
    // **Not wrapped in a transaction, deliberately.** A failure partway through this loop leaves the
    // earlier writes of the same task committed. A transaction would buy atomicity across the task's
    // slots at the cost of holding a write lock across `dumpsTyped` — serialization, inside the
    // lock, on a file the history recorder also opens every turn. That is the trade to revisit if a
    // reserved-channel write ever has to land atomically with an ordinary one; today none does. A
    // torn task is harmless under the degrade posture: the failure cuts durable writes and marks the
    // conversation unresumable, so nothing reads these rows again, and the loop carries on for
    // memory, which receives every write of the call — the `__interrupt__` one included.
    const held: WriteRow[] = [];
    for (let position = 0; position < writes.length; position++) {
      const [channel, value] = writes[position];
      // `Object.hasOwn`, not a plain index, because a channel name is arbitrary text arriving
      // from the graph: `WRITES_IDX_MAP['constructor']` resolves up the PROTOTYPE CHAIN to
      // `Object`, and `toString` / `valueOf` likewise, so a plain read would hand `idx` a function
      // and take the reserved-vs-positional branch on it. `Object.freeze` does not help — it seals
      // the own properties and leaves the prototype reachable. Upstream's `WRITES_IDX_MAP` has the
      // same shape; that is a reason to keep this copy of the map, not to keep the defect.
      const reserved = Object.hasOwn(WRITES_IDX_MAP, channel) ? WRITES_IDX_MAP[channel] : undefined;
      const idx = reserved ?? position;
      let write: WriteRow;
      try {
        const [type, serialized] = await this.serde.dumpsTyped(value);
        write = {
          task_id: taskId,
          idx,
          channel,
          type,
          value: ownedBytes(type, serialized),
        };
      } catch (error) {
        this.cutDurableWrites(error);
        continue;
      }
      held.push(write);
      if (this.cut || !insertOnce || !replace) continue;
      try {
        (idx < 0 ? replace : insertOnce).run(
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          idx,
          channel,
          write.type,
          write.value
        );
      } catch (error) {
        this.cutDurableWrites(error);
      }
    }
    for (const write of held) {
      this.mirror.putWrite(threadId, checkpointNs, checkpointId, write, 'slot');
    }
  }

  /** Delete a thread from memory and from SQLite. */
  async deleteThread(threadId: string): Promise<void> {
    this.mirror.deleteThread(threadId);
    deleteThreads(this.db, [threadId]);
  }

  /**
   * GS2-107 — delete every thread no conversation row names, past the grace window. The retention
   * module owns the policy and the reasoning; this is the saver's own connection lent to it, so a
   * session that already has the store open can reclaim without opening it again.
   *
   * **Every thread this saver wrote is excluded, always**, on top of whatever the caller names. A
   * caller cannot supply that set: the runner rotates threads without telling anyone, so the only
   * place that knows which thread the session ended on is the object the writes went through. The
   * union is the contract — `excludeThreadIds` adds to the protection and can never subtract from
   * it.
   */
  reclaimUnresumableThreads(
    options: { now?: number; graceMs?: number; excludeThreadIds?: readonly string[] } = {}
  ): ReclaimSummary {
    return reclaimUnresumableThreads(this.db, {
      ...options,
      excludeThreadIds: [...this.writtenThreads, ...(options.excludeThreadIds ?? [])],
    });
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
