/**
 * @packageDocumentation
 * Translates the agent runtime's typed {@link AgentStreamEvent} stream into ACP **v2**
 * `session/update` payloads. (`acpUpdatesV1.ts` is the v1 half; both extend the tool-call tracker
 * in `acpToolCalls.ts`, which is where the parts that are not about the dialect live.)
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
import type { SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import { AcpToolCallTracker, toolKindFor } from '#src/modules/acp/acpToolCalls.js';

/** One text content block, the shape both message chunks and tool content wrap. */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

/**
 * Turns one agent run's event stream into ACP v2 `session/update` payloads.
 *
 * One instance per prompt turn: it holds the message identity of the assistant text run and of the
 * reasoning run, plus the accumulated argument text per tool call. A fresh instance per turn is
 * what makes a new turn a new `messageId`, which is how a client tells two messages apart.
 */
export class AcpUpdateMapper extends AcpToolCallTracker {
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
        this.trackToolStart(event.id, event.name);
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
        this.appendToolArgs(event.id, event.delta);
        // [[TUI-C100]] — send the arguments as soon as they are whole, rather than waiting for the
        // call to end. A call stopped at the approval gate does not end until a human has ruled on
        // it, and the arguments are what they are ruling on.
        const rawInput = this.takeRawInputUpdate(event.id);
        if (rawInput === undefined) return [];
        return [{ sessionUpdate: 'tool_call_update', toolCallId: event.id, rawInput }];
      }
      case 'tool_end': {
        const rawInput = this.takeRawInputUpdate(event.id);
        // Status only (plus the arguments, if they have not already been sent). No title, no kind,
        // no name — the client keeps the ones the creating update set.
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
        this.trackToolSettled(event.id);
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
