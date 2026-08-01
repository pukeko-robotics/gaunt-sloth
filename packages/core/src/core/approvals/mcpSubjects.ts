/**
 * @module core/approvals/mcpSubjects
 *
 * EXT-70 (spec §4.7.5) — **which approval subject a registered tool name presents**.
 *
 * The distinction this module exists to make is the one §4.7.1 rests on: a `tool` subject's
 * annotations are read **verbatim**, an `mcpTool` subject's are believed only per hint and only
 * where the user said so. So a tool that reaches a third-party server while presenting as
 * `kind: 'tool'` is a gate that server can opt itself out of — the exact failure §4.7.1 names.
 * Every name carrying the MCP namespace therefore becomes an `mcpTool` subject, and there is no
 * path back to `kind: 'tool'` for one.
 *
 * ## The server is resolved against the configured keys, never by splitting
 *
 * An MCP tool is named `mcp__<server>__<tool>` (the mcp-adapters convention, single-sourced from
 * {@link MCP_TOOL_NAME_PREFIX}), where `<server>` is the user's own `mcpServers` key — the identity
 * §4.7.5 requires. **A key may itself contain `__`**, so splitting on the separator attributes such
 * a tool to a shorter key that also happens to be configured, and the wrong server means the wrong
 * TRUST lookup: one server's tool wearing another server's belief. Resolution is therefore a scan
 * of the configured key set for the keys that actually prefix this name.
 *
 * Where that does not yield **exactly one** key — no configured server matches, or two nested keys
 * both do — the call resolves to {@link UNRESOLVED_MCP_SERVER}, which is still an `mcpTool`
 * subject. Failing closed to "an MCP tool under a server we cannot name" is the only safe answer;
 * falling back to `kind: 'tool'` would hand an unidentifiable tool the trusted provenance.
 */
import { MCP_TOOL_NAME_PREFIX } from '#src/constants.js';
import type { McpToolApprovalSubject, ToolApprovalSubject } from '#src/core/approvals/matcher.js';

/** The separator mcp-adapters puts between the prefix, the server key and the tool name. */
const NAME_SEPARATOR = '__';

/** The `mcp__` namespace every MCP tool name carries. */
const MCP_NAME_PREFIX = `${MCP_TOOL_NAME_PREFIX}${NAME_SEPARATOR}`;

/**
 * The server identity an MCP tool call gets when its name does not resolve to exactly one
 * configured `mcpServers` key — nothing matched, or two nested keys both did.
 *
 * **The empty string, and that is load-bearing rather than arbitrary.** A server key is
 * `z.string().min(1)` both under `approvals.mcp.servers` (§9) and on an `mcpTool` rule entry
 * (§3.1), so this value is the one identity a user *cannot spell in config*: no entry can name it.
 * An unresolvable call is therefore matchable only by the reserved `server: "*"` (which means every
 * server and is correct here).
 *
 * Being unspellable is what makes it unnameable; it is **not** by itself what makes it untrusted,
 * because a lookup that misses under `servers` falls through to `approvals.mcp.defaults`. That
 * second half is enforced in `trustedAnnotationHints`, which refuses this value outright, and in
 * `mcpDeclaredAnnotationLookup`, which will not look a declaration up under it. Both are required:
 * the first stops a permissive `defaults` reaching an unattributable call, the second stops one
 * being found by string arithmetic on the sentinel.
 */
export const UNRESOLVED_MCP_SERVER = '';

/** Does this registered tool name sit in the MCP namespace? */
export function isMcpNamespacedToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_NAME_PREFIX);
}

/**
 * The registered tool name mcp-adapters emits for one server's tool — the inverse of
 * {@link approvalSubjectForToolName}'s split, single-sourced so a declared-annotation lookup keyed
 * by registered name round-trips exactly instead of re-deriving the separator.
 */
export function mcpToolRegisteredName(server: string, toolName: string): string {
  return `${MCP_NAME_PREFIX}${server}${NAME_SEPARATOR}${toolName}`;
}

/**
 * §4.7.1/§4.7.5 — the subject a gated call on `toolName` presents to the rule matcher.
 *
 * A name outside the MCP namespace is one of ours (a built-in, or a tool the user wired into their
 * own config): `kind: 'tool'`, the trusted provenance. A name inside it is `kind: 'mcpTool'`
 * **always** — with its resolved server where the configured keys name exactly one, and with
 * {@link UNRESOLVED_MCP_SERVER} otherwise.
 *
 * @param toolName The registered tool name, exactly as the model called it.
 * @param configuredMcpServers `Object.keys(config.mcpServers)` — the user's own keys, and the only
 *   thing consulted. Nothing a server declares about its own name ever participates (§4.7.5).
 */
export function approvalSubjectForToolName(
  toolName: string,
  configuredMcpServers: Iterable<string>
): ToolApprovalSubject | McpToolApprovalSubject {
  if (!isMcpNamespacedToolName(toolName)) return { kind: 'tool', name: toolName };

  let resolved: McpToolApprovalSubject | undefined;
  for (const server of configuredMcpServers) {
    // An empty key is unnameable in `approvals.mcp.servers` and on an `mcpTool` entry, so resolving
    // to it would be indistinguishable from not resolving at all — treat it as the latter.
    if (server === UNRESOLVED_MCP_SERVER) continue;
    const prefix = mcpToolRegisteredName(server, '');
    if (!toolName.startsWith(prefix)) continue;
    const name = toolName.slice(prefix.length);
    if (name.length === 0) continue;
    // A second matching key means two nested server names both explain this tool. Neither is more
    // right than the other, so neither is used.
    if (resolved) return { kind: 'mcpTool', server: UNRESOLVED_MCP_SERVER, name: toolName };
    resolved = { kind: 'mcpTool', server, name };
  }

  // Nothing configured explains the name: keep the whole name as the tool's identity, since there
  // is no server key to strip and guessing at one is exactly what this function refuses to do.
  return resolved ?? { kind: 'mcpTool', server: UNRESOLVED_MCP_SERVER, name: toolName };
}
