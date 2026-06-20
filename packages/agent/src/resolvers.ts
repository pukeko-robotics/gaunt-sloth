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
import type { GthCommand, AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';
import { displayInfo } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { createA2AAgentTool } from '#src/tools/A2AAgentTool.js';
import { prepareMcpTools } from '#src/utils/mcpUtils.js';
import { createAuthProviderAndAuthenticate } from '#src/mcp/OAuthClientProviderImpl.js';
import { MultiServerMCPClient, type StreamableHTTPConnection } from '@langchain/mcp-adapters';
import type { StatusLevel, StatusUpdateCallback } from '@gaunt-sloth/core/core/types.js';

/**
 * Create a full set of resolvers for the GthLangChainAgent.
 *
 * Each call returns a fresh set of resolvers with their own MCP client
 * instance, avoiding shared module-level state and race conditions.
 */
export function createResolvers(): AgentResolvers {
  let mcpClientInstance: MultiServerMCPClient | null = null;

  const resolveTools = async (
    config: GthConfig,
    command?: GthCommand
  ): Promise<StructuredToolInterface[]> => {
    const tools: StructuredToolInterface[] = [];

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

  return {
    resolveTools,
    cleanupTools,
    resolveMiddleware,
    cleanupMiddleware,
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
      const authProvider = await createAuthProviderAndAuthenticate(server);
      mcpServers[serverName] = {
        ...server,
        authProvider,
      };
    } else {
      mcpServers[serverName] = server;
    }
  }

  if (Object.keys(mcpServers).length > 0) {
    debugLog('Creating MultiServerMCPClient...');
    return new MultiServerMCPClient({
      throwOnLoadError: true,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: 'mcp',
      mcpServers: mcpServers,
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
