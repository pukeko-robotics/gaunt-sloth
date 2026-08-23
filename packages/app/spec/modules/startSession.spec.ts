import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';

const interactiveSessionMock = { createInteractiveSession: vi.fn() };
vi.mock('@gaunt-sloth/agent/modules/interactiveSessionModule.js', () => interactiveSessionMock);

const tuiSessionMock = { createTuiSession: vi.fn() };
vi.mock('#src/tui/tuiSessionModule.js', () => tuiSessionMock);

const loadInkMock = { isInkAvailable: vi.fn() };
vi.mock('#src/tui/loadInk.js', () => loadInkMock);

const consoleUtilsMock = { displayWarning: vi.fn(), displayInfo: vi.fn(), displaySuccess: vi.fn() };
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

// CFG-10 — config presence detector. Default: a config exists, so the first-run dialog is
// skipped and the existing dispatcher behaviour is exercised unchanged.
// CFG-37 — the layered `tui` preference reader. Default: unset, so the dispatcher auto-detects.
// The reader's own layering is proven against real files in packages/core/spec/config.tui.spec.ts,
// and the unmocked discovery→dispatch path in startSession.tuiConfig.spec.ts.
// CFG-36 — only the two readers the dispatcher calls are stubbed. The rest of the barrel stays
// real because the dispatcher also CLASSIFIES the errors it catches (a config failure is re-raised
// rather than reported as an absent TUI), and a wholesale mock would replace those predicates with
// nothing. Both directions of that classification are pinned in startSession.configError.spec.ts.
const configMock = { hasAnyConfig: vi.fn(), loadConfiguredTui: vi.fn() };
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gaunt-sloth/core/config.js')>();
  return { ...actual, ...configMock };
});

const firstRunDialogMock = { runFirstRunDialog: vi.fn() };
vi.mock('#src/commands/firstRunDialog.js', () => firstRunDialogMock);

// Stable objects so the named bindings startSession imported keep pointing at them; tests
// mutate properties rather than reassigning.
const systemUtilsMock = {
  stdin: { isTTY: true } as { isTTY?: boolean },
  stdout: { isTTY: true } as { isTTY?: boolean },
  env: {} as Record<string, string | undefined>,
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

const sessionConfig = {
  mode: 'chat',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as SessionConfig;

describe('startSession dispatcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.stdin.isTTY = true;
    systemUtilsMock.stdout.isTTY = true;
    systemUtilsMock.env = { TERM: 'xterm-256color' };
    loadInkMock.isInkAvailable.mockResolvedValue(true);
    tuiSessionMock.createTuiSession.mockResolvedValue(undefined);
    interactiveSessionMock.createInteractiveSession.mockResolvedValue(undefined);
    // Default: a config exists -> CFG-10 first-run dialog is not triggered.
    configMock.hasAnyConfig.mockResolvedValue(true);
    // Default: no config sets `tui` -> CFG-37 defers to the existing auto-detect.
    configMock.loadConfiguredTui.mockResolvedValue(undefined);
    firstRunDialogMock.runFirstRunDialog.mockResolvedValue(undefined);
  });

  it('uses the readline session in a non-TTY environment without probing Ink', async () => {
    systemUtilsMock.stdout.isTTY = false;
    const { startSession } = await import('#src/modules/startSession.js');

    await startSession(sessionConfig, {}, 'hello');

    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledWith(
      sessionConfig,
      {},
      'hello'
    );
    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(loadInkMock.isInkAvailable).not.toHaveBeenCalled();
  });

  it('uses the TUI when the terminal supports it and Ink is available', async () => {
    const { startSession } = await import('#src/modules/startSession.js');

    await startSession(sessionConfig, {}, 'hi');

    expect(tuiSessionMock.createTuiSession).toHaveBeenCalledWith(
      sessionConfig,
      {},
      'hi',
      // CFG-47 — the render-phase callback the dispatcher uses to tell a TUI failure from one the
      // readline path would also have had.
      expect.any(Function)
    );
    expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
  });

  it('falls back to readline when Ink is not installed', async () => {
    loadInkMock.isInkAvailable.mockResolvedValue(false);
    const { startSession } = await import('#src/modules/startSession.js');

    await startSession(sessionConfig, {}, undefined);

    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledWith(
      sessionConfig,
      {},
      undefined
    );
  });

  it('forces readline (and skips the Ink probe) when --no-tui is set', async () => {
    const { startSession } = await import('#src/modules/startSession.js');

    await startSession(sessionConfig, { tui: false }, undefined);

    expect(loadInkMock.isInkAvailable).not.toHaveBeenCalled();
    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalled();
  });

  it('CFG-16: runs the first-run dialog when no config exists, then continues into the session', async () => {
    // No config initially; after the dialog writes one, config is present.
    configMock.hasAnyConfig.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    loadInkMock.isInkAvailable.mockResolvedValue(false);

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(firstRunDialogMock.runFirstRunDialog).toHaveBeenCalledTimes(1);
    // CFG-16: a SUCCESSFUL first-run hands straight off into the interactive session in the same
    // process (no dead-end "re-run gth" message). Ink is unavailable here, so it falls through to
    // the readline session with the SAME sessionConfig and the freshly written config.
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledWith(
      sessionConfig,
      {},
      undefined
    );
    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
  });

  it('CFG-16: continues into the TUI session after a successful first-run when Ink is available', async () => {
    configMock.hasAnyConfig.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    loadInkMock.isInkAvailable.mockResolvedValue(true);

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(firstRunDialogMock.runFirstRunDialog).toHaveBeenCalledTimes(1);
    expect(tuiSessionMock.createTuiSession).toHaveBeenCalledWith(
      sessionConfig,
      {},
      undefined,
      expect.any(Function)
    );
    expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
  });

  it('CFG-56: pins the dialog to the global scope under --global', async () => {
    // Left to the dialog's project default, `gth -g` would write a config the run cannot see, fail
    // the re-check below and report incomplete setup on every retry.
    configMock.hasAnyConfig.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    loadInkMock.isInkAvailable.mockResolvedValue(false);

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, { global: true }, undefined);

    expect(firstRunDialogMock.runFirstRunDialog).toHaveBeenCalledWith(
      {},
      false,
      'global',
      undefined
    );
  });

  it('CFG-56: leaves the scope to the user without --global', async () => {
    configMock.hasAnyConfig.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    loadInkMock.isInkAvailable.mockResolvedValue(false);

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(firstRunDialogMock.runFirstRunDialog).toHaveBeenCalledWith(
      {},
      false,
      undefined,
      undefined
    );
  });

  it('GS2-33: pins the dialog to the named profile under -i/--profile', async () => {
    configMock.hasAnyConfig.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    loadInkMock.isInkAvailable.mockResolvedValue(false);

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, { identityProfile: 'test2' }, undefined);

    expect(firstRunDialogMock.runFirstRunDialog).toHaveBeenCalledWith(
      {},
      false,
      undefined,
      'test2'
    );
  });

  it('GS2-33: pins the dialog to global scope and the named profile under --global -i', async () => {
    configMock.hasAnyConfig.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    loadInkMock.isInkAvailable.mockResolvedValue(false);

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, { global: true, identityProfile: 'test2' }, undefined);

    expect(firstRunDialogMock.runFirstRunDialog).toHaveBeenCalledWith({}, false, 'global', 'test2');
  });

  it('CFG-16: does NOT run the dialog (no auto-launch) on a non-TTY (piped) run', async () => {
    systemUtilsMock.stdin.isTTY = false;
    configMock.hasAnyConfig.mockResolvedValue(false);

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    // No TTY -> never enter first-run setup, so there is no setup-driven auto-launch. It falls
    // through to the normal session (which surfaces the existing "no config" error downstream).
    expect(firstRunDialogMock.runFirstRunDialog).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledTimes(1);
  });

  it('CFG-10: aborts (no session) when setup is not completed', async () => {
    configMock.hasAnyConfig.mockResolvedValue(false); // still no config after the dialog
    loadInkMock.isInkAvailable.mockResolvedValue(false);

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(firstRunDialogMock.runFirstRunDialog).toHaveBeenCalledTimes(1);
    expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
  });

  // CFG-37 — the dispatcher must ACT on the configured preference, not merely read it. Each case
  // pins the rung against the neighbour it has to outrank, so the chain cannot quietly re-order.
  describe('CFG-37: the tui config key reaches the dispatch', () => {
    it('starts the readline session when a config sets tui false', async () => {
      configMock.loadConfiguredTui.mockResolvedValue(false);
      const { startSession } = await import('#src/modules/startSession.js');

      await startSession(sessionConfig, {}, undefined);

      expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
      // Cheap-gates-first is preserved: a config opt-out must not load React/Ink either.
      expect(loadInkMock.isInkAvailable).not.toHaveBeenCalled();
      expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledWith(
        sessionConfig,
        {},
        undefined
      );
    });

    it('starts the TUI when a config sets tui true in a CI env that would auto-off', async () => {
      systemUtilsMock.env = { TERM: 'xterm-256color', CI: '1' };
      configMock.loadConfiguredTui.mockResolvedValue(true);
      const { startSession } = await import('#src/modules/startSession.js');

      await startSession(sessionConfig, {}, undefined);

      expect(tuiSessionMock.createTuiSession).toHaveBeenCalledWith(
        sessionConfig,
        {},
        undefined,
        expect.any(Function)
      );
      expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
    });

    it('lets --no-tui beat a config true', async () => {
      configMock.loadConfiguredTui.mockResolvedValue(true);
      const { startSession } = await import('#src/modules/startSession.js');

      await startSession(sessionConfig, { tui: false }, undefined);

      expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
      expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalled();
    });

    it('lets --tui beat a config false', async () => {
      configMock.loadConfiguredTui.mockResolvedValue(false);
      const { startSession } = await import('#src/modules/startSession.js');

      await startSession(sessionConfig, { tui: true }, undefined);

      expect(tuiSessionMock.createTuiSession).toHaveBeenCalled();
      expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
    });

    it('lets GTH_NO_TUI beat a config true', async () => {
      systemUtilsMock.env = { TERM: 'xterm-256color', GTH_NO_TUI: '1' };
      configMock.loadConfiguredTui.mockResolvedValue(true);
      const { startSession } = await import('#src/modules/startSession.js');

      await startSession(sessionConfig, {}, undefined);

      expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
      expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalled();
    });

    it('degrades a config true to readline on a non-TTY, without crashing', async () => {
      systemUtilsMock.stdout.isTTY = false;
      configMock.loadConfiguredTui.mockResolvedValue(true);
      const { startSession } = await import('#src/modules/startSession.js');

      await expect(startSession(sessionConfig, {}, undefined)).resolves.toBeUndefined();

      expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
      expect(loadInkMock.isInkAvailable).not.toHaveBeenCalled();
      expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalled();
    });

    it('degrades a config true to readline when ink is not installed, without crashing', async () => {
      loadInkMock.isInkAvailable.mockResolvedValue(false);
      configMock.loadConfiguredTui.mockResolvedValue(true);
      const { startSession } = await import('#src/modules/startSession.js');

      await expect(startSession(sessionConfig, {}, undefined)).resolves.toBeUndefined();

      expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
      expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalled();
    });
  });

  it('degrades to readline with a warning if mounting the TUI throws', async () => {
    // CFG-47 — "mounting" is now a phase the session announces rather than an assumption about any
    // throw: the dispatcher falls back only for a failure raised after `onRenderStart` fires. A
    // mount failure is raised after it, so this behaviour is unchanged; a failure BEFORE it (a bad
    // config, a runner that would not start) propagates instead, which
    // startSession.configError.spec.ts pins in both directions.
    tuiSessionMock.createTuiSession.mockImplementation(
      async (
        _sessionConfig: unknown,
        _overrides: unknown,
        _message: unknown,
        onRenderStart?: () => void
      ) => {
        onRenderStart?.();
        throw new Error('no raw mode');
      }
    );
    const { startSession } = await import('#src/modules/startSession.js');

    await startSession(sessionConfig, {}, 'hi');

    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('no raw mode')
    );
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledWith(
      sessionConfig,
      {},
      'hi'
    );
  });
});
