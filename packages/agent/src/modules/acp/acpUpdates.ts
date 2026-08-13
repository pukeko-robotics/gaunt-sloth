/**
 * @packageDocumentation
 * Translates the agent runtime's typed {@link AgentStreamEvent} stream into ACP v2
 * `session/update` payloads.
 *
 * Kept as a pure, stateful-but-transport-free mapper rather than inlined in the request handlers
 * for two reasons. It is the half of the ACP surface with real logic — message identity, tool-call
 * upserts, which events open and close a run — so it is the half worth testing without a
 * connection. And the `session/update` **upsert semantics** live here and nowhere else: what the
 * mapper omits is what a client must leave unchanged, so a mapper that re-sent a full replacement
 * on every update would silently erase fields a client had already rendered.
 *
 * ## The upsert contract this mapper is written against
 *
 * A client applies updates per id, in arrival order: an omitted field leaves the stored value
 * unchanged, `null` clears it, a concrete value replaces it, and a chunk appends. The first
 * `tool_call_update` a client sees for a `toolCallId` CREATES the tool call. So the mapper sends
 * the descriptive fields **once**, on the creating update, and every later update for that call
 * carries only what actually changed — which is what makes a client's rendering of a running tool
 * call correct rather than flickering back to a bare id.
 */

import { randomUUID } from 'node:crypto';
import type { SessionUpdate, ToolKind } from '@agentclientprotocol/sdk/experimental/v2';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';

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

/** The ACP tool kind for a gth tool name; `other` for anything not built in. */
export function toolKindFor(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'other';
}

/** One text content block, the shape both message chunks and tool content wrap. */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

/**
 * Turns one agent run's event stream into ACP `session/update` payloads.
 *
 * One instance per prompt turn: it holds the message identity of the assistant text run and of the
 * reasoning run, plus the accumulated argument text per tool call. A fresh instance per turn is
 * what makes a new turn a new `messageId`, which is how a client tells two messages apart.
 */
export class AcpUpdateMapper {
  /**
   * `messageId` of the assistant text message currently being streamed, or `null` when no text run
   * is open. Cleared whenever something else interrupts the text (a tool call, a reasoning block),
   * so the text that resumes afterwards is a NEW message rather than an append to the one the
   * client already considers finished.
   */
  private assistantMessageId: string | null = null;

  /** `messageId` of the reasoning message currently being streamed, or `null` outside one. */
  private thoughtMessageId: string | null = null;

  /**
   * Streamed argument text per tool call id, reassembled from `tool_args` deltas. Held rather than
   * forwarded per delta because ACP has no argument-delta update: `rawInput` is a whole value, so
   * it can only be sent once the deltas stop arriving.
   */
  private readonly toolArgs = new Map<string, string>();

  /**
   * Tool calls the model has requested but which have neither produced a result nor been claimed by
   * a permission request, in the order they were announced, as `[toolCallId, toolName]`.
   *
   * Kept so the approval bridge can name the tool call a permission request is ABOUT. The gate's
   * `PendingToolInterrupt` carries the tool's name and arguments but no call id — the graph
   * suspends inside the middleware wrapping the call, which is downstream of where the id lives —
   * while the client has already drawn that call from this stream. This queue reconnects the two.
   */
  private readonly openToolCalls: Array<[string, string]> = [];

  /**
   * Takes the id of the OLDEST unclaimed tool call of `name`, removing it from the queue, or
   * `undefined` when there is none.
   *
   * **Consumed, because the gate drains interrupts as a BATCH.** The runner asks for every pending
   * call at once and loops over the array deciding each in turn; no result can arrive in between,
   * because results only exist on the resumed run. So when a model emits two parallel calls of the
   * same tool — routine on Anthropic and OpenAI — both are open and neither is running. Returning
   * "the most recent" would hand BOTH permission requests the second call's id, and a client would
   * attach one call's prompt, and its answer, to the other's row. Popping the queue is what stops a
   * second request re-claiming the first's id.
   *
   * **Oldest-first is the best available pairing, not a guarantee.** This queue is in the order the
   * model announced the calls; the runner iterates `getPendingToolInterrupts()`, which flattens
   * `state.tasks[].interrupts[].value.actionRequests[]` — and that innermost array is built by
   * LangChain's `humanInTheLoopMiddleware`, not by us. FIFO matches the two under the natural
   * assumption that the middleware preserves the AI message's `tool_call` order, which is not
   * something this code can enforce. **If it ever did not, the cost is UI attribution and nothing
   * more:** each request carries its own `command`/`rawInput` in its subject, and the runner applies
   * decisions positionally over its own array, so the human still rules on the right call and the
   * right decision still reaches it.
   *
   * Absent rather than guessed when nothing matches — a permission request pointing at the WRONG
   * call is worse than one pointing at no call, because a client would then attach the answer to a
   * call the user never saw.
   */
  claimToolCallId(name: string): string | undefined {
    const index = this.openToolCalls.findIndex(([, toolName]) => toolName === name);
    if (index < 0) return undefined;
    return this.openToolCalls.splice(index, 1)[0][0];
  }

  /**
   * The `session/update` payloads one runtime event produces — usually one, sometimes none
   * (`tool_args`, which only accumulates; the reasoning boundaries, which only move state).
   */
  map(event: AgentStreamEvent): SessionUpdate[] {
    switch (event.type) {
      case 'text': {
        this.assistantMessageId ??= randomUUID();
        return [
          {
            sessionUpdate: 'agent_message_chunk',
            messageId: this.assistantMessageId,
            content: textBlock(event.delta),
          },
        ];
      }
      case 'reasoning_start': {
        this.assistantMessageId = null;
        this.thoughtMessageId = randomUUID();
        return [];
      }
      case 'reasoning_delta': {
        this.thoughtMessageId ??= randomUUID();
        return [
          {
            sessionUpdate: 'agent_thought_chunk',
            messageId: this.thoughtMessageId,
            content: textBlock(event.delta),
          },
        ];
      }
      case 'reasoning_end': {
        this.thoughtMessageId = null;
        return [];
      }
      case 'tool_start': {
        // A tool call ends the open text run: the text that follows the tool is a separate message.
        this.assistantMessageId = null;
        this.toolArgs.set(event.id, '');
        this.openToolCalls.push([event.id, event.name]);
        // The CREATING update — the first one a client sees for this id. Everything descriptive is
        // sent here and never resent, because from here on omission means "unchanged".
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.id,
            name: event.name,
            title: event.name,
            kind: toolKindFor(event.name),
            status: 'pending',
          },
        ];
      }
      case 'tool_args': {
        this.toolArgs.set(event.id, (this.toolArgs.get(event.id) ?? '') + event.delta);
        return [];
      }
      case 'tool_end': {
        const rawInput = parseToolArgs(this.toolArgs.get(event.id));
        // Status only (plus the arguments, once they are complete). No title, no kind, no name —
        // the client keeps the ones the creating update set.
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.id,
            status: 'in_progress',
            ...(rawInput === undefined ? {} : { rawInput }),
          },
        ];
      }
      case 'tool_output': {
        // Live output from an executing tool. A CHUNK, not an update: it appends to whatever the
        // client has for this call, where a `tool_call_update` carrying `content` would replace it.
        if (event.id === undefined) return [];
        return [
          {
            sessionUpdate: 'tool_call_content_chunk',
            toolCallId: event.id,
            content: { type: 'content', content: textBlock(event.chunk) },
          },
        ];
      }
      case 'tool_result': {
        this.toolArgs.delete(event.id);
        // A call a permission request already claimed is no longer in the queue; that is expected,
        // not a miss.
        const open = this.openToolCalls.findIndex(([id]) => id === event.id);
        if (open >= 0) this.openToolCalls.splice(open, 1);
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.id,
            status: event.isError ? 'failed' : 'completed',
            content: [{ type: 'content', content: textBlock(event.content) }],
          },
        ];
      }
    }
  }
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
