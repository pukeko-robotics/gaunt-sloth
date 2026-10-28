/**
 * BATCH-43 / EXT-211 — the **gradable body** of an MCP tool result: for an errored result, the
 * server's own error body, so `gth eval`'s `tool_result_json_path` can grade *what a denial said*
 * and not merely that one happened; for a successful one, its `structuredContent`, which the model
 * never sees and which would otherwise be out of the check's reach.
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
 * A **successful** result invoked as a tool call is a `ToolMessage` whose `content` is the text the
 * model sees and whose artifact carries the same `mcp_structured_content` / `mcp_meta` entries.
 * (`@langchain/mcp-adapters` 1.x folded `structuredContent` into the content itself; 2.x does not,
 * so the model no longer receives it and grading has to read it from the artifact.)
 *
 * ## The order the body is taken in — ONE order for success and error
 *
 * {@link mcpToolGradedPayload} is the single place this order lives:
 *
 * 1. **The artifact's `structuredContent`.** It is the body in the shape the server chose and
 *    defined a schema for; it is the only place a structured-only result's detail exists; and text
 *    is free-form, so where the two disagree the structured body is the authoritative one to grade.
 *    The same reasoning holds whichever way the call went, which is why one order serves both.
 * 2. **The path's own fallback.** An error falls back to the text after the plain-argument prefix,
 *    the only body the throwing path keeps (the adapter still throws that form, so it stays for as
 *    long as anything installed can produce it). A success has no fallback of its own.
 * 3. **Nothing**, and the grading check reads the observed `content`, which on the tool-call path
 *    is already the server's bare text — so a text-only JSON result grades with no field at all.
 *
 * **Where a `path` starts differs by outcome, deliberately.** A successful result's body is the
 * envelope 1.x put in the content — `{ type: 'text', text, structuredContent, meta }` when the
 * result has one text block, `{ structuredContent, meta }` when it has none — so a suite written
 * against 1.x (`path: "structuredContent.contracts[0].type"`) keeps matching, and a structured-only
 * result is reachable the same way. A result with several content blocks gets no field, because
 * 1.x graded the blocks themselves there. An error's body is the structured content itself,
 * addressed from its root: 1.x never let a structured error body reach the check, so there is no
 * old path to keep, and from the root it grades the way a text-JSON error already does.
 *
 * `_meta` is never a source of its own. On a success it rides inside the 1.x envelope as `meta`,
 * where 1.x put it; it is never the graded body, because it is protocol metadata about the result,
 * and preferring it would stop a text-only JSON result that grades today from grading.
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

/** The adapter's `ToolMessage.artifact` entry type that carries a result's `_meta`. */
export const MCP_META_ARTIFACT = 'mcp_meta';

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
 * after the plain-argument prefix — {@link mcpToolGradedPayload} holds that order, and the module
 * doc gives its reasons.
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
  return result.isError ? mcpToolGradedPayload(result, mcpToolBindings, maxBytes) : undefined;
}

/**
 * The gradable body of an MCP tool result, successful or errored, or `undefined`. **The one place
 * the source order lives** — the artifact's `structuredContent` first, then the outcome's own
 * fallback — and the module doc says why, and why a `path` starts in a different place for each
 * outcome.
 *
 * The same contract as {@link mcpToolErrorPayload} holds for both outcomes: present implies
 * parseable, a body over `maxBytes` is dropped whole and never replaced by a lower source, and a
 * name with no binding yields nothing.
 */
export function mcpToolGradedPayload(
  result: McpToolErrorPayloadInput,
  mcpToolBindings: McpToolBindings,
  maxBytes: number
): string | undefined {
  const subject = approvalSubjectForToolName(result.name, mcpToolBindings);
  if (subject.kind !== 'mcpTool') return undefined;
  if (subject.server === UNRESOLVED_MCP_SERVER) return undefined;

  const structured = artifactEntryData(result.artifact, MCP_STRUCTURED_CONTENT_ARTIFACT);
  if (structured !== undefined) {
    const body = result.isError
      ? structured
      : successEnvelope(structured, result.content, result.artifact);
    if (body === undefined) return undefined;
    const serialised = serialise(body);
    if (serialised === undefined) return undefined;
    return Buffer.byteLength(serialised) > maxBytes ? undefined : serialised;
  }

  if (!result.isError) return undefined;
  return prefixedErrorBody(result.content, subject.server, subject.name, maxBytes);
}

/**
 * The body 1.x put in a successful result's content: the text block with `structuredContent` (and
 * `meta`) beside it, or those alone when there is no text. `undefined` for several content blocks,
 * which 1.x graded as the blocks themselves.
 */
function successEnvelope(
  structuredContent: unknown,
  content: unknown,
  artifact: unknown
): Record<string, unknown> | undefined {
  const meta = artifactEntryData(artifact, MCP_META_ARTIFACT);
  const rest = { structuredContent, ...(meta !== undefined ? { meta } : {}) };
  if (typeof content === 'string') return { type: 'text', text: content, ...rest };
  if (content === undefined || (Array.isArray(content) && content.length === 0)) return rest;
  return undefined;
}

/** The text after the adapter's plain-argument prefix, when it is JSON within the cap. */
function prefixedErrorBody(
  content: unknown,
  server: string,
  tool: string,
  maxBytes: number
): string | undefined {
  if (typeof content !== 'string') return undefined;
  const prefix = mcpToolErrorMessagePrefix(server, tool);
  if (!content.startsWith(prefix)) return undefined;

  const payload = content.slice(prefix.length);
  if (Buffer.byteLength(payload) > maxBytes) return undefined;

  try {
    JSON.parse(payload);
  } catch {
    return undefined;
  }
  return payload;
}

/** The `data` of the artifact entry of the given type, or `undefined` when there is none. */
function artifactEntryData(artifact: unknown, type: string): unknown {
  if (!Array.isArray(artifact)) return undefined;
  const entry: unknown = artifact.find(
    (item) =>
      typeof item === 'object' && item !== null && (item as { type?: unknown }).type === type
  );
  return entry === undefined ? undefined : (entry as { data?: unknown }).data;
}

/** JSON for a body, or `undefined` when it cannot be serialised. Serialising is what makes it parseable downstream. */
function serialise(body: unknown): string | undefined {
  try {
    const serialised = JSON.stringify(body);
    return typeof serialised === 'string' ? serialised : undefined;
  } catch {
    return undefined;
  }
}
