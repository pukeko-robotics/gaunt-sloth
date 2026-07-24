/**
 * @module McpResourceTool
 * EXT-48 — synthesize agent-callable tools for a connected MCP server's RESOURCES.
 *
 * gth is otherwise a tools-only MCP client (it consumes a server's getTools() +
 * getInstructions()). This factory bridges the adapter's resource API to the agent by
 * synthesizing two LangChain tools per resources-capable server, mirroring
 * {@link ../tools/A2AAgentTool.ts} — each tool closes over the LIVE MultiServerMCPClient
 * plus the server name and calls it in `func`:
 *
 *   - `mcp__<server>__list_resources` — no args; lists the server's concrete resources.
 *   - `mcp__<server>__read_resource`  — { uri }; reads one resource by URI.
 *
 * The `mcp__<server>__*` namespace (single-sourced from MCP_TOOL_NAME_PREFIX) makes these
 * tools inherit the `allowedTools` glob opt-out and TUI-C20 server-grouping for free, and
 * lets both agent backends consume them generically via the resolveTools array (zero
 * agent-backend edits).
 *
 * Concrete-URI list/read only: resource TEMPLATES (parameterized URIs) are deferred.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type {
  MultiServerMCPClient,
  MCPResource,
  MCPResourceContent,
} from '@langchain/mcp-adapters';
import { MCP_TOOL_NAME_PREFIX } from '@gaunt-sloth/core/constants.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';

/**
 * Format a single resource-content block for the model. Text is returned inline; a binary
 * (base64) `blob` is SUMMARIZED — never dumped as raw base64 into the model context.
 */
function formatResourceContent(content: MCPResourceContent): string {
  if (typeof content.text === 'string') {
    return content.text;
  }
  if (typeof content.blob === 'string') {
    // Decode only to measure the real byte length; the raw base64 is intentionally discarded.
    const size = Buffer.from(content.blob, 'base64').length;
    const mimeType = content.mimeType ?? 'application/octet-stream';
    return `[binary resource ${content.uri} — mimeType: ${mimeType}, size: ${size} bytes (base64 content omitted)]`;
  }
  return `[resource ${content.uri} returned no text or binary content]`;
}

/**
 * Build the two resource tools for one server, bound to the live client + server name.
 *
 * @param mcpClientInstance - the live MultiServerMCPClient the tools call through (closed over)
 * @param serverName - the connected server whose resources these tools expose
 * @returns the `list_resources` + `read_resource` DynamicStructuredTools, namespaced
 *          `mcp__<serverName>__*`
 */
export function createMcpResourceTools(
  mcpClientInstance: MultiServerMCPClient,
  serverName: string
): DynamicStructuredTool[] {
  const namePrefix = `${MCP_TOOL_NAME_PREFIX}__${serverName}__`;
  const listName = `${namePrefix}list_resources`;
  const readName = `${namePrefix}read_resource`;

  const listResourcesTool = new DynamicStructuredTool({
    name: listName,
    description:
      `List the resources exposed by the connected MCP server '${serverName}'. ` +
      `Returns each resource's uri, name, and (when provided) description and mimeType. ` +
      `Call this FIRST to discover available resource URIs, then use '${readName}' to read one.`,
    schema: z.object({}),
    func: async () => {
      debugLog(`Tool ${listName} called`);
      try {
        const byServer = await mcpClientInstance.listResources(serverName);
        const resources: MCPResource[] = byServer?.[serverName] ?? [];
        if (resources.length === 0) {
          return `The MCP server '${serverName}' exposes no resources.`;
        }
        const compact = resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        }));
        return JSON.stringify(compact, null, 2);
      } catch (error) {
        return `Error listing resources from MCP server '${serverName}': ${(error as Error).message}`;
      }
    },
  });

  const readResourceTool = new DynamicStructuredTool({
    name: readName,
    description:
      `Read the content of a single resource from the MCP server '${serverName}' by its uri ` +
      `(obtain uris from '${listName}'). Text resources are returned inline; binary (blob) ` +
      `resources are summarized (uri, mimeType, size) rather than returned as raw data.`,
    // `.min(1)` per the Gemini tool-schema rule (no JSON-Schema-draft keywords like .positive()).
    schema: z.object({
      uri: z.string().min(1).describe('The URI of the resource to read (from list_resources).'),
    }),
    func: async ({ uri }) => {
      debugLog(`Tool ${readName} called with uri: ${uri}`);
      try {
        // readResource returns a FLAT MCPResourceContent[] (NOT { contents: [...] }).
        const contents = await mcpClientInstance.readResource(serverName, uri);
        if (!contents || contents.length === 0) {
          return `The resource '${uri}' on MCP server '${serverName}' returned no content.`;
        }
        return contents.map(formatResourceContent).join('\n\n');
      } catch (error) {
        return `Error reading resource '${uri}' from MCP server '${serverName}': ${(error as Error).message}`;
      }
    },
  });

  return [listResourcesTool, readResourceTool];
}
