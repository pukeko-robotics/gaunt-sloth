/**
 * BATCH-43 — recover the **server's own error body** from the prose-wrapped message
 * `@langchain/mcp-adapters` throws for an MCP tool result carrying `isError: true`, so
 * `gth eval`'s `tool_result_json_path` can grade *what a denial said* and not merely that one
 * happened.
 *
 * ## Why there is anything to recover at all
 *
 * The MCP spec treats a tool-execution error as a normal result the client SHOULD hand back to the
 * model. The adapter instead throws, and the throw discards everything structured:
 *
 *     if (result.isError) throw new ToolException(
 *       `MCP tool '${toolName}' on server '${serverName}' returned an error: ` +
 *       result.content.map((c) => c.type === 'text' ? c.text : '').join('\n'));
 *
 * `result.structuredContent` and `result._meta` are read only on the lines *after* that throw, so a
 * server that puts its error detail solely in `structuredContent` is unreachable from here — that
 * is upstream, not a gap this module can close. What survives is the flattened **text** content,
 * behind a fixed prose prefix. Recovering it is therefore a matter of removing exactly that prefix.
 *
 * ## The prefix is COMPUTED, never matched
 *
 * The alternative — hunt the message for something that looks like JSON — needs a rule for which
 * JSON is *the* JSON when a message contains several, and a heuristic like that has no business in
 * a deterministic grading path: its failure mode is a plausible wrong parse that the suite author
 * cannot see. Every variable in the adapter's template is one we already hold, so the exact
 * expected prefix can be built and stripped, which dissolves the question instead of answering it.
 * When the constructed prefix is not what the message starts with, **nothing is recovered and no
 * field is recorded** — an absent field and the check's existing "not JSON" reason are an honest
 * answer; a lucky substring is not.
 *
 * Because the prefix is an upstream template literal, a dependency bump that rewords it would
 * silently stop the field ever being recorded while every other test stayed green (the observed
 * payload is untouched either way). `packages/agent/spec/mcpAdapterErrorMessage.spec.ts` therefore
 * drives the real adapter against a real in-memory MCP server and compares its thrown message to
 * {@link mcpToolErrorMessagePrefix}'s output, so such a bump reds here first.
 *
 * ## The server name is RESOLVED, never split off the registered name
 *
 * The adapter's template names the server by its `mcpServers` key and the tool by its **bare**
 * name, while the registered name the model calls carries both behind our namespace. A configured
 * key may itself contain the server separator, so the registered name does not determine its
 * server, and a prefix built from a guessed one would be wrong in exactly the case a multi-word
 * server name makes likely. Resolution goes through {@link approvalSubjectForToolName}, which reads
 * the bindings recorded when the tools loaded, so a recovered payload and an approvals decision can
 * never disagree about which server a tool belongs to. A name with no binding resolves to
 * {@link UNRESOLVED_MCP_SERVER} and yields no field: there is no server name to build a prefix
 * from, and guessing one is the thing this refuses to do.
 *
 * ## Why this lives at the CAPTURE site, not at the softening middleware
 *
 * The softening middleware in `GthLangChainAgent` holds the same two variables, and BATCH-43's
 * ruling names it as the place where they are available. Deriving there would mean carrying the
 * result to the capture site on the `ToolMessage` itself — a new field on the one object whose
 * fidelity to "what the model observed" is the whole reason the trace is graded. That object is
 * serialised by nine provider conversion paths and by the checkpointer, and none of them is a hop
 * this change should have to defend. The registered tool name and the content are identical at
 * both sites, so the derivation is the same computation either way; done here it needs no new
 * field on a message and reuses the middleware → `accumulateMessage` hop BATCH-23 already proved.
 *
 * @module
 */
import {
  approvalSubjectForToolName,
  UNRESOLVED_MCP_SERVER,
  type McpToolBindings,
} from '#src/core/approvals/mcpSubjects.js';

/**
 * The exact prefix `@langchain/mcp-adapters` puts in front of an errored MCP tool result's text
 * content, for a tool named `toolName` (its **bare** name, as the server advertises it) on the
 * server configured under `serverName`.
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
}

/**
 * The server's own error body, recovered from a softened MCP tool error, or `undefined`.
 *
 * **Present implies parseable**, and that contract is the point: the grading check falls back to
 * the observed payload — and to its existing failure reason — whenever this returns `undefined`, so
 * a recorded field must never be something the check would then choke on. Every one of these
 * yields `undefined`:
 *
 * - the result is not an error, or its content is not a plain string (a blocks array is a SUCCESS
 *   shape; the adapter's throw always produces a string);
 * - the name is not MCP-namespaced, or has no binding to a configured server;
 * - the message does not start with the computed prefix (a different adapter message — an invalid
 *   result, an unexpected content type — or an upstream reword);
 * - the remainder is not JSON, which is simply a server that formats its errors as prose;
 * - the remainder is longer than `maxBytes` UTF-8 bytes.
 *
 * That last one is a deliberate choice rather than a fallout. The observed payload is capped at
 * capture so a giant result cannot bloat run stats, and the same per-field bound has to apply here
 * or the cap is trivially escaped. It bounds each field, not the record: a result that carries both
 * fields can hold two capped strings, which is the price of keeping the observed payload intact
 * beside a gradable one. But a JSON document cut off at the bound does not parse, so recording
 * a truncated one would spend the bytes, break the present-implies-parseable contract, and leave
 * the check failing anyway — while looking, to whoever reads the record, as though the recovery
 * had worked. Dropping it says the true thing instead. The bound counts UTF-8 bytes, the same unit
 * the observed-payload cap counts (BATCH-49) — a character count here would recover a body the
 * other site had already cut, or drop one it had kept, for any payload outside ASCII.
 *
 * @param result The captured result: registered name, error status, and the untouched content.
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
  if (typeof result.content !== 'string') return undefined;

  const subject = approvalSubjectForToolName(result.name, mcpToolBindings);
  if (subject.kind !== 'mcpTool') return undefined;
  if (subject.server === UNRESOLVED_MCP_SERVER) return undefined;

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
