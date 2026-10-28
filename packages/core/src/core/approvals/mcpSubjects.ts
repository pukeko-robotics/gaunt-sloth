/**
 * EXT-70 (spec §4.7.5) — **which approval subject a registered tool name presents**.
 *
 * The distinction this module exists to make is the one §4.7.1 rests on: a `tool` subject's
 * annotations are read **verbatim**, an `mcpTool` subject's are believed only per hint and only
 * where the user said so. So a tool that reaches a third-party server while presenting as
 * `kind: 'tool'` is a gate that server can opt itself out of — the exact failure §4.7.1 names.
 * Every name carrying the MCP namespace therefore becomes an `mcpTool` subject, and there is no
 * path back to `kind: 'tool'` for one.
 *
 * ## The server comes from the bindings recorded at tool load, never from the name
 *
 * An MCP tool is registered as `mcp__<server><sep><tool>`, where `<server>` is the user's own
 * `mcpServers` key — the identity §4.7.5 requires — and `<sep>` is the adapter's server separator
 * ({@link MCP_SERVER_SEPARATOR}). **A registered name does not determine its server.** A key may
 * itself contain the separator, so with configured keys `github` and `github_enterprise` and a
 * single-underscore separator, `mcp__github_enterprise_search` is equally `github`'s tool
 * `enterprise_search` and `github_enterprise`'s tool `search`. Every string rule fails one of the
 * two: longest-prefix hands a `github` tool to `github_enterprise` (and a server picks its own tool
 * names, so an untrusted server can choose a name that borrows another server's trust and rules);
 * shortest-prefix does the mirror; and refusing nested keys silently disarms every server-scoped
 * rule — deny included — for both servers of any such pair.
 *
 * So the server is read from a {@link McpToolBindings} map, recorded by the resolver at the one
 * moment it is known exactly: when each server's tools are loaded, grouped under the key they were
 * loaded for ({@link bindMcpToolsets}). That map is authoritative because it is built from the
 * user's keys and the adapter's own per-server grouping, and because building it refuses a
 * duplicate registered name instead of letting one entry overwrite another — so no name can map to
 * two servers.
 *
 * A name that is not in the map resolves to {@link UNRESOLVED_MCP_SERVER}, which is still an
 * `mcpTool` subject. Failing closed to "an MCP tool under a server we cannot name" is the only safe
 * answer; falling back to `kind: 'tool'` would hand an unidentifiable tool the trusted provenance.
 *
 * @module
 */
import {
  MCP_NAMESPACE_SEPARATOR,
  MCP_SERVER_SEPARATOR,
  MCP_TOOL_NAME_PREFIX,
} from '#src/constants.js';
import type { McpToolApprovalSubject, ToolApprovalSubject } from '#src/core/approvals/matcher.js';

/** The `mcp__` namespace every MCP tool name carries. */
const MCP_NAME_PREFIX = `${MCP_TOOL_NAME_PREFIX}${MCP_NAMESPACE_SEPARATOR}`;

/**
 * The server identity an MCP tool call gets when its name is not in the bindings recorded at tool
 * load — the tool was not loaded this session, or it was loaded by nothing that records bindings.
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

/** Which configured server one bound MCP tool belongs to, and the server's own name for it. */
export interface McpToolBinding {
  /** The user's own `mcpServers` key the tool was loaded under. */
  server: string;
  /** The tool's name as the server advertises it, without our namespace or the server key. */
  tool: string;
}

/**
 * Registered tool name → {@link McpToolBinding}, recorded when the tools load. The only source of
 * server attribution for an MCP tool name (see the module docs for why the name cannot be one).
 */
export type McpToolBindings = ReadonlyMap<string, McpToolBinding>;

/** The empty bindings: every MCP-namespaced name resolves to {@link UNRESOLVED_MCP_SERVER}. */
export const NO_MCP_TOOL_BINDINGS: McpToolBindings = new Map();

/** Does this registered tool name sit in the MCP namespace? */
export function isMcpNamespacedToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_NAME_PREFIX);
}

/**
 * The registered tool name the adapter emits for one server's tool. Used to NAME a tool whose
 * server is already known (our synthesized resource tools; the prefix a server's tools are expected
 * to carry when its bindings are recorded). It is not injective — two different `(server, tool)`
 * pairs can produce the same string — so it must never be run backwards to find a server.
 */
export function mcpToolRegisteredName(server: string, toolName: string): string {
  return `${MCP_NAME_PREFIX}${server}${MCP_SERVER_SEPARATOR}${toolName}`;
}

/**
 * Thrown by {@link bindMcpToolsets} when two loaded tools share one registered name. The adapter
 * itself refuses the same collision across servers, and the resolver treats this exactly like
 * that refusal.
 */
export class McpToolNameCollisionError extends Error {
  constructor(
    readonly toolName: string,
    readonly servers: readonly [string, string]
  ) {
    super(
      `MCP tool name collision: "${toolName}" is registered by both "${servers[0]}" and ` +
        `"${servers[1]}". Rename one of the servers in mcpServers so their tool names differ.`
    );
    this.name = 'McpToolNameCollisionError';
  }
}

/**
 * Record the {@link McpToolBindings} for tools loaded per server.
 *
 * Each entry pairs a configured server key with the tools loaded **for that key** — the adapter's
 * per-server catalog, or tools we synthesized for that server. The server is therefore known, not
 * inferred, and the bare tool name is what follows that server's own prefix.
 *
 * - A tool whose name does not start with its own server's prefix is left out, so it resolves to
 *   {@link UNRESOLVED_MCP_SERVER}: a naming we did not expect is not a reason to guess.
 * - **A registered name loaded twice throws {@link McpToolNameCollisionError}** rather than letting
 *   the later entry overwrite the earlier. An overwrite would attribute one server's tool to
 *   another, which is the misattribution this map exists to make impossible. The same name listed
 *   twice under the same server is not an attribution conflict — both entries name one server —
 *   so it is recorded once and left to whatever handles duplicate tool names.
 */
export function bindMcpToolsets(
  toolsets: Iterable<readonly [server: string, tools: readonly { name?: unknown }[]]>
): McpToolBindings {
  const bindings = new Map<string, McpToolBinding>();
  for (const [server, tools] of toolsets) {
    if (server === UNRESOLVED_MCP_SERVER) continue;
    const prefix = mcpToolRegisteredName(server, '');
    for (const tool of tools) {
      const name = tool?.name;
      if (typeof name !== 'string' || !name.startsWith(prefix)) continue;
      const bare = name.slice(prefix.length);
      if (bare.length === 0) continue;
      const existing = bindings.get(name);
      if (existing) {
        if (existing.server === server && existing.tool === bare) continue;
        throw new McpToolNameCollisionError(name, [existing.server, server]);
      }
      bindings.set(name, { server, tool: bare });
    }
  }
  return bindings;
}

/**
 * The subset of `bindings` whose names are in `names` — what an agent keeps of a resolver's map, so
 * a binding for a tool this session did not load can never attribute anything.
 */
export function restrictMcpToolBindings(
  bindings: McpToolBindings | undefined,
  names: Iterable<unknown>
): McpToolBindings {
  if (!bindings || bindings.size === 0) return NO_MCP_TOOL_BINDINGS;
  const kept = new Map<string, McpToolBinding>();
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const binding = bindings.get(name);
    if (binding) kept.set(name, binding);
  }
  return kept;
}

/**
 * §4.7.1/§4.7.5 — the subject a gated call on `toolName` presents to the rule matcher.
 *
 * A name outside the MCP namespace is one of ours (a built-in, or a tool the user wired into their
 * own config): `kind: 'tool'`, the trusted provenance. A name inside it is `kind: 'mcpTool'`
 * **always** — with the server and bare name its binding records, and with
 * {@link UNRESOLVED_MCP_SERVER} and the whole name when it has none.
 *
 * @param toolName The registered tool name, exactly as the model called it.
 * @param bindings The bindings recorded when this session's tools loaded. Nothing a server declares
 *   about its own name participates, and nothing is parsed out of `toolName` (§4.7.5).
 */
export function approvalSubjectForToolName(
  toolName: string,
  bindings: McpToolBindings
): ToolApprovalSubject | McpToolApprovalSubject {
  if (!isMcpNamespacedToolName(toolName)) return { kind: 'tool', name: toolName };
  const binding = bindings.get(toolName);
  if (!binding || binding.server === UNRESOLVED_MCP_SERVER || binding.tool.length === 0) {
    return { kind: 'mcpTool', server: UNRESOLVED_MCP_SERVER, name: toolName };
  }
  return { kind: 'mcpTool', server: binding.server, name: binding.tool };
}
