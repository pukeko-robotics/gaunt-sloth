/**
 * @packageDocumentation
 * GS2-20 — the bridge from a session's config to the checkpointer it drives, and the counterpart to
 * the recorder bridge in `recordSession.ts`: one call, never throws, always returns a usable saver.
 *
 * **The fallback is a `MemorySaver`, never the absence of one.** With a tool-approval interrupt
 * installed and no checkpointer at all, the first gated tool call throws a LangGraph-internal
 * `MISSING_CHECKPOINTER` in the middle of a turn — a failure with no relationship to what the user
 * was doing. So a database this session cannot open costs exactly one thing, resumability, and the
 * user is told that plainly rather than discovering it later.
 *
 * **A write that fails later costs the same one thing.** This module owns the degrade policy the
 * saver reports into: one notice per session, and — the part that has to outlive the process — the
 * conversation's thread link cleared on disk, so a later resume refuses it. A checkpoint chain that
 * stopped growing mid-conversation is still well-formed, so without that mark the next `--resume`
 * would load a truncated conversation and present it as complete.
 */
import { randomUUID } from 'node:crypto';
import { BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph';
import { openCheckpointSaver } from '#src/history/checkpointSaver.js';
import { isHistoryEnabled, type HistoryConfigView } from '#src/history/historyEnabled.js';
import { resolveHistoryDbPath } from '#src/history/historyStore.js';
import { markConversationUnresumableSafe } from '#src/history/recordSession.js';
import { displayWarning } from '#src/utils/consoleUtils.js';

/** The checkpointer a session drives, plus what the session needs to know about it. */
export interface SessionCheckpointer {
  /** The saver to hand to `GthAgentRunner.init` / `GthAgentInterface.init`. Never null. */
  saver: BaseCheckpointSaver;
  /**
   * True when checkpoints are reaching disk — i.e. when this session can be resumed later. False
   * for a `MemorySaver`, whether that is the deliberate opt-out or the fallback.
   */
  durable: boolean;
  /**
   * The LangGraph thread this session's state is stored under, minted here so the conversation row
   * can record it BEFORE the runner is initialised — `init` can throw partway, and a conversation
   * whose thread id was never written is a listing entry that can never be resumed.
   */
  threadId: string;
  /**
   * Name the conversation row this session's turns group under, so a later checkpoint-write failure
   * can mark it unresumable ON DISK. Call once per conversation the session records under:
   * immediately after `openConversationSafe`, and again when a mid-session `/resume` moves the
   * session onto another conversation — the saver is the same, so the row it would mark has to
   * follow the session. Passing `undefined` (history off, or the row could not be opened) is fine
   * and simply leaves nothing to mark. Safe to call before or after a failure has already happened
   * — a failure that arrives first is applied here instead, and a rebind after one marks the new
   * row too, which is correct: a saver that has stopped writing is truncating whichever
   * conversation it is now on. Never throws.
   *
   * **Optional on the interface, and called with `?.`**, because a dozen-odd specs stub
   * `openSessionCheckpointerSafe` with a plain object literal to keep a session off the real
   * database. Requiring it would break every one of them at runtime for no gain: a stub that omits
   * it simply has no conversation to mark, which is the correct behaviour for a test that is not
   * about this.
   */
  bindConversation?(conversationId: number | undefined): void;
  /** Release the underlying connection (a no-op when the saver is in memory). Never throws. */
  close(): void;
}

export interface OpenSessionCheckpointerOptions {
  /** Drive a specific thread instead of a fresh one — how a resume re-enters a stored thread. */
  threadId?: string;
  /**
   * Where the fallback notice goes. Defaults to {@link displayWarning}; injectable so a caller on a
   * managed surface can route it, and so a test can read it without mocking the console.
   */
  notify?: (message: string) => void;
}

/**
 * Open the session's checkpointer. Returns a durable, SQLite-backed saver when history is on and
 * the database opens; a `MemorySaver` otherwise. Never throws.
 *
 * The `MemorySaver` case is two different situations that must not be conflated:
 * - `history.enabled: false` — the user turned persistence off. Silent: they asked for this.
 * - the database would not open — the user asked for persistence and did not get it, so
 *   {@link OpenSessionCheckpointerOptions.notify} says so.
 */
/**
 * Every durable checkpointer currently open in this process, as its own close function.
 *
 * A session normally closes its connection in a `finally`, but a process killed by a signal never
 * reaches one: `systemUtils` answers `SIGINT`/`SIGTERM` with `process.exit(0)`, which unwinds no
 * `try`/`finally` at all, and a `SIGHUP` — a user closing the terminal window — terminates without
 * running anything. Leaving the database open until the OS tears the process down is harmless on
 * POSIX and not on win32, where a live handle blocks the file from being deleted or replaced.
 */
const openSavers = new Set<() => void>();

/** Installed at most once per process, on the first durable checkpointer. */
let terminationHooksInstalled = false;

/**
 * Close every open checkpointer on the way out of the process.
 *
 * `exit` rather than a `SIGINT`/`SIGTERM` handler of our own, deliberately: `systemUtils` registers
 * its signal handlers when it is first imported, which is long before any session starts, and they
 * call `process.exit(0)`. Node runs signal listeners in registration order, so a later listener of
 * ours would never be reached — but `process.exit()` does run `exit` listeners, so that one hook
 * covers `SIGINT`, `SIGTERM`, an explicit exit and a normal return alike. `SIGHUP` has no such
 * handler anywhere and so needs its own.
 */
function ensureTerminationHooks(): void {
  if (terminationHooksInstalled) return;
  terminationHooksInstalled = true;

  const closeAll = (): void => {
    for (const close of [...openSavers]) {
      try {
        close();
      } catch {
        // Nothing useful can be done about a failed close while the process is already leaving.
      }
    }
    openSavers.clear();
  };

  process.on('exit', closeAll);

  const onHangup = (): void => {
    // Remove ourselves first so the default disposition applies again and the process dies with the
    // status it would have had. Swallowing a hangup would leave a session running invisibly.
    process.off('SIGHUP', onHangup);
    closeAll();
    process.kill(process.pid, 'SIGHUP');
  };
  process.on('SIGHUP', onHangup);
}

export function openSessionCheckpointerSafe(
  config: HistoryConfigView,
  options: OpenSessionCheckpointerOptions = {}
): SessionCheckpointer {
  const threadId = options.threadId ?? randomUUID();
  const notify = options.notify ?? displayWarning;
  const inMemory = (): SessionCheckpointer => ({
    saver: new MemorySaver(),
    durable: false,
    threadId,
    bindConversation: () => {},
    close: () => {},
  });

  // GS2-20 — the degrade path. A checkpoint write that fails mid-session drops the write and lets
  // the turn continue; these two closures are the "loudly" half. They are declared before the saver
  // because the saver is handed `degrade` at construction.
  //
  // The two facts are tracked separately on purpose. `degraded` is what happened; `conversationId`
  // is where to write it down, and it is not known yet — the conversation row is opened by the
  // caller AFTER this returns, because the row has to carry the thread id minted just above. So a
  // failure can precede the binding, and `applyMark` is called from both sides to close that gap.
  let degraded = false;
  let conversationId: number | undefined;
  const applyMark = (): void => {
    if (!degraded || conversationId === undefined) return;
    markConversationUnresumableSafe(config, conversationId);
  };
  const degrade = (): void => {
    // Once per session, not once per write: a full disk fails every super-step, and a notice per
    // write would bury the turn the user is still having under its own error report.
    if (degraded) return;
    degraded = true;
    notify(
      'Could not save this conversation to the conversation store, so it will not be resumable ' +
        'later — the rest of this session is unaffected and your work is not lost. The usual cause ' +
        'is a full or read-only disk. Set `history.enabled: false` in your config to stop trying.'
    );
    applyMark();
  };

  try {
    if (!isHistoryEnabled(config)) return inMemory();
    const dbPath = resolveHistoryDbPath(config.history?.dbPath, /* ensureDir */ true);
    const saver = openCheckpointSaver(dbPath, { onWriteFailure: degrade });
    if (!saver) {
      notify(
        `Could not open the conversation store at ${dbPath}, so this session will not be ` +
          'resumable later. It runs normally otherwise; set `history.enabled: false` in your ' +
          'config to stop trying.'
      );
      return inMemory();
    }
    // GS2-20 — hold the connection open only as long as the session actually runs. `saver.close()`
    // is itself fail-soft, so the guard is about not counting a closed saver as open rather than
    // about a double close throwing.
    let closed = false;
    const closeOnce = (): void => {
      if (closed) return;
      closed = true;
      saver.close();
    };
    openSavers.add(closeOnce);
    ensureTerminationHooks();

    // GS2-107 — the automatic half of the retention policy runs HERE, on the orderly close of a
    // session that actually ran, and nowhere else.
    //
    // **Why the close and not the open.** The connection is already there, so it adds no open of its
    // own, and it lands after the person has stopped waiting on the tool rather than in front of
    // their first prompt — a user with a large store must not pay for retention at startup.
    //
    // **Why not in `closeOnce`.** That closure is also what the process-exit and SIGHUP hooks call.
    // A row delete while the process is already leaving is work nobody is waiting for and nothing
    // can report, on a path that a signal can interrupt halfway.
    //
    // **Why the `bindConversation` gate.** Both surfaces bind straight after the resume checks pass,
    // so a checkpointer closed before that point is one whose session never started — the
    // `--resume` refusal path, which exits 1 promising that nothing was changed. Deleting rows there
    // would make that sentence false.
    //
    // **What keeps this session's own thread safe.** Not the id minted above: the runner rotates
    // threads and does not tell anyone — `resetThread()` on `/clear`, `resumeConversation` onto a
    // stored thread — so after any rotation that id names a thread nobody wrote. The saver excludes
    // the threads IT wrote instead, which is the same set by construction however often the session
    // rotated, so nothing is passed here. What remains outside that set is a live session in
    // ANOTHER process, and it is bounded only by the grace window; closing that gap needs shared
    // cross-process session state, which this ticket does not add.
    let served = false;
    let reclaimed = false;
    const reclaimOnClose = (): void => {
      if (reclaimed || !served || closed) return;
      reclaimed = true;
      try {
        saver.reclaimUnresumableThreads();
      } catch {
        /* retention is housekeeping: it must never be the reason a session fails to exit */
      }
    };

    return {
      saver,
      durable: true,
      threadId,
      bindConversation: (id) => {
        served = true;
        conversationId = id;
        applyMark();
      },
      close: () => {
        reclaimOnClose();
        openSavers.delete(closeOnce);
        closeOnce();
      },
    };
  } catch {
    // Reaching here means something outside the saver's own fail-soft open threw — resolving the
    // path, or creating `~/.gsloth`. Same outcome, same sentence: the session runs, unresumable.
    notify(
      'Could not open the conversation store, so this session will not be resumable later. ' +
        'It runs normally otherwise; set `history.enabled: false` in your config to stop trying.'
    );
    return inMemory();
  }
}
