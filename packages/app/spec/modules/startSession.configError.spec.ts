import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';

/**
 * CFG-36 / CFG-47 — what the dispatcher's TUI fallback is allowed to swallow.
 *
 * CFG-36 fixed a config failure being reported as the TUI being unavailable by re-raising the two
 * config error CLASSES from the catch. CFG-47 replaced that list with the rule it was approximating:
 * **falling back to readline can only help a failure the readline path would not also have.**
 * `createTuiSession` loads config, opens the conversation, starts session logging and runs
 * `runner.init` (which resolves the `subagents[].profile` configs) — every one of which the readline
 * path does identically — before it touches the terminal. So the fallback now covers exactly two
 * things: loading the TUI module (which statically imports the optional ink/react/chalk subtree),
 * and the render phase, which `createTuiSession` announces through its `onRenderStart` callback.
 *
 * **The cell that makes this ticket different from its predecessor is the third one.** A test that
 * only showed MARKED errors propagating would stay green on CFG-36's code and would therefore prove
 * nothing about the narrowing — the whole point is that a marker list always trails the code. It is
 * deliberately SYNTHETIC: `loader.ts`'s `-c <missing path>` throw was the real unmarked case, and
 * CFG-47 marks it, so pinning the narrowing on any specific production error would tie this cell's
 * life to that error's classification instead of to the rule.
 *
 * This is the level where any of it can be pinned at all: `createTuiSession`'s `GTH_TUI_E2E_FIXTURE`
 * branch returns BEFORE its config load, so the PTY e2e suite cannot reach the seam even in
 * principle. Both directions are asserted on purpose — a fallback that never happens is as wrong as
 * one that always does, so cells 4 and 5 redden if the fallback is removed while 1-3 redden if it
 * swallows too much.
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

/** `createTuiSession` failing BEFORE it reaches the render phase: `onRenderStart` is never called. */
function failsBeforeRender(error: unknown): void {
  tuiSessionMock.createTuiSession.mockImplementation(async () => {
    throw error;
  });
}

/** `createTuiSession` failing AFTER it announced the render phase, as a mount failure does. */
function failsDuringRender(error: unknown): void {
  tuiSessionMock.createTuiSession.mockImplementation(
    async (
      _sessionConfig: unknown,
      _overrides: unknown,
      _message: unknown,
      onRenderStart?: () => void
    ) => {
      onRenderStart?.();
      throw error;
    }
  );
}

describe('CFG-36/CFG-47: the TUI fallback covers the TUI and nothing else', () => {
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

  afterEach(async () => {
    // Cell 4 replaces the TUI module with a factory that throws; put the normal stub back (and drop
    // the module cache that remembers the failure) so the ordering of the cells cannot matter.
    // Deliberately re-mocking rather than `doUnmock`ing: unmocking would hand the later cells the
    // REAL tuiSessionModule, whose optional-dependency imports have nothing stubbed under them.
    vi.doMock('#src/tui/tuiSessionModule.js', () => tuiSessionMock);
    vi.resetModules();
    // **The pattern this spec is written to, and why the order is load-bearing.** `vi.doMock` does
    // not register a mock. It appends to a queue that vitest drains at the next module fetch, and
    // the drain resolves every consecutive `mock` entry IN PARALLEL: each entry awaits its own
    // module-resolution round trip and only then writes the mock registry, which is a plain
    // last-writer-wins map. Two queued registrations for the SAME path therefore do not apply in
    // the order they were queued — the one whose round trip finishes last wins. Un-drained, the
    // restore above shares a batch with the `vi.doMock` in the module-load cell below, and whenever
    // it lands second that cell gets the ordinary stub instead: the TUI "loads", and the readline
    // fallback the cell exists to prove never happens. It fails as a bare `createTuiSession` was
    // called, which reads like a product defect and is not one.
    // So: **one pending `vi.doMock` per module path at a time — consume it with the import it is
    // for before any other cell can queue its own.** The await below is that consumption; it leaves
    // the queue empty at the start of every cell, which is what makes cell 4's registration the
    // only one in its batch and therefore deterministic. Any spec that swaps a module mock between
    // cases needs the same discipline.
    // The one way to break that invariant from inside this file: a cell that queues a `vi.doMock`
    // and then fails or returns BEFORE its own import. Its entry stays pending, the restore joins
    // it, and this hook drains a batch of two — the same race, relocated somewhere far worse to
    // read, because the losing side is now the restore. If the throwing factory wins, the import
    // below executes it and this hook throws, so the failure surfaces against a cell that did
    // nothing wrong. A cell that queues a mock must reach the import it queued it for.
    // Where `vi.resetModules()` sits relative to `vi.doMock` is NOT part of this: the reset clears
    // the evaluated-module cache and deliberately skips mock entries, so it can neither discard nor
    // reorder a queued registration. Moving it does not fix anything, and is not why this works.
    await import('#src/tui/tuiSessionModule.js');
  });

  it('re-raises an unusable configuration instead of blaming the TUI', async () => {
    const error = await configDiscoveryError();
    failsBeforeRender(error);
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
    failsBeforeRender(error);
    const { startSession } = await import('#src/modules/startSession.js');

    await expect(startSession(sessionConfig, {}, 'hi')).rejects.toBe(error);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
  });

  // CFG-47, the cell this ticket exists for. NOTHING about this error is recognisable: it is a bare
  // Error with no marker property, no distinguishing message and no class of its own — exactly what
  // `initConfig`'s "-c <path> does not exist" was before this branch, and exactly what the next
  // unanticipated pre-render failure will be. It propagates because it happened before the render
  // phase, which is a property of WHERE it was raised rather than of WHAT it is. Restore CFG-36's
  // `if (isConfigDiscoveryError(err) || isMissingProviderKeyError(err)) throw err` and this is the
  // cell that goes red while the other four stay green.
  it('re-raises an UNMARKED pre-render failure too — the fallback is not a list of error types', async () => {
    const anonymous = new Error('subagent profile "reviewer" could not be prepared');
    failsBeforeRender(anonymous);
    const { startSession } = await import('#src/modules/startSession.js');

    await expect(startSession(sessionConfig, {}, 'hi')).rejects.toBe(anonymous);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
  });

  // The other direction, half 1: the optional TUI subtree is genuinely not installed. `ink` and
  // `react` are optionalDependencies and `#src/tui/tuiSessionModule.js` imports them statically, so
  // a headless install fails at the IMPORT — which is why the import gets a try of its own.
  it('still degrades to readline when the TUI module cannot be loaded at all', async () => {
    vi.doMock('#src/tui/tuiSessionModule.js', () => {
      throw new Error("Cannot find package 'ink'");
    });
    vi.resetModules();
    const { startSession } = await import('#src/modules/startSession.js');

    await expect(startSession(sessionConfig, {}, 'hi')).resolves.toBeUndefined();

    // `createTuiSession` was never entered — the failure was the module load, which is what
    // separates this cell from the render-failure one below. It is also the assertion that stays
    // meaningful whatever the loader says: vitest substitutes its own diagnostic for an error
    // thrown out of a mock factory, so the message reaching the notice is vitest's rather than the
    // one written above. What the notice must show is that it is the TUI that is unavailable, and
    // that the underlying reason travelled into it rather than being discarded.
    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
    const notice = consoleUtilsMock.displayWarning.mock.calls[0][0] as string;
    expect(notice).toMatch(/^TUI unavailable \(.+\); falling back to the readline session\.$/s);
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledWith(
      sessionConfig,
      {},
      'hi'
    );
  });

  // The other direction, half 2: Ink is present but will not mount on this terminal. That failure
  // happens after `createTuiSession` announced the render phase, and readline genuinely is the
  // answer to it. Without this cell (and the one above) "re-raise everything" would satisfy 1-3.
  it('still degrades to readline when the render itself fails', async () => {
    failsDuringRender(new Error('Raw mode is not supported'));
    const { startSession } = await import('#src/modules/startSession.js');

    await expect(startSession(sessionConfig, {}, 'hi')).resolves.toBeUndefined();

    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('Raw mode is not supported')
    );
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledWith(
      sessionConfig,
      {},
      'hi'
    );
  });
});
