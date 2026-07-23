import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

// GS2-8 — the readline (`--no-tui`) surface routes EVERY `/command` through the SAME registry as
// the Ink TUI (single source of truth) instead of its old hardcoded `exit`/`/yolo` handling.
// These tests drive the real dispatch path (the slashCommands module is deliberately NOT mocked)
// with a scripted readline, asserting: shared commands answer, `/quit`/`/exit` end the session,
// TUI-only commands degrade with a clear message, removed commands (`/mode`, `/tools`) read
// as unknown, and the `/`-vs-path heuristic sends a pasted filesystem path to the MODEL.

// Scripted readline: each `rl.question` call pops the next input; 'exit' as a safety default.
let inputs: string[] = [];
const rlQuestionMock = vi.fn(async () => inputs.shift() ?? 'exit');
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  error: vi.fn(),
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true },
}));

const consoleUtilsMock = {
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const initConfigMock = vi.fn();
vi.mock('@gaunt-sloth/core/config.js', () => ({
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

const runnerInstanceMock = {
  init: vi.fn(),
  processMessages: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  setSessionYolo: vi.fn(),
  toggleSessionYolo: vi.fn(),
  getAgent: vi.fn(),
  cleanup: vi.fn(),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

// GS2-56 — the readline `/debug-dump` now forwards to the core writer AND threads the agent's
// always-on last-model-request snapshot. Mock the writer (so no real `~/.gsloth` I/O) and stand in
// a minimal GthAbstractAgent class so the module's `instanceof` narrowing resolves against it.
const writeDebugDumpMock = vi.fn(() => ({ archiveDir: '/fake/.gsloth/debug-dumps/stamp' }));
vi.mock('@gaunt-sloth/core/utils/debugDump.js', () => ({ writeDebugDump: writeDebugDumpMock }));
class FakeAbstractAgent {
  lastModelRequest: unknown;
}
vi.mock('@gaunt-sloth/core/core/GthAbstractAgent.js', () => ({
  GthAbstractAgent: FakeAbstractAgent,
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn(() => ({})) }));
vi.mock('#src/core/resolveAgentFactory.js', () => ({ resolveAgentFactory: vi.fn(() => vi.fn()) }));

const sessionConfig = {
  mode: 'chat',
  readModePrompt: () => null,
  description: 'chat',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

/** All display* output joined, so copy assertions don't depend on which channel a line used. */
const allOutput = (): string =>
  [
    ...consoleUtilsMock.display.mock.calls,
    ...consoleUtilsMock.displayInfo.mock.calls,
    ...consoleUtilsMock.displayWarning.mock.calls,
  ]
    .map((c) => String(c[0]))
    .join('\n');

const runSession = async (...userInputs: string[]) => {
  inputs = [...userInputs];
  const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
  await createInteractiveSession(sessionConfig, {});
};

describe('interactiveSessionModule shared slash-command registry (GS2-8)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    inputs = [];
    initConfigMock.mockResolvedValue({
      streamSessionInferenceLog: false,
      modelDisplayName: 'test-model',
    });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('answer');
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    runnerInstanceMock.setSessionYolo.mockImplementation((v: boolean) => v);
    runnerInstanceMock.toggleSessionYolo.mockReturnValue(true);
  });

  it('/status answers with the session status (mode folded in from the old /mode) — never sent to the model', async () => {
    await runSession('/status', 'exit');
    const out = allOutput();
    expect(out).toContain('Session status');
    expect(out).toContain('Mode: chat');
    expect(out).toContain('Model: test-model');
    expect(out).toContain('Turns so far: 0');
    expect(runnerInstanceMock.processMessages).not.toHaveBeenCalled();
  });

  it('/help lists the SHARED registry — the renamed /verbose and the new /quit included', async () => {
    await runSession('/help', 'exit');
    const out = allOutput();
    expect(out).toContain('Slash commands');
    expect(out).toContain('/verbose — ');
    expect(out).toContain('/quit — Quit the session (alias of /exit)');
    expect(out).toContain('/status — ');
    expect(runnerInstanceMock.processMessages).not.toHaveBeenCalled();
  });

  it('/quit ends the session exactly like /exit (equal-citizen alias)', async () => {
    await runSession('/quit');
    expect(consoleUtilsMock.display).toHaveBeenCalledWith('Exiting...');
    expect(runnerInstanceMock.cleanup).toHaveBeenCalledTimes(1);
    expect(runnerInstanceMock.processMessages).not.toHaveBeenCalled();
  });

  it('/exit still ends the session through the shared registry', async () => {
    await runSession('/exit');
    expect(consoleUtilsMock.display).toHaveBeenCalledWith('Exiting...');
    expect(runnerInstanceMock.cleanup).toHaveBeenCalledTimes(1);
  });

  it('the bare `exit` keyword still quits (legacy path preserved)', async () => {
    await runSession('exit');
    expect(consoleUtilsMock.display).toHaveBeenCalledWith('Exiting...');
    expect(runnerInstanceMock.cleanup).toHaveBeenCalledTimes(1);
  });

  it('/verbose (TUI-only tool-detail toggle) degrades with a clear "needs the TUI" message', async () => {
    await runSession('/verbose', 'exit');
    expect(allOutput()).toContain('/verbose is not available without the TUI');
    expect(runnerInstanceMock.processMessages).not.toHaveBeenCalled();
  });

  it('/tools is gone (2.0 hard removal, renamed /verbose): it reads as an unknown command here too', async () => {
    await runSession('/tools', 'exit');
    expect(allOutput()).toContain('Unknown command: /tools');
    expect(runnerInstanceMock.processMessages).not.toHaveBeenCalled();
  });

  it('/clear and /debug (TUI-only) degrade instead of vanishing from the catalog', async () => {
    await runSession('/clear', '/debug', 'exit');
    const out = allOutput();
    expect(out).toContain('/clear is not available without the TUI');
    expect(out).toContain('/debug is not available without the TUI');
  });

  it('a pasted filesystem path is NOT a command — it goes to the model (the /-vs-path heuristic)', async () => {
    const { HumanMessage } = await import('@langchain/core/messages');
    await runSession('/usr/home/bob/test.md', 'exit');
    expect(runnerInstanceMock.processMessages).toHaveBeenCalledTimes(1);
    expect((HumanMessage as unknown as Mock).mock.calls[0][0]).toBe('/usr/home/bob/test.md');
  });

  it('an unknown /command warns and is NOT sent to the model', async () => {
    await runSession('/definitely-not-a-command', 'exit');
    expect(allOutput()).toContain('Unknown command: /definitely-not-a-command');
    expect(runnerInstanceMock.processMessages).not.toHaveBeenCalled();
  });

  it('/auto-approve on|off applies the runner flag with the state-aware warning (EXT-12 kept)', async () => {
    await runSession('/auto-approve on', 'exit');
    expect(runnerInstanceMock.setSessionYolo).toHaveBeenCalledWith(true);
    expect(allOutput()).toContain('Auto-approve ON');
  });

  it('/yolo still toggles session auto-approval through the shared registry', async () => {
    await runSession('/yolo', 'exit');
    expect(runnerInstanceMock.toggleSessionYolo).toHaveBeenCalledTimes(1);
    expect(allOutput()).toContain('Auto-approve ON');
  });

  it('/mode is gone (2.0 hard removal): it reads as an unknown command here too', async () => {
    await runSession('/mode', 'exit');
    expect(allOutput()).toContain('Unknown command: /mode');
  });

  it('/config surfaces the resolved-config summary built from the live session config', async () => {
    await runSession('/config', 'exit');
    const out = allOutput();
    expect(out).toContain('Resolved configuration');
    expect(out).toContain('Model: test-model');
  });

  it('/debug-dump on the readline (non-TUI) surface writes an archive threading the always-on model-request snapshot (GS2-56)', async () => {
    const { GthAbstractAgent } = await import('@gaunt-sloth/core/core/GthAbstractAgent.js');
    const agent = new (GthAbstractAgent as unknown as typeof FakeAbstractAgent)();
    agent.lastModelRequest = {
      extras: {
        systemPrompt: 'SYS',
        tools: [{ name: 't', schema: {} }],
        modelParams: { model: 'm' },
      },
      messages: [{ type: 'system', content: 'as-sent header' }],
    };
    runnerInstanceMock.getAgent.mockReturnValue(agent);

    await runSession('/debug-dump', 'exit');

    // The shared registry produced a REAL dump — not the old "unavailable" fallback this surface hit.
    expect(writeDebugDumpMock).toHaveBeenCalledTimes(1);
    const arg = writeDebugDumpMock.mock.calls[0][0] as {
      modelRequest?: { extras?: { systemPrompt?: string }; messages?: unknown };
      redact?: boolean;
    };
    // The always-on snapshot was threaded straight through from the live agent (no reshaping).
    expect(arg.modelRequest).toBe(agent.lastModelRequest);
    expect(arg.modelRequest!.extras!.systemPrompt).toBe('SYS');
    expect(arg.modelRequest!.messages).toEqual([{ type: 'system', content: 'as-sent header' }]);
    // Redaction defaults ON (no --unsafe-no-redact), resolved by the shared command.
    expect(arg.redact).toBe(true);

    const out = allOutput();
    expect(out).toContain('Debug dump written');
    expect(out).not.toContain('Debug dump unavailable');
    expect(runnerInstanceMock.processMessages).not.toHaveBeenCalled();
  });
});
