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
   * can mark it unresumable ON DISK. Call once, immediately after `openConversationSafe`; passing
   * `undefined` (history off, or the row could not be opened) is fine and simply leaves nothing to
   * mark. Safe to call before or after a failure has already happened — a failure that arrives
   * first is applied here instead. Never throws.
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
    return {
      saver,
      durable: true,
      threadId,
      bindConversation: (id) => {
        conversationId = id;
        applyMark();
      },
      close: () => saver.close(),
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
