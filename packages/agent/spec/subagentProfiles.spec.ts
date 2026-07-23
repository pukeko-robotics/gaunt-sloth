import { beforeEach, describe, expect, it, vi } from 'vitest';

// The acceptance headliner (GS2-33): a subagent launched with a named profile resolves THAT
// profile's model/tools — proven on the subagent-spawn config resolution itself. `initConfig` is the
// GS2-1 cascade entry point; mock it so a profile name maps to a distinct child config (its own
// model), and assert buildProfileSubagents threads the profile through and hands deepagents a
// SubAgent whose model is the child's, distinct from the parent's.
const initConfigMock = vi.fn();
vi.mock('@gaunt-sloth/core/config.js', () => ({
  initConfig: (overrides: unknown) => initConfigMock(overrides),
}));

// The prompt readers + buildSystemMessages otherwise hit the config path on disk; stub them so the
// composed child prompt is deterministic (mirrors GthDeepAgent.spec).
const buildSystemMessagesMock = vi.fn();
const readChatPromptMock = vi.fn();
const readCodePromptMock = vi.fn();
const readExecPromptMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', () => ({
  buildSystemMessages: buildSystemMessagesMock,
  readChatPrompt: readChatPromptMock,
  readCodePrompt: readCodePromptMock,
  readExecPrompt: readExecPromptMock,
}));

vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({ debugLog: vi.fn() }));

function fakeModel(id: string): any {
  return { _id: id, bindTools: () => ({}) };
}

describe('buildProfileSubagents — subagent profile reuse (GS2-33)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    buildSystemMessagesMock.mockReturnValue([{ content: 'CHILD PROMPT' }]);
    readChatPromptMock.mockReturnValue('chat-prompt');
    readCodePromptMock.mockReturnValue('code-prompt');
    readExecPromptMock.mockReturnValue('exec-prompt');
  });

  it("resolves the child under the named profile — the SubAgent's model is the profile's, not the parent's", async () => {
    // The parent (not modelled here) runs on a strong model; profile 'cheap' resolves to its own.
    initConfigMock.mockImplementation(async (overrides: { identityProfile?: string }) => {
      expect(overrides).toEqual({ identityProfile: 'cheap' }); // profile threaded, nothing else
      return { llm: fakeModel('cheap-model') };
    });

    const { buildProfileSubagents } = await import('#src/core/subagentProfiles.js');
    const subagents = await buildProfileSubagents(
      [{ name: 'recall', profile: 'cheap', description: 'cheap recall subagent' }],
      { command: 'chat' }
    );

    expect(initConfigMock).toHaveBeenCalledWith({ identityProfile: 'cheap' });
    expect(subagents).toHaveLength(1);
    // The load-bearing assertion: the child's model came from the named profile's resolved config.
    expect((subagents[0].model as { _id: string })._id).toBe('cheap-model');
    expect(subagents[0].name).toBe('recall');
    expect(subagents[0].description).toBe('cheap recall subagent');
    expect(subagents[0].systemPrompt).toBe('CHILD PROMPT');
  });

  it('resolves the child tools from the profile config with the filesystem disabled', async () => {
    initConfigMock.mockResolvedValue({ llm: fakeModel('cheap-model'), allowedTools: undefined });
    const resolveTools = vi.fn().mockResolvedValue([{ name: 'gth_grep' }]);

    const { buildProfileSubagents } = await import('#src/core/subagentProfiles.js');
    const subagents = await buildProfileSubagents([{ name: 'searcher', profile: 'cheap' }], {
      command: 'code',

      resolveTools: resolveTools as any,
    });

    // Child tools come from the profile's own resolver call, with fs disabled (deepagents owns fs).
    expect(resolveTools).toHaveBeenCalledWith(
      expect.objectContaining({ filesystem: 'none' }),
      'code'
    );
    expect(subagents[0].tools).toEqual([{ name: 'gth_grep' }]);
    // 'code' mode composes the code-mode prompt for the child.
    expect(readCodePromptMock).toHaveBeenCalled();
  });

  it("honours the profile's allowedTools:[] by giving the subagent no tools", async () => {
    initConfigMock.mockResolvedValue({ llm: fakeModel('cheap-model'), allowedTools: [] });
    const resolveTools = vi.fn();

    const { buildProfileSubagents } = await import('#src/core/subagentProfiles.js');
    const subagents = await buildProfileSubagents([{ name: 's', profile: 'locked' }], {
      command: 'chat',

      resolveTools: resolveTools as any,
    });

    expect(resolveTools).not.toHaveBeenCalled();
    expect(subagents[0].tools).toEqual([]);
  });

  it('defaults the description to a profile note when omitted', async () => {
    initConfigMock.mockResolvedValue({ llm: fakeModel('cheap-model') });
    const { buildProfileSubagents } = await import('#src/core/subagentProfiles.js');
    const subagents = await buildProfileSubagents([{ name: 's', profile: 'cheap' }], {
      command: 'chat',
    });
    expect(subagents[0].description).toContain('cheap');
  });

  it('resolves each subagent under its OWN profile in a multi-subagent config', async () => {
    initConfigMock.mockImplementation(async (overrides: { identityProfile?: string }) => ({
      llm: fakeModel(`${overrides.identityProfile}-model`),
    }));

    const { buildProfileSubagents } = await import('#src/core/subagentProfiles.js');
    const subagents = await buildProfileSubagents(
      [
        { name: 'a', profile: 'cheap' },
        { name: 'b', profile: 'strong' },
      ],
      { command: 'chat' }
    );

    expect((subagents[0].model as { _id: string })._id).toBe('cheap-model');
    expect((subagents[1].model as { _id: string })._id).toBe('strong-model');
  });
});
