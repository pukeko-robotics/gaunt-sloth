/**
 * @packageDocumentation
 * [[EXT-142]] — **the commands an ACP client can run in a session**, and the one command there is
 * today: the escape hatch for a refusal the user saved from the editor.
 *
 * ## Why this exists at all
 *
 * [[EXT-107]] made *Reject and remember* write to the project's deny file, and wired it on both ACP
 * dialects as well as the terminal. The control that LIFTS a saved refusal was wired on the
 * terminal only, so a refusal made in an editor was permanent from inside that editor: the only
 * ways back were to open a terminal session or to hand-edit a file the user had never been told
 * about. Those are exactly the two answers [[EXT-107]] rules out, and the reasoning does not stop
 * being true because the client speaks ACP.
 *
 * ## The protocol already has the affordance
 *
 * `available_commands_update` is a `session/update` the agent sends the client, in **both**
 * dialects (measured in `@agentclientprotocol/sdk@1.4.0`: the v1 and v2 `SessionUpdate` unions each
 * carry an `AvailableCommandsUpdate` member). The client renders it in its own command UI, so the
 * command is discoverable with its description and the user never has to learn that a file exists.
 * That is what a `_gsloth/*` `_meta` extension could not have done: `_meta` is for things the
 * protocol has no shape for, and a custom method would be invisible in the one client this is about.
 *
 * **Neither dialect gates it behind a capability.** `AgentCapabilities` / `SessionCapabilities` name
 * nothing command-related in either schema, so advertising is unconditional and the agent's
 * `initialize` response does not have to claim anything new.
 *
 * ## How a command comes back
 *
 * There is no invoke method. `PromptRequest` carries `sessionId` and `prompt` and nothing else in
 * either dialect, so a client runs an advertised command by sending it as prompt text and the agent
 * parses the leading name. {@link parseAcpSessionCommand} is that parse, and it is what keeps a
 * command off the model's turn.
 *
 * **The leading slash is a client CONVENTION, and it is the one thing here the schema does not
 * settle.** The schema says only that the input is *"all text that was typed after the command
 * name"*, and the SDK ships nothing on the client side that builds a prompt from an
 * `AvailableCommand` — so what arrives is whatever the client composes, and `/name args` is what
 * ACP's own documentation and Zed use. The parse requires the slash because the alternative is
 * worse: matching a bare leading word would intercept an ordinary message that happens to start
 * with it. **If a client's advertised command ever does nothing, this is the first place to look**
 * — the failure is safe (the text goes to the model) but it is silent, and no in-process test can
 * see it, because the harness sends what the test typed rather than what a real client composes.
 *
 * `maintenance/ux-guidelines.md`: **DL-5** — the affordance is the host protocol's own, so the
 * client draws it the way it draws every other command, rather than a private extension only a
 * client we control could see. **DL-4** — a refusal the user cannot inspect or reverse is the
 * opposite of inspectable. **DL-6** — what it lists is the shared refusal notice, with the same
 * three origin words the terminal uses, so one refusal does not mean two things across surfaces.
 *
 * ## What `/approvals` renders here, and what it deliberately does not
 *
 * The terminal's `/approvals` prints the posture notice (the current mode, the four modes it could
 * be switched to, the docs pointer, the MCP-trust usage line) and then the refusal list. **This
 * surface prints the refusal list alone.** Not an oversight and not a smaller budget: the posture
 * notice's copy names controls this surface does not offer — `/approvals <mode>` and
 * `/approvals trust` — and printing a control that is then refused is the failure the whole
 * approvals copy is written to avoid. The refusal list is the thing this node is about, and every
 * line of it is true here.
 *
 * ## One entry, and room for a second
 *
 * The registry is a list because a second command will want the same wiring, and the payload
 * builder, the parse and the dispatch are already general over it. What is deliberately NOT here is
 * the rest of the terminal's slash-command set: compaction, history, reasoning and debug are a
 * separate surface with their own questions, and porting them would have made this change about the
 * bridge instead of about the defect.
 */

import type { ApprovalRefusal, ApprovalRefusalLift } from '@gaunt-sloth/core/config.js';
import type { AcpContentBlockLike } from '#src/modules/acp/acpCommon.js';
import {
  approvalsRefusalsNotice,
  approvalsUndenyNotice,
  approvalsUsageNotice,
  parseApprovalsArg,
  type SlashCommandNotice,
} from '#src/modules/slashCommands.js';

/**
 * One command this agent advertises to an ACP client, in the dialect-neutral shape both
 * `AvailableCommand` types happen to share.
 */
export interface AcpSessionCommand {
  /** The name the client renders, and the word a prompt has to start with to invoke it. */
  readonly name: string;
  /** One sentence, shown beside the name in the client's command list. */
  readonly description: string;
  /**
   * The placeholder for whatever the user types after the name, or absent for a command that takes
   * nothing. ACP's only input variant is unstructured — everything after the name arrives as one
   * string — so this is a hint and never a schema.
   */
  readonly inputHint?: string;
}

/**
 * Every command an ACP session offers.
 *
 * Static and unconditional: the same list in every session, sent once when the session is created,
 * present whether or not anything is currently refused. A command that appeared only when it had
 * something to show would have to be re-sent whenever that changed, and would be missing at exactly
 * the moment a user went looking for it.
 */
export const ACP_SESSION_COMMANDS: readonly AcpSessionCommand[] = [
  {
    name: 'approvals',
    description:
      'List the calls that are refused in this project, and lift one you rejected by mistake.',
    inputHint: 'undeny <number> to lift a refusal, or leave empty to list them',
  },
];

/**
 * The `AvailableCommand` shape. `name` and `description` are identical in both dialects; `input` is
 * the one field they spell differently, so it is left to the two builders below.
 */
export interface AcpAvailableCommand {
  /** v2 only: the command variant's discriminator, always `command`. v1 has no such field. */
  type?: 'command';
  name: string;
  description: string;
  input?: Record<string, unknown>;
}

/**
 * The `availableCommands` payload for a **v1** `available_commands_update`.
 *
 * Returned as the array rather than the whole update because the two dialects wrap it in their own
 * `SessionUpdate` union, and each app is the thing that holds its dialect's types.
 *
 * **v1's input carries no discriminator.** Its `AvailableCommandInput` is the single variant
 * `UnstructuredCommandInput` — `{ hint }` and nothing else — so a `type` field here would be an
 * unrecognised key rather than the variant tag it is in v2. The two spellings are the whole reason
 * this is two functions and not one; everything else about the two payloads is the same.
 *
 * This is the forgiving direction — v1's schema strips the extra key, so a v2-shaped payload would
 * reach the client intact today. It is written to v1's own grammar anyway, because a key the schema
 * does not define is carried by nothing but the schema's current leniency, and `_meta` is where the
 * protocol says extras belong.
 */
export function acpAvailableCommandsV1(): AcpAvailableCommand[] {
  return ACP_SESSION_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.inputHint === undefined ? {} : { input: { hint: command.inputHint } }),
  }));
}

/**
 * The `availableCommands` payload for a **v2** `available_commands_update`.
 *
 * v2 tags the command itself as well as its input. The command is a discriminated union —
 * `Command & { type: 'command' }`, plus an open arm for variants that postdate this build — and an
 * entry without the tag does not parse, so the client's schema skips it and the whole list arrives
 * empty. The input is a union too — `TextCommandInput & { type: 'text' }` — so its tag is required. **Measured, because the
 * direction is not symmetric:** the v1 payload sent on v2 arrives at the client with `input`
 * **absent altogether**, dropped by the schema rather than degraded to the open arm, so the user
 * loses the hint that says the command takes a number. The other direction is harmless — v1's
 * schema simply strips the unknown `type` — which is why only this one can be read off the types.
 */
export function acpAvailableCommandsV2(): AcpAvailableCommand[] {
  return ACP_SESSION_COMMANDS.map((command) => ({
    type: 'command' as const,
    name: command.name,
    description: command.description,
    ...(command.inputHint === undefined
      ? {}
      : { input: { type: 'text', hint: command.inputHint } }),
  }));
}

/** An advertised command a prompt turned out to be, with whatever the user typed after it. */
export interface AcpCommandInvocation {
  /** The registry entry that matched. */
  readonly command: AcpSessionCommand;
  /** The whitespace-separated tokens after the name — the command's own argument list. */
  readonly args: string[];
}

/**
 * **Is this prompt one of our commands?** `null` for an ordinary prompt, which is the overwhelming
 * majority and has to stay untouched.
 *
 * Read off the FIRST content block rather than the flattened prompt text: that flattening
 * appends a described form of every attachment, and an attachment's own fields are
 * client-controlled text that could begin with a slash. A command is something the user invoked, so
 * only the first thing they typed can be one.
 */
export function parseAcpSessionCommand(
  prompt: readonly AcpContentBlockLike[]
): AcpCommandInvocation | null {
  const first = prompt[0];
  if (!first || first.type !== 'text') return null;
  const text = (first as unknown as { text?: unknown }).text;
  if (typeof text !== 'string') return null;
  const tokens = text.trim().split(/\s+/);
  const head = tokens[0];
  if (head === undefined || !head.startsWith('/')) return null;
  const name = head.slice(1).toLowerCase();
  const command = ACP_SESSION_COMMANDS.find((candidate) => candidate.name === name);
  if (!command) return null;
  return { command, args: tokens.slice(1) };
}

/**
 * What one command produced, as the text to put in the conversation.
 *
 * A string rather than a {@link SlashCommandNotice} because the two dialects put it in the
 * conversation differently — v2 has a whole-message update and v1 has only chunks — and neither has
 * anywhere to render a notice's tone. The title and its lines are joined the same way this surface
 * already renders the termination and outstanding-work notices.
 */
function noticeText(notice: SlashCommandNotice): string {
  return [notice.title, ...notice.lines].join('\n');
}

/**
 * [[EXT-107]] — what `/approvals` says when the list is empty, which the shared notice deliberately
 * does not answer: on the terminal an empty list prints nothing at all, because `/approvals` there
 * has already printed the posture.
 *
 * Here it is the whole of the command's answer, and silence would read as a command that did not
 * work. It also says where an entry would come from, because a user who has never saved a refusal
 * has no way to know what this list is for.
 */
function nothingRefusedNotice(): SlashCommandNotice {
  return {
    title: 'Nothing is refused',
    lines: [
      'No call is refused in this project right now, so there is nothing to lift.',
      'Answering a permission request with Reject and remember saves that exact call here, and ' +
        'this is where you take it back.',
    ],
    tone: 'info',
  };
}

/**
 * The arms of the terminal's `/approvals` that this surface does not offer, answered rather than
 * guessed at.
 *
 * `/approvals <mode>` and `/approvals trust` both parse — the parser is shared, which is what keeps
 * the number handling identical — so without this they would fall through to the list and a user
 * would read a successful-looking answer to a command that changed nothing. Saying where those two
 * do live is the whole of the help they need.
 */
function unsupportedVerbNotice(): SlashCommandNotice {
  return {
    title: 'This command lists refused calls and lifts them',
    lines: [
      'Run it with nothing after it to see what is refused, each line numbered, and ' +
        'undeny <number> to lift one of them. Nothing was changed.',
      'The approvals mode and which MCP servers’ annotations are believed are set in this ' +
        'project’s config file, not from an editor session.',
    ],
    tone: 'warn',
  };
}

/** The part of the runner one of these commands needs. */
export interface AcpCommandTarget {
  getRefusals(): ApprovalRefusal[];
  liftRefusal(index: number): ApprovalRefusalLift;
}

/**
 * Run one advertised command and return what the client should be told.
 *
 * Pure apart from the runner it is handed: no protocol types, no connection, no dialect. Both apps
 * call this and then put the string in the conversation in their own dialect's shape.
 *
 * The argument parse and every notice but the two above are the SHARED ones the terminal surfaces
 * render. That matters most for the number: `parseApprovalsArg` rejects a non-integer, a zero and a
 * negative rather than coercing them, because this command REMOVES a protection and a coerced
 * argument would remove a different one than the user named. A second parser here would be free to
 * drift from that on any later edit.
 */
export function runAcpSessionCommand(
  runner: AcpCommandTarget,
  invocation: AcpCommandInvocation
): string {
  const action = parseApprovalsArg(invocation.args);
  if (action === null || 'rung' in action || 'trust' in action) {
    return noticeText(unsupportedVerbNotice());
  }
  if ('usage' in action) return noticeText(approvalsUsageNotice(action.usage));
  if ('undeny' in action) {
    // [[EXT-107]] — the notice is built from what the runner RETURNS, so it can only describe the
    // refusal actually lifted: a configured entry is reported and never removed, and a lift whose
    // file rewrite did not land says so rather than promising it will not come back.
    return noticeText(approvalsUndenyNotice(runner.liftRefusal(action.undeny.index)));
  }
  const refusals = runner.getRefusals();
  return noticeText(approvalsRefusalsNotice(refusals) ?? nothingRefusedNotice());
}
