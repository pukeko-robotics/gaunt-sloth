import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

// startGthAcpServer (our deepagents-acp wrapper) — capture the options it is called with.
const startServerMock = vi.fn();
vi.mock('#src/core/gthAcpServer.js', () => ({
  startGthAcpServer: startServerMock,
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

const getProcessCwdMock = vi.fn();
const stderrWriteMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  getProcessCwd: getProcessCwdMock,
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
  systemPrompt: 'SYSTEM PROMPT',
};

describe('acpModule.startAcpServer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createResolversMock.mockReturnValue({ resolveTools: vi.fn() });
    buildDeepAgentParamsMock.mockResolvedValue(PARAMS);
    getProcessCwdMock.mockReturnValue('/work/dir');
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

  it('forwards the system prompt composed by buildDeepAgentParams to the ACP server', async () => {
    // The composed prompt now comes back on params.systemPrompt (built inside GthDeepAgent,
    // shared with the local runner path), not composed locally in acpModule.
    const { startAcpServer } = await import('#src/modules/acpModule.js');

    await startAcpServer(makeConfig());

    expect(startServerMock.mock.calls[0][0].agents.systemPrompt).toBe('SYSTEM PROMPT');
  });

  it('forwards an undefined systemPrompt when buildDeepAgentParams composes none', async () => {
    buildDeepAgentParamsMock.mockResolvedValue({ ...PARAMS, systemPrompt: undefined });
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

  it("rejects agent.backend: 'lean' — ACP is deep-only (B5 guard)", async () => {
    const { startAcpServer } = await import('#src/modules/acpModule.js');
    const config = makeConfig({ agent: { backend: 'lean' } });

    await expect(startAcpServer(config)).rejects.toThrow(/lean.*not supported by the ACP server/);
    // Guard runs before any agent is constructed.
    expect(gthDeepAgentCtorMock).not.toHaveBeenCalled();
    expect(buildDeepAgentParamsMock).not.toHaveBeenCalled();
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it("constructs the deep agent for agent.backend: 'deep'", async () => {
    const { startAcpServer } = await import('#src/modules/acpModule.js');
    const config = makeConfig({ agent: { backend: 'deep' } });

    await startAcpServer(config);

    expect(gthDeepAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(startServerMock).toHaveBeenCalledTimes(1);
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
