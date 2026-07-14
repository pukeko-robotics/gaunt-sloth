import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

/**
 * EXT-32 — capture seam: resolvers surface each connected MCP server's discovery `instructions`
 * (SDK Client.getInstructions(), reached via MultiServerMCPClient.getClient(name)) per server, and
 * omit servers that supply none. The captured value is exposed via getMcpServerInstructions() for
 * the shared prompt composition (and a future MCP debug tab).
 */

// Built-in tools are irrelevant here and would otherwise touch the real fs/tool config — stub to [].
vi.mock('#src/builtInToolsConfig.js', () => ({
  getDefaultTools: vi.fn().mockResolvedValue([]),
}));

// Fake MultiServerMCPClient: getTools() returns no tools; getClient(name) returns a per-server fake
// SDK Client (or throws) so we can drive getInstructions() outcomes per server.
const getClientMock = vi.fn();
const getToolsMock = vi.fn().mockResolvedValue([]);
class MultiServerMCPClientStub {
  constructor(public _config: unknown) {}
  getTools = getToolsMock;
  getClient = getClientMock;
  close = vi.fn().mockResolvedValue(undefined);
}
vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: MultiServerMCPClientStub,
}));

function makeConfig(mcpServers: Record<string, unknown>): GthConfig {
  return {
    llm: {},
    mcpServers,
  } as unknown as GthConfig;
}

describe('resolvers MCP instructions capture (EXT-32)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToolsMock.mockResolvedValue([]);
  });

  it('captures per-server instructions and omits servers that supply none', async () => {
    getClientMock.mockImplementation(async (name: string) => {
      if (name === 'jira') return { getInstructions: () => 'Use getIssue before commenting.' };
      if (name === 'blank') return { getInstructions: () => '   ' }; // whitespace-only → omitted
      if (name === 'quiet') return { getInstructions: () => undefined }; // absent → omitted
      // per-server failure must not abort the rest
      if (name === 'broken') throw new Error('not connected');
      return undefined;
    });

    const { createResolvers } = await import('#src/resolvers.js');
    const resolvers = createResolvers();
    await resolvers.resolveTools!(
      makeConfig({
        jira: { url: 'https://jira.example/mcp' },
        blank: { url: 'https://blank.example/mcp' },
        quiet: { url: 'https://quiet.example/mcp' },
        broken: { url: 'https://broken.example/mcp' },
      })
    );

    const captured = resolvers.getMcpServerInstructions!();
    expect(captured).toEqual([{ server: 'jira', instructions: 'Use getIssue before commenting.' }]);
  });

  it('returns an empty array when no MCP servers are configured', async () => {
    const { createResolvers } = await import('#src/resolvers.js');
    const resolvers = createResolvers();
    await resolvers.resolveTools!(makeConfig({}));
    expect(resolvers.getMcpServerInstructions!()).toEqual([]);
    // getClient is never reached with no servers configured.
    expect(getClientMock).not.toHaveBeenCalled();
  });

  it('resets the capture on each resolveTools call (no stale leak)', async () => {
    getClientMock.mockImplementation(async (name: string) =>
      name === 'jira' ? { getInstructions: () => 'first' } : undefined
    );
    const { createResolvers } = await import('#src/resolvers.js');
    const resolvers = createResolvers();

    await resolvers.resolveTools!(makeConfig({ jira: { url: 'https://jira.example/mcp' } }));
    expect(resolvers.getMcpServerInstructions!()).toHaveLength(1);

    // Second resolution with no servers must clear the previously-captured value.
    await resolvers.resolveTools!(makeConfig({}));
    expect(resolvers.getMcpServerInstructions!()).toEqual([]);
  });
});
