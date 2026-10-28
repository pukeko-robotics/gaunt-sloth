/**
 * @packageDocumentation
 * GS2-16 — pure, fail-soft helpers that harvest per-run analytics (token usage + invoked tool
 * names) from LangChain messages, so the local history recorder can populate `gth insights`
 * with real numbers instead of zeros.
 *
 * The extraction is deliberately structural and defensive (duck-typed reads guarded by a
 * try/catch) rather than `instanceof`-based: the same accumulator serves both the non-streaming
 * `invoke` path (a full `messages[]` from graph state) and the streaming paths (individual
 * message chunks / `ToolMessage`s as they arrive), across providers whose message shapes vary.
 * Nothing here may throw into a run — a missing/odd field just means that datum is skipped.
 */
import { mcpToolErrorPayload } from '#src/core/mcpErrorPayload.js';
import { NO_MCP_TOOL_BINDINGS, type McpToolBindings } from '#src/core/approvals/mcpSubjects.js';
import type { GthRunStats, GthToolCall, GthToolResult } from '#src/core/types.js';

/**
 * BATCH-21 / BATCH-49 — the DEFAULT cap on a captured tool-result payload, in **UTF-8 bytes**.
 *
 * Deliberately bytes, and deliberately a change from the character count this used to be. The cap
 * was applied to `text.length`, which counts UTF-16 code units, while every user-facing sentence
 * about it said "8 KB" — exact only for ASCII, and a different size from the one the code cut at
 * the moment a payload contained a character outside the ASCII range. Measuring UTF-8 bytes is what
 * those sentences already claimed, and it is the unit both neighbouring caps
 * (`builtInTools.<tool>.maxOutputBytes` / `maxBytes`) already use, so one number now means one size
 * to the person setting it and to the code applying it. An ASCII payload behaves exactly as it did
 * at this default; a non-ASCII one is cut somewhat earlier, which is the size the docs promised.
 *
 * This constant is the default's single source. A configured `toolResultCaptureMaxBytes` overrides
 * it at the read site (`resolveToolResultCaptureMaxBytes`); nothing else may restate the number.
 */
export const TOOL_RESULT_CONTENT_CAP = 8192;

/**
 * BATCH-49 — one captured payload after the cap has been applied: the text that is safe to store,
 * and whether the cap is what produced it.
 *
 * `truncated` is recorded HERE, at capture, rather than inferred later from the stored length. The
 * cut is on a character boundary (see {@link capToolResultText}), so a truncated payload can land
 * up to three bytes under the cap, and `.length` does not count bytes at all — a check that
 * compared the stored length with the cap would both miss real truncations and fire on a payload
 * that merely happened to be the same length. The capture site is the only place that still holds
 * the original, so it is the only place the fact can be recorded honestly.
 */
export interface CappedToolResultText {
  /** The payload as stored: the original when it fitted, the character-boundary prefix when it did not. */
  text: string;
  /** `true` iff `text` is a prefix of a longer payload — the cap is what cut it. */
  truncated: boolean;
  /**
   * The original payload's size in UTF-8 bytes, recorded only when {@link truncated} is `true`.
   *
   * This is the number a person needs in order to choose a new cap: the stored prefix's length
   * cannot say how far short the cut fell, and a reason string that only names the key still
   * leaves them guessing what to raise it to.
   */
  originalBytes?: number;
}

/**
 * BATCH-49 — apply `maxBytes` to `text`, cutting on a character boundary so the stored prefix is
 * always valid UTF-8.
 *
 * A byte cap applied as `slice` would split a multi-byte character: UTF-8 encodes one code point
 * in up to four bytes, and a cut that lands inside one yields a string that does not decode. So
 * the cut walks back to the start of the character the byte budget ran out inside, which means a
 * truncated payload can be up to three bytes *under* the cap and is never over it. A payload that
 * fits is returned unchanged, with `truncated: false` and no `originalBytes` — absence is the
 * record of "nothing was cut", and recording a size on every result would bloat the very trace
 * the cap exists to bound.
 *
 * `maxBytes` is a positive integer by the time it arrives here: the config schema rejects
 * anything else, and the read site substitutes {@link TOOL_RESULT_CONTENT_CAP} for an absent key.
 * Zero is not "unlimited" and is not handled here — see the schema comment for why.
 */
export function capToolResultText(text: string, maxBytes: number): CappedToolResultText {
  const encoded = Buffer.from(text);
  if (encoded.length <= maxBytes) return { text, truncated: false };

  // A continuation byte is 10xxxxxx. `encoded[maxBytes]` is the first byte that does not fit. When
  // it is a continuation, the character started inside the budget; walk back onto its lead and end
  // the prefix BEFORE that lead. `subarray` is exclusive, so stopping ON the lead is what drops it:
  // including the lead emits a truncated code point, and `toString` on that sequence substitutes
  // U+FFFD and still "decodes", which is a split papered over rather than avoided. A lead or an ASCII
  // byte at `encoded[maxBytes]` is already a character boundary, so the walk does not move and the
  // cut stays at the budget. The prefix is a genuine prefix of `text`, up to three bytes under the
  // cap, and never over it.
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    text: encoded.subarray(0, end).toString('utf8'),
    truncated: true,
    originalBytes: encoded.length,
  };
}

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
  /** BATCH-21 — one record per executed tool result (`ToolMessage`), in arrival order, un-deduped. */
  toolResults: GthToolResult[];
  /** BATCH-52 — one record per requested tool call whose arguments are complete, in request order. */
  toolCalls: GthToolCall[];
  /**
   * BATCH-52 — the current round's streamed calls, keyed by `tool_call_chunks` index, whose
   * arguments may still be arriving. Moved into {@link toolCalls} when the round's first
   * `ToolMessage` lands (indexes restart each round), and read as-is by a mid-round finalize.
   */
  streamingCalls: Map<number, StreamingToolCall>;
  /** BATCH-52 — ids already in {@link toolCalls}, so a call seen both streamed and whole is kept once. */
  recordedCallIds: Set<string>;
}

/** BATCH-52 — one streamed tool call being reassembled from its `tool_call_chunks` deltas. */
export interface StreamingToolCall {
  id?: string;
  name: string;
  argsText: string;
}

/** A fresh, empty accumulator. */
export function createRunStatsAccumulator(): RunStatsAccumulator {
  return {
    input: 0,
    output: 0,
    sawUsage: false,
    tools: new Set<string>(),
    toolResults: [],
    toolCalls: [],
    streamingCalls: new Map(),
    recordedCallIds: new Set(),
  };
}

/**
 * BATCH-52 — the stored record for one requested call: its arguments capped like a result's
 * payload. A call without a name is not recorded, matching the name set; a duplicate id is kept
 * once. Returns `undefined` for either.
 */
function toolCallRecord(
  call: StreamingToolCall,
  recordedIds: ReadonlySet<string>,
  maxBytes: number
): GthToolCall | undefined {
  if (!call.name) return undefined;
  if (call.id && recordedIds.has(call.id)) return undefined;
  const capped = capToolResultText(call.argsText, maxBytes);
  return {
    name: call.name,
    ...(call.id ? { id: call.id } : {}),
    args: capped.text,
    ...(capped.truncated ? { argsTruncated: true, argsOriginalBytes: capped.originalBytes } : {}),
  };
}

/** BATCH-52 — add one call to the accumulator's records (no-op for a nameless or repeated call). */
function recordToolCall(acc: RunStatsAccumulator, call: StreamingToolCall, maxBytes: number): void {
  const record = toolCallRecord(call, acc.recordedCallIds, maxBytes);
  if (!record) return;
  acc.toolCalls.push(record);
  if (record.id) acc.recordedCallIds.add(record.id);
}

/**
 * BATCH-52 — fold one message's requested tool calls into the argument records.
 *
 * A streamed chunk carries `tool_call_chunks`: argument fragments keyed by `index`, the id and
 * name on the first fragment only. Those are concatenated per index, the same way the plain tool
 * indication reassembles them, and a different id arriving at an index already holding a call
 * starts a new call (a provider that sends no `index` puts every call at 0). A whole message — the
 * non-streaming path, a replayed message, or a provider that sends complete calls on a chunk —
 * carries `tool_calls` with parsed arguments, recorded at once.
 */
function accumulateToolCallArgs(
  acc: RunStatsAccumulator,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  m: any,
  maxBytes: number
): void {
  const deltas = m.tool_call_chunks;
  if (Array.isArray(deltas) && deltas.length > 0) {
    for (const delta of deltas) {
      const index = typeof delta?.index === 'number' ? delta.index : 0;
      let entry = acc.streamingCalls.get(index);
      if (entry && delta.id && entry.id && entry.id !== delta.id) {
        recordToolCall(acc, entry, maxBytes);
        entry = undefined;
      }
      entry ??= { name: '', argsText: '' };
      if (typeof delta.id === 'string' && delta.id) entry.id = delta.id;
      if (typeof delta.name === 'string' && delta.name) entry.name = entry.name || delta.name;
      if (typeof delta.args === 'string') entry.argsText += delta.args;
      acc.streamingCalls.set(index, entry);
    }
    return;
  }
  const calls = m.tool_calls;
  if (!Array.isArray(calls)) return;
  for (const tc of calls) {
    const name = typeof tc?.name === 'string' ? tc.name : '';
    let argsText: string;
    try {
      argsText = JSON.stringify(tc.args ?? {});
    } catch {
      argsText = '';
    }
    recordToolCall(
      acc,
      { id: typeof tc?.id === 'string' ? tc.id : undefined, name, argsText },
      maxBytes
    );
  }
}

/** BATCH-52 — the round is over: its streamed calls' arguments are complete, so record them. */
function closeStreamingRound(acc: RunStatsAccumulator, maxBytes: number): void {
  for (const call of acc.streamingCalls.values()) recordToolCall(acc, call, maxBytes);
  acc.streamingCalls.clear();
}

/**
 * BATCH-21 — derive a tool result's text payload from a `ToolMessage.content`, fail-soft. A string
 * passes through; anything else non-`undefined` is JSON-stringified (the same derivation the
 * `tool_result` stream event uses in `GthAbstractAgent`); the result is capped at `maxBytes`
 * UTF-8 bytes (see {@link capToolResultText}). Returns `undefined` (payload omitted) when nothing
 * textual can be derived — never throws.
 *
 * **A single content block is captured as the block, NOT unwrapped to its inner text — deliberately.**
 * The alternative (unwrap a lone `{type:'text',text}` so an eval's `tool_result_json_path` reaches
 * the inner JSON without a `text` hop) was considered and rejected:
 *
 * - **The capture must be what the MODEL observed.** That is the one property a tool-result trace
 *   exists to preserve; an eval that grades a payload the model never saw grades a fiction.
 * - **No shape is unreachable, so nothing is being worked around.** `resolveJsonPath` normalizes
 *   `[0]` index syntax, so a block reachable at `text` in the object form is reachable at `[0].text`
 *   in the array form; a bare-string payload parses directly.
 * - **Unwrapping would silently break suites already written to the documented `text` hop**, and it
 *   would make the capture depend on which MCP-adapter branch produced the content (a lone text
 *   block arrives as a bare string, but as a block object once the server also returns
 *   `structuredContent`/`_meta`) — swapping a stated contract for an inferred one.
 * - It would not help the case this capture exists for anyway: a SOFTENED MCP error's payload is
 *   the adapter's own error message (prose, then the server's text), so it is not JSON at any hop.
 */
function toolResultContentText(
  content: unknown,
  maxBytes: number
): CappedToolResultText | undefined {
  try {
    let text: string | undefined;
    if (typeof content === 'string') {
      text = content;
    } else if (content !== undefined) {
      text = JSON.stringify(content);
    }
    if (text === undefined) return undefined;
    return capToolResultText(text, maxBytes);
  } catch {
    /* fail-soft: an unstringifiable payload just means no content is recorded */
    return undefined;
  }
}

/**
 * Requested tool calls of an AIMessage / AIMessageChunk: their names (a Set, so repeats collapse)
 * and, for `tool_call_json_path`, their arguments. Continuation chunks in a streamed
 * tool call carry an empty name, so the name guard is on a non-empty string.
 */
function accumulateRequestedToolCalls(
  acc: RunStatsAccumulator,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  m: any,
  captureMaxBytes: number
): void {
  const toolCalls = m.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const name = tc?.name;
      if (typeof name === 'string' && name.length > 0) acc.tools.add(name);
    }
  }
  accumulateToolCallArgs(acc, m, captureMaxBytes);
}

/**
 * Fold the tool calls of an AI message the tool-call repair promoted from model text into the
 * accumulator.
 *
 * The promoted message keeps the id of the text message it replaces. A streamed run has already
 * seen that id as plain text and never delivers the promoted message to {@link accumulateMessage},
 * so the agent hands it here when it promotes it. Only the requested calls are recorded, not usage:
 * the text message it replaces was already counted.
 *
 * The non-streaming path folds the same message through {@link accumulateMessage} as well; the call
 * is kept once because {@link RunStatsAccumulator.recordedCallIds} already holds its id. Fail-soft.
 */
export function accumulatePromotedToolCalls(
  acc: RunStatsAccumulator,
  message: unknown,
  captureMaxBytes: number = TOOL_RESULT_CONTENT_CAP
): void {
  try {
    if (!message || typeof message !== 'object') return;
    accumulateRequestedToolCalls(acc, message, captureMaxBytes);
  } catch {
    /* fail-soft: never let stats capture affect a run */
  }
}

/**
 * Fold one LangChain message (or message chunk) into the accumulator. Fail-soft: any unexpected
 * shape is swallowed so a run is never affected. Harvests, when present:
 * - `usage_metadata.input_tokens` / `.output_tokens` (summed; marks `sawUsage`),
 * - tool names from an AIMessage's requested `tool_calls[].name` AND from a `ToolMessage`'s own
 *   `.name` (the executed tool), so both "requested" and "executed" tools are captured, and
 * - (BATCH-21) a per-`ToolMessage` result record — `name` + `isError` (from `.status`) + capped
 *   `content` — into `acc.toolResults`, so tool-RESULT assertions can grade what a tool returned.
 *
 * `mcpToolBindings` is the agent's record of which configured server each MCP tool was loaded
 * under, used only to resolve which server an errored MCP tool belongs to (BATCH-43; see the
 * record's `errorPayload`). It is passed per fold rather than held on the accumulator so this never
 * depends on the accumulator being re-created after the tools are known — the default leaves every
 * non-MCP capture exactly as it was.
 *
 * `captureMaxBytes` is the same kind of argument, for the same reason (BATCH-49): the cap is a
 * config value (`toolResultCaptureMaxBytes`, defaulted at the read site), and holding it on the
 * accumulator would tie every fold to the accumulator having been rebuilt after the config was
 * known. The default is {@link TOOL_RESULT_CONTENT_CAP}, so a caller that predates the argument
 * caps exactly where it always did.
 */
export function accumulateMessage(
  acc: RunStatsAccumulator,
  message: unknown,
  mcpToolBindings: McpToolBindings = NO_MCP_TOOL_BINDINGS,
  captureMaxBytes: number = TOOL_RESULT_CONTENT_CAP
): void {
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

    accumulateRequestedToolCalls(acc, m, captureMaxBytes);

    // Executed tool result (ToolMessage). Its `.name` is the tool that produced the result.
    const type: unknown = typeof m.getType === 'function' ? m.getType() : m._getType?.();
    if (type === 'tool') closeStreamingRound(acc, captureMaxBytes);
    if (type === 'tool' && typeof m.name === 'string' && m.name.length > 0) {
      acc.tools.add(m.name);
      // BATCH-21 — capture the RESULT record too (same capture site, same fail-soft discipline):
      // `.status === 'error'` is LangChain's real tool-error signal, `.content` the returned
      // payload (capped; omitted when no text can be derived). One record per ToolMessage, in
      // arrival order — deliberately NOT deduplicated, unlike the name set above.
      const captured = toolResultContentText(m.content, captureMaxBytes);
      // BATCH-43 — beside the observed payload, never instead of it: an errored MCP tool's result
      // is the adapter's own prose-prefixed message, which `tool_result_json_path` cannot parse.
      // `mcpToolErrorPayload` rebuilds that prefix from the resolved server + tool name and strips
      // it, yielding the server's own error body when (and only when) it is JSON. Derived from the
      // RAW `m.content`, not from the capped `captured` above — deriving after the cap would work
      // on every payload short enough to test with and silently stop working on the long ones. The
      // SAME cap is applied inside, to the derived payload: the two fields share one budget, so a
      // raised `toolResultCaptureMaxBytes` recovers an error body the default would have dropped,
      // and a lowered one drops one the default would have kept.
      const isError = m.status === 'error';
      const errorPayload = mcpToolErrorPayload(
        { name: m.name, isError, content: m.content },
        mcpToolBindings,
        captureMaxBytes
      );
      // BATCH-49 — the truncation fact rides the record, recorded at this capture rather than
      // inferred later from the stored length (see {@link CappedToolResultText}). `contentTruncated`
      // is present only when the cap cut something, so a record that fitted is byte-identical to the
      // one this capture produced before the field existed.
      acc.toolResults.push({
        name: m.name,
        isError,
        ...(captured !== undefined ? { content: captured.text } : {}),
        ...(captured?.truncated
          ? { contentTruncated: true, contentOriginalBytes: captured.originalBytes }
          : {}),
        ...(errorPayload !== undefined ? { errorPayload } : {}),
      });
    }
  } catch {
    /* fail-soft: never let stats capture affect a run */
  }
}

/**
 * Freeze the accumulator into the public {@link GthRunStats}. Tokens omitted unless observed.
 *
 * BATCH-52 — calls still streaming (no result has closed their round yet: the run ended on them,
 * or stats are read mid-round) are included as they stand, without being moved, so a later fold
 * still closes the round normally. `captureMaxBytes` caps those the same way a fold would.
 */
export function finalizeRunStats(
  acc: RunStatsAccumulator,
  captureMaxBytes: number = TOOL_RESULT_CONTENT_CAP
): GthRunStats {
  const toolCalls = [...acc.toolCalls];
  const seen = new Set(acc.recordedCallIds);
  for (const call of acc.streamingCalls.values()) {
    const record = toolCallRecord(call, seen, captureMaxBytes);
    if (!record) continue;
    toolCalls.push(record);
    if (record.id) seen.add(record.id);
  }
  return {
    tokensInput: acc.sawUsage ? acc.input : undefined,
    tokensOutput: acc.sawUsage ? acc.output : undefined,
    tools: [...acc.tools],
    toolResults: [...acc.toolResults],
    toolCalls,
  };
}

/**
 * One-shot convenience for the non-streaming path: fold a full `messages[]` (e.g. the final graph
 * state) into a fresh accumulator and finalize. Fail-soft (a non-iterable input yields empties).
 */
export function extractRunStats(
  messages: unknown,
  mcpToolBindings: McpToolBindings = NO_MCP_TOOL_BINDINGS,
  captureMaxBytes: number = TOOL_RESULT_CONTENT_CAP
): GthRunStats {
  const acc = createRunStatsAccumulator();
  try {
    if (Array.isArray(messages)) {
      for (const m of messages) accumulateMessage(acc, m, mcpToolBindings, captureMaxBytes);
    }
  } catch {
    /* fail-soft */
  }
  return finalizeRunStats(acc, captureMaxBytes);
}
