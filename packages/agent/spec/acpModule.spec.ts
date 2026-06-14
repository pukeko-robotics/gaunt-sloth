import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

// startServer (deepagents-acp) — capture the options it is called with.
const startServerMock = vi.fn();
vi.mock('deepagents-acp', () => ({
  startServer: startServerMock,
}));

// GthDeepAgent — capture ctor args and stub buildDeepAgentParams.
const buildDeepAgentParamsMock = vi.fn();
const gthDeepAgentCtorMock = vi.fn();
vi.mock('#src/core/GthDeepAgent.js', () => {
  const GthDeepAgent = vi.fn(function (this: unknown, ...args: unknown[]) {
    gthDeepAgentCtorMock(...args);
  });
  GthDeepAgent.prototype.buildDeepAgentParams = buildDeepAgentParamsMock;
  return { GthDeepAgent };
});

const createResolversMock = vi.fn();
vi.mock('#src/resolvers.js', () => ({
  createResolvers: createResolversMock,
}));

const buildSystemMessagesMock = vi.fn();
const readCodePromptMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', () => ({
  buildSystemMessages: buildSystemMessagesMock,
  readCodePrompt: readCodePromptMock,
}));

const getCurrentWorkDirMock = vi.fn();
const stderrWriteMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  getCurrentWorkDir: getCurrentWorkDirMock,
  stderr: { write: stderrWriteMock },
}));

vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({
  debugLog: vi.fn(),
}));

function makeConfig(over: Partial<GthConfig> = {}): GthConfig {
  return { llm: {} as unknown, filesystem: 'all', ...over } as GthConfig;
}

const PARAMS = {
  model: { id: 'model' },
  tools: [{ name: 'foo' }],
  permissions: [{ operations: ['read'], paths: ['/x'], mode: 'deny' }],
  middleware: [{ name: 'GthDeepFsDenialSoftening' }],
};

describe('acpModule.startAcpServer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createResolversMock.mockReturnValue({ resolveTools: vi.fn() });
    buildDeepAgentParamsMock.mockResolvedValue(PARAMS);
    buildSystemMessagesMock.mockReturnValue([{ content: 'SYSTEM PROMPT' }]);
    readCodePromptMock.mockReturnValue('code-mode-prompt');
    getCurrentWorkDirMock.mockReturnValue('/work/dir');
    startServerMock.mockResolvedValue(undefined);
  });

  it('builds params for the deep agent with the default code command and resolvers', async () => {
    const { startAcpServer } = await import('#src/modules/acpModule.js');
    const config = makeConfig();

    await startAcpServer(config);

    // GthDeepAgent constructed with (statusUpdate, resolvers from createResolvers).
    expect(createResolversMock).toHaveBeenCalledTimes(1);
    expect(gthDeepAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(typeof gthDeepAgentCtorMock.mock.calls[0][0]).toBe('function');
    expect(gthDeepAgentCtorMock.mock.calls[0][1]).toEqual({
      resolveTools: expect.any(Function),
    });
    // Default command is 'code'.
    expect(buildDeepAgentParamsMock).toHaveBeenCalledWith('code', config);
  });

  it('starts the ACP server with name/description/model/tools/middleware/permissions and workspaceRoot', async () => {
    const { startAcpServer } = await import('#src/modules/acpModule.js');

    await startAcpServer(makeConfig());

    expect(startServerMock).toHaveBeenCalledTimes(1);
    const opts = startServerMock.mock.calls[0][0];
    expect(opts.workspaceRoot).toBe('/work/dir');
    expect(opts.agents).toMatchObject({
      name: 'gaunt-sloth',
      description: 'Gaunt Sloth deep coding agent',
      model: PARAMS.model,
      tools: PARAMS.tools,
      middleware: PARAMS.middleware,
      permissions: PARAMS.permissions,
      systemPrompt: 'SYSTEM PROMPT',
    });
  });

  it('composes the system prompt from buildSystemMessages(config, readCodePrompt(config))', async () => {
    const { startAcpServer } = await import('#src/modules/acpModule.js');
    const config = makeConfig();

    await startAcpServer(config);

    expect(readCodePromptMock).toHaveBeenCalledWith(config);
    expect(buildSystemMessagesMock).toHaveBeenCalledWith(config, 'code-mode-prompt');
  });

  it('leaves systemPrompt undefined when no system messages are composed', async () => {
    buildSystemMessagesMock.mockReturnValue([]);
    const { startAcpServer } = await import('#src/modules/acpModule.js');

    await startAcpServer(makeConfig());

    expect(startServerMock.mock.calls[0][0].agents.systemPrompt).toBeUndefined();
  });

  it('honors custom name, description and command options', async () => {
    const { startAcpServer } = await import('#src/modules/acpModule.js');
    const config = makeConfig();

    await startAcpServer(config, { name: 'pukeko', description: 'Custom', command: 'chat' });

    expect(buildDeepAgentParamsMock).toHaveBeenCalledWith('chat', config);
    expect(startServerMock.mock.calls[0][0].agents).toMatchObject({
      name: 'pukeko',
      description: 'Custom',
    });
  });

  it('routes agent status to stderr, never stdout', async () => {
    const { startAcpServer } = await import('#src/modules/acpModule.js');

    await startAcpServer(makeConfig());

    // The status callback handed to GthDeepAgent must write to the stderr stub.
    const statusUpdate = gthDeepAgentCtorMock.mock.calls[0][0] as (
      _level: unknown,
      _message: string
    ) => void;
    statusUpdate(0, 'hello');
    expect(stderrWriteMock).toHaveBeenCalledWith('hello\n');
  });
});
