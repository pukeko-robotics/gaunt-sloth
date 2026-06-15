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

// Stub the prompt readers (they otherwise hit the gsloth config path on disk) so the composed
// systemPrompt is deterministic. buildSystemMessages returns a single SystemMessage-shaped object.
const buildSystemMessagesMock = vi.fn();
const readChatPromptMock = vi.fn();
const readCodePromptMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', () => ({
  buildSystemMessages: buildSystemMessagesMock,
  readChatPrompt: readChatPromptMock,
  readCodePrompt: readCodePromptMock,
  formatToolCalls: vi.fn(() => ''),
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
    readChatPromptMock.mockReturnValue('chat-mode-prompt');
    readCodePromptMock.mockReturnValue('code-mode-prompt');
    buildSystemMessagesMock.mockReturnValue([{ content: 'SYSTEM PROMPT' }]);
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

  it('passes the composed gsloth system prompt to createDeepAgent (chat prompt by default)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    const config = makeConfig();

    await agent.init('chat', config);

    // 'code' uses the code-mode prompt; everything else (chat/api/…) uses the chat-mode prompt.
    expect(readChatPromptMock).toHaveBeenCalledWith(config);
    expect(readCodePromptMock).not.toHaveBeenCalled();
    expect(buildSystemMessagesMock).toHaveBeenCalledWith(config, 'chat-mode-prompt');
    expect(createDeepAgentMock.mock.calls[0][0].systemPrompt).toBe('SYSTEM PROMPT');
  });

  it('uses the code-mode prompt for the code command', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    const config = makeConfig();

    await agent.init('code', config);

    expect(readCodePromptMock).toHaveBeenCalledWith(config);
    expect(buildSystemMessagesMock).toHaveBeenCalledWith(config, 'code-mode-prompt');
    expect(createDeepAgentMock.mock.calls[0][0].systemPrompt).toBe('SYSTEM PROMPT');
  });

  it('leaves systemPrompt undefined when no prompt content is composed', async () => {
    buildSystemMessagesMock.mockReturnValue([]);
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init('code', makeConfig());

    expect(createDeepAgentMock.mock.calls[0][0].systemPrompt).toBeUndefined();
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
      expect.stringContaining('collide with deepagents built-in filesystem tools: read_file')
    );
  });

  it('resolves tools with filesystem disabled so gsloth fs toolkit is not loaded', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolveTools = vi.fn().mockResolvedValue([]);
    const agent = new GthDeepAgent(statusUpdate, { resolveTools });

    await agent.init(undefined, makeConfig({ filesystem: 'all' }));

    // deepagents owns the filesystem; tool resolution must see filesystem:'none' so the
    // gsloth toolkit's permission-bypassing fs tools are never loaded. Permissions still
    // reflect the real 'all' mode.
    expect(resolveTools).toHaveBeenCalledWith(
      expect.objectContaining({ filesystem: 'none' }),
      undefined
    );
  });

  it('drops a configured summarization middleware (deepagents provides it)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolvers = {
      resolveTools: vi.fn().mockResolvedValue([]),
      resolveMiddleware: vi
        .fn()
        .mockResolvedValue([{ name: 'SummarizationMiddleware' }, { name: 'keep-mw' }]),
    };
    const agent = new GthDeepAgent(statusUpdate, resolvers);

    await agent.init(undefined, makeConfig());

    const names = createDeepAgentMock.mock.calls[0][0].middleware.map(
      (m: { name: string }) => m.name
    );
    expect(names).not.toContain('SummarizationMiddleware');
    expect(names).toContain('keep-mw');
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

  it('orders middleware: fs-denial-softening (outermost), resolved, then status', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolvers = {
      resolveTools: vi.fn().mockResolvedValue([]),
      resolveMiddleware: vi.fn().mockResolvedValue([{ name: 'custom-mw' }]),
    };
    const agent = new GthDeepAgent(statusUpdate, resolvers);

    await agent.init(undefined, makeConfig());

    const params = createDeepAgentMock.mock.calls[0][0];
    expect(params.middleware.map((m: { name: string }) => m.name)).toEqual([
      'GthDeepFsDenialSoftening',
      'custom-mw',
      'GthMiddlewareToolCallStatusUpdate',
    ]);
  });

  it('fs-denial-softening converts a permission throw into an error ToolMessage', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(undefined, makeConfig());

    const softening = createDeepAgentMock.mock.calls[0][0].middleware.find(
      (m: { name: string }) => m.name === 'GthDeepFsDenialSoftening'
    );
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('permission denied for read on /secret.env'));

    const result = await softening.wrapToolCall({ toolCall: { id: 'tc1' } }, handler);
    expect(String(result.content)).toContain('permission denied for read on /secret.env');
    expect(result.tool_call_id).toBe('tc1');
    expect(result.status).toBe('error');
  });

  it('fs-denial-softening rethrows non-permission errors', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(undefined, makeConfig());

    const softening = createDeepAgentMock.mock.calls[0][0].middleware.find(
      (m: { name: string }) => m.name === 'GthDeepFsDenialSoftening'
    );
    const handler = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(softening.wrapToolCall({ toolCall: { id: 'tc1' } }, handler)).rejects.toThrow(
      'boom'
    );
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
