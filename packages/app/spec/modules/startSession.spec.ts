import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';

const interactiveSessionMock = { createInteractiveSession: vi.fn() };
vi.mock('@gaunt-sloth/agent/modules/interactiveSessionModule.js', () => interactiveSessionMock);

const tuiSessionMock = { createTuiSession: vi.fn() };
vi.mock('#src/tui/tuiSessionModule.js', () => tuiSessionMock);

const loadInkMock = { isInkAvailable: vi.fn() };
vi.mock('#src/tui/loadInk.js', () => loadInkMock);

const consoleUtilsMock = { displayWarning: vi.fn(), displayInfo: vi.fn() };
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

// CFG-10 — config presence detector. Default: a config exists, so the first-run dialog is
// skipped and the existing dispatcher behaviour is exercised unchanged.
const configMock = { hasAnyConfig: vi.fn() };
vi.mock('@gaunt-sloth/core/config.js', () => configMock);

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

    expect(tuiSessionMock.createTuiSession).toHaveBeenCalledWith(sessionConfig, {}, 'hi');
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

  it('CFG-10: runs the first-run dialog when no config exists on an interactive TTY', async () => {
    // No config initially; after the dialog writes one, config is present.
    configMock.hasAnyConfig.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    loadInkMock.isInkAvailable.mockResolvedValue(false); // keep on readline for assertion

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(firstRunDialogMock.runFirstRunDialog).toHaveBeenCalledTimes(1);
    // Continues into the session once setup completes.
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledTimes(1);
  });

  it('CFG-10: does NOT run the dialog or hang on a non-TTY (piped) run', async () => {
    systemUtilsMock.stdin.isTTY = false;
    configMock.hasAnyConfig.mockResolvedValue(false);

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(firstRunDialogMock.runFirstRunDialog).not.toHaveBeenCalled();
    // Falls through to the normal session (which surfaces the existing error downstream).
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

  it('degrades to readline with a warning if mounting the TUI throws', async () => {
    tuiSessionMock.createTuiSession.mockRejectedValue(new Error('no raw mode'));
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
