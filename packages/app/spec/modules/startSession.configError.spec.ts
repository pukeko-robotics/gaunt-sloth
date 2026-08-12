import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';

/**
 * CFG-36 — the dispatcher's TUI catch must tell an unusable CONFIGURATION apart from the TUI being
 * unavailable.
 *
 * `createTuiSession` loads config (and the subagent profiles under it), so a mistyped `-i`, a
 * malformed layer or a missing provider key throws through the very seam that exists to degrade a
 * missing/unmountable Ink to readline. Misclassified, it prints a false diagnosis, restarts under
 * readline, and reports the true failure only on the second config load.
 *
 * This is the level where that can be pinned at all: `createTuiSession`'s `GTH_TUI_E2E_FIXTURE`
 * branch returns BEFORE its config load, so the PTY e2e suite cannot reach the seam even in
 * principle. Both directions are asserted on purpose — a fallback that never happens is as wrong as
 * one that always does, and a cell that only proved the re-raise would stay green if someone
 * removed the readline fallback entirely.
 */

const interactiveSessionMock = { createInteractiveSession: vi.fn() };
vi.mock('@gaunt-sloth/agent/modules/interactiveSessionModule.js', () => interactiveSessionMock);

const tuiSessionMock = { createTuiSession: vi.fn() };
vi.mock('#src/tui/tuiSessionModule.js', () => tuiSessionMock);

const loadInkMock = { isInkAvailable: vi.fn() };
vi.mock('#src/tui/loadInk.js', () => loadInkMock);

const consoleUtilsMock = { displayWarning: vi.fn(), displayInfo: vi.fn(), displaySuccess: vi.fn() };
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

// Only the two readers the dispatcher calls are stubbed; the REST of the config barrel stays real,
// because the error classes and their duck-typed predicates are precisely what is under test here.
// A plain factory would replace them with undefined and the cell would prove nothing.
const configMock = { hasAnyConfig: vi.fn(), loadConfiguredTui: vi.fn() };
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gaunt-sloth/core/config.js')>();
  return { ...actual, ...configMock };
});

const systemUtilsMock = {
  stdin: { isTTY: true } as { isTTY?: boolean },
  stdout: { isTTY: true } as { isTTY?: boolean },
  env: {} as Record<string, string | undefined>,
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

const sessionConfig = {
  mode: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as SessionConfig;

const PROFILE_NOT_FOUND_MESSAGE =
  'identity profile "typo" not found: no config file in .gsloth/.gsloth-settings/typo/';
const MISSING_KEY_MESSAGE = 'Error processing LLM config: Groq API key not found.';

/**
 * The REAL errors a config load raises, built through a dynamic import so the mocks above are
 * initialised first. Real classes rather than look-alikes: the predicates are duck-typed on a marker
 * property, so a hand-rolled stand-in could pass the check while the production class did not.
 */
async function configDiscoveryError(): Promise<Error> {
  const { ConfigDiscoveryError } = await import('@gaunt-sloth/core/config.js');
  return new ConfigDiscoveryError(PROFILE_NOT_FOUND_MESSAGE, { identityProfile: 'typo' });
}

async function missingKeyError(): Promise<Error> {
  const { MissingProviderKeyError } = await import('@gaunt-sloth/core/config.js');
  return new MissingProviderKeyError(MISSING_KEY_MESSAGE, {
    provider: 'groq',
    envVar: 'GROQ_API_KEY',
    envVars: ['GROQ_API_KEY'],
  });
}

describe('CFG-36: a config failure under the TUI is not "TUI unavailable"', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.stdin.isTTY = true;
    systemUtilsMock.stdout.isTTY = true;
    systemUtilsMock.env = { TERM: 'xterm-256color' };
    loadInkMock.isInkAvailable.mockResolvedValue(true);
    interactiveSessionMock.createInteractiveSession.mockResolvedValue(undefined);
    // A config exists (so the first-run dialog is out of the picture) and none sets `tui`.
    configMock.hasAnyConfig.mockResolvedValue(true);
    configMock.loadConfiguredTui.mockResolvedValue(undefined);
  });

  it('re-raises an unusable configuration instead of blaming the TUI', async () => {
    const error = await configDiscoveryError();
    tuiSessionMock.createTuiSession.mockRejectedValue(error);
    const { startSession } = await import('#src/modules/startSession.js');

    // The SAME error object reaches the caller, so the CLI's top-level guard prints it once and
    // chooses the exit code — the loader's message, not a paraphrase of it.
    await expect(startSession(sessionConfig, { identityProfile: 'typo' }, 'hi')).rejects.toBe(
      error
    );

    // No false diagnosis...
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    // ...and no silent restart under readline, which would load the same broken config again and
    // report the real failure only the second time round.
    expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
  });

  it('re-raises a missing provider key the same way (CFG-35 throws through this seam too)', async () => {
    const error = await missingKeyError();
    tuiSessionMock.createTuiSession.mockRejectedValue(error);
    const { startSession } = await import('#src/modules/startSession.js');

    await expect(startSession(sessionConfig, {}, 'hi')).rejects.toBe(error);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
  });

  // The other direction. Ink genuinely absent (or unmountable) is what the fallback is FOR, and it
  // has to keep working: without this case, re-raising everything would satisfy the two above.
  it('still degrades to readline when the TUI itself is unavailable', async () => {
    const inkMissing = Object.assign(new Error("Cannot find package 'ink'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    tuiSessionMock.createTuiSession.mockRejectedValue(inkMissing);
    const { startSession } = await import('#src/modules/startSession.js');

    await expect(startSession(sessionConfig, {}, 'hi')).resolves.toBeUndefined();

    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining("Cannot find package 'ink'")
    );
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledWith(
      sessionConfig,
      {},
      'hi'
    );
  });
});
