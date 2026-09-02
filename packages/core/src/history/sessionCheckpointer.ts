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
 */
import { randomUUID } from 'node:crypto';
import { BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph';
import { openCheckpointSaver } from '#src/history/checkpointSaver.js';
import { isHistoryEnabled, type HistoryConfigView } from '#src/history/historyEnabled.js';
import { resolveHistoryDbPath } from '#src/history/historyStore.js';
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
    close: () => {},
  });
  try {
    if (!isHistoryEnabled(config)) return inMemory();
    const dbPath = resolveHistoryDbPath(config.history?.dbPath, /* ensureDir */ true);
    const saver = openCheckpointSaver(dbPath);
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
