import type { BaseMessage } from '@langchain/core/messages';
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import { z } from 'zod';
import type { DebugRequestExtras, DebugToolDef } from '@gaunt-sloth/agent/core/debugCapture.js';
import type { GthConfig, ResolvedApprovals } from '@gaunt-sloth/core/config.js';
import { APPROVAL_RUNG_LABELS, isRatedRung } from '@gaunt-sloth/core/config.js';
import type {
  AgentResolvers,
  McpServerInstruction,
  McpConnectionFailure,
} from '@gaunt-sloth/core/core/types.js';
import type {
  ApprovalCaptureAction,
  ApprovalDecidingStage,
  ApprovalDecisionCapture,
  ApprovalHumanAnswer,
} from '@gaunt-sloth/core/core/shell/approvalCapture.js';
import { neutralizeUntrustedText } from '@gaunt-sloth/core/core/shell/framing.js';
import { redactForToolDisplay } from '@gaunt-sloth/core/core/toolDisplay.js';
import {
  NO_MCP_TOOL_BINDINGS,
  type McpToolBindings,
} from '@gaunt-sloth/core/core/approvals/mcpSubjects.js';

/**
 * Pure renderers turning the agent's debug captures into the JSON strings the `/debug`
 * panel shows. Kept React-free so they are unit-testable in isolation; the panel just splits
 * the result on newlines into its bounded viewport.
 */

/**
 * Render "Sent to model (chat history)": the real `request.messages` at call time. Uses
 * LangChain's `mapChatMessagesToStoredMessages` so each message is a plain, JSON-stable record
 * (type + content + kwargs) rather than a class instance. Defensive: a non-serializable payload
 * degrades to a readable fallback instead of throwing inside the render path.
 */
export function renderHistory(messages: BaseMessage[]): string {
  try {
    const stored = mapChatMessagesToStoredMessages(messages);
    return withDescription(HISTORY_TAB_DESCRIPTION, JSON.stringify(stored, null, 2));
  } catch (err) {
    return `(could not render history: ${err instanceof Error ? err.message : String(err)})`;
  }
}

const HISTORY_TAB_DESCRIPTION =
  'The message list sent to the model at call time, each message as a JSON-stable record. The ' +
  'system prompt is shown separately on the System prompt tab.';

/**
 * Render "Raw model response": the resolved `AIMessage` returned by the handler. We try the
 * stored-message form first (consistent with the history view); if the value is not a chat
 * message we fall back to a plain JSON dump, then to `String()`.
 */
export function renderResponse(response: unknown): string {
  try {
    if (isBaseMessage(response)) {
      return JSON.stringify(mapChatMessagesToStoredMessages([response]), null, 2);
    }
    return JSON.stringify(response, null, 2);
  } catch (err) {
    return `(could not render response: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * TUI-C16 (2): a short, plain-language note leading each "Sent to model" tab — what this slice of
 * the request is and why it shapes the turn. It is set off from the content by a rule but scrolls
 * WITH it (not a fixed header), so it costs no permanent screen estate.
 */
function withDescription(description: string, body: string): string {
  return `${description}\n${'─'.repeat(8)}\n\n${body}`;
}

const SYSTEM_TAB_DESCRIPTION =
  'System prompt and params. The standing instructions and scalar settings that frame every ' +
  'turn: model params, the tool-choice policy, then the system prompt itself. Sent once per ' +
  'call, ahead of the conversation.';

const TOOLS_TAB_DESCRIPTION =
  'Tools the model may call this turn. Names first, for an at-a-glance overview; then each ' +
  "tool's full description and parameter schema below.";

/**
 * Render the "System prompt" tab (TUI-C16): the non-message, non-tool parts that also shape a
 * turn — the scalar model params, the tool-choice config and the system prompt itself. The tool
 * catalogue lives on its own tab (see {@link renderToolDetails}) so the system prompt stands
 * alone. These come pre-filtered (key-free) from the capture site; this renderer only formats
 * them readably. Each part degrades to a note rather than throwing, so the `/debug` panel never
 * blanks on an odd payload. Long content that TUI-C4's maximise makes usable.
 */
export function renderSystemDetails(extras: DebugRequestExtras | undefined): string {
  if (!extras) return '(no request details captured yet)';
  const sections: string[] = [];

  sections.push('=== MODEL PARAMS ===');
  sections.push(extras.modelParams ? safeJson(extras.modelParams) : '(no model params captured)');

  if (extras.toolChoice !== undefined) {
    sections.push('');
    sections.push('=== TOOL CHOICE ===');
    sections.push(safeJson(extras.toolChoice));
  }

  sections.push('');
  sections.push('=== SYSTEM PROMPT ===');
  sections.push(extras.systemPrompt ? extras.systemPrompt : '(no system prompt captured)');

  return withDescription(SYSTEM_TAB_DESCRIPTION, sections.join('\n'));
}

/**
 * Render the "Tools" tab (TUI-C16 (3)): the tool catalogue the model may call this turn. Leads
 * with a compact list of tool NAMES as an at-a-glance overview of what the model can call, then
 * the full per-tool descriptors (description + JSON-schema params) below. Split out of the system
 * view so you no longer scroll past the whole system prompt to reach the tools.
 */
export function renderToolDetails(extras: DebugRequestExtras | undefined): string {
  if (!extras) return '(no request details captured yet)';
  const tools = extras.tools ?? [];
  const sections: string[] = [];

  sections.push(`=== TOOLS (${tools.length}) ===`);
  if (tools.length > 0) {
    // (3) at-a-glance name list first …
    for (const tool of tools) sections.push(`• ${tool.name}`);
    // … then the full descriptors below.
    sections.push('');
    sections.push('=== TOOL DEFINITIONS ===');
    for (const tool of tools) {
      sections.push('');
      sections.push(renderToolDef(tool));
    }
  } else {
    sections.push('(no tools captured)');
  }

  return withDescription(TOOLS_TAB_DESCRIPTION, sections.join('\n'));
}

const MCP_TAB_DESCRIPTION =
  'MCP server overview. For each connected MCP server: its discovery instructions and the tools it ' +
  'contributes (shown with the same server-prefixed names the model calls). This is the overview, ' +
  "not the schemas. For a tool's full description and parameter schema, see the Tools tab.";

/**
 * TUI-C20: gather the session-stable inputs the MCP debug tab needs — the configured MCP server
 * list and each server's captured discovery instructions. Instructions come from EXT-32's
 * `AgentResolvers.getMcpServerInstructions` accessor (captured once during tool resolution and
 * reused here, NOT re-queried), so the tab shows exactly the same instruction text the system prompt
 * was composed with. React-free + defensive (missing config / accessor → empty) so it is unit
 * testable and can never blank or crash the panel. The per-server tool grouping is left to
 * {@link renderMcpDetails}, which reads the live per-request tool catalogue.
 */
export function collectMcpOverview(
  config: Pick<GthConfig, 'mcpServers'> | undefined,
  resolvers:
    | Pick<
        AgentResolvers,
        'getMcpServerInstructions' | 'getMcpConnectionFailures' | 'getMcpToolBindings'
      >
    | undefined
): {
  servers: string[];
  instructions: McpServerInstruction[];
  failures: McpConnectionFailure[];
  bindings: McpToolBindings;
} {
  const servers = Object.keys(config?.mcpServers ?? {});
  const instructions = resolvers?.getMcpServerInstructions?.() ?? [];
  const failures = resolvers?.getMcpConnectionFailures?.() ?? [];
  const bindings = resolvers?.getMcpToolBindings?.() ?? NO_MCP_TOOL_BINDINGS;
  return { servers, instructions, failures, bindings };
}

/**
 * Render the "MCP" tab (TUI-C20): a per-server overview of the connected MCP servers. Under each
 * server it shows (a) its discovery `instructions` (from EXT-32's captured accessor, threaded in via
 * `instructions`; a server that supplied none gets a neutral line, never an empty block) and (b) its
 * contributed tools by their registered name with a one-line description. Tool SCHEMAS are
 * deliberately NOT rendered here — the intro points at the Tools tab for those. `servers` is the
 * full configured server list; `extras.tools` is the live per-turn tool catalogue, grouped under a
 * server by `bindings` — the resolver's record of which server each tool was loaded under — and
 * never by name prefix, because a server key may contain the adapter's separator and one server's
 * prefix can then be the start of another's. No servers → a neutral empty state (never a throw).
 */
export function renderMcpDetails(
  extras: DebugRequestExtras | undefined,
  servers: string[],
  instructions: McpServerInstruction[],
  failures: McpConnectionFailure[] = [],
  bindings: McpToolBindings = NO_MCP_TOOL_BINDINGS
): string {
  const sections: string[] = [];
  sections.push(`=== MCP SERVERS (${servers.length}) ===`);

  if (servers.length === 0) {
    sections.push('(no MCP servers configured)');
    return withDescription(MCP_TAB_DESCRIPTION, sections.join('\n'));
  }

  const instructionByServer = new Map(instructions.map((i) => [i.server, i.instructions]));
  const failureByServer = new Map(failures.map((f) => [f.server, f.reason]));
  const tools = extras?.tools ?? [];

  for (const server of servers) {
    sections.push('');
    sections.push(`── ${server} ──`);

    // A server that failed to connect contributes no tools — say so, with the reason, instead of
    // leaving a bare "(no tools loaded)" line that reads as "connected, but empty". Shown first so
    // the failure is the headline for this server; instructions/tools are naturally empty below.
    const failureReason = failureByServer.get(server);
    if (failureReason) {
      sections.push(`  ⚠ connection failed: ${failureReason}`);
    }

    // (a) discovery instructions — the SAME text EXT-32 injected into the system prompt.
    const serverInstructions = instructionByServer.get(server);
    sections.push('instructions:');
    if (serverInstructions) {
      for (const line of serverInstructions.split('\n')) sections.push(`  ${line}`);
    } else {
      sections.push('  (no instructions provided)');
    }

    // (b) the server's tools by their server-prefixed name + a one-line description.
    const serverTools = tools.filter((t) => bindings.get(t.name)?.server === server);
    sections.push(`tools (${serverTools.length}):`);
    if (serverTools.length > 0) {
      for (const tool of serverTools) {
        const oneLine = tool.description ? tool.description.split('\n')[0].trim() : '';
        sections.push(oneLine ? `  • ${tool.name}: ${oneLine}` : `  • ${tool.name}`);
      }
    } else if (failureReason) {
      sections.push('  (none — server unavailable, see above)');
    } else {
      sections.push('  (no tools loaded for this server)');
    }
  }

  return withDescription(MCP_TAB_DESCRIPTION, sections.join('\n'));
}

const AUTO_TAB_DESCRIPTION =
  'Auto-mode: what the approvals gate did with each gated tool call, and — the point of this tab — ' +
  'WHICH STAGE decided it. "Escalated" on its own does not distinguish a rater verdict from a ' +
  'deterministic floor match from a deny-list hit, and those need different answers. Most recent ' +
  'call first. The rater config in force is at the top; the full rater prompt and its raw answer ' +
  'are not drawn here — they are in the /debug-dump archive.';

/**
 * **Which stage decided**, in the words a reader of this tab needs.
 *
 * A total `Record` on purpose, for two reasons. A stage added to
 * {@link @gaunt-sloth/core!core/shell/approvalCapture.ApprovalDecidingStage | ApprovalDecidingStage} is a compile error until someone writes its sentence,
 * which is the same guarantee `MECHANISM_NOTES` and `APPROVAL_RUNG_LABELS` buy. And it puts the
 * distinction this whole tab exists for in ONE table, so a test can pin each stage to its own
 * wording rather than to an enum value that reads the same for every branch.
 */
const STAGE_LABELS: Record<ApprovalDecidingStage, string> = {
  'not-gated': 'the rung in force does not gate this tool',
  'invalid-cwd': 'the requested working directory does not exist or is not a directory',
  'deny-list': 'a declared deny entry (or an earlier "always reject")',
  bypass: 'nothing — the gate is off for this session',
  'hardline-floor': 'the deterministic hardline floor, before any rating',
  'escalate-entry': 'a declared escalate entry — straight to a person, no rating',
  'allow-list': 'a declared allow entry, with no rating',
  'allow-tripwire': 'a declared allow entry that kept the rater on as a tripwire',
  rater: 'the auto-rater',
  'tool-open-world-floor': 'the open-world floor on a non-shell tool call',
  'unrated-rung': 'the rung itself — it consults no model, so a person decides',
};

/** What became of the call, in the words the notices use. */
const ACTION_LABELS: Record<ApprovalCaptureAction, string> = {
  approve: 'approved — the tool ran',
  reject: 'rejected',
  escalate: 'escalated to a person',
  halt: 'halted the run',
  error: 'the decision itself errored',
};

/**
 * How an escalation ended once it reached (or failed to reach) a person.
 *
 * [[EXT-110]] — the non-answers read differently on purpose. `no-human` is a question that was
 * never put to anybody, because the surface wired no way to ask; `teardown` is one that was put to
 * a surface and went away unanswered, whoever or whatever ended it; and [[EXT-193]]'s
 * `unrecognised` is one that came back answered in a dialect this build cannot read. All of them
 * mean the command did not run, and
 * a reader chasing an incident needs to know which happened — above all, that none of them is the
 * refusal `reject` alone reports.
 */
const HUMAN_ANSWER_LABELS: Record<ApprovalHumanAnswer, string> = {
  approve: 'yes, and they approved',
  reject: 'yes, and they refused',
  'no-human': 'no — nobody was at the keyboard',
  teardown: 'asked, but the session ended before anyone answered',
  unrecognised: 'asked, but the answer came back in a form this build could not read',
};

/**
 * Render the "Auto-mode" tab ([[TUI-C27]]): the approvals gate's own record of every gated tool
 * call this session, plus the rater config in force.
 *
 * **Newest first, which deliberately differs from `approvals.json` in the `/debug-dump` archive.**
 * The archive is read in a text editor with the whole file in reach, so chronological order is the
 * natural one there. This tab is an eight-row viewport, and the call a person opened it about is
 * almost always the last one — putting the oldest of fifty records under the description would make
 * the common case a scroll to the bottom.
 *
 * **The rater's prompt and raw answer are deliberately not drawn.** They are the archive's job (the
 * capture holds them and `/debug-dump` writes them), each is kilobytes, and they are the most
 * sensitive thing the record carries. The description says where they live so nobody reads their
 * absence as them not being recorded.
 *
 * **Every free-text leaf goes through the SAME on-screen policy the tool panels use** —
 * {@link @gaunt-sloth/core!core/toolDisplay.redactForToolDisplay | redactForToolDisplay} then {@link @gaunt-sloth/core!core/shell/framing.neutralizeUntrustedText | neutralizeUntrustedText}, in that order
 * (see this module's `safeText`) — because these records carry the user's own commands. Applied per LEAF and
 * never to the assembled block: the neutraliser escapes newlines, so neutralising the whole thing
 * would collapse the tab into one unreadable line.
 */
export function renderApprovalDetails(
  captures: readonly ApprovalDecisionCapture[],
  approvals: ResolvedApprovals | undefined
): string {
  const sections: string[] = [];

  sections.push('=== RATER CONFIG ===');
  if (approvals) {
    sections.push(
      `rung in force: ${APPROVAL_RUNG_LABELS[approvals.rung]} ` +
        `(${isRatedRung(approvals.rung) ? 'consults the rater' : 'consults no model'})`
    );
    sections.push(`rater profile: ${safeText(approvals.rater ?? '(the session model)')}`);
    sections.push(
      `alignment checker profile: ${safeText(approvals.alignmentChecker ?? '(the session model)')}`
    );
    sections.push(
      `rater timeout: ${
        approvals.raterTimeoutMs === undefined ? '(the default)' : `${approvals.raterTimeoutMs} ms`
      }`
    );
    sections.push(
      `declared entries: ${approvals.allow.length} allow · ${approvals.deny.length} deny · ` +
        `${approvals.escalate.length} escalate`
    );
  } else {
    sections.push('(this session has no approvals surface)');
  }

  sections.push('');
  sections.push(`=== GATED CALLS (${captures.length}) — most recent first ===`);
  if (captures.length === 0) {
    sections.push('(no tool call has been through the gate yet)');
    return withDescription(AUTO_TAB_DESCRIPTION, sections.join('\n'));
  }

  const newestFirst = [...captures].reverse();
  newestFirst.forEach((record, i) => {
    sections.push('');
    for (const line of approvalRecordLines(record, i + 1, newestFirst.length)) sections.push(line);
  });

  return withDescription(AUTO_TAB_DESCRIPTION, sections.join('\n'));
}

/** One gated call, from arrival to outcome. */
function approvalRecordLines(
  record: ApprovalDecisionCapture,
  position: number,
  total: number
): string[] {
  const lines: string[] = [];
  lines.push(`── ${position} of ${total} · ${safeText(record.at)} · ${safeText(record.tool)} ──`);
  if (record.command !== undefined) lines.push(`  command: ${safeText(record.command)}`);
  lines.push(`  rung in force: ${APPROVAL_RUNG_LABELS[record.rung]}`);
  // The headline. `stage` is absent only when the decision threw before reaching one, and that is
  // said outright rather than left as a blank a reader would read as the recorder having failed.
  lines.push(
    `  decided by: ${
      record.stage ? STAGE_LABELS[record.stage] : '(the decision ended before any stage decided)'
    }`
  );
  lines.push(
    `  outcome: ${record.action ? ACTION_LABELS[record.action] : '(no outcome recorded)'}`
  );
  if (record.scope) lines.push(`  granted for: ${record.scope}`);
  if (record.humanAnswer) {
    lines.push(`  a person was asked: ${HUMAN_ANSWER_LABELS[record.humanAnswer]}`);
  }

  if (record.hardline) {
    lines.push(`  hardline floor: ${safeText(record.hardline.description)}`);
    // Naming the matched pattern is the §8.1 resolution this node took, and the same one the
    // archive took: §8.1 governs rung descriptions and promotional copy, not a diagnostic view a
    // user opens about their own session, where "a floor matched" is not actionable.
    lines.push(`    matched pattern: ${safeText(record.hardline.pattern)}`);
  }

  if (record.ruleMatch) {
    lines.push(`  list entry: ${record.ruleMatch.action} — ${safeText(record.ruleMatch.entry)}`);
    if (record.ruleMatch.rate !== undefined) {
      lines.push(`    rater kept on as a tripwire: ${yesNo(record.ruleMatch.rate)}`);
    }
  }

  if (record.preflight) {
    lines.push(`  preflight: ${record.preflight.kind} — ${safeText(record.preflight.reason)}`);
    // Two different questions, and reporting either one alone misattributes the decision: whether
    // the rating sat below the floor, and whether the decision's readers applied the floor at all.
    lines.push(`    rewrote the rating: ${yesNo(record.preflight.rewroteRating)}`);
    lines.push(`    applied to the decision: ${yesNo(record.preflight.floorApplied)}`);
    if (record.preflight.carvedHosts?.length) {
      lines.push(
        `    hosts the user named: ${record.preflight.carvedHosts.map(safeText).join(', ')}`
      );
    }
  }

  if (record.parserUnresolved) {
    // This is what remains of "was the call an abstain": not an outcome of its own, but the gate
    // parser's shape report on a command it could not statically resolve, carried into the rating
    // as neutral context. A rated call with this block and a rated call without it are two
    // different stories about the same stage.
    lines.push(`  command not statically resolvable: ${record.parserUnresolved.mechanism}`);
    for (const note of record.parserUnresolved.notes) lines.push(`    note: ${safeText(note)}`);
  }

  lines.push(...ratingLines(record));
  lines.push(...alignmentLines(record));

  lines.push(
    `  negotiation budget: ${record.budget.consecutiveRejections}/${record.budget.maxConsecutive} ` +
      `consecutive rejections · ${record.budget.rejectionsSinceHuman}/${record.budget.maxBeforeHuman} ` +
      'since a person was involved'
  );
  if (record.error) lines.push(`  error: ${safeText(record.error)}`);
  return lines;
}

/** The rating call, when one was made. Its absence is itself reported — it names the stage. */
function ratingLines(record: ApprovalDecisionCapture): string[] {
  const rating = record.rating;
  if (!rating) return ['  rating: none — no model was consulted for this call'];
  const lines: string[] = [];
  lines.push(
    rating.verdict
      ? `  rating: ${rating.verdict.outcome} — ${safeText(rating.verdict.reason)}`
      : '  rating: sent, but no answer was recorded'
  );
  lines.push(
    `    rater model: ${safeText(rating.model ?? '(not recorded)')}` +
      ` · profile: ${safeText(rating.profile ?? '(the session model)')}` +
      ` · ${rating.durationMs === undefined ? 'still in flight' : `${rating.durationMs} ms`}` +
      ` (budget ${rating.timeoutMs} ms)`
  );
  lines.push(`    a rejection would go back to the agent: ${yesNo(rating.negotiable)}`);
  if (rating.failClosed) {
    // The distinction a bug report cannot make without this line: the gate decided, not the model.
    lines.push(`    fail-closed: ${rating.failClosed} — the gate decided this, not the rater`);
  }
  if (rating.providerError) {
    const parts: string[] = [];
    if (rating.providerError.status !== undefined)
      parts.push(`HTTP ${rating.providerError.status}`);
    if (rating.providerError.message) parts.push(safeText(rating.providerError.message));
    if (rating.providerError.withheld) parts.push('(provider message withheld)');
    lines.push(`    provider error: ${parts.length ? parts.join(' — ') : '(no detail)'}`);
  }
  return lines;
}

/** The alignment check, when the classifier declined and a checker was consulted. */
function alignmentLines(record: ApprovalDecisionCapture): string[] {
  const alignment = record.alignment;
  if (!alignment) return [];
  const lines: string[] = [];
  lines.push(
    alignment.decision
      ? `  alignment check: ${alignment.decision.kind} — ${safeText(alignment.decision.reason)}`
      : '  alignment check: sent, but no decision was recorded'
  );
  if (alignment.decision?.suggestedCommand) {
    lines.push(`    suggested instead: ${safeText(alignment.decision.suggestedCommand)}`);
  }
  lines.push(
    `    checker profile: ${safeText(alignment.profile ?? '(the session model)')}` +
      ` · ${alignment.durationMs === undefined ? 'still in flight' : `${alignment.durationMs} ms`}` +
      ` (budget ${alignment.timeoutMs} ms)`
  );
  if (alignment.failClosed) {
    lines.push(`    fail-closed: ${alignment.failClosed} — the gate decided this, not the checker`);
  }
  return lines;
}

/**
 * One free-text leaf, ready for the screen.
 *
 * **Redact first, neutralise second — never the reverse**, the same order and the same reasoning as
 * the tool panels (`parseChecklistArgs`, `toolDisplay.formatParamValue`): a literal secret carrying
 * a control character stops matching the moment that character is rewritten to a printable escape,
 * so neutralising first can leave a secret on screen that redacting first would have caught.
 *
 * The secret SET is `toolDisplay`'s, not one harvested here — a second harvest outside core has no
 * registered config to read the inline `apiKey` literals from, and would be a visibly-redacted
 * surface with a weaker guarantee than the panel beside it.
 */
function safeText(value: string): string {
  return neutralizeUntrustedText(redactForToolDisplay(value));
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** Format one tool definition: name, description, then its JSON-schema params. */
function renderToolDef(tool: DebugToolDef): string {
  const lines: string[] = [`• ${tool.name}`];
  if (tool.description) {
    for (const d of tool.description.split('\n')) lines.push(`    ${d}`);
  }
  const schema = renderToolSchema(tool.schema);
  if (schema) {
    lines.push('    params:');
    for (const s of schema.split('\n')) lines.push(`      ${s}`);
  }
  return lines.join('\n');
}

/**
 * Render a tool's parameter schema. LangChain tools carry either a Zod schema or an already
 * JSON-schema-shaped object; we convert Zod via `zodToJsonSchema` and fall back to a plain
 * JSON dump (then to nothing) so an unusual shape never throws inside the render path.
 */
function renderToolSchema(schema: unknown): string | undefined {
  if (schema === undefined || schema === null) return undefined;
  try {
    if (isZodSchema(schema)) {
      // Zod v4 ships a native JSON-schema converter; this is the canonical params shape.
      return JSON.stringify(z.toJSONSchema(schema as z.ZodType), null, 2);
    }
    return JSON.stringify(schema, null, 2);
  } catch {
    // A non-convertible schema (odd shape / unsupported node) must never blank the panel.
    try {
      return JSON.stringify(schema, null, 2);
    } catch {
      return undefined;
    }
  }
}

function isZodSchema(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('_def' in (value as Record<string, unknown>) ||
      typeof (value as { safeParse?: unknown }).safeParse === 'function')
  );
}

/** JSON.stringify that degrades to a readable note instead of throwing on odd values. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return `(could not render: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function isBaseMessage(value: unknown): value is BaseMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    typeof (value as { _getType?: unknown })._getType === 'function'
  );
}
