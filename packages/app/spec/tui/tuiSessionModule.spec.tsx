import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
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
  // CFG-26 — the session module seeds the status bar from the resolved posture and wires the
  // `/approvals` family through the runner.
  // CFG-26 — the session module seeds the status bar from the RESOLVED posture and wires the
  // `/approvals` family through these.
  GthAgentRunner.prototype.getSessionApprovals = vi.fn().mockReturnValue({
    mode: 'ask',
    rater: { enabled: false, strictness: 'standard', escalate: 'danger' },
    allowlist: true,
    persistAllowlist: true,
  });
  GthAgentRunner.prototype.setSessionApprovalMode = vi.fn();
  GthAgentRunner.prototype.getAllowlistCounts = vi
    .fn()
    .mockReturnValue({ session: 0, always: undefined });
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
  // TUI-C37 — mouse reports arrive on stdin, so the module reads it to build the filtered proxy.
  stdin: Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  }),
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
// The hermetic e2e seam (GTH_TUI_E2E_FIXTURE) — mocked so the fixture branch's own copy of the
// TTY gate is reachable from a unit test.
const createFixtureTuiAgentMock = vi.fn();
vi.mock('#src/tui/fixtureAgent.js', () => ({
  createFixtureTuiAgent: createFixtureTuiAgentMock,
}));
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

describe('createTuiSession — the full-screen surface (TUI-C48)', () => {
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

  // TUI-C48 — the one seam that makes the session full-screen. Ink owns entering and leaving the
  // alternate buffer AND restoring the user's original screen on every exit path including signals
  // (measured), so what this repo has to get right is exactly this option being set — and it is
  // the sort of thing a refactor drops silently, because nothing else observably changes.
  it('renders into the alternate screen', async () => {
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    expect(renderMock).toHaveBeenCalledTimes(1);
    const options = renderMock.mock.calls[0][1] as { alternateScreen?: boolean };
    expect(options.alternateScreen).toBe(true);
  });

  it('writes no viewport bump of its own — the alternate screen replaced it', async () => {
    // The TUI-C13 launch bump pushed a screenful of newlines into the user's scrollback and then
    // homed the cursor. In the alternate screen that is both pointless and destructive: the buffer
    // Ink switches to is already blank, and the newlines would scroll the user's real screen away
    // for nothing. Assert on the BYTES rather than on the absence of a call, because the session
    // legitimately writes other escapes (see the alternate-scroll block below).
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    const written = systemUtilsMock.stdout.write.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(written).not.toContain('\n');
    expect(written).not.toContain('\x1b[H');
    expect(written).not.toContain('\x1b[J');
  });

  // TUI-C48 constraint 7 — in the alternate screen a terminal with NO mouse mode set converts wheel
  // notches into bare Up/Down arrows, which the slash-command menu claims. Exactly one of the two
  // terminal modes is installed at a time, and this is the pair that proves it: neither "always
  // suppress" nor "never suppress" passes both halves.
  describe('alternate-scroll suppression', () => {
    it('suppresses alternate-scroll when mouse tracking is OFF', async () => {
      initConfigMock.mockResolvedValue({ useMouse: false });
      const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

      await createTuiSession(sessionConfig, overrides);

      const written = systemUtilsMock.stdout.write.mock.calls.map((c: unknown[]) => c[0]).join('');
      expect(written).toContain('\x1b[?1007l');
      expect(written).not.toContain('\x1b[?1000h');
    });

    it('leaves alternate-scroll alone when mouse tracking is ON', async () => {
      // With tracking on the terminal reports the wheel as an SGR event and alternate-scroll never
      // applies, so touching it would change a user's terminal setting for no reason.
      initConfigMock.mockResolvedValue({ useMouse: true });
      const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

      await createTuiSession(sessionConfig, overrides);

      const written = systemUtilsMock.stdout.write.mock.calls.map((c: unknown[]) => c[0]).join('');
      expect(written).toContain('\x1b[?1000h');
      expect(written).not.toContain('\x1b[?1007l');
    });
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
    const runnerCall = (GthAgentRunner as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    expect(runnerCall[2]).toBe(resolvedFactory);
  });

  it('GS2-63: forces output.header ON for the TUI even when config opts it out', async () => {
    // The `output.header: false` opt-out only applies to non-TUI text modes; the interactive
    // TUI must ALWAYS show the run-header preamble, so createTuiSession overrides the setting.
    initConfigMock.mockResolvedValue({ output: { header: false } });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    expect(runnerInitMock).toHaveBeenCalledTimes(1);
    const initConfigArg = runnerInitMock.mock.calls[0][1] as { output?: { header?: boolean } };
    expect(initConfigArg.output?.header).toBe(true);
  });

  // CFG-25 — call-site wiring: createTuiSession must pass sessionConfig.mode into the (real,
  // unmocked) formatConfigSummary so the /config panel prop carries the EFFECTIVE per-command
  // filesystem. If a refactor drops the second argument, the prop reads `Filesystem: none` and
  // this fails — the original live bug.
  it('passes the session mode through to the configSummary prop (CFG-25 wiring)', async () => {
    initConfigMock.mockResolvedValue({
      filesystem: 'none',
      commands: { chat: { filesystem: 'read' } },
    });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    const appElement = renderMock.mock.calls[0][0] as { props: { configSummary: string[] } };
    expect(appElement.props.configSummary).toContain('Filesystem: read (chat; top-level: none)');
    expect(appElement.props.configSummary).not.toContain('Filesystem: none');
  });

  it('still asks for the alternate screen on a non-TTY, because Ink is what no-ops it', async () => {
    // Ink resolves `alternateScreen` against its own interactive/TTY detection and writes nothing
    // on a pipe. Gating it here as well would be a second copy of that policy, free to drift — and
    // the surface that would break is the one nobody watches.
    systemUtilsMock.stdout.isTTY = false;
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect((renderMock.mock.calls[0][1] as { alternateScreen?: boolean }).alternateScreen).toBe(
      true
    );
  });

  // TUI-C33 — the banner is terminal chrome, so it must be gated on stdout being a real TTY on
  // BOTH interactive surfaces. The plain surface's half of this is proved in
  // interactiveSessionModule.banner.spec.ts; this is the TUI's half.
  it('TUI-C33: gates showLaunchBanner on stdout being a TTY', async () => {
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');
    const bannerProp = async (isTTY: boolean): Promise<boolean> => {
      renderMock.mockClear();
      systemUtilsMock.stdout.isTTY = isTTY;
      await createTuiSession(sessionConfig, overrides);
      return (renderMock.mock.calls[0][0] as { props: { showLaunchBanner: boolean } }).props
        .showLaunchBanner;
    };

    expect(await bannerProp(true)).toBe(true);
    // Piped/redirected stdout gets no banner — and the prop is a strict boolean, never `undefined`.
    expect(await bannerProp(false)).toBe(false);
  });

  it('TUI-C33: gates showLaunchBanner on a TTY in the hermetic e2e branch too', async () => {
    // The fixture seam mounts its own <App> with its own copy of the gate, so it needs its own
    // assertion — otherwise a regression there is invisible until the PTY suite runs.
    systemUtilsMock.env = { GTH_TUI_E2E_FIXTURE: '/fixtures/session.json' };
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    systemUtilsMock.stdout.isTTY = false;
    await createTuiSession(sessionConfig, overrides);
    expect(
      (renderMock.mock.calls[0][0] as { props: { showLaunchBanner: boolean } }).props
        .showLaunchBanner
    ).toBe(false);
    // The fixture branch never reaches initConfig — it is the pre-config seam.
    expect(initConfigMock).not.toHaveBeenCalled();

    renderMock.mockClear();
    systemUtilsMock.stdout.isTTY = true;
    await createTuiSession(sessionConfig, overrides);
    expect(
      (renderMock.mock.calls[0][0] as { props: { showLaunchBanner: boolean } }).props
        .showLaunchBanner
    ).toBe(true);
  });

  it('TUI-C33: threads modelProviderType from the resolved config into <App>', async () => {
    // The banner names the provider, which the status bar does not — so this is the only path by
    // which the provider reaches the screen.
    initConfigMock.mockResolvedValue({ modelDisplayName: 'gpt-5', modelProviderType: 'openai' });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    const { props } = renderMock.mock.calls[0][0] as {
      props: { modelDisplayName?: string; modelProviderType?: string };
    };
    expect(props.modelProviderType).toBe('openai');
    expect(props.modelDisplayName).toBe('gpt-5');
  });

  it('TUI-C17: runTurn merges live tool output emitted mid-run into the event stream', async () => {
    // The real toolOutputChannel is deliberately NOT mocked here: this proves the session wires
    // runTurn through mergeToolOutputIntoEvents, so a toolkit's emitToolOutput during a run
    // surfaces as a typed `tool_output` event in the stream the <App> folds — instead of hitting
    // the raw stdout default sink and corrupting Ink's frame.
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');
    const { GthAgentRunner } = await import('@gaunt-sloth/core/core/GthAgentRunner.js');
    const { emitToolOutput } = await import('@gaunt-sloth/core/core/toolOutputChannel.js');

    (
      GthAgentRunner.prototype.processMessagesWithEvents as ReturnType<typeof vi.fn>
    ).mockImplementation(async function* () {
      yield { type: 'text', delta: 'running the tool' };
      // A toolkit streaming child output while the graph run is in flight.
      emitToolOutput({
        toolCallId: 'c1',
        toolName: 'run_tests',
        kind: 'output',
        text: 'suite green\n',
      });
      yield { type: 'tool_result', id: 'c1', content: 'done' };
    });

    await createTuiSession(sessionConfig, overrides);

    const appElement = renderMock.mock.calls[0][0] as {
      props: {
        agent: {
          runTurn: (input: string, signal: AbortSignal) => AsyncGenerator<unknown>;
        };
      };
    };
    const events: unknown[] = [];
    for await (const event of appElement.props.agent.runTurn('go', new AbortController().signal)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text', delta: 'running the tool' },
      { type: 'tool_output', id: 'c1', name: 'run_tests', chunk: 'suite green\n' },
      { type: 'tool_result', id: 'c1', content: 'done' },
    ]);
    // Nothing leaked to raw stdout while the turn's subscription was live.
    expect(systemUtilsMock.stdout.write).not.toHaveBeenCalledWith('suite green\n');
  });
});

/**
 * TUI-C37 — the session module's mouse wiring. The point of these is the negative case: a run with
 * mouse off must be byte-identical to one built before mouse existed, which is what keeps piped and
 * captured output clean.
 */
describe('createTuiSession — mouse wiring (TUI-C37)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {};
    systemUtilsMock.stdout.isTTY = true;
    systemUtilsMock.stdout.rows = 24;
    resolveAgentFactoryMock.mockReturnValue(resolvedFactory);
    runnerInitMock.mockResolvedValue(undefined);
    runnerGetAgentMock.mockReturnValue({});
    runnerCleanupMock.mockResolvedValue(undefined);
    renderMock.mockReturnValue({
      clear: vi.fn(),
      waitUntilExit: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('writes no mouse escape bytes at all when the resolved config says mouse is off', async () => {
    initConfigMock.mockResolvedValue({ useMouse: false });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    const written = systemUtilsMock.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(written).not.toContain('1006');
    expect(written).not.toContain('1000h');
  });

  it('still installs the stdin filter when mouse is off, so /mouse on can work later', async () => {
    // The filter has to be in front of Ink before render, and Ink can never be handed a different
    // stdin afterwards. Making it conditional is what silently broke `/mouse on` in a session that
    // started with mouse off: the state flipped, the notice printed, and nothing happened.
    initConfigMock.mockResolvedValue({ useMouse: false });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    const options = renderMock.mock.calls[0][1] as { stdin: unknown };
    expect(options.stdin).toBeDefined();
    expect(options.stdin).not.toBe(systemUtilsMock.stdin);
  });

  it('lets a session that started with mouse off turn reporting on', async () => {
    initConfigMock.mockResolvedValue({ useMouse: false });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);
    const before = systemUtilsMock.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(before).not.toContain('\x1b[?1006h');

    // The App asks the session module to apply the toggle; this is that call.
    const appElement = renderMock.mock.calls[0][0] as {
      props: { onSetMouse?: (enabled: boolean) => void };
    };
    appElement.props.onSetMouse?.(true);

    const after = systemUtilsMock.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(after).toContain('\x1b[?1006h');
  });

  it('enables reporting and hands Ink the FILTERED stdin when mouse is on', async () => {
    initConfigMock.mockResolvedValue({ useMouse: true });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    const written = systemUtilsMock.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('\x1b[?1006h');
    // Not the real stdin: mouse reports must be stripped before Ink ever sees them.
    const options = renderMock.mock.calls[0][1] as { stdin: unknown };
    expect(options.stdin).toBeDefined();
    expect(options.stdin).not.toBe(systemUtilsMock.stdin);
  });

  it('restores the terminal after the session ends', async () => {
    initConfigMock.mockResolvedValue({ useMouse: true });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    const written = systemUtilsMock.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('\x1b[?1006l');
  });

  it('restores the terminal even when the session throws', async () => {
    // The path that leaves a shell spewing escape gibberish if it is missed.
    initConfigMock.mockResolvedValue({ useMouse: true });
    renderMock.mockReturnValue({
      clear: vi.fn(),
      waitUntilExit: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await expect(createTuiSession(sessionConfig, overrides)).rejects.toThrow('boom');

    const written = systemUtilsMock.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('\x1b[?1006l');
  });

  it('seeds the App with the resolved mouse state', async () => {
    initConfigMock.mockResolvedValue({ useMouse: true });
    const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');

    await createTuiSession(sessionConfig, overrides);

    const appElement = renderMock.mock.calls[0][0] as { props: { mouseEnabled?: boolean } };
    expect(appElement.props.mouseEnabled).toBe(true);
  });
});
