/**
 * @packageDocumentation
 * Bridges the agent's tool-approval gate to ACP **v1**'s `session/request_permission`.
 * (`acpPermissions.ts` is the v2 half and carries the reasoning both share.)
 *
 * **The gate must reach a human on this surface too.** [[EXT-54]] records what happens otherwise:
 * a server that wires no approval callback does not get a quieter gate, it gets a gated tool that
 * silently does nothing. A new dialect is a new surface, and the hole reopens per surface unless
 * each one answers it.
 *
 * ## What v1 has instead of v2's `subject`
 *
 * v2 carries a request-level `title`, an optional `description`, and a structured `subject` that
 * can say "this is a shell command, here it is, and here is its cwd". **v1 has none of those**: a
 * `RequestPermissionRequest` is a session id, a `ToolCallUpdate`, and the options. So:
 *
 * - the command travels as `rawInput`, which is where a v1 client reads a tool call's arguments;
 * - the gate's explanation — the rater's verdict, the escalation entry that fired, what a
 *   remembered answer would store — travels as the tool call's `content`, the only free-text field
 *   in the request. Dropping it is not an option: a user asked to rule on a call their own
 *   configuration should have approved reads an unexplained prompt as the gate malfunctioning.
 *
 * The `toolCall` field is an UPSERT against the call the client is already rendering, so every
 * descriptive field is sent with the same values the creating `tool_call` update carried. Re-sending
 * them is a no-op for a call the client knows, and it is what lets the request stand on its own for
 * a call the client has never seen — which is what a minted id means.
 *
 * ## Untrusted text crosses this boundary as DATA, deliberately
 *
 * The command, the rater's reason and the escalation provenance are all model- or third-party-
 * authored, and they are not painted through `core/shell/framing` here. That is not an oversight:
 * these values leave as JSON fields of a structured request and the client draws them in its own
 * UI, where terminal control codes are inert, and framing them would ship a line-number gutter into
 * a GUI. What matters is that they stay in their own fields rather than being interpolated into the
 * prompt's own prose, so nothing the model writes can impersonate the request itself.
 */

import type {
  RequestPermissionRequest,
  SessionId,
  ToolCallContent,
} from '@agentclientprotocol/sdk';
import type { PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';
import { ACP_PERMISSION_OPTIONS } from '#src/modules/acp/acpPermissions.js';
import { toolKindFor } from '#src/modules/acp/acpToolCalls.js';

/** The gated tool whose argument is a shell command. */
const SHELL_TOOL = 'run_shell_command';

/**
 * The human-readable explanation for the prompt: everything the gate knows about WHY this call
 * reached a human.
 *
 * Assembled from the same three sources the terminal surfaces show, for the same reason. Empty when
 * the gate has nothing to add, in which case no content is attached rather than an empty block.
 */
function descriptionFor(pending: PendingToolInterrupt): string | undefined {
  const parts: string[] = [];
  if (pending.safetyVerdict) {
    parts.push(
      `AI rater: ${pending.safetyVerdict.outcome} — ${pending.safetyVerdict.reason}`.trimEnd()
    );
  }
  if (pending.escalatedBy) {
    parts.push(`Your approvals.escalate list matched this call: ${pending.escalatedBy}`);
  }
  if (pending.grantPreview) {
    parts.push(`"Allow and remember" will store: ${pending.grantPreview}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** The shell command a pending call would run, when it is one and it is a plain string. */
function shellCommandOf(pending: PendingToolInterrupt): string | undefined {
  if (pending.name !== SHELL_TOOL) return undefined;
  const command = pending.args.command;
  return typeof command === 'string' ? command : undefined;
}

/** One tool-call content entry wrapping a line of text. */
function toolText(text: string): ToolCallContent {
  return { type: 'content', content: { type: 'text', text } };
}

/**
 * What the request puts in front of the human, beyond the tool's name and arguments.
 *
 * The command comes first when there is one: v2 can say "this is a command" structurally and v1
 * cannot, so on this dialect the only way to put it where a person ruling on it will read it is to
 * spell it out. The gate's own explanation follows.
 */
function explanationFor(pending: PendingToolInterrupt): ToolCallContent[] {
  const command = shellCommandOf(pending);
  const description = descriptionFor(pending);
  return [
    ...(command === undefined ? [] : [toolText(`Shell command: ${command}`)]),
    ...(description === undefined ? [] : [toolText(description)]),
  ];
}

/** The ACP v1 permission request for one pending tool call the gate escalated to a human. */
export function permissionRequestForV1(options: {
  sessionId: SessionId;
  pending: PendingToolInterrupt;
  /** The tool call id the update stream already announced for this call, when it is known. */
  toolCallId?: string;
}): RequestPermissionRequest {
  const { sessionId, pending, toolCallId } = options;
  const content = explanationFor(pending);
  return {
    sessionId,
    toolCall: {
      // A request about a call the update stream never announced still needs an id. It is minted
      // rather than omitted — the field is required — and carries the same descriptive fields a
      // creating update would, so the client renders the tool by name instead of an empty row.
      toolCallId: toolCallId ?? `permission-${pending.name}`,
      name: pending.name,
      // The SAME title the creating update sent. This request is an upsert against a call the
      // client is already drawing, so a different title here would rename that row mid-flight.
      title: pending.name,
      kind: toolKindFor(pending.name),
      status: 'pending',
      rawInput: pending.args,
      ...(content.length === 0 ? {} : { content }),
    },
    options: [...ACP_PERMISSION_OPTIONS],
  };
}
