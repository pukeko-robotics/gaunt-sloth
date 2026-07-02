/**
 * @packageDocumentation
 * GS2-16 — pure, fail-soft helpers that harvest per-run analytics (token usage + invoked tool
 * names) from LangChain messages, so the opt-in history recorder can populate `gth insights`
 * with real numbers instead of zeros.
 *
 * The extraction is deliberately structural and defensive (duck-typed reads guarded by a
 * try/catch) rather than `instanceof`-based: the same accumulator serves both the non-streaming
 * `invoke` path (a full `messages[]` from graph state) and the streaming paths (individual
 * message chunks / `ToolMessage`s as they arrive), across providers whose message shapes vary.
 * Nothing here may throw into a run — a missing/odd field just means that datum is skipped.
 */
import type { GthRunStats } from '#src/core/types.js';

/** Mutable tally behind {@link finalizeRunStats}; see {@link createRunStatsAccumulator}. */
export interface RunStatsAccumulator {
  /** Running sum of input/prompt tokens. */
  input: number;
  /** Running sum of output/completion tokens. */
  output: number;
  /** Whether ANY message reported `usage_metadata` — gates whether tokens are recorded at all. */
  sawUsage: boolean;
  /** Deduplicated set of invoked tool names. */
  tools: Set<string>;
}

/** A fresh, empty accumulator. */
export function createRunStatsAccumulator(): RunStatsAccumulator {
  return { input: 0, output: 0, sawUsage: false, tools: new Set<string>() };
}

/**
 * Fold one LangChain message (or message chunk) into the accumulator. Fail-soft: any unexpected
 * shape is swallowed so a run is never affected. Harvests, when present:
 * - `usage_metadata.input_tokens` / `.output_tokens` (summed; marks `sawUsage`), and
 * - tool names from an AIMessage's requested `tool_calls[].name` AND from a `ToolMessage`'s own
 *   `.name` (the executed tool), so both "requested" and "executed" tools are captured.
 */
export function accumulateMessage(acc: RunStatsAccumulator, message: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = message as any;
    if (!m || typeof m !== 'object') return;

    const usage = m.usage_metadata;
    if (usage && typeof usage === 'object') {
      acc.sawUsage = true;
      if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
        acc.input += usage.input_tokens;
      }
      if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
        acc.output += usage.output_tokens;
      }
    }

    // Requested tool calls (AIMessage / AIMessageChunk). Continuation chunks in a streamed
    // tool call carry an empty name, so guard on a non-empty string; the Set dedupes repeats.
    const toolCalls = m.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const name = tc?.name;
        if (typeof name === 'string' && name.length > 0) acc.tools.add(name);
      }
    }

    // Executed tool result (ToolMessage). Its `.name` is the tool that produced the result.
    const type: unknown = typeof m.getType === 'function' ? m.getType() : m._getType?.();
    if (type === 'tool' && typeof m.name === 'string' && m.name.length > 0) {
      acc.tools.add(m.name);
    }
  } catch {
    /* fail-soft: never let stats capture affect a run */
  }
}

/** Freeze the accumulator into the public {@link GthRunStats}. Tokens omitted unless observed. */
export function finalizeRunStats(acc: RunStatsAccumulator): GthRunStats {
  return {
    tokensInput: acc.sawUsage ? acc.input : undefined,
    tokensOutput: acc.sawUsage ? acc.output : undefined,
    tools: [...acc.tools],
  };
}

/**
 * One-shot convenience for the non-streaming path: fold a full `messages[]` (e.g. the final graph
 * state) into a fresh accumulator and finalize. Fail-soft (a non-iterable input yields empties).
 */
export function extractRunStats(messages: unknown): GthRunStats {
  const acc = createRunStatsAccumulator();
  try {
    if (Array.isArray(messages)) {
      for (const m of messages) accumulateMessage(acc, m);
    }
  } catch {
    /* fail-soft */
  }
  return finalizeRunStats(acc);
}
