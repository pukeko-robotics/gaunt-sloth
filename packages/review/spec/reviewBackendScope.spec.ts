/**
 * GS2-81 — end-to-end: `gth review` / `gth pr` tell the user their `agent.backend: deep` is not
 * honored, instead of dropping it in silence.
 *
 * This drives the whole real path a `gth review` run takes below the CLI: the real `review()`, the
 * real `GthAgentRunner` it builds (with no backend factory — `@gaunt-sloth/review` does not depend
 * on `@gaunt-sloth/agent`, so it has none to give), the real `defaultStatusCallback` and the real
 * `displayWarning`, and asserts on what is written to the terminal. Nothing about the selection is
 * injected or stubbed, and the assertion is on the user-visible write rather than on a warning
 * function having been called.
 *
 * `GthLangChainAgent` is stubbed because it is the model boundary — the thing that would otherwise
 * need a live LLM. The runner still reaches it through the same `agentFactory ?? lean` fallback
 * that decides the backend, so the decision under test is untouched: the stub stands in for the
 * lean agent, and `reviewModule.spec.ts` cannot host this test at all because it mocks the runner
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

describe('GS2-81 — review tells the user agent.backend: deep is not honored', () => {
  let review: typeof import('#src/modules/reviewModule.js').review;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const configWith = (backend?: 'deep' | 'lean'): GthConfig =>
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
      output: { header: false },
      ...(backend ? { agent: { backend } } : {}),
    }) as unknown as GthConfig;

  /** Everything actually written to the terminal's warning channel during the run. */
  const terminalWarnings = (): string[] =>
    warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('agent.backend'));

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

  it('prints a warning naming the review command when agent.backend is deep', async () => {
    await review('review', '', 'a diff', configWith('deep'), 'review');

    expect(terminalWarnings()).toHaveLength(1);
    expect(terminalWarnings()[0]).toContain('agent.backend: deep');
    expect(terminalWarnings()[0]).toContain('the review command');
    // The run itself still happened on the lean agent, so the notice is about a real substitution.
    expect(leanAgent.invoke).toHaveBeenCalledTimes(1);
  });

  it('prints a warning naming the pr command when agent.backend is deep', async () => {
    await review('pr', '', 'a diff', configWith('deep'), 'pr');

    expect(terminalWarnings()[0]).toContain('the pr command');
  });

  it('prints nothing about the backend when agent.backend is unset', async () => {
    await review('review', '', 'a diff', configWith(), 'review');

    expect(terminalWarnings()).toEqual([]);
  });
});
