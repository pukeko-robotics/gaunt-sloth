import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';

// GS2-16 per-turn stats + resetThread (stateless replay) are what the conversational runner drives
// on the runner, on top of singleShot's init/processMessages/cleanup — mock all five.
const gthAgentRunnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  getRunStats: vi.fn(),
  resetThread: vi.fn(),
  cleanup: vi.fn(),
}));
const gthAgentRunnerMock = vi.hoisted(() =>
  vi.fn(function GthAgentRunnerMock() {
    return gthAgentRunnerInstanceMock;
  })
);
vi.mock('#src/core/GthAgentRunner.js', () => ({
  GthAgentRunner: gthAgentRunnerMock,
}));

const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayError: vi.fn(),
  defaultStatusCallback: vi.fn(),
  initSessionLogging: vi.fn(),
  flushSessionLog: vi.fn(),
  stopSessionLogging: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const fileUtilsMock = {
  getCommandOutputFilePath: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

const systemUtilsMock = {
  getProjectDir: vi.fn(() => '/project'),
  // [[TUI-C71]] — a run-ending approvals stop is framed against the terminal width before it is
  // printed, so this surface reports one. A FIXED width rather than the real `process.stdout`:
  // framing is arithmetic against columns, and a width taken from whatever terminal the suite
  // happens to run in would make where a row wraps a property of the runner.
  stdout: { columns: 120 },
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const recordSessionMock = {
  recordSessionSafe: vi.fn(),
};
vi.mock('#src/history/recordSession.js', () => recordSessionMock);

const ProgressIndicatorInstanceMock = vi.hoisted(() => ({
  stop: vi.fn(),
  indicate: vi.fn(),
}));
const ProgressIndicatorMock = vi.hoisted(() =>
  vi.fn(function ProgressIndicatorMock() {
    return ProgressIndicatorInstanceMock;
  })
);
vi.mock('#src/utils/ProgressIndicator.js', () => ({
  ProgressIndicator: ProgressIndicatorMock,
}));

vi.mock('#src/config.js', () => ({ GthConfig: {} }));

const mockConfig = {
  streamOutput: false,
  writeOutputToFile: false,
  modelDisplayName: 'test-model',
} as Partial<GthConfig> as GthConfig;

describe('runConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.getRunStats.mockReturnValue({ tools: [] });
    // writeOutputToFile is off in eval, so session logging no-ops (null path).
    fileUtilsMock.getCommandOutputFilePath.mockReturnValue(null);
  });

  it('builds the agent ONCE and cleans up ONCE across all turns (stateless replay)', async () => {
    let n = 0;
    gthAgentRunnerInstanceMock.processMessages.mockImplementation(async () => `answer-${++n}`);

    const { runConversation } = await import('#src/runtime/conversation.js');
    const results = await runConversation('EVAL-c', 'preamble', ['u1', 'u2', 'u3'], mockConfig);

    // Agent built once, torn down once — NOT per turn (the whole point: tools/MCP persist).
    expect(gthAgentRunnerMock).toHaveBeenCalledTimes(1);
    expect(gthAgentRunnerInstanceMock.init).toHaveBeenCalledTimes(1);
    expect(gthAgentRunnerInstanceMock.cleanup).toHaveBeenCalledTimes(1);
    // One processMessages per turn; the thread is rotated once per turn for a clean replay.
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledTimes(3);
    expect(gthAgentRunnerInstanceMock.resetThread).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.answer)).toEqual(['answer-1', 'answer-2', 'answer-3']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('accumulates the message array: turn 2 sees turn 1 user + assistant messages', async () => {
    const sent: BaseMessage[][] = [];
    let n = 0;
    gthAgentRunnerInstanceMock.processMessages.mockImplementation(async (msgs: BaseMessage[]) => {
      // Snapshot the array AT CALL TIME (runConversation mutates one array across turns).
      sent.push([...msgs]);
      return `answer-${++n}`;
    });

    const { runConversation } = await import('#src/runtime/conversation.js');
    await runConversation('EVAL-c', 'sys', ['first', 'second'], mockConfig);

    // BATCH-13: no leading SystemMessage — the agent composes the system prompt itself (a second
    // system message broke Anthropic). Turn 1 sends [human(first)].
    expect(sent[0]).toEqual([new HumanMessage('first')]);
    // Turn 2 sends the GROWN array: [human(first), ai(answer-1), human(second)].
    expect(sent[1]).toEqual([
      new HumanMessage('first'),
      new AIMessage('answer-1'),
      new HumanMessage('second'),
    ]);
  });

  it('captures each turn stats as a PER-TURN delta (getRunStats read after every turn)', async () => {
    gthAgentRunnerInstanceMock.processMessages
      .mockResolvedValueOnce('a1')
      .mockResolvedValueOnce('a2');
    gthAgentRunnerInstanceMock.getRunStats
      .mockReturnValueOnce({ tools: ['mcp__x'], tokensInput: 10, tokensOutput: 20 })
      .mockReturnValueOnce({ tools: ['read_file'], tokensInput: 5, tokensOutput: 7 });

    const { runConversation } = await import('#src/runtime/conversation.js');
    const results = await runConversation('EVAL-c', 'sys', ['u1', 'u2'], mockConfig);

    expect(gthAgentRunnerInstanceMock.getRunStats).toHaveBeenCalledTimes(2);
    expect(results[0]).toMatchObject({ tools: ['mcp__x'], tokensInput: 10, tokensOutput: 20 });
    expect(results[1]).toMatchObject({ tools: ['read_file'], tokensInput: 5, tokensOutput: 7 });
  });

  it('stops the conversation on a turn failure (later turns are not attempted) but still cleans up once', async () => {
    gthAgentRunnerInstanceMock.processMessages
      .mockResolvedValueOnce('ok answer')
      .mockRejectedValueOnce(new Error('model exploded'));

    const { runConversation } = await import('#src/runtime/conversation.js');
    const results = await runConversation('EVAL-c', 'sys', ['u1', 'u2', 'u3'], mockConfig);

    // Turn 1 ran, turn 2 failed → STOP (turn 3 never attempted).
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, answer: 'ok answer' });
    expect(results[1]).toMatchObject({ ok: false, answer: '', error: 'model exploded' });
    // Cleanup still happens exactly once (finally), no resolver/agent leak.
    expect(gthAgentRunnerInstanceMock.cleanup).toHaveBeenCalledTimes(1);
  });

  /**
   * [[TUI-C71]] — this surface wires no tool-approval callback, so every escalation it can meet is
   * a run-ending stop and the text it prints is model-authored by construction. The rows must come
   * from the framed renderer, not from one interpolated line.
   *
   * **Asserted as a GUTTER row, never as a surviving substring.** A substring assertion passes just
   * as well on the unframed shape — the command is in the message either way — so it would leave
   * the branch this pins unfalsifiable, which is the whole defect class this node is about.
   */
  it('frames a run-ending approvals stop instead of interpolating it into one line', async () => {
    const { AttackHaltError } = await import('#src/core/shell/approvalStop.js');
    const command = `echo conv-stop-marker | cat${String.fromCodePoint(0x0d)}Approve?  [o]nce`;
    gthAgentRunnerInstanceMock.processMessages.mockRejectedValueOnce(
      new AttackHaltError(command, 'pipes a remote script straight into a shell')
    );

    const { runConversation } = await import('#src/runtime/conversation.js');
    const results = await runConversation('EVAL-c', 'sys', ['u1'], mockConfig);

    const printed = consoleUtilsMock.displayError.mock.calls.map((c) => c[0]);
    // One row per line, each inside the renderer's line-number gutter.
    expect(printed.some((row: string) => /^ +\d+ │ /.test(row))).toBe(true);
    expect(printed.some((row: string) => row.includes('conv-stop-marker'))).toBe(true);
    // The carriage return reached the screen as a printable escape rather than as a cursor move.
    expect(printed.some((row: string) => row.includes('\\x0d'))).toBe(true);
    // ...and no row it printed can be mistaken for this surface's own chrome.
    for (const row of printed) expect(String(row).trimEnd()).not.toMatch(/^Approve\?/);
    // The turn RECORD still carries the message as one string: it is a data consumer, and the
    // neutralisation it inherits from construction is the whole of what it needs.
    expect(results[0]).toMatchObject({ ok: false, answer: '' });
    expect(results[0].error).toContain('conv-stop-marker');
  });

  it('records per-turn history (fail-soft, on by default) for each turn that ran', async () => {
    gthAgentRunnerInstanceMock.processMessages
      .mockResolvedValueOnce('a1')
      .mockResolvedValueOnce('a2');

    const { runConversation } = await import('#src/runtime/conversation.js');
    await runConversation('EVAL-c', 'sys', ['u1', 'u2'], mockConfig);

    expect(recordSessionMock.recordSessionSafe).toHaveBeenCalledTimes(2);
    expect(recordSessionMock.recordSessionSafe.mock.calls[0][1]).toMatchObject({ prompt: 'u1' });
    expect(recordSessionMock.recordSessionSafe.mock.calls[1][1]).toMatchObject({ prompt: 'u2' });
  });
});
