import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';

// CFG-37 wiring — the one test level that proves DISCOVERY reaches DISPATCH. startSession.spec
// stubs the config reader (so it can pin the precedence chain cheaply) and config.tui.spec proves
// the reader's layering against real files; between them sits the wiring, and only a spec that
// plants a real config on disk and asserts which session module got called can prove it.
//
// So the core config module is NOT mocked here. Only the two session surfaces, the Ink probe, and
// the global-config path are — the last so a test never reads (or is steered by) the developer's
// real ~/.gsloth config.
const interactiveSessionMock = { createInteractiveSession: vi.fn() };
vi.mock('@gaunt-sloth/agent/modules/interactiveSessionModule.js', () => interactiveSessionMock);

const tuiSessionMock = { createTuiSession: vi.fn() };
vi.mock('#src/tui/tuiSessionModule.js', () => tuiSessionMock);

const loadInkMock = { isInkAvailable: vi.fn() };
vi.mock('#src/tui/loadInk.js', () => loadInkMock);

const { getGlobalGslothConfigReadPathMock } = vi.hoisted(() => ({
  getGlobalGslothConfigReadPathMock:
    vi.fn<(_filename: string, _identityProfile?: string) => string>(),
}));
vi.mock('@gaunt-sloth/core/utils/globalConfigUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@gaunt-sloth/core/utils/globalConfigUtils.js')>();
  return { ...actual, getGlobalGslothConfigReadPath: getGlobalGslothConfigReadPathMock };
});

const sessionConfig = {
  mode: 'chat',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as SessionConfig;

const LLM_SPEC = { type: 'vertexai' };

describe('startSession reads the tui config key off disk (CFG-37 wiring)', () => {
  let root: string;
  let globalDir: string;
  let projectDir: string;
  const origInitCwd = process.env.INIT_CWD;
  let realStdinIsTTY: boolean | undefined;
  let realStdoutIsTTY: boolean | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();

    const { setProjectDir } = await import('@gaunt-sloth/core/utils/systemUtils.js');
    setProjectDir(undefined);

    root = mkdtempSync(resolve(tmpdir(), 'gsloth-tui-wiring-'));
    globalDir = resolve(root, '__global__');
    mkdirSync(globalDir, { recursive: true });
    // `.git` stops the up-tree walk here, so discovery can never escape into the real repo.
    projectDir = resolve(root, 'proj');
    mkdirSync(resolve(projectDir, '.git'), { recursive: true });
    process.env.INIT_CWD = projectDir;
    // Redirect the global dir ONLY; the profile-segment rule stays production code, so a
    // profile-scoped global lookup cannot silently resolve to the unscoped path here.
    const { resolveGlobalConfigPath } =
      await import('@gaunt-sloth/core/utils/globalConfigUtils.js');
    getGlobalGslothConfigReadPathMock.mockImplementation((filename, identityProfile) =>
      resolveGlobalConfigPath(globalDir, filename, identityProfile)
    );

    // Declare the terminal rather than inherit the runner's: systemUtils re-exports the live
    // process streams and process.env, so a TUI-capable terminal has to be stated here or the
    // hard gates decide the case and the config rung is never reached.
    realStdinIsTTY = process.stdin.isTTY;
    realStdoutIsTTY = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('CI', undefined);
    vi.stubEnv('GTH_NO_TUI', undefined);

    loadInkMock.isInkAvailable.mockResolvedValue(true);
    tuiSessionMock.createTuiSession.mockResolvedValue(undefined);
    interactiveSessionMock.createInteractiveSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.stdin.isTTY = realStdinIsTTY as boolean;
    process.stdout.isTTY = realStdoutIsTTY as boolean;
    vi.unstubAllEnvs();
    if (origInitCwd === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = origInitCwd;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const writeProjectConfig = (config: Record<string, unknown>): void => {
    writeFileSync(resolve(projectDir, '.gsloth.config.json'), JSON.stringify(config));
  };
  const writeGlobalConfig = (config: Record<string, unknown>): void => {
    writeFileSync(resolve(globalDir, '.gsloth.config.json'), JSON.stringify(config));
  };

  it('starts the readline session for a GLOBAL config that sets tui false', async () => {
    writeGlobalConfig({ llm: LLM_SPEC, tui: false });

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledTimes(1);
  });

  it('starts the TUI for a GLOBAL config that sets tui true, in a CI env that would auto-off', async () => {
    // CI=1 is what makes this case mean anything. The shared terminal stub already favours the
    // TUI, so against that baseline "TUI was started" is the answer auto-detect gives on its own
    // and the assertion would hold even if the config were never read. Under CI the baseline is
    // readline, so the TUI can only be reached by the global `tui: true` outranking the heuristic.
    vi.stubEnv('CI', '1');
    writeGlobalConfig({ llm: LLM_SPEC, tui: true });

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(tuiSessionMock.createTuiSession).toHaveBeenCalledTimes(1);
    expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
  });

  it('lets a PROJECT config override the global one all the way to the dispatch', async () => {
    writeGlobalConfig({ llm: LLM_SPEC, tui: true });
    writeProjectConfig({ llm: LLM_SPEC, tui: false });

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledTimes(1);
  });

  it('lets --no-tui beat a project config true', async () => {
    writeProjectConfig({ llm: LLM_SPEC, tui: true });

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, { tui: false }, undefined);

    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledTimes(1);
  });

  it('lets GTH_NO_TUI beat a project config true', async () => {
    vi.stubEnv('GTH_NO_TUI', '1');
    writeProjectConfig({ llm: LLM_SPEC, tui: true });

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledTimes(1);
  });

  it('degrades a config true to readline on a non-TTY without crashing', async () => {
    process.stdout.isTTY = false;
    writeProjectConfig({ llm: LLM_SPEC, tui: true });

    const { startSession } = await import('#src/modules/startSession.js');
    await expect(startSession(sessionConfig, {}, undefined)).resolves.toBeUndefined();

    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledTimes(1);
  });

  // TUI-C48 — what the dispatcher does with the session once the config has decided.
  //
  // Both session surfaces are mocked in this file, so what it can see is the dispatch: which
  // surface was called and what it was handed. That is the right question here and the wrong one
  // for the terminal — nothing at this level observes a buffer switch, and an assertion that a
  // mock was not called must not be described as one. The terminal-level half of the seam is a
  // pair of cases in `tui-e2e/chat.tui.test.ts`, which plant this same config on disk, launch the
  // real binary in a real pty, and assert the opted-out session is still on the user's screen
  // after it exits — with the control alongside showing a session that isn't.
  //
  // The two halves below are asserted together deliberately: a dispatcher that called BOTH
  // surfaces would satisfy the readline half alone, and one that dropped the message would satisfy
  // the "no TUI" half alone.
  it('hands an opted-out session to readline with its config and message unchanged', async () => {
    writeGlobalConfig({ llm: LLM_SPEC, tui: false });

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, 'do the thing');

    expect(tuiSessionMock.createTuiSession).not.toHaveBeenCalled();
    expect(interactiveSessionMock.createInteractiveSession).toHaveBeenCalledTimes(1);
    const [passedSessionConfig, , passedMessage] =
      interactiveSessionMock.createInteractiveSession.mock.calls[0];
    expect(passedSessionConfig).toBe(sessionConfig);
    expect(passedMessage).toBe('do the thing');
  });

  it('auto-detects (TUI here) when a real config sets no tui key at all', async () => {
    writeProjectConfig({ llm: LLM_SPEC });

    const { startSession } = await import('#src/modules/startSession.js');
    await startSession(sessionConfig, {}, undefined);

    expect(tuiSessionMock.createTuiSession).toHaveBeenCalledTimes(1);
    expect(interactiveSessionMock.createInteractiveSession).not.toHaveBeenCalled();
  });
});
