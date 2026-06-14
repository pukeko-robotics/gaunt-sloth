import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeBackend {
  cwd?: string;
  virtualMode?: boolean;
  resolveAbsPath?: (_filePath: string) => string;
}

// Fake DeepAgentsServer: a base handleNewSession (records the call + returns a result), an
// acpBackends map, and a start() spy. The real connection wiring dispatches
// `this.handleNewSession(params, conn)` dynamically, so our instance-level patch must intercept.
const baseHandleNewSession = vi.fn();
const startMock = vi.fn();

class FakeDeepAgentsServer {
  acpBackends = new Map<string, FakeBackend>();

  async handleNewSession(params: any, conn: any) {
    return baseHandleNewSession(params, conn);
  }
  async start() {
    return startMock();
  }
}

vi.mock('deepagents-acp', () => ({
  DeepAgentsServer: FakeDeepAgentsServer,
}));

vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({
  debugLog: vi.fn(),
}));

describe('startGthAcpServer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    baseHandleNewSession.mockResolvedValue({ sessionId: 's1' });
    startMock.mockResolvedValue(undefined);
  });

  it('starts the underlying server and returns it', async () => {
    const { startGthAcpServer } = await import('#src/core/gthAcpServer.js');
    const server = await startGthAcpServer({ agents: { name: 'x' } } as never);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(server).toBeInstanceOf(FakeDeepAgentsServer);
  });

  it('re-roots to the session cwd and switches the backend to virtual-fs mode, then delegates', async () => {
    const { startGthAcpServer } = await import('#src/core/gthAcpServer.js');
    const server = (await startGthAcpServer({ agents: { name: 'x' } } as never)) as unknown as {
      acpBackends: Map<string, FakeBackend>;

      handleNewSession: (_params: any, _conn: any) => Promise<any>;
    };
    const backend: FakeBackend = { cwd: '/' };
    server.acpBackends.set('x', backend);

    const result = await server.handleNewSession({ cwd: '/home/me/project' }, { conn: true });

    // Base handler still runs and its result propagates.
    expect(baseHandleNewSession).toHaveBeenCalledWith({ cwd: '/home/me/project' }, { conn: true });
    expect(result).toEqual({ sessionId: 's1' });
    // Backend re-rooted to the resolved session cwd, in virtual-fs mode.
    expect(backend.cwd).toBe('/home/me/project');
    expect(backend.virtualMode).toBe(true);
    // '/' now resolves to the workspace root, not the OS root.
    expect(backend.resolveAbsPath!('/')).toBe('/home/me/project');
    expect(backend.resolveAbsPath!('/src/a.ts')).toBe('/home/me/project/src/a.ts');
  });

  it('still applies virtual-fs mode when session/new carries no cwd, keeping the existing root', async () => {
    const { startGthAcpServer } = await import('#src/core/gthAcpServer.js');
    const server = (await startGthAcpServer({ agents: { name: 'x' } } as never)) as unknown as {
      acpBackends: Map<string, FakeBackend>;

      handleNewSession: (_params: any, _conn: any) => Promise<any>;
    };
    const backend: FakeBackend = { cwd: '/original' };
    server.acpBackends.set('x', backend);

    await server.handleNewSession({}, {});

    expect(backend.cwd).toBe('/original');
    expect(backend.virtualMode).toBe(true);
    expect(backend.resolveAbsPath!('/x')).toBe('/original/x');
  });
});
