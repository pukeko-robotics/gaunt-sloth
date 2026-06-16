import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';

const interactiveSessionMock = { createInteractiveSession: vi.fn() };
vi.mock('@gaunt-sloth/agent/modules/interactiveSessionModule.js', () => interactiveSessionMock);

const tuiSessionMock = { createTuiSession: vi.fn() };
vi.mock('#src/tui/tuiSessionModule.js', () => tuiSessionMock);

const loadInkMock = { isInkAvailable: vi.fn() };
vi.mock('#src/tui/loadInk.js', () => loadInkMock);

const consoleUtilsMock = { displayWarning: vi.fn() };
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

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
