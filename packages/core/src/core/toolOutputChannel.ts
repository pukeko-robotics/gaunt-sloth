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
 *   notice, `stdout.write` for chunks, `displayWarning`/`displayError` for a failure-path
 *   warning/error — so headless output is unchanged.
 * - The Ink TUI subscribes for the duration of a turn via {@link mergeToolOutputIntoEvents},
 *   which converts each chunk into a typed `tool_output` {@link AgentStreamEvent} attributed to
 *   its tool call, merged live into the turn's event stream so it lands in `foldEvents`.
 *
 * Single-subscriber by design: one process hosts at most one interactive TUI session, and the
 * non-TUI surfaces never subscribe. (Concurrent server sessions — AG-UI/ACP — stay on the
 * default sink, exactly as before.)
 *
 * TUI-C31 hardens the seam's edge windows: failure-path warnings/errors now travel the channel
 * too ({@link GthToolOutputChunk} `kind: 'warning' | 'error'`, residual a); the merge drains a
 * straggler queued in the unsubscribe microwindow (residual b) and cleans up on early-`return()`
 * (residual c); and {@link setToolOutputSuppressed} lets the mounted TUI suppress a
 * post-unsubscribe straggler between turns instead of leaking it to raw stdout (residual d).
 */
import type { AgentStreamEvent } from '#src/core/types.js';
import { displayError, displayInfo, displayWarning } from '#src/utils/consoleUtils.js';
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
   * `output` — a verbatim child stdout/stderr chunk (historically `stdout.write`);
   * `warning` / `error` — a failure-path advisory (historically `displayWarning`/`displayError`),
   *   e.g. a hardline refusal or a spawn-level failure. TUI-C31 (a): routing these through the
   *   channel keeps them out of raw stdout while the Ink frame is mounted; the default sink still
   *   renders them via `displayWarning`/`displayError` for every non-TUI surface, byte-for-byte.
   */
  kind: 'notice' | 'output' | 'warning' | 'error';
  /**
   * The text, verbatim. Notices carry NO leading newline — raw-console framing (the historical
   * leading `\n`) is the default sink's concern, not the producer's. A `warning`/`error` DOES
   * carry whatever leading framing its historical `displayWarning`/`displayError` call had (the
   * default sink forwards it unchanged), so headless output stays byte-for-byte identical.
   */
  text: string;
}

export type GthToolOutputListener = (chunk: GthToolOutputChunk) => void;

let activeListener: GthToolOutputListener | null = null;

/**
 * TUI-C31 (d): true while a surface owns the terminal frame (the mounted Ink TUI) but no
 * per-turn subscriber is attached — i.e. BETWEEN turns. In that window a straggler child that
 * outlived the kill grace must NOT reach raw stdout (it would corrupt Ink's managed frame), so
 * the default sink drops it instead. Off by default, so every headless surface is unaffected.
 */
let suppressed = false;

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
 * TUI-C31 (d): mark whether a terminal-owning surface (the Ink TUI) is mounted. While mounted,
 * the default sink SUPPRESSES output that has no per-turn subscriber (a post-turn straggler)
 * rather than writing it raw over the managed frame. The TUI session sets this `true` around the
 * whole session (`render()` … `waitUntilExit()`) and back to `false` on unmount, so once the TUI
 * is gone the default (headless) stdout sink is fully restored. An active per-turn subscriber
 * always takes precedence, so legitimate in-turn output is untouched.
 */
export function setToolOutputSuppressed(value: boolean): void {
  suppressed = value;
}

/**
 * Emit one piece of live tool output. Routed to the active subscriber when present (the Ink
 * TUI), otherwise to the DEFAULT SINK, which reproduces the pre-TUI-C17 behaviour exactly:
 * the notice via `displayInfo` with its historical leading newline, chunks via `stdout.write`,
 * a warning via `displayWarning` and an error via `displayError` (TUI-C31 a). While the TUI is
 * mounted but no subscriber is attached (between turns), a no-subscriber emit is SUPPRESSED
 * rather than written raw over the managed frame (TUI-C31 d).
 */
export function emitToolOutput(chunk: GthToolOutputChunk): void {
  if (activeListener) {
    activeListener(chunk);
    return;
  }
  if (suppressed) {
    // TUI mounted, between turns: drop the straggler instead of corrupting the managed frame.
    return;
  }
  switch (chunk.kind) {
    case 'notice':
      displayInfo(`\n${chunk.text}`);
      break;
    case 'warning':
      displayWarning(chunk.text);
      break;
    case 'error':
      displayError(chunk.text);
      break;
    default:
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
    // A `notice` is chrome; a failure-path `warning`/`error` is also chrome relative to the child's
    // own stdout/stderr `output`, so it lands on the view-model's separate `notice` field (never
    // counted as a raw output line) rather than styled as command output.
    ...(chunk.kind === 'notice' || chunk.kind === 'warning' || chunk.kind === 'error'
      ? { isNotice: true }
      : {}),
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
    // TUI-C31 (b): the subscriber is still attached at this point, so a straggler chunk can be
    // pushed in the microwindow between the loop's last drain and the unsubscribe (the child
    // flushed one final line as the turn ended). Detach the subscriber FIRST — after which no
    // further chunk can be queued — THEN drain whatever is already queued, so nothing enqueued is
    // silently dropped.
    unsubscribe();
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (failed) throw error;
  } finally {
    // TUI-C31 (c): also reached on early-stop — a consumer `return()`/`throw` into this generator
    // while it is suspended (e.g. at a yield, the way a `for await` aborts). Make that path clean:
    // unsubscribe (idempotent — a stale unsubscribe is a no-op) so the subscription never leaks,
    // settle any pending wake resolver, and best-effort release the inner stream. This is
    // deliberately fire-and-forget: `inner` may be parked on an await that its own `return()`
    // cannot interrupt, and AWAITING the pump here would hang the consumer's `return()` on exactly
    // that unresolvable inner — so we release and let go rather than block.
    unsubscribe();
    notify();
    if (!done) {
      void inner.return?.(undefined).catch(() => {});
    }
  }
}
