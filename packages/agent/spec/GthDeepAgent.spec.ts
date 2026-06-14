import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';
import { buildPermissions } from '#src/core/deepAgentPermissions.js';

// Capture createDeepAgent params; stub FilesystemBackend as a constructible marker.
const createDeepAgentMock = vi.fn();
class FilesystemBackendStub {
  options: unknown;
  constructor(options: unknown) {
    this.options = options;
  }
}
vi.mock('deepagents', () => ({
  createDeepAgent: createDeepAgentMock,
  FilesystemBackend: FilesystemBackendStub,
}));

function fakeTool(name: string, metadata?: Record<string, unknown>): any {
  const invoke = vi.fn();
  return { name, description: name, metadata, invoke, call: invoke, schema: {} };
}

function makeConfig(over: Partial<GthConfig> = {}): GthConfig {
  return {
    llm: { bindTools: () => ({}) } as any,
    filesystem: 'all',
    streamOutput: true,
    ...over,
  } as GthConfig;
}

describe('GthDeepAgent', () => {
  const statusUpdate = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    createDeepAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
  });

  it('builds a deep agent with model, FilesystemBackend, permissions and checkpointer', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolvers = {
      resolveTools: vi.fn().mockResolvedValue([fakeTool('foo')]),
      resolveMiddleware: vi.fn().mockResolvedValue([]),
    };
    const config = makeConfig({ filesystem: 'none' });
    const agent = new GthDeepAgent(statusUpdate, resolvers);

    const checkpointer = { id: 'cp' } as any;

    await agent.init(undefined, config, checkpointer);

    expect(createDeepAgentMock).toHaveBeenCalledTimes(1);
    const params = createDeepAgentMock.mock.calls[0][0];
    expect(params.model).toBe(config.llm);
    expect(params.checkpointer).toBe(checkpointer);
    expect(params.backend).toBeInstanceOf(FilesystemBackendStub);
    expect((params.backend as FilesystemBackendStub).options).toMatchObject({ virtualMode: true });
    expect(params.permissions).toEqual(buildPermissions({ filesystem: 'none' }));
    expect(params.tools.map((t: { name: string }) => t.name)).toEqual(['foo']);
  });

  it('drops resolved tools that collide with deepagents filesystem tool names', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolvers = {
      resolveTools: vi.fn().mockResolvedValue([fakeTool('read_file'), fakeTool('keep')]),
    };
    const agent = new GthDeepAgent(statusUpdate, resolvers);

    await agent.init(undefined, makeConfig());

    const params = createDeepAgentMock.mock.calls[0][0];
    expect(params.tools.map((t: { name: string }) => t.name)).toEqual(['keep']);
    expect(statusUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('superseding: read_file')
    );
  });

  it('maps .aiignore + filesystem mode onto permissions', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const config = makeConfig({
      filesystem: ['src'],
      aiignore: { enabled: true, patterns: ['*.env'] },
    });
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init(undefined, config);

    const params = createDeepAgentMock.mock.calls[0][0];
    expect(params.permissions).toEqual(
      buildPermissions({ filesystem: ['src'], aiignore: { enabled: true, patterns: ['*.env'] } })
    );
    // .aiignore deny rule comes first (wins over the src allow rule).
    expect(params.permissions[0].mode).toBe('deny');
  });

  it('appends the tool-call status middleware after resolved middleware', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolvers = {
      resolveTools: vi.fn().mockResolvedValue([]),
      resolveMiddleware: vi.fn().mockResolvedValue([{ name: 'custom-mw' }]),
    };
    const agent = new GthDeepAgent(statusUpdate, resolvers);

    await agent.init(undefined, makeConfig());

    const params = createDeepAgentMock.mock.calls[0][0];
    expect(params.middleware.map((m: { name: string }) => m.name)).toEqual([
      'custom-mw',
      'GthMiddlewareToolCallStatusUpdate',
    ]);
  });

  it('skips tool resolution entirely when allowedTools is an empty allow-list', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolveTools = vi.fn();
    const agent = new GthDeepAgent(statusUpdate, { resolveTools });

    await agent.init(undefined, makeConfig({ allowedTools: [] }));

    expect(resolveTools).not.toHaveBeenCalled();
    expect(createDeepAgentMock.mock.calls[0][0].tools).toEqual([]);
  });

  it('stubs client config tools (clones, swapping the body for interrupt)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const clientTool = fakeTool('client_tool', { client: true });
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init(undefined, makeConfig({ tools: [clientTool] }));

    const passed = createDeepAgentMock.mock.calls[0][0].tools;
    expect(passed).toHaveLength(1);
    expect(passed[0].name).toBe('client_tool');
    // extractAndFlattenTools clones client tools and replaces invoke/call with a stub.
    expect(passed[0]).not.toBe(clientTool);
    expect(passed[0].invoke).not.toBe(clientTool.invoke);
  });
});
