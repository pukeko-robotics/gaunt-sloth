/**
 * @module core/approvals/promptHeader
 *
 * [[TUI-C67]] — **the one sentence the terminal approval surfaces open with**, branched on the
 * {@link ApprovalSubject} kind the decision itself already ran on. Its callers are the readline
 * session and the Ink TUI. The ACP server asks a human too but renders this sentence nowhere — it
 * builds its own permission title instead, which is [[TUI-C89]]'s to fix — so do not read "every
 * approval surface" into the line above.
 *
 * ## Why this is shared rather than written per surface
 *
 * Each terminal surface used to build the opening line from its own string literal, and both
 * literals said *the agent wants to run a shell command*. That was true while the shell was the
 * only gated tool. Since [[EXT-80]] widened the gate at `manual` and `write` to the built-in write
 * tools, MCP tools and custom tools, the most common prompt in those modes described the wrong kind
 * of action: a file write, an MCP call or a custom tool, each announced as a shell command. A
 * prompt that misnames what it is asking about is worse than a vague one, because the human answers
 * the question they were shown.
 *
 * Two literals cannot be kept in agreement by review, so there is one renderer and the surfaces own
 * only their own chrome — the same split `core/shell/framing` and `core/shell/negotiation` already
 * use, and for the same reason: two surfaces must not be able to describe one call two ways.
 *
 * ## The branch is the decision's own discriminator
 *
 * `subject.kind` is what `GthAgentRunner.decideToolApprovalInner` matched on, what
 * `core/approvals/matcher.ts` resolves rules against, and what
 * `core/approvals/mcpSubjects.ts` derives from the registered tool name against the user's own
 * `mcpServers` keys. Re-deriving the kind here from the tool name would be a **second** classifier,
 * free to disagree with the one that actually gated the call — so the subject travels on the
 * {@link import('#src/core/types.js').PendingToolInterrupt} and this module only reads it.
 *
 * ## The `tool` arm is generic on purpose
 *
 * *The agent wants to use the `<tool>` tool* names no class of action. That is deliberate and
 * ruled: what made the old prompt bad was that it was **false**, and this is merely unspecific.
 * Deriving the better sentence (*"change files"*) from the annotations the gate already read is
 * [[TUI-C83]]'s node, and it drags a coverage guard and a two-registrar audit with it. Do not read
 * the vagueness here as an oversight and do not close it with a second annotation lookup.
 */
import type { ApprovalSubject } from '#src/core/approvals/matcher.js';
import { UNRESOLVED_MCP_SERVER } from '#src/core/approvals/mcpSubjects.js';
import { neutralizeToOneLine } from '#src/core/shell/framing.js';
import type { PendingToolInterrupt } from '#src/core/types.js';

/**
 * An identifier as it may be interpolated into the prompt's **own** chrome line.
 *
 * A registered tool name is not always ours: an MCP server supplies the names in its tool listing,
 * and the `mcpTool` arm additionally prints the server-supplied short name. This line sits at
 * column 0 among the dialog's own rows, so a name carrying a newline would lay down a row that
 * looks exactly like chrome and a carriage return would walk the cursor back over it — the
 * [[TUI-C26]] forgery, reached through the one string that was never framed. `neutralizeToOneLine`
 * is core's existing answer for text that must survive as a single safe line; an ordinary name
 * passes through it byte for byte, so nothing legitimate changes shape.
 */
const identifier = (value: string): string => neutralizeToOneLine(value);

/**
 * The opening sentence of the approval prompt for one gated call, **without** any surface's own
 * punctuation or styling.
 *
 * Three arms, one per subject kind:
 *
 * - `shell` — *The agent wants to run a shell command via `<tool>`*, unchanged, so the case that was
 *   already clear stays clear.
 * - `mcpTool` — *The agent wants to call `<name>` on the MCP server `<server>`, via `<tool>`*.
 *   **Naming the server is a deliberate addition rather than a side effect**: the subject already
 *   carries it, and which server a call reaches is the one load-bearing fact the old prompt hid.
 * - `tool` — *The agent wants to use the `<tool>` tool*.
 *
 * **An MCP call whose server would print as a blank falls to the `tool` arm.** The `mcpTool`
 * sentence would otherwise read "on the MCP server , via …" — nothing where the decisive word goes.
 * The `tool` arm names the full registered name instead, which still carries the visible `mcp__`
 * namespace, and invents no prose claiming a server nothing could attribute.
 *
 * **A pending call with no subject also falls to the `tool` arm**, which is true of any gated call
 * and false of none. The runner attaches a subject to every interrupt it hands the approval
 * callback (asserted in `packages/core/spec/approvalPromptHeader.spec.ts`), so this is a floor
 * rather than a path: a surface handed a hand-built interrupt gets the vague sentence, never a
 * wrong one.
 *
 * @param pending The gated call — its registered name, and the subject the gate decided on.
 */
export function approvalPromptHeader(
  pending: Pick<PendingToolInterrupt, 'name' | 'subject'>
): string {
  const tool = identifier(pending.name);
  const subject: ApprovalSubject | undefined = pending.subject;
  if (subject?.kind === 'shell') {
    return `The agent wants to run a shell command via ${tool}`;
  }
  if (subject?.kind === 'mcpTool') {
    const server = identifier(subject.server);
    // **The guard is on the RENDERED server, not the raw one.** `UNRESOLVED_MCP_SERVER` is the
    // empty string — the one identity a user cannot spell in config — but it is not the only value
    // that reaches the screen as a blank: `neutralizeToOneLine` ends in a trim, so a server key of
    // whitespace alone, which `z.string().min(1)` admits, is empty by the time it would be printed.
    // Comparing the value before neutralisation lets exactly that key render the sentence with a
    // hole in it, which is the output this fallback exists to prevent.
    if (server !== UNRESOLVED_MCP_SERVER) {
      const name = identifier(subject.name);
      return `The agent wants to call ${name} on the MCP server ${server}, via ${tool}`;
    }
  }
  return `The agent wants to use the ${tool} tool`;
}
