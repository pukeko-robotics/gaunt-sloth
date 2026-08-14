/**
 * EXT-114 — end-to-end: a `gth review` / `gth pr` run whose config declares `subagents` tells the
 * user they are not dispatched, instead of dropping them in silence.
 *
 * This drives the whole real path a `gth review` run takes below the CLI: the real `review()`, the
 * real `GthAgentRunner` it builds, the real `defaultStatusCallback` and the real `displayWarning`,
 * and asserts on what is written to the terminal. Nothing is injected or stubbed on the notice
 * path, and the assertion is on the user-visible write rather than on a warning function having
 * been called — the unit-level cells in `core/spec/subagentScope.spec.ts` cannot prove that a
 * status-level message survives the callback and reaches a terminal channel.
 *
 * `GthLangChainAgent` is stubbed because it is the model boundary — the thing that would otherwise
 * need a live LLM. The runner still reaches it through the same path, so the behaviour under test
 * is untouched; `reviewModule.spec.ts` cannot host this test at all because it mocks the runner
 * itself.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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

describe('EXT-114 — review tells the user declared subagents are not dispatched', () => {
  let review: typeof import('#src/modules/reviewModule.js').review;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const configWith = (subagents?: Array<{ name: string; profile: string }>): GthConfig =>
    ({
      llm: { _llmType: () => 'test', bindTools: vi.fn() },
      streamOutput: false,
      contentSource: 'file',
      requirementSource: 'file',
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: false,
      canInterruptInferenceWithEsc: false,
      includeCurrentDateAfterGuidelines: false,
      noDefaultPrompts: true,
      output: { header: 'none' },
      ...(subagents ? { subagents } : {}),
    }) as unknown as GthConfig;

  /** Everything actually written to the terminal's warning channel during the run. */
  const terminalWarnings = (): string[] =>
    warnSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('subagents'));

  beforeEach(async () => {
    vi.resetAllMocks();
    leanAgent.init.mockResolvedValue(undefined);
    leanAgent.invoke.mockResolvedValue('LGTM');
    leanAgent.cleanup.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ({ review } = await import('#src/modules/reviewModule.js'));
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('prints a warning naming the review command and the declared subagent', async () => {
    await review(
      'review',
      '',
      'a diff',
      configWith([{ name: 'searcher', profile: 'flash' }]),
      'review'
    );

    expect(terminalWarnings()).toHaveLength(1);
    expect(terminalWarnings()[0]).toContain('searcher');
    expect(terminalWarnings()[0]).toContain('the review command');
    // The run itself still happened, so the notice is about a real run that went without them.
    expect(leanAgent.invoke).toHaveBeenCalledTimes(1);
  });

  it('prints a warning naming the pr command', async () => {
    await review('pr', '', 'a diff', configWith([{ name: 'searcher', profile: 'flash' }]), 'pr');

    expect(terminalWarnings()[0]).toContain('the pr command');
  });

  it('prints nothing about subagents when none are declared', async () => {
    await review('review', '', 'a diff', configWith(), 'review');

    expect(terminalWarnings()).toEqual([]);
  });
});
