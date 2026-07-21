/**
 * @module toolOutputChannel
 * TUI-C17 — the managed route for LIVE tool output (a custom/dev toolkit child process's
 * stdout/stderr chunks and its "🔧 Executing …" announcement).
 *
 * The toolkits used to write child output straight to `process.stdout` and announce runs via
 * `displayInfo`. Under the Ink TUI both bypass Ink's managed frame: the raw text prints out of
 * order above the agent message, never reaches the `TurnViewModel`, and vanishes on the next
 * re-render. The fix is an emit/subscribe seam:
 *
 * - The toolkits call {@link emitToolOutput} instead of writing to stdout/`displayInfo`.
 * - With NO subscriber (every non-TUI surface: `--no-tui`, piped, `exec`, the AG-UI server),
 *   the DEFAULT SINK reproduces the historical behaviour byte-for-byte — `displayInfo` for the
 *   notice, `stdout.write` for chunks — so headless output is unchanged.
 * - The Ink TUI subscribes for the duration of a turn via {@link mergeToolOutputIntoEvents},
 *   which converts each chunk into a typed `tool_output` {@link AgentStreamEvent} attributed to
 *   its tool call, merged live into the turn's event stream so it lands in `foldEvents`.
 *
 * Single-subscriber by design: one process hosts at most one interactive TUI session, and the
 * non-TUI surfaces never subscribe. (Concurrent server sessions — AG-UI/ACP — stay on the
 * default sink, exactly as before.)
 */
import type { AgentStreamEvent } from '#src/core/types.js';
import { displayInfo } from '#src/utils/consoleUtils.js';
import { stdout } from '#src/utils/systemUtils.js';

/** One emitted piece of live tool output, attributed to the tool (and call) that produced it. */
export interface GthToolOutputChunk {
  /**
   * The LangChain tool call id this output belongs to (`ToolRunnableConfig.toolCall.id`),
   * when the invoking framework supplied one. Lets a consumer nest output under the exact call.
   */
  toolCallId?: string;
  /** The gth tool name (e.g. `run_shell_command`, a custom tool's name). Always known. */
  toolName: string;
  /**
   * `notice` — the "🔧 Executing …" announcement (historically `displayInfo`);
   * `output` — a verbatim child stdout/stderr chunk (historically `stdout.write`).
   */
  kind: 'notice' | 'output';
  /** The text, verbatim. Notices carry NO leading newline — raw-console framing (the historical
   * leading `\n`) is the default sink's concern, not the producer's. */
  text: string;
}

export type GthToolOutputListener = (chunk: GthToolOutputChunk) => void;

let activeListener: GthToolOutputListener | null = null;

/**
 * Subscribe to live tool output, replacing the default stdout/`displayInfo` sink for as long
 * as the subscription is active. Returns an unsubscribe function. Last subscriber wins; the
 * returned unsubscribe only clears its OWN registration (a stale unsubscribe can never detach
 * a newer subscriber).
 */
export function subscribeToolOutput(listener: GthToolOutputListener): () => void {
  activeListener = listener;
  return () => {
    if (activeListener === listener) {
      activeListener = null;
    }
  };
}

/**
 * Emit one piece of live tool output. Routed to the active subscriber when present (the Ink
 * TUI), otherwise to the DEFAULT SINK, which reproduces the pre-TUI-C17 behaviour exactly:
 * the notice via `displayInfo` with its historical leading newline, chunks via `stdout.write`.
 */
export function emitToolOutput(chunk: GthToolOutputChunk): void {
  if (activeListener) {
    activeListener(chunk);
    return;
  }
  if (chunk.kind === 'notice') {
    displayInfo(`\n${chunk.text}`);
  } else {
    stdout.write(chunk.text);
  }
}

/** Convert one channel chunk into its typed {@link AgentStreamEvent} representation. */
function toEvent(chunk: GthToolOutputChunk): AgentStreamEvent {
  return {
    type: 'tool_output',
    ...(chunk.toolCallId !== undefined ? { id: chunk.toolCallId } : {}),
    name: chunk.toolName,
    chunk: chunk.text,
    ...(chunk.kind === 'notice' ? { isNotice: true } : {}),
  };
}

/**
 * Merge live tool output into an agent event stream: subscribes to the channel for the
 * lifetime of `inner` and yields each emitted chunk as a `tool_output` event, interleaved
 * with `inner`'s own events in arrival order. Because tool child output arrives WHILE the
 * graph stream is awaiting its next message, the merge is push-based (a woken queue), so a
 * long-running command's output streams into the consumer live rather than batching until
 * the tool finishes.
 *
 * Used by the TUI session around `processMessagesWithEvents`; always unsubscribes (restoring
 * the default stdout sink) when the inner stream completes, throws, or the consumer stops
 * early. Errors from `inner` (including aborts) propagate unchanged after the queue drains.
 */
export async function* mergeToolOutputIntoEvents(
  inner: AsyncGenerator<AgentStreamEvent>
): AsyncGenerator<AgentStreamEvent> {
  const queue: AgentStreamEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let error: unknown;
  let failed = false;
  const notify = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const unsubscribe = subscribeToolOutput((chunk) => {
    queue.push(toEvent(chunk));
    notify();
  });

  // Pump the inner stream into the same queue so both sources serialize in arrival order.
  const pump = (async () => {
    try {
      for await (const event of inner) {
        queue.push(event);
        notify();
      }
    } catch (e) {
      failed = true;
      error = e;
    } finally {
      done = true;
      notify();
    }
  })();

  try {
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await pump;
    if (failed) throw error;
  } finally {
    unsubscribe();
    // Consumer stopped early (return/throw into this generator): release the inner stream too.
    if (!done) {
      void inner.return?.(undefined).catch(() => {});
    }
  }
}
