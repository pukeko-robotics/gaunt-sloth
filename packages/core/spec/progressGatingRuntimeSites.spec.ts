import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { GthConfig } from '#src/config.js';
import { StatusLevel } from '#src/core/types.js';
import { resetConsoleLevel, setConsoleLevel } from '#src/utils/consoleLevel.js';

/**
 * [[TUI-C110]] — the console-level gate on the progress line, asserted **per construction site**,
 * for the three `Thinking.` sites in core: `runSingleShot`, `runConversation` and
 * `GthAbstractAgent.invoke`.
 *
 * They are three separate cells because they are three separate call paths — the two runtime
 * entry points build their indicator only when `streamOutput` is false, while the agent's
 * non-streaming `invoke` builds its own around the model call — and a cell driving one of them
 * says nothing about the others.
 *
 * **Both directions, every site.** A site that is never reached writes nothing either, so the quiet
 * assertion alone could not fail. Each site is therefore also driven at the default `info` rung and
 * pinned to its exact byte stream.
 *
 * The REAL `ProgressIndicator` is used throughout (the sibling specs mock it away), and `stdout` is
 * kept in the `systemUtils` mock so it is not mocked away — that wrapper is the seam every cell
 * asserts on. `consoleUtils` is mocked, and the gate is still the production one, because the
 * console LEVEL lives in `utils/consoleLevel.js` and nothing here replaces it.
 *
 * **The `systemUtils` mock is a plain factory on purpose — do not "improve" it into an
 * `importOriginal` spread.** `systemUtils` imports `ProgressIndicator` (the `reading STDIN` site)
 * and `ProgressIndicator` imports `systemUtils` back. Calling `importOriginal()` inside the factory
 * evaluates the real module, which pulls `ProgressIndicator` in through that cycle and binds it to
 * the REAL `stdout` before the mock is in place: the cells then print to the terminal running the
 * suite and assert on a mock nothing ever writes to. Measured, not theorised.
 */
const stdoutWriteMock = vi.fn();

vi.mock('#src/utils/systemUtils.js', () => ({
  stdout: { write: stdoutWriteMock },
  getProjectDir: vi.fn(() => '/project'),
  getUseColour: vi.fn(() => false),
  // The real ones put the terminal into raw mode; a test runner has no business doing that.
  waitForEscape: vi.fn(),
  stopWaitingForEscape: vi.fn(),
}));

vi.mock('#src/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayDebug: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displaySuccess: vi.fn(),
  displayToolIndication: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

vi.mock('#src/utils/fileUtils.js', () => ({
  getCommandOutputFilePath: vi.fn(() => null),
}));

// Keeps the run out of the developer's real ~/.gsloth/history.db (the suite's global guard fails
// the run if a spec writes to it).
vi.mock('#src/history/recordSession.js', () => ({
  recordSessionSafe: vi.fn(),
  recordSessionTurnSafe: vi.fn(),
}));

// GS2-106 — the single-shot runtime opens the durable checkpointer whenever history is on. Stubbed
// in memory, the way the interactive-session specs stub it, so this spec never reaches the
// developer's real history database.
vi.mock('#src/history/sessionCheckpointer.js', async () => {
  const { MemorySaver } = await import('@langchain/langgraph');
  return {
    openSessionCheckpointerSafe: () => ({
      saver: new MemorySaver(),
      durable: false,
      threadId: 'stub-thread',
      bindConversation: () => {},
      close: () => {},
    }),
  };
});

const gthAgentRunnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  getRunStats: vi.fn(),
  resetThread: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('#src/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return gthAgentRunnerInstanceMock;
  }),
}));

/** Everything written to the terminal by the site under test, in order, as one string. */
const written = (): string => stdoutWriteMock.mock.calls.map((call) => call[0]).join('');

/** streamOutput:false is what makes the runtime indicators exist at all. */
const runtimeConfig = {
  streamOutput: false,
  writeOutputToFile: false,
  modelDisplayName: 'test-model',
} as Partial<GthConfig> as GthConfig;

/** The config fields `GthAbstractAgent.invoke` reads. */
const agentConfig = {
  streamOutput: false,
  canInterruptInferenceWithEsc: true,
  useColour: false,
  writeOutputToFile: false,
  writeBinaryOutputsToFile: false,
  streamSessionInferenceLog: false,
} as Partial<GthConfig> as GthConfig;

const runConfig: RunnableConfig = { configurable: { thread_id: 'tui-c110' } };

/** A one-node graph that answers immediately — this cell is about the line, not the turn. */
function answeringGraph() {
  return new StateGraph(MessagesAnnotation)
    .addNode('speak', () => ({ messages: [new AIMessage('the answer')] }))
    .addEdge(START, 'speak')
    .addEdge('speak', END)
    .compile({ checkpointer: new MemorySaver() });
}

async function invokeThroughAgent(): Promise<void> {
  const { GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js');
  class TestAgent extends GthAbstractAgent {
    async init(): Promise<void> {
      /* the graph is injected directly */
    }
  }
  const agent = new TestAgent(vi.fn());
  (agent as unknown as { config: unknown }).config = agentConfig;
  (agent as unknown as { agent: unknown }).agent = answeringGraph();
  await agent.invoke([new HumanMessage('q')], runConfig);
}

describe('progress-line gating, per construction site (core runtime)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('an answer');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.getRunStats.mockReturnValue({ tools: [] });
  });

  afterEach(() => {
    resetConsoleLevel();
  });

  describe('runSingleShot — Thinking.', () => {
    it('draws its line, and nothing more, at the default info level', async () => {
      const { runSingleShot } = await import('#src/runtime/singleShot.js');
      await runSingleShot('src', 'preamble', 'question', runtimeConfig);

      expect(written()).toBe('Thinking.\n');
    });

    it('draws nothing at all at consoleLevel display — no label, no dots, no blank line', async () => {
      setConsoleLevel(StatusLevel.DISPLAY);

      const { runSingleShot } = await import('#src/runtime/singleShot.js');
      await runSingleShot('src', 'preamble', 'question', runtimeConfig);

      expect(written()).toBe('');
    });
  });

  describe('runConversation — Thinking.', () => {
    it('draws its line, and nothing more, at the default info level', async () => {
      const { runConversation } = await import('#src/runtime/conversation.js');
      await runConversation('src', 'preamble', ['u1', 'u2'], runtimeConfig);

      expect(written()).toBe('Thinking.\n');
    });

    it('draws nothing at all at consoleLevel display — no label, no dots, no blank line', async () => {
      setConsoleLevel(StatusLevel.DISPLAY);

      const { runConversation } = await import('#src/runtime/conversation.js');
      await runConversation('src', 'preamble', ['u1', 'u2'], runtimeConfig);

      expect(written()).toBe('');
    });
  });

  describe('GthAbstractAgent.invoke — Thinking.', () => {
    it('draws its line, and nothing more, at the default info level', async () => {
      await invokeThroughAgent();

      expect(written()).toBe('Thinking.\n');
    });

    it('draws nothing at all at consoleLevel display — no label, no dots, no blank line', async () => {
      setConsoleLevel(StatusLevel.DISPLAY);

      await invokeThroughAgent();

      expect(written()).toBe('');
    });

    it('draws nothing at consoleLevel error either', async () => {
      setConsoleLevel(StatusLevel.ERROR);

      await invokeThroughAgent();

      expect(written()).toBe('');
    });
  });
});
