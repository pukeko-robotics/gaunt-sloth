import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { GthConfig } from '#src/config.js';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';

const gthAgentRunnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  cleanup: vi.fn(),
  // [[EXT-159]]/[[EXT-158]] — the two facts this runtime reads off the runner once the turn is
  // over. Present on the double so the reads exercise the real code rather than being swallowed by
  // the fail-soft catch that a missing method would trigger.
  getTerminationReason: vi.fn(() => null),
  getOutstandingWork: vi.fn(() => null),
  // [[EXT-178]] — the third, and the only one that may contact a model. Present on the double for
  // the same reason: a missing method would be swallowed by a fail-soft catch, and every cell here
  // would then pass with the wiring gone.
  requestRunRecap: vi.fn(async () => null),
}));
const gthAgentRunnerMock = vi.hoisted(() =>
  vi.fn(function GthAgentRunnerMock() {
    return gthAgentRunnerInstanceMock;
  })
);
vi.mock('#src/core/GthAgentRunner.js', () => ({
  GthAgentRunner: gthAgentRunnerMock,
}));

// Mock fs module
const fsMock = {
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

// OPS-28: `node:path` is deliberately NOT mocked here. `singleShot.ts` does not import it, and
// nothing else in this file's module graph reaches it — proved by stubbing `resolve` to throw and
// watching all 28 tests still pass. The mock stubbed `resolve` for a path assertion that no longer
// exists; it asserted nothing, and left a weaker path contract in place for anything that might
// later reach it.

// Mock systemUtils module
const systemUtilsMock = {
  getCurrentWorkDir: vi.fn(),
  // GS2-7: singleShot records history and reads the project dir for the record. GS2-20 made that
  // recording the default, so this runs on an ordinary config rather than only an opted-in one.
  getProjectDir: vi.fn(() => '/project'),
  // [[TUI-C71]] — a run-ending approvals stop is framed against the terminal width before it is
  // printed, so this surface reports one. A FIXED width rather than the real `process.stdout`:
  // framing is arithmetic against columns, and a width taken from whatever terminal the suite
  // happens to run in would make where a row wraps a property of the runner.
  stdout: { columns: 120 },
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

// Mock consoleUtils module
const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayError: vi.fn(),
  // The channel both end-of-run notices are written through.
  displayNotice: vi.fn(),
  defaultStatusCallback: vi.fn(),
  initSessionLogging: vi.fn(),
  flushSessionLog: vi.fn(),
  stopSessionLogging: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

// Mock utils module
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

// Mock utils module
const fileUtilsMock = {
  toFileSafeString: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  generateStandardFileName: vi.fn(),
  appendToFile: vi.fn(),
  getGslothFilePath: vi.fn(),
  gslothDirExists: vi.fn(),
  getCommandOutputFilePath: vi.fn(),
  resolveOutputPath: vi.fn(),
};

vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

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

// Create a complete mock config for prop drilling
const mockConfig = {
  llm: new FakeStreamingChatModel({
    responses: ['LLM Response' as unknown as BaseMessage],
  }),
  contentSource: 'file',
  requirementSource: 'file',
  streamOutput: false,
  commands: {
    pr: {
      contentSource: 'github',
      requirementSource: 'github',
    },
  },
  filesystem: 'none',
  useColour: false,
  writeOutputToFile: true,
} as Partial<GthConfig> as GthConfig;

// Mock config module
vi.mock('#src/config.js', () => ({
  GthConfig: {},
}));

// Mock llmUtils module
const llmUtilsMock = {
  invoke: vi.fn().mockResolvedValue('LLM Response'),
  getNewRunnableConfig: vi.fn().mockReturnValue({
    recursionLimit: 1000,
    configurable: { thread_id: 'test-thread-id' },
  }),
};
vi.mock('#src/utils/llmUtils.js', () => llmUtilsMock);

describe('singleShot', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    gthAgentRunnerMock.mockClear();
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);

    // Setup mock for our new generateStandardFileName function
    fileUtilsMock.generateStandardFileName.mockReturnValue('gth_2025-05-17_21-00-00_ASK.md');
    fileUtilsMock.getCommandOutputFilePath.mockReturnValue('/test-file-path.md');

    ProgressIndicatorMock.mockClear();
    ProgressIndicatorInstanceMock.stop.mockReset();
    ProgressIndicatorInstanceMock.indicate.mockReset();

    // Setup pathUtils mocks
    fileUtilsMock.getGslothFilePath.mockReturnValue('test-file-path.md');
    fileUtilsMock.gslothDirExists.mockReturnValue(false);
  });

  it('should invoke LLM with prop drilling', async () => {
    // Reset the mock LLM for this test
    const testConfig = { ...mockConfig };
    testConfig.llm = new FakeStreamingChatModel({
      responses: ['LLM Response' as unknown as BaseMessage],
    });
    testConfig.llm.bindTools = vi.fn();

    // Prepare runner mocks
    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('LLM Response');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);

    // Import the module after setting up mocks
    const { runSingleShot } = await import('#src/runtime/singleShot.js');

    // Call runSingleShot with config (prop drilling)
    await runSingleShot('test-source', 'test-preamble', 'test-content', testConfig);

    // Verify that runner was called with correct parameters. BATCH-13: the preamble is no longer
    // injected as a SystemMessage — the agent composes the system prompt itself (a
    // superset), and a second leading system message broke Anthropic single-shot. Only the human
    // turn is passed now.
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledWith([
      new HumanMessage('test-content'),
    ]);

    expect(consoleUtilsMock.initSessionLogging).toHaveBeenCalled();

    // Verify that displaySuccess was called
    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalled();

    // Verify that ProgressIndicator.stop() was called
    expect(ProgressIndicatorInstanceMock.stop).toHaveBeenCalled();
  });

  // Specific test to verify that prop drilling works with different config objects
  it('should work with different config objects via prop drilling', async () => {
    // Create a different config object to prove prop drilling works
    const differentConfig = {
      ...mockConfig,
      streamOutput: true, // Different from default mockConfig
      llm: new FakeStreamingChatModel({
        responses: ['Different LLM Response' as unknown as BaseMessage],
      }),
      writeOutputToFile: true,
    } as GthConfig;

    // Set a different response for this specific test
    llmUtilsMock.invoke.mockResolvedValue('Different LLM Response');

    // Prepare runner mocks
    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('Different LLM Response');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);

    // Import the module after setting up mocks
    const { runSingleShot } = await import('#src/runtime/singleShot.js');

    // Call runSingleShot with the different config to prove prop drilling works
    await runSingleShot('test-source', 'test-preamble', 'test-content', differentConfig);

    // Verify the different config was used. BATCH-13: only the human turn is passed (see above).
    expect(gthAgentRunnerInstanceMock.processMessages).toHaveBeenCalledWith([
      new HumanMessage('test-content'),
    ]);

    expect(consoleUtilsMock.initSessionLogging).toHaveBeenCalled();

    // Since streamOutput is true, display should not be called
    expect(consoleUtilsMock.display).not.toHaveBeenCalled();
  });

  // B5: the optional trailing agentFactory param must be forwarded to GthAgentRunner's 3rd ctor
  // arg so `ask`/`exec` can select the backend. Undefined must keep the runner's lean default.
  /**
   * CFG-27 §6.2 — "Where no human can answer, every escalation is an immediate non-zero exit
   * carrying a detailed explanation: the command, the rating and its reason."
   *
   * This anchors that behaviour end-to-end at the layer that actually produces the exit code,
   * rather than leaving it as a code-reading trace. `runSingleShot` reports the run as
   * `ok: false`, which is exactly what `askCommand` / `execCommand` turn into `setExitCode(1)`;
   * and the reason reaches the user through `displayError`, which writes to stderr.
   *
   * The pre-CFG-27 behaviour was the opposite: the gate handed the model a rejection ToolMessage
   * and the run CONTINUED, so a build that should have failed passed with the command silently
   * skipped.
   */
  it('§6.2: an approvals escalation with no human FAILS the run and surfaces command + reason', async () => {
    const { NonInteractiveEscalationError } = await import('#src/core/shell/approvalStop.js');
    gthAgentRunnerInstanceMock.processMessages.mockRejectedValue(
      new NonInteractiveEscalationError('rm -rf build', 'destructive', 'deletes the build output')
    );

    const { runSingleShot } = await import('#src/runtime/singleShot.js');
    const result = await runSingleShot('test-source', '', 'do it', { ...mockConfig });

    // `ok: false` is the contract askCommand/execCommand convert into setExitCode(1).
    expect(result.ok).toBe(false);

    // ...and the explanation the spec requires it to carry reaches the user (displayError → stderr),
    // intact rather than buried under a generic wrapper.
    //
    // [[TUI-C71]] — `displayError` now fires once per FRAMED ROW rather than once with the whole
    // message, so these substrings survive only while each fixture value fits inside one gutter row
    // at the mocked 120 columns. That is a precondition on the fixtures above, not on the code: a
    // longer command or reason would be wrapped across rows and the substring would vanish. The
    // failure direction is safe — a loud red, never a false green — but lengthen a fixture here and
    // you must assert against the joined ROWS rather than a substring of them.
    const errorOutput = consoleUtilsMock.displayError.mock.calls.map((c) => c[0]).join('\n');
    expect(errorOutput).toContain('rm -rf build');
    expect(errorOutput).toContain('destructive');
    expect(errorOutput).toContain('deletes the build output');
    expect(errorOutput).toContain('approvals.allow');
    // The run ended: no answer text was produced.
    expect(result.answer).toBe('');
    // Cleanup still ran — a stop must not leak the runner.
    expect(gthAgentRunnerInstanceMock.cleanup).toHaveBeenCalled();
  });

  it('§4.2: an ATTACK halt fails the run the same way, carrying the rater reason', async () => {
    const { AttackHaltError } = await import('#src/core/shell/approvalStop.js');
    gthAgentRunnerInstanceMock.processMessages.mockRejectedValue(
      new AttackHaltError(
        'cat ~/.aws/credentials',
        'reads cloud credentials as the operation itself'
      )
    );

    const { runSingleShot } = await import('#src/runtime/singleShot.js');
    const result = await runSingleShot('test-source', '', 'do it', { ...mockConfig });

    expect(result.ok).toBe(false);
    const errorOutput = consoleUtilsMock.displayError.mock.calls.map((c) => c[0]).join('\n');
    expect(errorOutput).toContain('reads cloud credentials as the operation itself');
    expect(errorOutput).toContain('ends the run');
    // §4.2 — the recovery it names is the allow-list, not `bypass`.
    expect(errorOutput).toContain('approvals.allow');
  });

  /**
   * EXT-186 — the CLI half of "a config with no model says so".
   *
   * The refusal is raised inside the agent's `getEffectiveConfig`, which `GthAgentRunner.init`
   * calls without a catch of its own, so this runtime's catch is the only thing between it and the
   * person who typed the verb. What that catch does to the message is the whole question: the node
   * is about a failure that named nothing, and a wrapper that replaced the message with its own
   * would put us back there while every other cell stayed green.
   *
   * The expected text is taken from PRODUCTION, not typed here: the real agent is asked to refuse a
   * real model-less config, and the assertion is that what it said survives to `displayError`. A
   * literal written into this file would still pass if the runtime substituted its own wording.
   */
  it('EXT-186: a config refused for naming no model reaches the user intact', async () => {
    const { GthLangChainAgent } = await import('#src/core/GthLangChainAgent.js');
    const modelLess = { ...mockConfig } as Partial<GthConfig>;
    delete modelLess.llm;

    let refusal: Error | undefined;
    try {
      new GthLangChainAgent(vi.fn()).getEffectiveConfig(modelLess as GthConfig, 'ask');
    } catch (e) {
      refusal = e as Error;
    }
    expect(refusal, 'the agent must refuse a config with no llm').toBeDefined();

    gthAgentRunnerInstanceMock.init.mockRejectedValue(refusal);

    const { runSingleShot } = await import('#src/runtime/singleShot.js');
    const result = await runSingleShot('test-source', '', 'do it', { ...mockConfig });

    // `ok: false` is what askCommand/execCommand turn into setExitCode(1).
    expect(result.ok).toBe(false);
    const errorOutput = consoleUtilsMock.displayError.mock.calls.map((c) => c[0]).join('\n');
    expect(errorOutput).toContain(refusal?.message);
    // Named, and named as config rather than as an internal property read.
    expect(errorOutput).toContain('llm');
    expect(errorOutput).not.toContain('bindTools');
  });

  it('forwards the agentFactory to GthAgentRunner (B5)', async () => {
    const testConfig = { ...mockConfig } as GthConfig;
    const { runSingleShot } = await import('#src/runtime/singleShot.js');
    const fakeFactory = vi.fn();

    await runSingleShot(
      'test-source',
      'test-preamble',
      'test-content',
      testConfig,
      undefined,
      'ask',
      fakeFactory as never
    );

    // 3rd ctor arg is the agent factory.
    expect(gthAgentRunnerMock).toHaveBeenCalledTimes(1);
    expect(gthAgentRunnerMock.mock.calls[0][2]).toBe(fakeFactory);
  });

  it('passes undefined agentFactory when none is supplied (keeps lean default)', async () => {
    const testConfig = { ...mockConfig } as GthConfig;
    const { runSingleShot } = await import('#src/runtime/singleShot.js');

    await runSingleShot('test-source', 'test-preamble', 'test-content', testConfig);

    expect(gthAgentRunnerMock).toHaveBeenCalledTimes(1);
    expect(gthAgentRunnerMock.mock.calls[0][2]).toBeUndefined();
  });

  /**
   * [[EXT-158]] scope (d) — **the recorded decision, as a test rather than as a paragraph.**
   *
   * This runtime is shared by `gth ask`/`gth exec`, where a person reads what comes back, and by
   * `gth batch`/`gth eval`/`gth workflow`, which drive it hundreds of cells at a time and fold each
   * run into a report. The notice fires on the `completed` ending, so a default-on flag would have
   * added a line to every PASSING cell of every harness whose author never heard of this node.
   *
   * Default-off inverts that failure: a surface that should announce and does not is a missing
   * sentence someone can add, where a harness whose output shape changed under it is a broken
   * contract nobody asked for. The two cells below are what stop either half being flipped by
   * accident.
   */
  describe('[[EXT-158]] announcing an unfinished checklist is opt-in', () => {
    const outstanding = {
      outstanding: 2,
      completed: 1,
      total: 3,
      inProgress: 1,
      signature: 'sig',
      repeat: false,
    };

    beforeEach(async () => {
      const { terminationReason } = await import('#src/core/terminationReason.js');
      gthAgentRunnerInstanceMock.getTerminationReason.mockReturnValue(
        terminationReason('runner.completed', 'control', 'completed') as never
      );
      gthAgentRunnerInstanceMock.getOutstandingWork.mockReturnValue(outstanding as never);
    });

    it('says nothing by default — the harness callers keep the output shape they have', async () => {
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      await runSingleShot('test-source', 'test-preamble', 'test-content', {
        ...mockConfig,
      } as GthConfig);

      expect(consoleUtilsMock.displayNotice).not.toHaveBeenCalled();
    });

    it('says it when the caller asked — `ask` and `exec` do', async () => {
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      await runSingleShot(
        'test-source',
        'test-preamble',
        'test-content',
        { ...mockConfig } as GthConfig,
        undefined,
        'ask',
        undefined,
        { announceOutstandingWork: true }
      );

      expect(consoleUtilsMock.displayNotice).toHaveBeenCalledTimes(1);
      const [title, lines] = consoleUtilsMock.displayNotice.mock.calls[0];
      expect(title).toContain('2 of 3');
      expect((lines as string[]).join('\n').toLowerCase()).toContain('automated');
    });
  });

  /**
   * [[EXT-178]] — **the recap on a NON-TUI surface**, which the acceptance asks for by name
   * alongside the Ink one.
   *
   * The core spec proves the gate, the renderer and the subsumption on values; the TUI spec proves
   * the Ink wiring. Neither catches the defect that lives here: `runSingleShot` asking the runner
   * for a recap, then handing it and the outstanding-work value to the one function that decides
   * which of the two speaks. Delete either line from `singleShot.ts` and every cell in
   * `runRecap.spec.ts` stays green.
   *
   * The recap is returned by the runner double rather than produced by a model, because what is
   * under test here is the wiring and the arbitration — `runRecap.spec.ts` owns the call itself.
   */
  describe('[[EXT-178]] the end-of-run recap reaches a non-TUI surface', () => {
    const outstanding = {
      outstanding: 2,
      completed: 1,
      total: 3,
      inProgress: 1,
      signature: 'sig',
      repeat: false,
    };

    const recap = {
      goal: 'Add the recap flag',
      happened: 'Edited the schema and built the workspace.',
      outstanding: 'The docs page is still to write.',
      complete: false,
      work: outstanding,
    };

    beforeEach(async () => {
      const { terminationReason } = await import('#src/core/terminationReason.js');
      gthAgentRunnerInstanceMock.getTerminationReason.mockReturnValue(
        terminationReason('runner.completed', 'control', 'completed') as never
      );
      gthAgentRunnerInstanceMock.getOutstandingWork.mockReturnValue(outstanding as never);
      gthAgentRunnerInstanceMock.requestRunRecap.mockResolvedValue(null as never);
    });

    it('renders the goal, what happened and what is outstanding, and returns the value', async () => {
      gthAgentRunnerInstanceMock.requestRunRecap.mockResolvedValue(recap as never);
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      const result = await runSingleShot(
        'test-source',
        'test-preamble',
        'test-content',
        { ...mockConfig } as GthConfig,
        undefined,
        'ask',
        undefined,
        { announceOutstandingWork: true, announceRunRecap: true }
      );

      expect(consoleUtilsMock.displayNotice).toHaveBeenCalledTimes(1);
      const [title, lines] = consoleUtilsMock.displayNotice.mock.calls[0];
      const rendered = [title, ...(lines as string[])].join('\n');
      expect(rendered).toContain('Add the recap flag');
      expect(rendered).toContain('Edited the schema');
      expect(rendered).toContain('docs page is still to write');
      // The fact travels as a value too, so an embedder is not left parsing the console.
      expect(result.recap).toEqual(recap);
    });

    /**
     * **The subsumption cell on a real surface.** Exactly one notice is drawn, it is the recap, and
     * it carries the counts the suppressed notice would have carried — asserted by the absence of
     * that notice's own title prefix in the one thing that was printed.
     */
    it('suppresses the unfinished-checklist notice and keeps its counts', async () => {
      gthAgentRunnerInstanceMock.requestRunRecap.mockResolvedValue(recap as never);
      const { OUTSTANDING_WORK_NOTICE_TITLE_PREFIX } = await import('#src/core/outstandingWork.js');
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      await runSingleShot(
        'test-source',
        'test-preamble',
        'test-content',
        { ...mockConfig } as GthConfig,
        undefined,
        'ask',
        undefined,
        { announceOutstandingWork: true, announceRunRecap: true }
      );

      expect(consoleUtilsMock.displayNotice).toHaveBeenCalledTimes(1);
      const [title, lines] = consoleUtilsMock.displayNotice.mock.calls[0];
      expect(title).not.toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);
      expect((lines as string[]).join('\n')).toContain('2 of 3 items not marked completed');
    });

    /**
     * **The floor survives a failing recap, on the surface rather than in the arbitrator.**
     *
     * `runRecap.spec.ts` proves `runEndReport` restores the notice when handed `null`; this proves
     * the call site actually reaches it when the runner's own call THROWS, which is the failure
     * mode a single shared `try` would swallow — taking the free notice down with the paid recap.
     */
    it('falls back to the notice when the recap call throws', async () => {
      gthAgentRunnerInstanceMock.requestRunRecap.mockRejectedValue(new Error('provider down'));
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      const result = await runSingleShot(
        'test-source',
        'test-preamble',
        'test-content',
        { ...mockConfig } as GthConfig,
        undefined,
        'ask',
        undefined,
        { announceOutstandingWork: true, announceRunRecap: true }
      );

      expect(consoleUtilsMock.displayNotice).toHaveBeenCalledTimes(1);
      expect(consoleUtilsMock.displayNotice.mock.calls[0][0]).toContain('2 of 3');
      expect(result.recap).toBeNull();
    });

    it('is not offered to the harness callers, which ask for neither', async () => {
      gthAgentRunnerInstanceMock.requestRunRecap.mockResolvedValue(recap as never);
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      const result = await runSingleShot('test-source', 'test-preamble', 'test-content', {
        ...mockConfig,
      } as GthConfig);

      // `batch`, `eval` and `workflow` land here. Not asked for, so not called at all — the model
      // call is the cost this decision is about, and it is never made on their behalf.
      expect(gthAgentRunnerInstanceMock.requestRunRecap).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayNotice).not.toHaveBeenCalled();
      expect(result.recap).toBeNull();
    });
  });
});
