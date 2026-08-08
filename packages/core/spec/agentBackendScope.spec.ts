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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  let AGENT_BACKEND_SCOPE_DOCS_URL: string;
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
    ({ GthAgentRunner, AGENT_BACKEND_SCOPE_DOCS_URL } =
      await import('#src/core/GthAgentRunner.js'));
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

  /**
   * The notice must NOT carry its own copy of which commands honor the key. The first draft did,
   * and it was wrong on the day it shipped (it omitted `workflow` agent steps while the docs table
   * written in the same commit listed them) — a sentence is not a claim a test can check. It points
   * at the docs instead, and these two cells check the half that IS checkable: the pointer is
   * present, and it still resolves to a real heading.
   */
  it('points at the docs for the command list instead of enumerating commands', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init('review', configWith('deep'));

    expect(backendWarnings()[0]).toContain(AGENT_BACKEND_SCOPE_DOCS_URL);
  });

  it("the docs URL's anchor resolves to a real heading in profiles.md", () => {
    // Built from import.meta.url, not a path literal, so the Windows CI cell resolves it too.
    const docPath = fileURLToPath(
      new URL('../../../docs/configuration/profiles.md', import.meta.url)
    );
    const markdown = readFileSync(docPath, 'utf8');

    const anchors = [...markdown.matchAll(/^#{1,6} +(.+?)\s*$/gm)].map(([, heading]) =>
      heading
        .toLowerCase()
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/ +/g, '-')
    );

    const fragment = AGENT_BACKEND_SCOPE_DOCS_URL.split('#')[1];
    expect(fragment).toBeTruthy();
    expect(anchors).toContain(fragment);
    // The section the anchor names is only worth pointing at if it holds the list.
    expect(markdown).toContain('Honours `agent.backend`');
  });

  /**
   * The notice fires BEFORE the agent is built, not after it is initialized. That ordering is the
   * difference between a user with a broken provider config learning their backend key was ignored
   * and never hearing it at all — and moving the call below `await this.agent.init(...)` passes
   * every other cell in this file.
   */
  it('warns even when the agent fails to initialize', async () => {
    createAgentMock.mockImplementation(() => {
      throw new Error('provider is not configured');
    });
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);

    await expect(runner.init('review', configWith('deep'))).rejects.toThrow(
      'provider is not configured'
    );
    expect(backendWarnings()).toHaveLength(1);
  });

  it('warns before the agent is built, not after', async () => {
    const order: string[] = [];
    createAgentMock.mockImplementation(() => {
      order.push('agent-built');
      return { invoke: vi.fn(), stream: vi.fn() };
    });
    statusUpdate.mockImplementation((level, message) => {
      if (level === StatusLevel.WARNING && message.includes('agent.backend')) order.push('warning');
    });

    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init('review', configWith('deep'));

    expect(order).toEqual(['warning', 'agent-built']);
  });

  it('names the pr command when the pr review runs with agent.backend: deep', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init('pr', configWith('deep'));

    expect(backendWarnings()[0]).toContain('the pr command');
  });

  /**
   * The `gth pr` discovery agent inits with `command: undefined` (it must run on the chat prompt),
   * so without `owningCommand` a `gth pr` run printed two notices in two different voices — "this
   * run…" then "the pr command…" — which reads as two problems rather than one repeated.
   */
  it('names the owning command for a commandless run (the pr discovery agent)', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init(undefined, configWith('deep'), undefined, { owningCommand: 'pr' });

    const warnings = backendWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the pr command');
    expect(warnings[0]).not.toContain('undefined');
    expect(warnings[0]).not.toContain('this run');
  });

  it('falls back to a scope-free phrasing when neither a command nor an owning command is known', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init(undefined, configWith('deep'));

    const warnings = backendWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('this run');
    expect(warnings[0]).not.toContain('undefined');
  });

  it('never lets owningCommand change how the run behaves — only what the notice says', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init(undefined, configWith('deep'), undefined, { owningCommand: 'pr' });

    // `command` is what selects the mode prompt / posture; the label must not reach the agent.
    expect(createAgentMock).toHaveBeenCalledTimes(1);
    const [[agentOptions]] = createAgentMock.mock.calls as [[{ systemPrompt?: string }]];
    const withoutLabel = vi.fn();
    createAgentMock.mockImplementation((options: unknown) => {
      withoutLabel(options);
      return { invoke: vi.fn(), stream: vi.fn() };
    });
    await new GthAgentRunner(statusUpdate, resolvers as never).init(undefined, configWith('deep'));
    const [[baselineOptions]] = withoutLabel.mock.calls as [[{ systemPrompt?: string }]];
    expect(agentOptions.systemPrompt).toEqual(baselineOptions.systemPrompt);
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
