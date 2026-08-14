/**
 * REL-12 — end-to-end: a real `gth review` / `gth pr` run opens with the Gaunt Sloth heading, on
 * BOTH surfaces.
 *
 * This drives the real `review()`, the real `GthAgentRunner` it builds, the real
 * `defaultStatusCallback`, the real `display`, and the real session-logging capture, and asserts on
 * what is actually written — to the terminal channel and to the log stream that becomes the
 * `writeOutputToFile` report. That report is the surface the node exists for: a CI workflow reads it
 * back and posts it as a PR comment, so a heading that reached only the terminal would look correct
 * locally and do nothing at all where it matters.
 *
 * `GthLangChainAgent` is stubbed because it is the model boundary — the thing that would otherwise
 * need a live LLM — exactly as `reviewSubagentScope.spec.ts` stubs it. The log stream is stubbed at
 * `systemUtils` so the run writes no file; everything between `display` and that stream is real.
 * `reviewModule.spec.ts` cannot host this: it mocks `consoleUtils` wholesale, so nothing there can
 * show that a displayed line is captured into the report at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

const leanAgent = {
  init: vi.fn(async () => {}),
  invoke: vi.fn(async () => 'LGTM'),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  streamWithEventsResume: vi.fn(),
  cleanup: vi.fn(async () => {}),
  setVerbose: vi.fn(),
};

vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class GthLangChainAgentStub {
    constructor() {
      return leanAgent;
    }
  },
}));

// The log stream is the ONLY thing stubbed below `display`: `initLogStream` would otherwise open a
// real file. `writeToLogStream` is what `consoleUtils` feeds the ANSI-stripped console output into,
// so it IS the report's content.
const initLogStreamMock = vi.fn();
const writeToLogStreamMock = vi.fn();
const closeLogStreamMock = vi.fn();
const stdoutWriteMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async () => {
  const actual = await vi.importActual<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>(
    '@gaunt-sloth/core/utils/systemUtils.js'
  );
  return {
    ...actual,
    initLogStream: initLogStreamMock,
    writeToLogStream: writeToLogStreamMock,
    closeLogStream: closeLogStreamMock,
    stdout: { write: stdoutWriteMock, columns: 80 },
  };
});

const HEADING = '## Gaunt Sloth: Code Review';

/** How many of `lines` contain the heading — the count is what proves "exactly once". */
const headingCount = (lines: string[]): number => lines.filter((l) => l.includes(HEADING)).length;

describe('REL-12 — the review heading reaches the terminal and the output file', () => {
  let review: typeof import('#src/modules/reviewModule.js').review;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  const configWith = (overrides: Partial<GthConfig>): GthConfig =>
    ({
      llm: { _llmType: () => 'test', bindTools: vi.fn() },
      streamOutput: false,
      contentSource: 'file',
      requirementSource: 'file',
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: true,
      canInterruptInferenceWithEsc: false,
      includeCurrentDateAfterGuidelines: false,
      noDefaultPrompts: true,
      modelDisplayName: 'gemini-3.1-pro-preview',
      modelProviderType: 'google-genai',
      ...overrides,
    }) as unknown as GthConfig;

  /** Everything written to the terminal's log channel. */
  const terminalLines = (): string[] => logSpy.mock.calls.map((call) => String(call[0]));

  /** Everything captured into the session log — i.e. the content of the report file. */
  const reportLines = (): string[] =>
    writeToLogStreamMock.mock.calls.map((call) => String(call[0]));

  beforeEach(async () => {
    vi.clearAllMocks();
    leanAgent.init.mockResolvedValue(undefined);
    leanAgent.invoke.mockResolvedValue('LGTM');
    leanAgent.cleanup.mockResolvedValue(undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    ({ review } = await import('#src/modules/reviewModule.js'));
  });

  afterEach(() => {
    logSpy.mockRestore();
    infoSpy.mockRestore();
  });

  // Both verbs, each with the command config it really runs under — `pr` reviews a GitHub PR, which
  // injects the `gh` file-read tool on the line above the emission, so the cell exercises that path
  // rather than merely passing a different string.
  it.each([
    ['review', {}],
    ['pr', { commands: { pr: { contentSource: 'github' } } }],
  ] as Array<['review' | 'pr', Partial<GthConfig>]>)(
    'opens %s with the heading and the attribution on the terminal and in the report',
    async (command, commandConfig) => {
      await review(
        command,
        '',
        'a diff',
        configWith({ writeOutputToFile: './rel12-review.md', ...commandConfig }),
        command
      );

      // Terminal.
      expect(headingCount(terminalLines())).toBe(1);
      // The report a workflow reads back and posts.
      expect(headingCount(reportLines())).toBe(1);
      expect(reportLines().join('')).toContain(
        'stateless review · gemini-3.1-pro-preview (google-genai)'
      );
      // Emitted before the agent ran, so it heads the document rather than trailing the review.
      // Located by CONTENT, not by index: anything else the run legitimately logs first (a config
      // advisory, a subagent notice) must not turn this red — it is the ordering that matters.
      const headingAt = writeToLogStreamMock.mock.calls.findIndex((call) =>
        String(call[0]).includes(HEADING)
      );
      expect(headingAt).toBeGreaterThanOrEqual(0);
      expect(writeToLogStreamMock.mock.invocationCallOrder[headingAt]).toBeLessThan(
        leanAgent.invoke.mock.invocationCallOrder[0]
      );
    }
  );

  it('still shows the heading when output.header is false', async () => {
    // GS2-63's `output.header: false` strips the agent's technical run-header preamble
    // (Workdir/Model/Tools/Middleware) so captured stdout stays diffable — proven in
    // `packages/core/spec/GthLangChainAgent.spec.ts`. The Gaunt Sloth heading is not preamble: it is
    // the first line of the review document, so that switch must not reach it.
    await review(
      'review',
      '',
      'a diff',
      configWith({ writeOutputToFile: './rel12-review.md', output: { header: false } }),
      'review'
    );

    expect(headingCount(terminalLines())).toBe(1);
    expect(headingCount(reportLines())).toBe(1);
  });

  it('shows it exactly once — not twice — when output.header is absent', async () => {
    await review('review', '', 'a diff', configWith({ writeOutputToFile: './rel12-review.md' }));

    expect(headingCount(terminalLines())).toBe(1);
    expect(headingCount(reportLines())).toBe(1);
  });

  it('emits it on the display channel, never through the header status channel', async () => {
    await review('review', '', 'a diff', configWith({ writeOutputToFile: './rel12-review.md' }));

    // `headerStatus` reports at INFO, which lands on `console.info`; `display` lands on
    // `console.log`. Routing the heading through the header helper — the one change that would put
    // it back under `output.header` — would move it to the other channel, and this is what notices.
    const infoLines = infoSpy.mock.calls.map((call) => String(call[0]));
    expect(headingCount(infoLines)).toBe(0);
    expect(headingCount(terminalLines())).toBe(1);
  });

  it('shows it on a terminal-only run, where nothing is written to a file at all', async () => {
    await review('review', '', 'a diff', configWith({ writeOutputToFile: false }));

    expect(headingCount(terminalLines())).toBe(1);
    expect(initLogStreamMock).not.toHaveBeenCalled();
    expect(reportLines()).toEqual([]);
  });
});
