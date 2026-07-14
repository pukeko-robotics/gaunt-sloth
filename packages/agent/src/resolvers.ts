/**
 * @packageDocumentation
 * Resolver implementations for the AgentResolvers pattern.
 *
 * Provides `resolveTools` / `cleanupTools` that wire up built-in tools
 * (filesystem, dev, custom), MCP servers, and A2A agents.
 *
 * Provides `resolveMiddleware` / `cleanupMiddleware` that delegate to the
 * agent middleware registry.
 */

import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type {
  GthCommand,
  AgentResolvers,
  McpServerInstruction,
} from '@gaunt-sloth/core/core/types.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';
import { displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { createA2AAgentTool } from '#src/tools/A2AAgentTool.js';
import { prepareMcpTools } from '#src/utils/mcpUtils.js';
import { formatMcpConnectFailureMessage } from '#src/utils/mcpAuthError.js';
import { createAuthProviderAndAuthenticate } from '#src/mcp/OAuthClientProviderImpl.js';
import { MultiServerMCPClient, type StreamableHTTPConnection } from '@langchain/mcp-adapters';
import type { StatusLevel, StatusUpdateCallback } from '@gaunt-sloth/core/core/types.js';
import { MCP_TOOL_NAME_PREFIX } from '@gaunt-sloth/core/constants.js';

/**
 * Create a full set of resolvers for the GthLangChainAgent.
 *
 * Each call returns a fresh set of resolvers with their own MCP client
 * instance, avoiding shared module-level state and race conditions.
 */
export function createResolvers(): AgentResolvers {
  let mcpClientInstance: MultiServerMCPClient | null = null;
  // EXT-32: per-server MCP discovery `instructions` captured during the most recent resolveTools.
  // Kept on the resolver so the composed system prompt (via getMcpServerInstructions) AND a future
  // MCP debug tab ([[TUI-C20]]) can read the SAME captured text without re-querying the servers.
  let mcpServerInstructions: McpServerInstruction[] = [];

  const resolveTools = async (
    config: GthConfig,
    command?: GthCommand
  ): Promise<StructuredToolInterface[]> => {
    const tools: StructuredToolInterface[] = [];
    // Fresh capture per resolution; a stale value must never leak across re-inits.
    mcpServerInstructions = [];

    // 1. Get built-in tools (filesystem, devTools, customTools, etc.)
    try {
      const { getDefaultTools } = await import('#src/builtInToolsConfig.js');
      const defaultTools = await getDefaultTools(config, command);
      debugLog(`Default tools loaded: ${defaultTools.length}`);
      tools.push(...defaultTools);
    } catch (error) {
      debugLog(`Built-in tools not available: ${error}`);
    }

    // 2. Get MCP tools
    try {
      mcpClientInstance = await getMcpClient(config);
      if (mcpClientInstance) {
        const rawMcpTools = await mcpClientInstance.getTools();
        // Use a simple status callback for prepareMcpTools
        const statusCallback: StatusUpdateCallback = (level: StatusLevel, message: string) => {
          displayInfo(message);
        };
        const mcpTools = prepareMcpTools(statusCallback, config, rawMcpTools) ?? [];
        debugLog(`MCP tools loaded: ${mcpTools.length}`);
        tools.push(...(mcpTools as StructuredToolInterface[]));
      }
    } catch (error) {
      debugLog(`MCP tools error: ${error}`);
      // EXT-31: both connection-level failures (incl. expired/invalid auth) AND per-tool schema-load
      // errors under throwOnLoadError are caught inside the adapter's _initializeConnection and
      // routed to the function-form onConnectionError callback in getMcpClient (surface + skip, no
      // re-throw), so they do NOT reach here. This backstop therefore only catches a wholesale
      // getTools() throw (belt-and-braces) — surface it neutrally so MCP tool loading can never fail
      // silently, while the session degrades gracefully (built-in and A2A tools below still load).
      displayWarning(
        `MCP integration tools could not be fully loaded; continuing without them. ` +
          `Underlying error: ${error}`
      );
    }

    // 2b. EXT-32: capture each connected MCP server's discovery `instructions` string (from its MCP
    // `initialize` handshake, exposed by the SDK Client via getInstructions()). This is ISOLATED
    // from the getTools() block above so a getClient/getInstructions failure can never discard
    // successfully-loaded MCP tools nor log a misleading "MCP tools error". Per-server try/catch so
    // one unreachable/instruction-less server does not abort the rest. Absent/empty/whitespace-only
    // instructions contribute nothing (trimmed, then omitted). The captured value is injected —
    // fenced + per-server-labelled — into the composed system prompt on BOTH backends.
    if (mcpClientInstance) {
      const serverNames = Object.keys(config.mcpServers || {});
      for (const serverName of serverNames) {
        try {
          const client = await mcpClientInstance.getClient(serverName);
          const instructions = client?.getInstructions()?.trim();
          if (instructions) {
            mcpServerInstructions.push({ server: serverName, instructions });
          }
        } catch (error) {
          debugLog(`MCP instructions capture error for '${serverName}': ${error}`);
        }
      }
      debugLog(`MCP servers with instructions: ${mcpServerInstructions.length}`);
    }

    // 3. Get A2A tools
    const a2aTools = getA2ATools(config);
    debugLog(`A2A tools loaded: ${a2aTools.length}`);
    tools.push(...a2aTools);

    return tools;
  };

  const cleanupTools = async (): Promise<void> => {
    if (mcpClientInstance) {
      try {
        await mcpClientInstance.close();
      } catch {
        // Ignore cleanup errors
      }
      mcpClientInstance = null;
    }
  };

  const resolveMiddleware = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    middleware: any[] | undefined,
    config: GthConfig
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any[]> => {
    try {
      const { resolveMiddleware: resolve } = await import('#src/middleware/registry.js');
      return await resolve(middleware, config);
    } catch (error) {
      debugLog(`Middleware resolution error: ${error}`);
      return [];
    }
  };

  const cleanupMiddleware = async (): Promise<void> => {
    // No cleanup needed for middleware currently
  };

  // EXT-32: expose the captured per-server MCP instructions for the shared prompt composition (and,
  // later, the [[TUI-C20]] MCP debug tab). Returns a defensive copy so callers can't mutate the
  // captured state. Empty until resolveTools has run (or when no server supplied instructions).
  const getMcpServerInstructions = (): McpServerInstruction[] => [...mcpServerInstructions];

  return {
    resolveTools,
    cleanupTools,
    resolveMiddleware,
    cleanupMiddleware,
    getMcpServerInstructions,
  };
}

// --- Private helpers ---

async function getMcpClient(config: GthConfig): Promise<MultiServerMCPClient | null> {
  debugLog('Setting up MCP client...');

  const rawMcpServers = { ...(config.mcpServers || {}) } as Record<
    string,
    StreamableHTTPConnection
  >;
  debugLog(`MCP servers count: ${Object.keys(rawMcpServers).length}`);

  const mcpServers = {} as Record<string, StreamableHTTPConnection>;
  for (const serverName of Object.keys(rawMcpServers)) {
    const server = rawMcpServers[serverName] as StreamableHTTPConnection;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (server.url && server && (server.authProvider as any) === 'OAuth') {
      displayInfo(`Starting OAuth for ${server.url}`);
      try {
        const authProvider = await createAuthProviderAndAuthenticate(server);
        mcpServers[serverName] = {
          ...server,
          authProvider,
        };
      } catch (error) {
        // EXT-31: an OAuth handshake/refresh failure happens BEFORE the MCP client exists, so it
        // can't reach the connect-time onConnectionError callback below. Surface it here (named +
        // actionable) and skip only THIS server so the others still load — never a silent drop.
        displayWarning(formatMcpConnectFailureMessage(serverName, error, { oauth: true }));
      }
    } else {
      mcpServers[serverName] = server;
    }
  }

  if (Object.keys(mcpServers).length > 0) {
    debugLog('Creating MultiServerMCPClient...');
    return new MultiServerMCPClient({
      throwOnLoadError: true,
      prefixToolNameWithServerName: true,
      // TUI-C20: single-sourced so the MCP debug tab can regroup tools back by server prefix.
      additionalToolNamePrefix: MCP_TOOL_NAME_PREFIX,
      mcpServers: mcpServers,
      // EXT-31: per-server surfacing. The function form of onConnectionError lets a failed server be
      // classified + surfaced and then SKIPPED (added to the client's failedServers set) rather than
      // aborting getTools() — so one integration's expired auth no longer swallows every other
      // server's tools. Auth failures (401/403/expired token/refused handshake) get a named re-auth
      // message; other failures are surfaced plainly as non-auth. Degradation stays graceful.
      onConnectionError: ({ serverName, error }: { serverName: string; error?: unknown }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const oauth = (rawMcpServers[serverName]?.authProvider as any) === 'OAuth';
        displayWarning(formatMcpConnectFailureMessage(serverName, error, { oauth }));
      },
    });
  } else {
    debugLog('No MCP servers configured');
    return null;
  }
}

function getA2ATools(config: GthConfig): StructuredToolInterface[] {
  debugLog('Setting up A2A tools...');
  const a2aAgents = (config.a2aAgents || {}) as Record<
    string,
    { agentId: string; agentUrl: string }
  >;
  const tools: StructuredToolInterface[] = [];

  for (const [agentId, agentConfig] of Object.entries(a2aAgents)) {
    debugLog(`Adding A2A agent tool: ${agentId}`);
    tools.push(createA2AAgentTool(agentConfig));
  }

  return tools;
}
