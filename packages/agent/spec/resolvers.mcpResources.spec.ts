import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { GthConfig } from '#src/config.js';

/**
 * EXT-48 — resource-tool synthesis: for each connected MCP server that advertises the `resources`
 * capability (SDK Client.getServerCapabilities().resources, reached via
 * MultiServerMCPClient.getClient(name)), resolvers push two agent-callable tools into the resolved
 * tools array — `mcp__<server>__list_resources` and `mcp__<server>__read_resource` — that close
 * over the live client. Servers without the capability (or that throw) contribute none, and one
 * bad server must not abort the rest. read_resource returns text inline and SUMMARIZES a blob
 * (never leaks raw base64).
 */

// Built-in tools are irrelevant here and would otherwise touch the real fs/tool config — stub to [].
vi.mock('#src/builtInToolsConfig.js', () => ({
  getDefaultTools: vi.fn().mockResolvedValue([]),
}));

// Fake MultiServerMCPClient: getTools() returns no tools; getClient(name) returns a per-server fake
// SDK Client (or throws) so we drive getServerCapabilities() per server; listResources/readResource
// back the synthesized tools' func when invoked.
const getClientMock = vi.fn();
const getToolsMock = vi.fn().mockResolvedValue([]);
const listResourcesMock = vi.fn();
const readResourceMock = vi.fn();
class MultiServerMCPClientStub {
  constructor(public _config: unknown) {}
  getTools = getToolsMock;
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
    getToolsMock.mockResolvedValue([]);
  });

  it('synthesizes list_resources + read_resource for a resources-capable server (namespaced mcp__<server>__)', async () => {
    getClientMock.mockImplementation(async (name: string) =>
      name === 'files' ? fakeClient({ resources: true }) : undefined
    );

    const tools = await resolve(makeConfig({ files: { url: 'https://files.example/mcp' } }));
    const names = toolNames(tools);

    expect(names).toContain('mcp__files__list_resources');
    expect(names).toContain('mcp__files__read_resource');
    // Namespaced so `allowedTools: ['mcp__files__*']` would gate them.
    expect(names.filter((n) => n.startsWith('mcp__files__'))).toHaveLength(2);
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
    expect(names).toContain('mcp__good__list_resources');
    expect(names).toContain('mcp__good__read_resource');
    // The broken server contributed no tools of its own.
    expect(names.some((n) => n.startsWith('mcp__broken__'))).toBe(false);
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
    const listTool = tools.find((t) => t.name === 'mcp__files__list_resources')!;
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
    const readTool = tools.find((t) => t.name === 'mcp__files__read_resource')!;
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
    const readTool = tools.find((t) => t.name === 'mcp__files__read_resource')!;
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
