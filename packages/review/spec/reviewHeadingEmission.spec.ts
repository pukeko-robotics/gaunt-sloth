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
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

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

  /**
   * The node's actual requirement: the review **opens** with the attribution, on both surfaces —
   * once, and with nothing above it.
   *
   * The first-write assertion is the load-bearing one, and it is an assertion about **index 0**
   * deliberately. Nothing on this path can legitimately write to the report before the heading:
   * `initSessionLogging` is opened four lines above the emission and is called nowhere else on the
   * review path (`reviewCommand.ts`, `prCommand.ts`, `packages/app/src/cli.ts` and
   * `packages/review/cli.js` never open it), and the agent — whose notices are the only other
   * plausible writer — is not constructed until thirty lines later. So index 0 is a RULE here, not
   * an accident of what happened to run first, and a "find it wherever it is" lookup gives up the
   * only assertion that can catch a line inserted above the emission. One `displayWarning` there
   * leaves the whole suite green and puts an advisory at the top of the posted PR comment; this is
   * what notices.
   */
  const expectHeadingOpensBothSurfaces = (): void => {
    expect(headingCount(terminalLines())).toBe(1);
    expect(headingCount(reportLines())).toBe(1);
    expect(
      reportLines()[0],
      'the review must OPEN with the attribution (REL-12 acceptance 1) — if you added a line above the emission, move it below rather than relaxing this'
    ).toContain(HEADING);
    // The terminal half pins the first `console.log` write, NOT the first thing on the user's
    // screen: `ProgressIndicator` writes straight to stdout without a newline, so a real
    // `streamOutput: false` run shows `Reviewing.## Gaunt Sloth: Code Review`. That collision is
    // reported separately and is not this spec's to assert away — if it is ever fixed by routing
    // the indicator through `display`, this line reddens on the fix and should move, not relax.
    expect(terminalLines()[0]).toContain(HEADING);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    leanAgent.init.mockResolvedValue(undefined);
    leanAgent.invoke.mockResolvedValue('LGTM');
    leanAgent.cleanup.mockResolvedValue(undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ({ review } = await import('#src/modules/reviewModule.js'));
  });

  afterEach(async () => {
    logSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    // The console level is module state, so a cell that moves it must not leak into the next file.
    const { resetConsoleLevel } = await import('@gaunt-sloth/core/utils/consoleUtils.js');
    resetConsoleLevel();
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

      expectHeadingOpensBothSurfaces();
      expect(reportLines().join('')).toContain(
        'stateless review · gemini-3.1-pro-preview (google-genai)'
      );
      // Emitted before the agent ran. Located by CONTENT here, because this half is about ORDER
      // relative to the run, and reading it off an index would make it depend on the assertion above.
      const headingAt = reportLines().findIndex((line) => line.includes(HEADING));
      expect(writeToLogStreamMock.mock.invocationCallOrder[headingAt]).toBeLessThan(
        leanAgent.invoke.mock.invocationCallOrder[0]
      );
    }
  );

  it('still shows the heading on the compact run-header rung', async () => {
    // GS2-93's `compact` rung strips the agent's technical preamble (Workdir/Model/Tools/
    // Middleware) so captured stdout stays diffable — proven in
    // `packages/core/spec/GthLangChainAgent.spec.ts`. The Gaunt Sloth heading is not preamble: it is
    // the first line of the review document, and on this rung it IS the run's attribution, which is
    // why the agent emits no second `Gaunt Sloth: <verb>` line for review/pr.
    await review(
      'review',
      '',
      'a diff',
      configWith({ writeOutputToFile: './rel12-review.md', output: { header: 'compact' } }),
      'review'
    );

    expectHeadingOpensBothSurfaces();
  });

  // GS2-93 — `none` is the one rung that reaches the attribution, and it takes the WHOLE block:
  // heading and line, terminal and report. The report half is the load-bearing one, because that is
  // the stream a caller pipes into their own template or diffs.
  it.each([
    ['review', {}],
    ['pr', { commands: { pr: { contentSource: 'github' } } }],
  ] as Array<['review' | 'pr', Partial<GthConfig>]>)(
    'drops the whole attribution block on the none rung (%s), on both surfaces',
    async (command, commandConfig) => {
      await review(
        command,
        '',
        'a diff',
        configWith({
          writeOutputToFile: './rel12-review.md',
          output: { header: 'none' },
          ...commandConfig,
        }),
        command
      );

      expect(headingCount(terminalLines())).toBe(0);
      expect(headingCount(reportLines())).toBe(0);
      expect(terminalLines().join('')).not.toContain('stateless review');
      expect(reportLines().join('')).not.toContain('stateless review');
    }
  );

  it('shows it exactly once — not twice — when output.header is absent', async () => {
    await review('review', '', 'a diff', configWith({ writeOutputToFile: './rel12-review.md' }));

    expectHeadingOpensBothSurfaces();
  });

  it('emits it through `display` — DISPLAY level, log channel — so no other helper passes', async () => {
    const { setConsoleLevel, resetConsoleLevel } =
      await import('@gaunt-sloth/core/utils/consoleUtils.js');
    const { StatusLevel } = await import('@gaunt-sloth/core/core/types.js');
    const config = () => configWith({ writeOutputToFile: './rel12-review.md' });

    // The CHANNEL rules out two helpers, including the header gate: `displayInfo` lands on
    // console.info — it is what `headerStatus` reports through, so it is the one change that would
    // put the heading back under the preamble gate, and therefore the load-bearing exclusion — and
    // `displayWarning` lands on console.warn. `displaySuccess` and `displayError` are NOT excluded
    // here: both call `su.log`, i.e. console.log, exactly as `display` does. The level halves below
    // are what rule those two out.
    await review('review', '', 'a diff', config());
    expect(headingCount(terminalLines())).toBe(1);
    for (const spy of [infoSpy, warnSpy, errorSpy]) {
      expect(headingCount(spy.mock.calls.map((call) => String(call[0])))).toBe(0);
    }

    // The channel alone cannot tell `display` from `displaySuccess`: both write to console.log, and
    // with colour off they are byte-identical. The console-level gate is what separates them, so it
    // is pinned from BOTH sides — and exactly one level satisfies both halves, which is the point.
    try {
      // At DISPLAY, anything QUIETER is suppressed — `displayInfo` would vanish here.
      setConsoleLevel(StatusLevel.DISPLAY);
      logSpy.mockClear();
      await review('review', '', 'a diff', config());
      expect(headingCount(terminalLines())).toBe(1);

      // At SUCCESS, DISPLAY is suppressed — `displaySuccess`, or anything LOUDER, would still print.
      // (That the attribution goes quiet on a quieted console is accepted behaviour: the same gate
      // drops a non-streamed review body too.)
      setConsoleLevel(StatusLevel.SUCCESS);
      logSpy.mockClear();
      await review('review', '', 'a diff', config());
      expect(headingCount(terminalLines())).toBe(0);
    } finally {
      resetConsoleLevel();
    }
  });

  it('shows it on a terminal-only run, where nothing is written to a file at all', async () => {
    await review('review', '', 'a diff', configWith({ writeOutputToFile: false }));

    expect(headingCount(terminalLines())).toBe(1);
    expect(initLogStreamMock).not.toHaveBeenCalled();
    expect(reportLines()).toEqual([]);
  });
});
