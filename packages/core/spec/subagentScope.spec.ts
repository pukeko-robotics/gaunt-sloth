/**
 * EXT-114 — a run that declares `subagents` must say they are not dispatched.
 *
 * The key stays valid (a config written for GS2-25 should not have to be un-written), and nothing
 * spawns a subagent today. Between those two facts sits the failure this notice exists to prevent:
 * the parent silently does the work itself, on the parent's model, and the only visible symptom is
 * the bill. So the config is honoured-or-announced, never quietly ignored.
 *
 * This drives the real `GthAgentRunner.init` fallback, the real `GthLangChainAgent` behind it and
 * the real config object, asserting on the status stream the user actually reads. Nothing here
 * injects the warning or stubs the decision.
 *
 * The only mock is `langchain`'s `createAgent`, the model-graph boundary.
 *
 * The negative cells are the load-bearing half. Without them an implementation that warns on every
 * run — or on an empty array — passes just as happily, and "not silent" would be unproven.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GthConfig } from '#src/config.js';
import type { StatusUpdateCallback } from '#src/core/types.js';
import { StatusLevel } from '#src/core/types.js';

const createAgentMock = vi.fn();
vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return { ...actual, createAgent: createAgentMock };
});

vi.mock('#src/middleware/registry.js', () => ({ resolveMiddleware: vi.fn(async () => []) }));

describe('EXT-114 — declared subagents are never silently dropped', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let SUBAGENTS_DOCS_URL: string;
  let statusUpdate: Mock<StatusUpdateCallback>;

  /** A config the agent can initialize from, with no prompt files read off this machine. */
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

  /** WARNING-level messages only — the level a user sees, not merely the text emitted. */
  const subagentWarnings = (): string[] =>
    statusUpdate.mock.calls
      .filter(([level]) => level === StatusLevel.WARNING)
      .map(([, message]) => message)
      .filter((message) => message.includes('subagents'));

  beforeEach(async () => {
    vi.resetAllMocks();
    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    statusUpdate = vi.fn();
    ({ GthAgentRunner, SUBAGENTS_DOCS_URL } = await import('#src/core/GthAgentRunner.js'));
  });

  it('warns once, naming the command and every declared subagent', async () => {
    const runner = new GthAgentRunner(statusUpdate, { resolveTools: async () => [] } as never);
    await runner.init(
      'code',
      configWith([
        { name: 'searcher', profile: 'flash' },
        { name: 'reviewer', profile: 'sonnet' },
      ])
    );

    const warnings = subagentWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the code command');
    // BOTH names, so a user can tell which of their declarations went unused. An implementation
    // that named only the first would pass a single-subagent check.
    expect(warnings[0]).toContain('searcher');
    expect(warnings[0]).toContain('reviewer');
    // The agent was still built: the notice is about a run that happened, not an aborted one.
    expect(createAgentMock).toHaveBeenCalledTimes(1);
  });

  it('points at the docs instead of paraphrasing what replaces them', async () => {
    const runner = new GthAgentRunner(statusUpdate, { resolveTools: async () => [] } as never);
    await runner.init('code', configWith([{ name: 'searcher', profile: 'flash' }]));

    expect(subagentWarnings()[0]).toContain(SUBAGENTS_DOCS_URL);
  });

  it("the docs URL's anchor resolves to a real heading in the page it names", () => {
    // The file to read is DERIVED FROM THE URL, never a second hardcoded path: otherwise the URL
    // could be repointed at a different page and this cell would happily go on validating the
    // fragment against the old one. Only the org/repo half is uncheckable offline.
    const [href, fragment] = SUBAGENTS_DOCS_URL.split('#');
    const repoRelativePath = href.split('/blob/main/')[1];
    expect(repoRelativePath).toBeTruthy();

    // Resolved from import.meta.url, not a path literal, so the Windows CI cell resolves it too.
    const docPath = fileURLToPath(new URL(`../../../${repoRelativePath}`, import.meta.url));
    const markdown = readFileSync(docPath, 'utf8');

    const anchors = [...markdown.matchAll(/^#{1,6} +(.+?)\s*$/gm)].map(([, heading]) =>
      heading
        .toLowerCase()
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/ +/g, '-')
    );

    expect(fragment).toBeTruthy();
    expect(anchors).toContain(fragment);
  });

  /**
   * The notice fires BEFORE the agent is built, not after it is initialized. That ordering is the
   * difference between a user with a broken provider config learning their subagents were ignored
   * and never hearing it at all — and moving the call below `await this.agent.init(...)` passes
   * every other cell in this file.
   */
  it('warns even when the agent fails to initialize', async () => {
    createAgentMock.mockImplementation(() => {
      throw new Error('provider is not configured');
    });
    const runner = new GthAgentRunner(statusUpdate, { resolveTools: async () => [] } as never);

    await expect(
      runner.init('code', configWith([{ name: 'searcher', profile: 'flash' }]))
    ).rejects.toThrow('provider is not configured');
    expect(subagentWarnings()).toHaveLength(1);
  });

  it('falls back to a scope-free phrasing when no command is known', async () => {
    const runner = new GthAgentRunner(statusUpdate, { resolveTools: async () => [] } as never);
    await runner.init(undefined, configWith([{ name: 'searcher', profile: 'flash' }]));

    const warnings = subagentWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('this run');
    expect(warnings[0]).not.toContain('undefined');
  });

  it('names the owning command for a commandless run (the pr discovery agent)', async () => {
    const runner = new GthAgentRunner(statusUpdate, { resolveTools: async () => [] } as never);
    await runner.init(undefined, configWith([{ name: 'searcher', profile: 'flash' }]), undefined, {
      owningCommand: 'pr',
    });

    expect(subagentWarnings()[0]).toContain('the pr command');
  });

  it('stays quiet when no subagents are declared', async () => {
    const runner = new GthAgentRunner(statusUpdate, { resolveTools: async () => [] } as never);
    await runner.init('code', configWith());

    expect(subagentWarnings()).toEqual([]);
  });

  it('stays quiet for an EMPTY subagents array — nothing was asked for', async () => {
    const runner = new GthAgentRunner(statusUpdate, { resolveTools: async () => [] } as never);
    await runner.init('code', configWith([]));

    expect(subagentWarnings()).toEqual([]);
  });
});
