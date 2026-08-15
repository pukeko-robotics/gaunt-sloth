/**
 * @packageDocumentation
 * Tool-call identity, shared by both ACP dialects.
 *
 * The two dialects disagree about how a tool call is REPORTED — v1 has a distinct `tool_call`
 * update that creates one and a `tool_call_update` that patches it, v2 folds creation into the
 * first `tool_call_update` — but they agree completely about what a tool call IS. The kind hint, the
 * reassembly of streamed argument deltas, and the pairing of a permission request with the call it
 * is about are the same problem on both surfaces, so they are solved once here.
 *
 * **The pairing especially.** {@link AcpToolCallTracker.claimToolCallId} is the piece that took
 * three attempts to get right, and a second copy of it living in the other dialect's mapper is how
 * one of them silently regresses to attaching a permission prompt to the wrong row.
 */

import type { ToolKind } from '@agentclientprotocol/sdk';

/**
 * ACP tool KIND for a gth tool name — the hint a client uses to pick an icon and a UI treatment.
 *
 * Matched by exact name, with `other` as the fallback, because a wrong kind is worse than a
 * generic one: a client that shows a delete glyph for a read is actively misleading about what the
 * agent is doing. Unknown names (custom tools, MCP tools) therefore land on `other` rather than
 * being guessed at from substrings.
 */
const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  create_directory: 'edit',
  delete_directory: 'delete',
  delete_file: 'delete',
  directory_tree: 'read',
  edit_file: 'edit',
  get_file_info: 'read',
  gth_read_binary: 'read',
  gth_status_update: 'think',
  gth_web_fetch: 'fetch',
  list_allowed_directories: 'read',
  list_directory: 'read',
  list_directory_with_sizes: 'read',
  move_file: 'move',
  read_file: 'read',
  read_multiple_files: 'read',
  run_build: 'execute',
  run_lint: 'execute',
  run_shell_command: 'execute',
  run_single_test: 'execute',
  run_tests: 'execute',
  search_files: 'search',
  write_file: 'edit',
};

/**
 * The ACP tool kind for a gth tool name; `other` for anything not built in.
 *
 * Typed against **v1's** `ToolKind`, which is the closed union of the ten defined kinds; v2 widens
 * the same union with a catch-all for future values. Typing against the stricter one is what lets a
 * single function serve both — a v1 kind is always a valid v2 kind, and the reverse is not true.
 */
export function toolKindFor(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'other';
}

/**
 * Tracks the tool calls a turn has opened, so a permission request can name the one it is about.
 *
 * A dialect's update mapper extends this and keeps the fields fed: {@link trackToolStart} when the
 * model announces a call, {@link appendToolArgs} for each argument delta, {@link trackToolSettled}
 * when a result lands.
 */
export abstract class AcpToolCallTracker {
  /**
   * Streamed argument text per tool call id, reassembled from `tool_args` deltas. Held rather than
   * forwarded per delta because ACP has no argument-delta update: `rawInput` is a whole value, so
   * it can only be sent once the deltas stop arriving.
   */
  protected readonly toolArgs = new Map<string, string>();

  /**
   * Tool calls the model has requested but which have neither produced a result nor been claimed by
   * a permission request, in the order they were announced, as `[toolCallId, toolName]`.
   *
   * Kept so the approval bridge can name the tool call a permission request is ABOUT. The gate's
   * `PendingToolInterrupt` carries the tool's name and arguments but no call id — the graph
   * suspends inside the middleware wrapping the call, which is downstream of where the id lives —
   * while the client has already drawn that call from this stream. This queue reconnects the two.
   */
  protected readonly openToolCalls: Array<[string, string]> = [];

  /** Records a newly announced call and opens its argument buffer. */
  protected trackToolStart(id: string, name: string): void {
    this.toolArgs.set(id, '');
    this.openToolCalls.push([id, name]);
  }

  /** Accumulates one streamed argument delta. */
  protected appendToolArgs(id: string, delta: string): void {
    this.toolArgs.set(id, (this.toolArgs.get(id) ?? '') + delta);
  }

  /** The reassembled arguments for a call, as a value for `rawInput`. */
  protected rawInputFor(id: string): unknown {
    return parseToolArgs(this.toolArgs.get(id));
  }

  /** Forgets a call that has produced its result. */
  protected trackToolSettled(id: string): void {
    this.toolArgs.delete(id);
    // A call a permission request already claimed is no longer in the queue; that is expected,
    // not a miss.
    const open = this.openToolCalls.findIndex(([openId]) => openId === id);
    if (open >= 0) this.openToolCalls.splice(open, 1);
  }

  /**
   * Takes the id of the unclaimed tool call that matches `name` and `args`, removing it from the
   * queue, or `undefined` when there is none.
   *
   * **Matched on the ARGUMENTS, because position is not a reliable discriminator here.** The
   * arguments are the one value both sides hold: the gate's `PendingToolInterrupt` carries them, and
   * this tracker still holds the streamed argument text at claim time (it is only discarded on
   * `tool_result`, which exists solely on the resumed run).
   *
   * **Where the exact match degrades, named rather than implied:** this side is JSON reassembled
   * from the model's streamed argument deltas, and a local model that ignores
   * `disable_parallel_tool_use` can merge sibling calls' buffers into invalid JSON (`{}{}`,
   * `{"steps":3}{}` — see the AG-UI server's `parseToolArguments` note). {@link parseToolArgs}
   * deliberately does not carry that path's recovery, so such a payload stays a raw string, matches
   * nothing, and falls back to position — on exactly the model class most likely to emit sloppy
   * parallel calls. The fallback is still the best remaining answer and the cost is which row a
   * client attaches the prompt to, never which command the human rules on.
   *
   * **Position was tried and is wrong in both directions**, which is why it is only the fallback.
   * The runner drains suspended calls as a BATCH — every pending call decided in turn before
   * anything resumes — so a model emitting two parallel calls of one tool has both open and neither
   * running. Returning "the most recent" handed BOTH requests the second call's id. But plain
   * oldest-first is no better in the case that is *normal* at the rated rungs: this method is
   * reached only from the human-approval callback, which sits behind the gate's earlier exits
   * (not-gated, deny list, bypass, the hardline floor, the allow list, and the rater's own arms), so
   * a batch where one call is settled without a human and its sibling escalates leaves the settled
   * call's id unclaimed at the head of the queue — and oldest-first then hands the request the
   * wrong one, with every upstream ordering assumption perfectly intact.
   *
   * **Consuming is right either way**, and the queue order still decides between two calls whose
   * arguments are genuinely identical, where either answer is equally true.
   *
   * Absent rather than guessed when nothing matches — a permission request pointing at the WRONG
   * call is worse than one pointing at no call, because a client would then attach the answer to a
   * call the user never saw.
   */
  claimToolCallId(name: string, args?: Record<string, unknown>): string | undefined {
    const candidates = this.openToolCalls
      .map(([id, toolName], index) => ({ id, toolName, index }))
      .filter((candidate) => candidate.toolName === name);
    if (candidates.length === 0) return undefined;
    const wanted = args === undefined ? undefined : canonicalJson(args);
    const matched =
      wanted === undefined
        ? undefined
        : candidates.find(
            (candidate) => canonicalJson(parseToolArgs(this.toolArgs.get(candidate.id))) === wanted
          );
    const chosen = matched ?? candidates[0];
    this.openToolCalls.splice(chosen.index, 1);
    return chosen.id;
  }
}

/**
 * A value serialized with object keys in sorted order, so two arguments objects that differ only in
 * key order compare equal.
 *
 * They routinely do: one side is JSON reassembled from a model's streamed argument deltas and the
 * other is the object the graph handed the gate. Comparing raw `JSON.stringify` output would make
 * the exact match in {@link AcpToolCallTracker.claimToolCallId} fail for a reason that has nothing
 * to do with whether the two describe the same call.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    );
  return `{${entries.join(',')}}`;
}

/**
 * The reassembled tool arguments as a value for `rawInput`, or `undefined` when there is nothing
 * worth sending.
 *
 * Deliberately fail-soft: a model that emits malformed argument JSON is a real and recurring
 * condition (see the AG-UI server's `parseToolArguments` note), and it must not take down the turn
 * that reports it. An unparseable payload is passed through as the raw string so the client can
 * still show what the model asked for.
 */
function parseToolArgs(raw: string | undefined): unknown {
  const text = (raw ?? '').trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
