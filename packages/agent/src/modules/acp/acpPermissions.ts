/**
 * @packageDocumentation
 * Bridges the agent's tool-approval gate to ACP v2's `session/request_permission`.
 *
 * **This is the reason the ACP server drives {@link GthAgentRunner} rather than an agent
 * directly.** The runner is what owns the gate — the bypass check, the allow-list, the AI rater,
 * the deny list, and finally the human callback — and a surface that skips it does not get a
 * quieter gate, it gets a gated tool that silently does nothing (the hole [[EXT-54]] records
 * against the AG-UI and the old ACP servers). Everything here is the last hop of that gate: the
 * runner has already decided the call needs a human, and this turns "needs a human" into a request
 * an editor can put in front of one, then turns the answer back into a decision the runner
 * understands.
 *
 * ## Untrusted text crosses this boundary as DATA, deliberately
 *
 * The command, the rater's reason and the escalation provenance are all model- or third-party-
 * authored. On the terminal surfaces they are painted through `core/shell/framing` because a
 * carriage return there reaches column 0 and an escape sequence clears the screen. **That renderer
 * is not applied here, and its absence is not an oversight:** these values leave as JSON fields of
 * a structured request, and the client draws them in its own UI, where terminal control codes are
 * inert. Framing them would ship a line-number gutter and box drawing into a GUI. What matters on
 * this surface is that they stay in their own fields rather than being interpolated into the
 * prompt's own prose — so a client can style them as untrusted, and nothing the model writes can
 * impersonate the request's title.
 *
 * ## [[EXT-137]] — what this surface does instead of a fixed block, stated rather than rediscovered
 *
 * The terminal surfaces split the prompt in two: a pinned block carrying only text we wrote, and
 * the scrollable conversation carrying everything else. **That split is an Ink concept and does not
 * transfer here, because this surface owns no layout at all** — the editor decides what is pinned,
 * what truncates and in which direction.
 *
 * What IS ours is the shape of the request, and this dialect already has the property the terminal
 * split had to be built to get: the command travels in `subject`, the gate's explanation in
 * `description`, and the `title` is our own line. So an attacker padding a URL's path lengthens a
 * structured field the client renders as data, and changes nothing about the request's own prose.
 * The residue is named honestly at {@link permissionRequestFor} — the non-shell title interpolates
 * the registered tool name, which for an MCP tool is partly a third-party server's — and that line
 * is [[TUI-C89]]'s to settle, not something to close from here.
 */

import type { PermissionOption } from '@agentclientprotocol/sdk';
import type {
  PermissionOptionId,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  RequestPermissionSubject,
  SessionId,
} from '@agentclientprotocol/sdk/experimental/v2';
import type {
  ApprovalLifetime,
  PendingToolInterrupt,
  ToolApprovalDecision,
} from '@gaunt-sloth/core/core/types.js';
import { toolKindFor } from '#src/modules/acp/acpToolCalls.js';

/** The gated tool whose argument is a shell command, and so has an ACP `command` subject. */
const SHELL_TOOL = 'run_shell_command';

/**
 * The four answers offered on every permission request, one per ACP `PermissionOptionKind`.
 *
 * The set is fixed rather than computed from what the gate would accept, because a menu that
 * appears and disappears per call is a menu a user cannot learn. What each one MEANS is in
 * {@link decisionForOutcome}; the labels say it in words, since a bare kind hint does not tell
 * anyone what "always" persists to.
 *
 * **Both dialects offer this same menu, so it is typed against v1's `PermissionOption`** — the
 * stricter of the two, since v2 widens `PermissionOptionKind` with a catch-all. A value valid for
 * v1 is valid for v2; the reverse would not compile, which is the point of choosing this direction.
 */
export const ACP_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow and remember', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Reject and remember', kind: 'reject_always' },
];

/** The shell command a pending call would run, when it is one and it is a plain string. */
function shellCommandOf(pending: PendingToolInterrupt): string | undefined {
  if (pending.name !== SHELL_TOOL) return undefined;
  const command = pending.args.command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * The structured `subject` for a pending call: a `command` subject when the gate stopped a shell
 * command (so the client can show the command as a command), a `tool_call` subject otherwise.
 *
 * `toolCallId` correlates the request with the tool call the client is ALREADY rendering from the
 * `session/update` stream — the model emits its tool call before the graph suspends on the gate,
 * so by the time a permission request goes out the client has drawn the call and is waiting on it.
 * Without the correlation the prompt is about a tool call the client cannot point at.
 */
function subjectFor(
  pending: PendingToolInterrupt,
  toolCallId: string | undefined,
  cwd: string
): RequestPermissionSubject {
  const command = shellCommandOf(pending);
  if (command !== undefined) {
    return {
      type: 'command',
      command,
      cwd,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    };
  }
  return {
    type: 'tool_call',
    toolCall: {
      // A `tool_call` subject has nowhere to put "no id", so a call the update stream never
      // announced still needs one. It is minted rather than omitted, and it is the same shape a
      // creating `tool_call_update` would carry, so a client that renders the subject shows the
      // tool by name instead of an empty row.
      toolCallId: toolCallId ?? `permission-${pending.name}`,
      name: pending.name,
      title: pending.name,
      kind: toolKindFor(pending.name),
      status: 'pending',
      rawInput: pending.args,
    },
  };
}

/**
 * The human-readable explanation for the prompt: everything the gate knows about WHY this call
 * reached a human.
 *
 * Assembled from the same three sources the terminal surfaces show — the rater's verdict, the
 * declared `approvals.escalate` entry that fired, and what a remembered answer would store — for
 * the same reason: a user asked to rule on a call their configuration should have approved reads
 * an unexplained prompt as the gate malfunctioning. Empty when the gate has nothing to add, in
 * which case the field is omitted rather than sent as an empty string.
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

/** The ACP permission request for one pending tool call the gate escalated to a human. */
export function permissionRequestFor(options: {
  sessionId: SessionId;
  pending: PendingToolInterrupt;
  /** The tool call id the update stream already announced for this call, when it is known. */
  toolCallId?: string;
  /** The session's working directory — the `cwd` a `command` subject is required to carry. */
  cwd: string;
}): RequestPermissionRequest {
  const { sessionId, pending, toolCallId, cwd } = options;
  const command = shellCommandOf(pending);
  const description = descriptionFor(pending);
  return {
    sessionId,
    // The title is the AGENT's own words and carries **no command-derived text**: what the model
    // wrote is in the subject, where a client can style it as the model's. That is the property
    // [[EXT-137]] pins — on the shell arm this is a constant, so padding a URL's path to any length
    // cannot change a byte of the line a person reads before answering.
    //
    // **The `tool` arm interpolates the registered name, and for an MCP tool that name is partly a
    // third-party server's**, so "no untrusted text at all" would overstate it. It is left as it is
    // deliberately: the name is what makes the prompt about a call the client is already drawing,
    // this surface's title is not a fixed-height row that truncation can empty, and the ACP
    // permission title is [[TUI-C89]]'s to settle rather than something to change from here.
    title: command !== undefined ? 'Run a shell command' : `Run the ${pending.name} tool`,
    ...(description === undefined ? {} : { description }),
    subject: subjectFor(pending, toolCallId, cwd),
    options: [...ACP_PERMISSION_OPTIONS],
  };
}

/**
 * [[EXT-154]] — **what one of the two remembering answers actually did**, in a sentence for the
 * editor's conversation, sent once the runner has said what the answer landed as.
 *
 * `maintenance/ux-guidelines.md` (DL-4): a confirmation states what LANDED, and waits for it if it
 * has to. *Allow and remember* and *Reject and remember* both promise a project file, and the write
 * is attempted after the {@link ToolApprovalCallback} has returned — so the labels are an offer and
 * this is the only place either promise can be checked. The other two options record nothing, so
 * they earn no sentence and are not sent one.
 *
 * ## The copy is this surface's, not the terminal's
 *
 * Re-earned rather than pasted across, as the guidelines require of every claim ACP renders. The
 * client is an editor: there is no menu key to name, no `/approvals undeny` to point at (an editor
 * has no slash commands — the gap [[EXT-142]] owns), and *allow-list* / *deny-list* are the
 * terminal's vocabulary for something an editor user only ever meets as project settings. What
 * carries over is the answer's own word — *remembered* — because that is what the option said.
 *
 * ## Three cases, where the terminal surfaces have two
 *
 * **This menu is fixed** — all four options on every request, so a user can learn it — which means
 * *Allow and remember* is offered where the gate has nothing to store: a `catastrophic` verdict, a
 * command that does not statically resolve, a call nothing can attribute. There the answer records
 * NOTHING, not even for the session, and `landed` is `once`. The terminal menus hide the control in
 * exactly those cases and so cannot reach it; telling that user *this session only* would be a
 * second false claim in place of the one this removes.
 */
export function rememberedAnswerNote(
  decision: 'approve' | 'reject',
  landed: ApprovalLifetime
): string {
  if (decision === 'approve') {
    if (landed === 'always')
      return "Allowed and remembered — this exact command is saved to this project's approvals settings and will run without asking in future sessions.";
    if (landed === 'session')
      return "Allowed for this session only — this project's approvals settings could not be written, so the next session will ask about this command again.";
    return 'Allowed for this one call only — nothing was remembered, so the next identical call will ask again.';
  }
  if (landed === 'always')
    return "Rejected and remembered — this exact call is saved to this project's approvals settings and will be refused without asking in future sessions.";
  if (landed === 'session')
    return "Rejected for this session only — this project's approvals settings could not be written, so the next session will ask about this call again.";
  return 'Rejected for this one call only — nothing was remembered, so the next identical call will ask again.';
}

/**
 * The gate decision an ACP permission outcome means.
 *
 * **Every path that is not an explicit allow is a reject**, including an option id we do not
 * recognise and an outcome variant that postdates this code. That polarity is the whole safety
 * property: a client that answers with something unexpected must not be able to run a command,
 * and a future ACP outcome must fail toward refusing rather than toward executing.
 *
 * `allow-always` maps to the `always` scope, which persists to the project allow-list — the same
 * thing the terminal menu's *always approve* does. [[EXT-107]] — `reject-always` is now its mirror
 * and maps to `always` too, persisting to the project deny-list. One menu item cannot mean two
 * lifetimes across three surfaces: the same answer given in the TUI, at the readline prompt and in
 * an editor over ACP has to be the same refusal, or a user who learns the control on one surface
 * has learned something untrue about the others. Both labels say "remember" so the user is told
 * which pair of choices is written down.
 */
export function decisionForOutcome(outcome: RequestPermissionOutcome): ToolApprovalDecision {
  if (outcome.outcome !== 'selected') {
    return { type: 'reject', message: 'The client cancelled the permission request.' };
  }
  const optionId = (outcome as { optionId?: PermissionOptionId }).optionId;
  switch (optionId) {
    case 'allow-once':
      return { type: 'approve' };
    case 'allow-always':
      return { type: 'approve', scope: 'always' };
    case 'reject-always':
      return { type: 'reject', scope: 'always', message: 'The user rejected this tool call.' };
    case 'reject-once':
      return { type: 'reject', message: 'The user rejected this tool call.' };
    default:
      return {
        type: 'reject',
        message: `The client selected an unknown permission option (${String(optionId)}).`,
      };
  }
}
