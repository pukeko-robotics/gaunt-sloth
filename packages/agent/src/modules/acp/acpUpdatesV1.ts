/**
 * @packageDocumentation
 * Translates the agent runtime's typed {@link AgentStreamEvent} stream into ACP **v1**
 * `session/update` payloads. (`acpUpdates.ts` is the v2 half.)
 *
 * ## Where v1 differs, and why the mapper could not be shared
 *
 * The two dialects report the same events, but not with the same messages, and each difference
 * changes what a conforming client ends up rendering:
 *
 * - **v1 has a distinct `tool_call` update that CREATES a tool call**, where v2 folded creation into
 *   the first `tool_call_update`. Sending only `tool_call_update`s on v1 would leave a client
 *   patching a call it was never told about.
 * - **v1 has no `tool_call_content_chunk`.** Its `tool_call_update.content` REPLACES the whole
 *   collection, so live tool output is streamed by accumulating it here and resending the
 *   collection — the opposite of v2, where each chunk appends and only a `tool_call_update` replaces.
 * - **v1 has no `state_update`.** There is nowhere to report `running` / `requires_action` / `idle`,
 *   and no notification carries the stop reason: the turn's outcome is the `session/prompt`
 *   RESPONSE. See `acpAgentAppV1.ts`.
 * - **A prompt turn does not echo the user's message.** v1 reserves replay for `session/load`; a
 *   client already renders what it sent, so echoing it would draw the message twice.
 *
 * What is NOT duplicated is tool-call identity — the kind hint, the argument reassembly, and the
 * pairing that lets a permission request name the call it is about all come from
 * {@link AcpToolCallTracker}.
 */

import { randomUUID } from 'node:crypto';
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import { AcpToolCallTracker, toolKindFor } from '#src/modules/acp/acpToolCalls.js';

/** One text content block, the shape both message chunks and tool content wrap. */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

/** One tool-call content entry wrapping a text block. */
function toolText(text: string): ToolCallContent {
  return { type: 'content', content: textBlock(text) };
}

/**
 * Turns one agent run's event stream into ACP v1 `session/update` payloads.
 *
 * One instance per prompt turn: it holds the message identity of the assistant text run and of the
 * reasoning run, the accumulated argument text per tool call, and the output accumulated for each
 * running tool. A fresh instance per turn is what makes a new turn a new `messageId`, which is how
 * a client tells two messages apart.
 */
export class AcpV1UpdateMapper extends AcpToolCallTracker {
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
   * Live output accumulated per tool call, because v1 can only REPLACE a tool call's content.
   *
   * With no append-a-chunk update in the dialect, the only way to show a tool's output as it
   * arrives is to resend everything seen so far; keeping the collection here is what makes each
   * replacement a superset of the last rather than a flicker back to the newest line alone.
   */
  private readonly toolOutput = new Map<string, ToolCallContent[]>();

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
        this.toolOutput.set(event.id, []);
        // v1's CREATE. `title` is required here, and everything descriptive is sent with it; the
        // later `tool_call_update`s carry only what changed.
        return [
          {
            sessionUpdate: 'tool_call',
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
        if (event.id === undefined) return [];
        const collected = this.toolOutput.get(event.id) ?? [];
        collected.push(toolText(event.chunk));
        this.toolOutput.set(event.id, collected);
        // The whole collection, because v1 replaces rather than appends. Copied so a later push
        // cannot mutate an update already handed to the transport.
        return [
          { sessionUpdate: 'tool_call_update', toolCallId: event.id, content: [...collected] },
        ];
      }
      case 'tool_result': {
        this.trackToolSettled(event.id);
        this.toolOutput.delete(event.id);
        // The result REPLACES whatever live output was showing — it is the authoritative record of
        // what the tool produced, and the same thing v2's final update does.
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.id,
            status: event.isError ? 'failed' : 'completed',
            content: [toolText(event.content)],
          },
        ];
      }
    }
  }
}
