/**
 * BATCH-43 / EXT-211 — recover the **server's own error body** from an errored MCP tool result, so
 * `gth eval`'s `tool_result_json_path` can grade *what a denial said* and not merely that one
 * happened.
 *
 * ## What the adapter hands back
 *
 * `@langchain/mcp-adapters` answers a tool result carrying `isError: true` in one of two ways,
 * depending on how the tool was invoked:
 *
 * - **As a tool call** (how the agent's tool node always invokes it): a `ToolMessage` with
 *   `status: 'error'`, whose `content` is the server's own text with nothing added, and whose
 *   `artifact` keeps the result's `structuredContent` (an entry of type `mcp_structured_content`)
 *   and `_meta` (`mcp_meta`). A result with no text gets the stock sentence *The MCP tool returned
 *   an error without text content.* as its content, so its detail survives only in the artifact.
 * - **With plain arguments**: it throws a `ToolException` whose message is a fixed prose prefix
 *   followed by the result's flattened text, and the softening middleware turns that message into
 *   the observation. Nothing structured survives on this path.
 *
 * ## The order the body is taken in, and why
 *
 * 1. **The artifact's `structuredContent`, serialised as JSON.** It is the server's error body in
 *    the shape the server chose, it is the only place a structured-only error's detail exists, and
 *    when a server sends both forms the structured one is the one it defined a schema for. Text is
 *    free-form, so where the two disagree the structured body is the authoritative one to grade.
 * 2. **The text after the plain-argument prefix**, which is the only body the throwing path keeps.
 *    The adapter still throws that form, so this stays for as long as anything installed can produce
 *    it; on the tool-call path content never starts with the prefix and this never fires.
 * 3. **Nothing**, and the grading check falls back to the observed `content`. On the tool-call path
 *    that is already the server's bare text, so a text-only JSON error grades with no field at all.
 *
 * `_meta` is never a source. It is protocol metadata about the result, not the server's error body,
 * and preferring it would make a text-only JSON error that grades today stop grading.
 *
 * ## The prefix is COMPUTED, never matched
 *
 * The alternative — hunt the message for something that looks like JSON — needs a rule for which
 * JSON is *the* JSON when a message contains several, and a heuristic like that has no business in
 * a deterministic grading path: its failure mode is a plausible wrong parse that the suite author
 * cannot see. Every variable in the adapter's template is one we already hold, so the exact
 * expected prefix can be built and stripped. When the constructed prefix is not what the message
 * starts with, **nothing is recovered and no field is recorded**.
 *
 * Because the prefix is an upstream template literal, a dependency bump that rewords it would
 * silently stop the field ever being recorded. `packages/agent/spec/mcpAdapterErrorMessage.spec.ts`
 * therefore drives the real adapter against a real in-memory MCP server and compares its thrown
 * message to {@link mcpToolErrorMessagePrefix}'s output, and pins the tool-call shape beside it.
 *
 * ## The server name is RESOLVED, never split off the registered name
 *
 * The adapter's template names the server by its `mcpServers` key and the tool by its **bare**
 * name, while the registered name the model calls carries both behind our namespace. A configured
 * key may itself contain the server separator, so the registered name does not determine its
 * server. Resolution goes through {@link approvalSubjectForToolName}, which reads the bindings
 * recorded when the tools loaded, so a recovered payload and an approvals decision can never
 * disagree about which server a tool belongs to. The artifact path is held to the same gate: a
 * name with no binding is not known to be an MCP tool at all, so neither source is read for it.
 *
 * ## Why this lives at the CAPTURE site, not at the softening middleware
 *
 * Deriving at the middleware would mean carrying the result to the capture site on the
 * `ToolMessage` itself — a new field on the one object whose fidelity to "what the model observed"
 * is the whole reason the trace is graded, serialised by every provider conversion path and by the
 * checkpointer. The registered name, the content and the artifact all reach the capture site
 * unchanged, so the derivation is the same computation either way and needs no new field here.
 *
 * @module
 */
import {
  approvalSubjectForToolName,
  UNRESOLVED_MCP_SERVER,
  type McpToolBindings,
} from '#src/core/approvals/mcpSubjects.js';

/** The adapter's `ToolMessage.artifact` entry type that carries a result's `structuredContent`. */
export const MCP_STRUCTURED_CONTENT_ARTIFACT = 'mcp_structured_content';

/**
 * The exact prefix `@langchain/mcp-adapters` puts in front of an errored MCP tool result's text
 * content when it throws (the plain-argument path), for a tool named `toolName` (its **bare**
 * name, as the server advertises it) on the server configured under `serverName`.
 *
 * Single-sourced so the derivation below and the spec that pins the adapter's wording compare the
 * same string: a retyped literal on both sides of that assertion would pin nothing.
 */
export function mcpToolErrorMessagePrefix(serverName: string, toolName: string): string {
  return `MCP tool '${toolName}' on server '${serverName}' returned an error: `;
}

/** One captured tool result, in the shape {@link mcpToolErrorPayload} needs to judge it. */
export interface McpToolErrorPayloadInput {
  /** The registered tool name, exactly as the model called it (`ToolMessage.name`). */
  name: string;
  /** Whether the result carried LangChain's error signal (`ToolMessage.status === 'error'`). */
  isError: boolean;
  /** The result payload as captured, untouched (`ToolMessage.content`). */
  content: unknown;
  /** The result's artifact as captured, untouched (`ToolMessage.artifact`). */
  artifact?: unknown;
}

/**
 * The server's own error body for an errored MCP tool result, or `undefined`.
 *
 * Taken from the artifact's `structuredContent` when there is one, and otherwise from the text
 * after the plain-argument prefix — the order and its reasons are in the module doc.
 *
 * **Present implies parseable**, and that contract is the point: the grading check falls back to
 * the observed payload — and to its existing failure reason — whenever this returns `undefined`, so
 * a recorded field must never be something the check would then choke on. Every one of these
 * yields `undefined`:
 *
 * - the result is not an error;
 * - the name is not MCP-namespaced, or has no binding to a configured server;
 * - there is no `structuredContent` artifact entry, and the content is not a plain string that
 *   starts with the computed prefix (a blocks array is a SUCCESS shape; the throw always produces a
 *   string);
 * - the prefix remainder is not JSON, which is simply a server that formats its errors as prose;
 * - the body is longer than `maxBytes` UTF-8 bytes.
 *
 * That last one is a deliberate choice rather than a fallout. The observed payload is capped at
 * capture so a giant result cannot bloat run stats, and the same per-field bound has to apply here
 * or the cap is trivially escaped. A JSON document cut off at the bound does not parse, so
 * recording a truncated one would spend the bytes, break the present-implies-parseable contract,
 * and leave the check failing anyway. Dropping it says the true thing instead. An over-cap
 * structured body does not fall through to the prefix source: the server's preferred body exists,
 * it is only too large, and grading a different body in its place would hide that. The bound counts
 * UTF-8 bytes, the same unit the observed-payload cap counts (BATCH-49).
 *
 * @param result The captured result: registered name, error status, and the untouched content and
 *   artifact.
 * @param mcpToolBindings The bindings recorded when this session's tools loaded — the only thing
 *   consulted when resolving which server this tool belongs to.
 * @param maxBytes The same cap the observed payload is held to, in UTF-8 bytes. A body whose
 *   encoded size is over it is dropped whole rather than cut — see the contract above.
 */
export function mcpToolErrorPayload(
  result: McpToolErrorPayloadInput,
  mcpToolBindings: McpToolBindings,
  maxBytes: number
): string | undefined {
  if (!result.isError) return undefined;

  const subject = approvalSubjectForToolName(result.name, mcpToolBindings);
  if (subject.kind !== 'mcpTool') return undefined;
  if (subject.server === UNRESOLVED_MCP_SERVER) return undefined;

  const structured = structuredContentBody(result.artifact);
  if (structured !== undefined) {
    return Buffer.byteLength(structured) > maxBytes ? undefined : structured;
  }

  if (typeof result.content !== 'string') return undefined;
  const prefix = mcpToolErrorMessagePrefix(subject.server, subject.name);
  if (!result.content.startsWith(prefix)) return undefined;

  const payload = result.content.slice(prefix.length);
  if (Buffer.byteLength(payload) > maxBytes) return undefined;

  try {
    JSON.parse(payload);
  } catch {
    return undefined;
  }
  return payload;
}

/**
 * The artifact's `structuredContent`, serialised as JSON, or `undefined` when the artifact carries
 * none or it cannot be serialised. Serialising here is what makes it parseable downstream.
 */
function structuredContentBody(artifact: unknown): string | undefined {
  if (!Array.isArray(artifact)) return undefined;
  const entry: unknown = artifact.find(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item as { type?: unknown }).type === MCP_STRUCTURED_CONTENT_ARTIFACT
  );
  if (entry === undefined) return undefined;
  const data = (entry as { data?: unknown }).data;
  if (data === undefined) return undefined;
  try {
    const serialised = JSON.stringify(data);
    return typeof serialised === 'string' ? serialised : undefined;
  } catch {
    return undefined;
  }
}
