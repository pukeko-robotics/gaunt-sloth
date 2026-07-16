import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import type { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';

// ── ink render ────────────────────────────────────────────────────────────────
// The render instance must expose clear() + waitUntilExit() (createTuiSession awaits the
// latter). waitUntilExit resolves immediately so the session call returns.
const renderMock = vi.fn();
vi.mock('ink', () => ({ render: renderMock }));

// ── core/config ─────────────────────────────────────────────────────────────--
const initConfigMock = vi.fn();
vi.mock('@gaunt-sloth/core/config.js', () => ({ initConfig: initConfigMock }));

// ── core/GthAgentRunner ───────────────────────────────────────────────────────
const runnerInitMock = vi.fn();
const runnerGetAgentMock = vi.fn();
const runnerCleanupMock = vi.fn();
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => {
  const GthAgentRunner = vi.fn();
  GthAgentRunner.prototype.init = runnerInitMock;
  GthAgentRunner.prototype.getAgent = runnerGetAgentMock;
  GthAgentRunner.prototype.cleanup = runnerCleanupMock;
  GthAgentRunner.prototype.processMessagesWithEvents = vi.fn();
  GthAgentRunner.prototype.resetThread = vi.fn();
  GthAgentRunner.prototype.setToolApprovalCallback = vi.fn();
  // EXT-12 — the session module reads the initial auto-approve state and wires setAutoApprove.
  GthAgentRunner.prototype.isSessionYolo = vi.fn().mockReturnValue(false);
  GthAgentRunner.prototype.toggleSessionYolo = vi.fn();
  GthAgentRunner.prototype.setSessionYolo = vi.fn();
  return { GthAgentRunner };
});

vi.mock('@gaunt-sloth/core/core/types.js', () => ({ StatusLevel: {} }));

// ── core/consoleUtils + fileUtils ─────────────────────────────────────────────
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  flushSessionLog: vi.fn(),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
  // TUI-C19 — the load-time warning-capture window wrapped around initConfig.
  beginWarningCapture: vi.fn(),
  endWarningCapture: vi.fn(() => []),
}));
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn(() => undefined),
}));

// ── systemUtils (stdout is the launch-bump target) ─────────────────────────────
// Stable object so the named binding tuiSessionModule imported keeps pointing at it; tests
// mutate properties rather than reassigning.
const systemUtilsMock = {
  env: {} as Record<string, string | undefined>,
  getProjectDir: vi.fn(() => '/proj'),
  stdout: { isTTY: true, rows: 24, write: vi.fn() } as {
    isTTY?: boolean;
    rows?: number;
    write: ReturnType<typeof vi.fn>;
  },
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

// ── langchain + agent deps (kept inert) ────────────────────────────────────────
vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({ createResolvers: vi.fn() }));
const resolvedFactory = vi.hoisted(() => vi.fn());
const resolveAgentFactoryMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/agent/core/resolveAgentFactory.js', () => ({
  resolveAgentFactory: resolveAgentFactoryMock,
}));
vi.mock('@gaunt-sloth/agent/core/GthDeepAgent.js', () => ({ GthDeepAgent: vi.fn() }));

// ── tui-local deps ─────────────────────────────────────────────────────────────
vi.mock('#src/tui/components/App.js', () => ({ App: vi.fn(() => null) }));
vi.mock('#src/tui/debugRender.js', () => ({
  renderHistory: vi.fn(),
  renderSystemDetails: vi.fn(),
  renderToolDetails: vi.fn(),
  renderResponse: vi.fn(),
  // TUI-C20 — the MCP overview tab's collector + renderer, threaded through the debug bridge.
  collectMcpOverview: vi.fn(() => ({ servers: [], instructions: [], failures: [] })),
  renderMcpDetails: vi.fn(),
}));

const sessionConfig = {
  mode: 'chat',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as SessionConfig;
const overrides = {} as CommandLineConfigOverrides;

describe('createTuiSession — launch bump (TUI-C13)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {}; // no fixture -> production path
    systemUtilsMock.stdout.isTTY = true;
    systemUtilsMock.stdout.rows = 24;
    initConfigMock.mockResolvedValue({});
    resolveAgentFactoryMock.mockReturnValue(resolvedFactory);
    runnerInitMock.mockResolvedValue(undefined);
    runnerGetAgentMock.mockReturnValue({});
    runnerCleanupMock.mockResolvedValue(undefined);
    renderMock.mockReturnValue({
      clear: vi.fn(),
      waitUntilExit: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('writes the bump sequence to stdout BEFORE render when stdout is an interactive TTY', async () => {
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    expect(systemUtilsMock.stdout.write).toHaveBeenCalledTimes(1);
    const written = systemUtilsMock.stdout.write.mock.calls[0][0] as string;
    expect(written).toContain('\n'); // newlines bump prior content into scrollback
    expect(written).toContain('\x1b[H'); // cursor home
    expect(written).toContain('\x1b[J'); // clear to end of *visible* screen
    expect(written).not.toContain('\x1b[3J'); // must NOT erase scrollback

    // Written before Ink paints its first frame.
    const writeOrder = systemUtilsMock.stdout.write.mock.invocationCallOrder[0];
    const renderOrder = renderMock.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renderOrder);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('selects the agent backend via resolveAgentFactory(config, "lean") — B5 (regression: TUI path)', async () => {
    const backendConfig = { agent: { backend: 'deep' } };
    initConfigMock.mockResolvedValue(backendConfig);
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');
    const { GthAgentRunner } = await import('@gaunt-sloth/core/core/GthAgentRunner.js');

    await createTuiSession(sessionConfig, overrides);

    // The TUI is the default interactive surface, so it must default to LEAN like the readline /
    // ask / exec paths (deep is opt-in). It routes through resolveAgentFactory so an explicit
    // config.agent.backend is still honored — not a hardcoded factory.
    expect(resolveAgentFactoryMock).toHaveBeenCalledWith(backendConfig, 'lean');
    // …and the resolved factory is the one handed to the runner as the 3rd ctor arg.
    const runnerCall = (GthAgentRunner as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(runnerCall[2]).toBe(resolvedFactory);
  });

  it('does NOT write the bump sequence when stdout is not a TTY (piped/redirected/tests)', async () => {
    systemUtilsMock.stdout.isTTY = false;
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    expect(systemUtilsMock.stdout.write).not.toHaveBeenCalled();
    // The session still mounts the app — only the cosmetic bump is suppressed.
    expect(renderMock).toHaveBeenCalledTimes(1);
  });
});
