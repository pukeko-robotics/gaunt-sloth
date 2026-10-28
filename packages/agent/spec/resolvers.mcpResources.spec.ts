import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { GthConfig } from '#src/config.js';
import { mcpToolRegisteredName } from '@gaunt-sloth/core/core/approvals/mcpSubjects.js';
import { MCP_SERVER_SEPARATOR } from '@gaunt-sloth/core/constants.js';

/**
 * EXT-48 — resource-tool synthesis: for each connected MCP server that advertises the `resources`
 * capability (SDK Client.getServerCapabilities().resources, reached via
 * MultiServerMCPClient.getClient(name)), resolvers push two agent-callable tools into the resolved
 * tools array — `mcp__<server>_list_resources` and `mcp__<server>_read_resource` — that close
 * over the live client. Servers without the capability (or that throw) contribute none, and one
 * bad server must not abort the rest. read_resource returns text inline and SUMMARIZES a blob
 * (never leaks raw base64).
 */

// Built-in tools are irrelevant here and would otherwise touch the real fs/tool config — stub to [].
vi.mock('#src/builtInToolsConfig.js', () => ({
  getDefaultTools: vi.fn().mockResolvedValue([]),
}));

// Fake MultiServerMCPClient: per-server discovery returns no tools; getClient(name) returns a per-server fake
// SDK Client (or throws) so we drive getServerCapabilities() per server; listResources/readResource
// back the synthesized tools' func when invoked.
const getClientMock = vi.fn();
const listToolsetsMock = vi.fn().mockResolvedValue({});
const listResourcesMock = vi.fn();
const readResourceMock = vi.fn();
class MultiServerMCPClientStub {
  constructor(public _config: unknown) {}
  listToolsets = listToolsetsMock;
  initializeConnections = listToolsetsMock;
  getClient = getClientMock;
  listResources = listResourcesMock;
  readResource = readResourceMock;
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

// A per-server fake SDK Client. `resources` present => capability advertised.
function fakeClient(opts: { resources?: boolean; instructions?: string } = {}) {
  return {
    getInstructions: () => opts.instructions,
    getServerCapabilities: () => (opts.resources ? { tools: {}, resources: {} } : { tools: {} }),
  };
}

function toolNames(tools: StructuredToolInterface[]): string[] {
  return tools.map((t) => t.name);
}

async function resolve(config: GthConfig): Promise<StructuredToolInterface[]> {
  const { createResolvers } = await import('#src/resolvers.js');
  const resolvers = createResolvers();
  return resolvers.resolveTools!(config);
}

describe('resolvers MCP resource tools synthesis (EXT-48)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listToolsetsMock.mockResolvedValue({});
  });

  it('synthesizes list_resources + read_resource for a resources-capable server (namespaced mcp__<server>_)', async () => {
    getClientMock.mockImplementation(async (name: string) =>
      name === 'files' ? fakeClient({ resources: true }) : undefined
    );

    const tools = await resolve(makeConfig({ files: { url: 'https://files.example/mcp' } }));
    const names = toolNames(tools);

    expect(names).toContain('mcp__files_list_resources');
    expect(names).toContain('mcp__files_read_resource');
    // Namespaced so `allowedTools: ['mcp__files_*']` would gate them.
    expect(names.filter((n) => n.startsWith('mcp__files_'))).toHaveLength(2);
  });

  it('contributes NO resource tools for a server that does not advertise the resources capability', async () => {
    getClientMock.mockImplementation(async (name: string) =>
      name === 'plain' ? fakeClient({ resources: false }) : undefined
    );

    const tools = await resolve(makeConfig({ plain: { url: 'https://plain.example/mcp' } }));

    expect(toolNames(tools).filter((n) => n.startsWith('mcp__'))).toEqual([]);
  });

  it('a server that throws contributes none AND does not abort the other servers (degradation reuse)', async () => {
    getClientMock.mockImplementation(async (name: string) => {
      if (name === 'good') return fakeClient({ resources: true });
      if (name === 'broken') throw new Error('capabilities probe failed');
      return undefined;
    });

    const tools = await resolve(
      makeConfig({
        good: { url: 'https://good.example/mcp' },
        broken: { url: 'https://broken.example/mcp' },
      })
    );
    const names = toolNames(tools);

    // The broken server aborts nothing: the good server's tools are still present.
    expect(names).toContain('mcp__good_list_resources');
    expect(names).toContain('mcp__good_read_resource');
    // The broken server contributed no tools of its own.
    expect(names.some((n) => n.startsWith('mcp__broken_'))).toBe(false);
  });

  it('list_resources returns the resource list shape (uri/name/description/mimeType)', async () => {
    getClientMock.mockImplementation(async () => fakeClient({ resources: true }));
    listResourcesMock.mockResolvedValue({
      files: [
        {
          uri: 'file:///notes/todo.md',
          name: 'todo',
          description: 'the todo list',
          mimeType: 'text/markdown',
        },
      ],
    });

    const tools = await resolve(makeConfig({ files: { url: 'https://files.example/mcp' } }));
    const listTool = tools.find((t) => t.name === 'mcp__files_list_resources')!;
    const result = (await listTool.invoke({})) as string;

    expect(listResourcesMock).toHaveBeenCalledWith('files');
    expect(result).toContain('file:///notes/todo.md');
    expect(result).toContain('todo');
    expect(result).toContain('text/markdown');
  });

  it('read_resource returns text inline for a text content', async () => {
    getClientMock.mockImplementation(async () => fakeClient({ resources: true }));
    readResourceMock.mockResolvedValue([
      { uri: 'file:///notes/todo.md', mimeType: 'text/markdown', text: '# Buy milk' },
    ]);

    const tools = await resolve(makeConfig({ files: { url: 'https://files.example/mcp' } }));
    const readTool = tools.find((t) => t.name === 'mcp__files_read_resource')!;
    const result = (await readTool.invoke({ uri: 'file:///notes/todo.md' })) as string;

    expect(readResourceMock).toHaveBeenCalledWith('files', 'file:///notes/todo.md');
    expect(result).toContain('# Buy milk');
  });

  it('read_resource SUMMARIZES a blob content (mimeType + size) and never leaks the raw base64', async () => {
    // A distinctive base64 fixture so `.not.toContain` is meaningful ("AAAA..." would be too common).
    const rawBlob = 'Q0FGRUJBQkUtRUJBQkVGQUNFLTk5OTk5OTk5OTk5OTk5OTk=';
    getClientMock.mockImplementation(async () => fakeClient({ resources: true }));
    readResourceMock.mockResolvedValue([
      { uri: 'file:///img/logo.png', mimeType: 'image/png', blob: rawBlob },
    ]);

    const tools = await resolve(makeConfig({ files: { url: 'https://files.example/mcp' } }));
    const readTool = tools.find((t) => t.name === 'mcp__files_read_resource')!;
    const result = (await readTool.invoke({ uri: 'file:///img/logo.png' })) as string;

    // Summary is present: mimeType + a decoded byte size, and the resource uri.
    expect(result).toContain('image/png');
    expect(result).toContain('file:///img/logo.png');
    expect(result).toMatch(/\d+ bytes/);
    // The raw base64 payload must NOT be dumped into the model context.
    expect(result).not.toContain(rawBlob);
  });

  it('returns no resource tools when no MCP servers are configured', async () => {
    const tools = await resolve(makeConfig({}));
    expect(toolNames(tools).filter((n) => n.startsWith('mcp__'))).toEqual([]);
    expect(getClientMock).not.toHaveBeenCalled();
  });
});

/**
 * EXT-211 — the bindings the resolver records for approval-subject resolution: every MCP tool,
 * adapter-loaded and synthesized alike, under the server it was loaded for. The server key below
 * nests another key, which is the case a registered name cannot settle on its own.
 */
describe('resolvers MCP tool bindings (EXT-211)', () => {
  const nested = `files${MCP_SERVER_SEPARATOR}archive`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function resolveWithBindings(config: GthConfig) {
    const { createResolvers } = await import('#src/resolvers.js');
    const resolvers = createResolvers();
    const tools = await resolvers.resolveTools!(config);
    return { tools, bindings: resolvers.getMcpToolBindings!() };
  }

  it('binds adapter tools and synthesized resource tools to the server each loaded for', async () => {
    const search = mcpToolRegisteredName('files', 'search');
    const fetchTool = mcpToolRegisteredName(nested, 'fetch');
    listToolsetsMock.mockResolvedValue({
      files: [{ name: search }],
      [nested]: [{ name: fetchTool }],
    });
    getClientMock.mockImplementation(async (name: string) =>
      name === nested ? fakeClient({ resources: true }) : fakeClient()
    );

    const { bindings } = await resolveWithBindings(
      makeConfig({
        files: { url: 'https://a.example/mcp' },
        [nested]: { url: 'https://b.example' },
      })
    );

    expect(Object.fromEntries(bindings)).toEqual({
      [search]: { server: 'files', tool: 'search' },
      [fetchTool]: { server: nested, tool: 'fetch' },
      [mcpToolRegisteredName(nested, 'list_resources')]: { server: nested, tool: 'list_resources' },
      [mcpToolRegisteredName(nested, 'read_resource')]: { server: nested, tool: 'read_resource' },
    });
  });

  it('a server tool colliding with another server’s synthesized resource tool drops every MCP tool', async () => {
    // `files` lists a tool whose registered name is exactly the nested server's synthesized
    // list_resources. Keeping either would attribute one server's tool to the other.
    const colliding = mcpToolRegisteredName(nested, 'list_resources');
    listToolsetsMock.mockResolvedValue({
      files: [{ name: colliding }, { name: mcpToolRegisteredName('files', 'search') }],
    });
    getClientMock.mockImplementation(async (name: string) =>
      name === nested ? fakeClient({ resources: true }) : fakeClient()
    );

    const { tools, bindings } = await resolveWithBindings(
      makeConfig({
        files: { url: 'https://a.example/mcp' },
        [nested]: { url: 'https://b.example' },
      })
    );

    expect(toolNames(tools).filter((n) => n.startsWith('mcp__'))).toEqual([]);
    expect(bindings.size).toBe(0);
  });

  it('CONTROL: without the collision the same servers keep their tools', async () => {
    listToolsetsMock.mockResolvedValue({
      files: [{ name: mcpToolRegisteredName('files', 'search') }],
    });
    getClientMock.mockImplementation(async (name: string) =>
      name === nested ? fakeClient({ resources: true }) : fakeClient()
    );

    const { tools, bindings } = await resolveWithBindings(
      makeConfig({
        files: { url: 'https://a.example/mcp' },
        [nested]: { url: 'https://b.example' },
      })
    );

    expect(toolNames(tools).filter((n) => n.startsWith('mcp__'))).toHaveLength(3);
    expect(bindings.size).toBe(3);
  });
});
