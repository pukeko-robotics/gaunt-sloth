import type { BaseMessage } from '@langchain/core/messages';
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import { z } from 'zod';
import type { DebugRequestExtras, DebugToolDef } from '@gaunt-sloth/agent/core/debugCapture.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type {
  AgentResolvers,
  McpServerInstruction,
  McpConnectionFailure,
} from '@gaunt-sloth/core/core/types.js';
import { MCP_TOOL_NAME_PREFIX } from '@gaunt-sloth/core/constants.js';

/**
 * Pure renderers turning the deep agent's debug captures into the JSON strings the `/debug`
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
 * {@link AgentResolvers.getMcpServerInstructions} accessor (captured once during tool resolution and
 * reused here, NOT re-queried), so the tab shows exactly the same instruction text the system prompt
 * was composed with. React-free + defensive (missing config / accessor → empty) so it is unit
 * testable and can never blank or crash the panel. The per-server tool grouping is left to
 * {@link renderMcpDetails}, which reads the live per-request tool catalogue.
 */
export function collectMcpOverview(
  config: Pick<GthConfig, 'mcpServers'> | undefined,
  resolvers:
    | Pick<AgentResolvers, 'getMcpServerInstructions' | 'getMcpConnectionFailures'>
    | undefined
): {
  servers: string[];
  instructions: McpServerInstruction[];
  failures: McpConnectionFailure[];
} {
  const servers = Object.keys(config?.mcpServers ?? {});
  const instructions = resolvers?.getMcpServerInstructions?.() ?? [];
  const failures = resolvers?.getMcpConnectionFailures?.() ?? [];
  return { servers, instructions, failures };
}

/**
 * Render the "MCP" tab (TUI-C20): a per-server overview of the connected MCP servers. Under each
 * server it shows (a) its discovery `instructions` (from EXT-32's captured accessor, threaded in via
 * `instructions`; a server that supplied none gets a neutral line, never an empty block) and (b) its
 * contributed tools by their server-prefixed name (`mcp__<server>__<tool>`) with a one-line
 * description. Tool SCHEMAS are deliberately NOT rendered here — the intro points at the Tools tab
 * for those. `servers` is the full configured server list; `extras.tools` is the live per-turn tool
 * catalogue, regrouped by the shared {@link MCP_TOOL_NAME_PREFIX} prefix so the grouping can't drift
 * from how the resolver named them. No servers → a neutral empty state (never a throw).
 */
export function renderMcpDetails(
  extras: DebugRequestExtras | undefined,
  servers: string[],
  instructions: McpServerInstruction[],
  failures: McpConnectionFailure[] = []
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
    const prefix = `${MCP_TOOL_NAME_PREFIX}__${server}__`;
    const serverTools = tools.filter((t) => t.name.startsWith(prefix));
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
