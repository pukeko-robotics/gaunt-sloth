import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

// GS2-18 — the readline (`--no-tui`) interactive path must persist each turn via the opt-in,
// fail-soft history recorder at its turn boundary (same as the single-shot + Ink-TUI paths):
// records a session when `history.enabled`, and records NOTHING (creates no DB) by default.
// GS2-16 — the recorded row carries the live token/tool analytics read from the runner.
//
// The recorder + store are REAL here (temp DB); everything else (readline, runner, agent) is
// mocked so nothing actually talks to a model. One user turn ('hello') then 'exit'.

// readline / stdin — first '>' prompt returns the user turn, the next returns 'exit'.
let turnsAsked = 0;
const rlQuestionMock = vi.fn(async (prompt: string) => {
  if (typeof prompt === 'string' && prompt.includes('>')) {
    turnsAsked += 1;
    return turnsAsked === 1 ? 'hello there' : 'exit';
  }
  return '';
});
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

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

const initConfigMock = vi.fn();
vi.mock('@gaunt-sloth/core/config.js', () => ({ initConfig: initConfigMock }));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: vi.fn().mockResolvedValue('the answer'),
  getRunStats: vi.fn(() => ({ tokensInput: 11, tokensOutput: 5, tools: ['read_file'] })),
  setToolApprovalCallback: vi.fn(),
  toggleSessionYolo: vi.fn(),
  cleanup: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn(() => ({})) }));
vi.mock('#src/core/resolveAgentFactory.js', () => ({ resolveAgentFactory: vi.fn(() => vi.fn()) }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

describe('interactiveSessionModule readline history recording (GS2-18 / GS2-16)', () => {
  let dir: string;
  beforeEach(() => {
    turnsAsked = 0;
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-readline-hist-'));
    vi.clearAllMocks();
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('the answer');
    runnerInstanceMock.getRunStats.mockReturnValue({
      tokensInput: 11,
      tokensOutput: 5,
      tools: ['read_file'],
    });
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the turn (with live token/tool analytics) when history.enabled', async () => {
    const dbPath = resolve(dir, 'history.db');
    initConfigMock.mockResolvedValue({
      streamSessionInferenceLog: false,
      modelDisplayName: 'test-model',
      history: { enabled: true, dbPath },
    });

    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});

    expect(existsSync(dbPath)).toBe(true);
    const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
    const store = openHistoryStore(dbPath, { create: false })!;
    const recent = store.listRecent(10);
    expect(recent).toHaveLength(1); // exactly one turn recorded ('hello there'); 'exit' is not a turn
    expect(recent[0].command).toBe('code');
    expect(recent[0].prompt).toBe('hello there');
    expect(recent[0].response).toBe('the answer');
    expect(recent[0].model).toBe('test-model');
    expect(recent[0].tokensInput).toBe(11);
    expect(recent[0].tokensOutput).toBe(5);
    expect(recent[0].tools).toEqual(['read_file']);
    expect(typeof recent[0].durationMs).toBe('number');
    store.close();
  });

  it('records NOTHING and creates no DB when history is disabled (default-off)', async () => {
    const dbPath = resolve(dir, 'history.db');
    initConfigMock.mockResolvedValue({
      streamSessionInferenceLog: false,
      modelDisplayName: 'test-model',
      // history absent → default run
    });

    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});

    expect(existsSync(dbPath)).toBe(false);
  });
});
