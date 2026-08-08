/**
 * GS2-81 — `agent.backend` is COMMAND-SCOPED, and a run that cannot honor it must say so.
 *
 * `GthAgentRunner`'s `agentFactory ?? lean` fallback is the exact point where a configured
 * `agent.backend: 'deep'` stops existing: a caller that passes no factory gets the lean agent no
 * matter what the config asked for. `gth review`, `gth pr` and the `gth pr` discovery agent are all
 * in that position. This file drives that real fallback — a real `GthAgentRunner`, the real
 * `GthLangChainAgent` behind it, the real config object — and asserts on the status stream the user
 * actually reads. Nothing here injects the warning or stubs the decision.
 *
 * The only mock is `langchain`'s `createAgent`, the model-graph boundary: mocking it is also what
 * lets the lean agent's own construction be the evidence that lean is what ran.
 *
 * The negative cells are the load-bearing half. Without them an implementation that warns on every
 * run — or on `lean`, or when the deep factory WAS supplied — passes just as happily, and "no
 * longer silent" would be unproven.
 *
 * The end-to-end counterpart, driving `review()` itself through to the terminal write, is
 * `packages/review/spec/reviewBackendScope.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { GthConfig } from '#src/config.js';
import type { GthAgentInterface, StatusUpdateCallback } from '#src/core/types.js';
import { StatusLevel } from '#src/core/types.js';

const createAgentMock = vi.fn();
vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return { ...actual, createAgent: createAgentMock };
});

vi.mock('#src/middleware/registry.js', () => ({ resolveMiddleware: vi.fn(async () => []) }));

describe('GS2-81 — agent.backend is command-scoped and never silently dropped', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdate: Mock<StatusUpdateCallback>;

  /** A config the lean agent can initialize from, with no prompt files read off this machine. */
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

  const resolvers = { resolveTools: async () => [] };

  /** A deep-backend stand-in: any factory at all means the caller CAN honor the key. */
  const suppliedAgent = {
    init: vi.fn(async () => {}),
    invoke: vi.fn(),
    stream: vi.fn(),
    streamWithEvents: vi.fn(),
    streamWithEventsResume: vi.fn(),
    cleanup: vi.fn(async () => {}),
  } as unknown as GthAgentInterface;

  /** WARNING-level messages only — the level a user sees, not merely the text emitted. */
  const backendWarnings = (): string[] =>
    statusUpdate.mock.calls
      .filter(([level]) => level === StatusLevel.WARNING)
      .map(([, message]) => message)
      .filter((message) => message.includes('agent.backend'));

  beforeEach(async () => {
    vi.resetAllMocks();
    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    statusUpdate = vi.fn();
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  it('warns, naming the command, when review runs with agent.backend: deep and no backend factory', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init('review', configWith('deep'));

    const warnings = backendWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('agent.backend: deep');
    expect(warnings[0]).toContain('the review command');
    expect(warnings[0]).toContain('lean');

    // …and the lean agent is what actually got built: only GthLangChainAgent calls createAgent.
    expect(createAgentMock).toHaveBeenCalledTimes(1);
  });

  it('names the pr command when the pr review runs with agent.backend: deep', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init('pr', configWith('deep'));

    expect(backendWarnings()[0]).toContain('the pr command');
  });

  it('warns without naming a command for a commandless run (the pr discovery agent)', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init(undefined, configWith('deep'));

    const warnings = backendWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('this run');
    expect(warnings[0]).not.toContain('undefined');
  });

  it('stays quiet when a backend factory IS supplied — that caller honors the key', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never, () => suppliedAgent);
    await runner.init('code', configWith('deep'));

    expect(backendWarnings()).toEqual([]);
    // The supplied factory really was the one used, so the quiet is not a missed code path.
    expect(suppliedAgent.init).toHaveBeenCalledTimes(1);
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('stays quiet for agent.backend: lean without a factory — lean IS what runs', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init('review', configWith('lean'));

    expect(backendWarnings()).toEqual([]);
  });

  it('stays quiet when agent.backend is unset', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init('review', configWith());

    expect(backendWarnings()).toEqual([]);
  });
});
