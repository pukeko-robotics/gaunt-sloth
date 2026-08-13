import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

/**
 * GS2-27 — what the agent's composed code-mode system prompt actually carries.
 *
 * GS2-21 fixed the main composed prompt (backstory + guidelines + mode + identity) being assembled
 * in one backend and therefore missing from another; GS2-27 closed the residual gap (the code-mode
 * OS/shell + real-cwd notes) by moving both into core's `systemPromptNotes`. This spec pins the
 * pieces that composition must produce, so a piece silently dropped — or moved back into a call
 * site where the next backend would not inherit it — fails here.
 *
 * It drives the real `init()` path and inspects the systemPrompt handed to the graph builder
 * (`createAgent`). The append notes themselves are REAL (not mocked), so the assertions check
 * actual composed content; only the on-disk prompt readers are stubbed.
 */

// getCurrentWorkDir feeds the real-cwd note. Partial mock so other systemUtils members stay real.
const getCurrentWorkDirMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  getCurrentWorkDir: () => getCurrentWorkDirMock(),
}));

// Deterministic base prompt: stub the on-disk prompt readers + composer so composition does not hit
// the gsloth config path.
const buildSystemMessagesMock = vi.fn();
const readModePromptMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', () => ({
  buildSystemMessages: buildSystemMessagesMock,
  readModePrompt: readModePromptMock,
  formatToolCalls: vi.fn(() => ''),
}));

// Capture createAgent params (the graph builder); keep the rest of langchain real (createMiddleware
// is used to build the middleware stack).
const createAgentMock = vi.fn();
vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return { ...actual, createAgent: createAgentMock };
});

function makeConfig(over: Partial<GthConfig> = {}): GthConfig {
  return {
    llm: { bindTools: () => ({}) } as unknown as GthConfig['llm'],
    filesystem: 'all',
    streamOutput: true,
    ...over,
  } as GthConfig;
}

/** Compose the code-mode systemPrompt handed to createAgent, for the given cwd. */
async function codeSystemPrompt(cwd: string, over: Partial<GthConfig> = {}): Promise<string> {
  getCurrentWorkDirMock.mockReturnValue(cwd);
  createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
  const { GthLangChainAgent } = await import('@gaunt-sloth/core/core/GthLangChainAgent.js');
  const agent = new GthLangChainAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
  await agent.init('code', makeConfig(over));
  return createAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string;
}

describe('composed system prompt (GS2-27)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readModePromptMock.mockImplementation((command: string) => `${command}-mode-prompt`);
    buildSystemMessagesMock.mockReturnValue([{ content: 'SYSTEM PROMPT' }]);
  });

  it('composes the code-mode pieces (base + real-cwd note + OS/shell note)', async () => {
    const { OS_SHELL_GUIDANCE } = await import('@gaunt-sloth/core/utils/systemPromptNotes.js');
    const prompt = await codeSystemPrompt('/home/user/proj');

    // base prompt
    expect(prompt).toContain('SYSTEM PROMPT');
    // EXT-13 real-cwd / path-model note (the dynamic cwd value + real-path framing)
    expect(prompt).toContain('Working directory: /home/user/proj');
    expect(prompt).toContain('real absolute filesystem paths');
    // EXT-26 OS/shell-dialect note
    expect(prompt).toContain('Host operating system:');
    expect(prompt).toContain(OS_SHELL_GUIDANCE);
    // GS2-35 commit co-author note: default (unconfigured) identity. No model resolves from
    // makeConfig(), so the name is the bare default.
    expect(prompt).toContain('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
    // EXT-83 commit-message rules: plain English, passed by file, and the MECHANISM that makes the
    // inline form dangerous rather than a bare prohibition.
    expect(prompt).toContain('Write the commit message in plain English');
    expect(prompt).toContain('Never pass a commit message inline with the -m option');
    expect(prompt).toContain('before git ever runs');
    expect(prompt).toContain('git commit -F');
    // EXT-97 staging rule: the message file is left untracked by the rule above, so an unscoped add
    // sweeps it into the commit. Mechanism, not bare prohibition.
    expect(prompt).toContain('Stage the files you changed by naming their paths');
    expect(prompt).toContain('Do not stage with git add -A, git add . or git commit -a');
    expect(prompt).toContain('Never stage the commit message file itself.');
    expect(prompt).toContain('If this session has given you a scratchpad location');
  });

  // GS2-79 — mode-prompt SELECTION. The agent used to carry an inline three-branch ternary, so a
  // command missing from it silently got the default (chat) branch instead of failing; that is how
  // `review`/`pr` came to compose the chat prompt. The property is therefore not "it produces the
  // right string" but "it delegates the decision to the shared reader, passing its own command" — a
  // reintroduced local ternary stops calling it and fails here. WHICH prompt each command then
  // resolves to is pinned, with the real readers, in GthModePromptSelection.spec.ts.
  it('delegates mode-prompt selection to the SHARED reader, per command (GS2-79)', async () => {
    getCurrentWorkDirMock.mockReturnValue('/home/user/proj');

    for (const command of ['code', 'exec', 'chat', 'review', 'pr'] as const) {
      readModePromptMock.mockClear();
      createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
      const { GthLangChainAgent } = await import('@gaunt-sloth/core/core/GthLangChainAgent.js');
      const agent = new GthLangChainAgent(vi.fn(), {
        resolveTools: vi.fn().mockResolvedValue([]),
      });
      await agent.init(command, makeConfig());

      // The shared reader is consulted exactly once, with the command the agent was initialised
      // for — so selection cannot be running off anything other than that command.
      expect(readModePromptMock.mock.calls.map(([cmd]) => cmd)).toEqual([command]);
    }
  });

  it('injects a CONFIGURED commit co-author identity (GS2-35)', async () => {
    const prompt = await codeSystemPrompt('/home/user/proj', {
      commit: { coAuthor: { name: 'Acme Bot', email: 'bot@acme.test' } },
    } as unknown as Partial<GthConfig>);

    expect(prompt).toContain('Co-Authored-By: Acme Bot <bot@acme.test>');
    expect(prompt).not.toContain('code@gauntsloth.app');
  });

  // EXT-84 — the commit note's tool-naming clause is gated on the EFFECTIVE `filesystem`. Both
  // directions are asserted, because a gate that never fires passes a one-directional check.
  it('names the commit-message write tool when filesystem registers it', async () => {
    for (const filesystem of ['all', ['all'], ['write_file']] as GthConfig['filesystem'][]) {
      const prompt = await codeSystemPrompt('/home/user/proj', { filesystem });
      expect(prompt).toContain('Write the message to a file with the write_file tool');
    }
  });

  it('drops the tool name when filesystem does not register it', async () => {
    // The string modes AND an array form that excludes the write tool — the array is the case a
    // two-value check would miss.
    for (const filesystem of [
      'read',
      'none',
      ['read'],
      ['read_file'],
    ] as GthConfig['filesystem'][]) {
      const prompt = await codeSystemPrompt('/home/user/proj', { filesystem });
      expect(prompt).not.toContain('Write the message to a file with the write_file tool');
      // The prohibitions and the file form survive, and so does the path that remains.
      expect(prompt).toContain('Never pass a commit message inline with the -m option');
      expect(prompt).toContain('git commit -F');
      expect(prompt).toContain(
        'If nothing in this session can write that file, do not create the commit yourself'
      );
      // EXT-97 — the staging rule is UNIVERSAL, composed outside the tool-naming ternary, so it
      // survives on the branch that names no tool. Relocating it into the registered branch fails
      // here.
      expect(prompt).toContain('Stage the files you changed by naming their paths');
      expect(prompt).toContain('Do not stage with git add -A, git add . or git commit -a');
    }
  });

  it('follows a command scoped filesystem override', async () => {
    // `commands.code.filesystem` is merged INSIDE the agent (getEffectiveConfig), not by the
    // loader, and it is the natural way a user expresses this. Both directions are asserted, so an
    // agent reading the raw root value instead of the merged one fails whichever way it points.
    const narrowed = await codeSystemPrompt('/home/user/proj', {
      filesystem: 'all',
      commands: { code: { filesystem: 'read' } },
    } as unknown as Partial<GthConfig>);
    expect(narrowed).not.toContain('Write the message to a file with the write_file tool');
    expect(narrowed).toContain('If nothing in this session can write that file');

    const widened = await codeSystemPrompt('/home/user/proj', {
      filesystem: 'read',
      commands: { code: { filesystem: 'all' } },
    } as unknown as Partial<GthConfig>);
    expect(widened).toContain('Write the message to a file with the write_file tool');
  });

  /**
   * EXT-114 — the two-path-namespace guidance left with the backend that needed it. It told the
   * model that the filesystem tools are rooted at a virtual `/` while the shell uses real native
   * paths, and that a path from one must never be passed to the other. Nothing splits the
   * namespaces any more, so that text now describes a filesystem the model does not have — the
   * worst kind of prompt text, because it is confidently wrong rather than merely absent, and it
   * would talk a model out of the absolute paths that are in fact correct.
   *
   * Swept over a non-POSIX cwd as well as a POSIX one, because the cwd shape is exactly what used
   * to select the virtual mode this guidance came with.
   */
  it('never tells the model the filesystem tools use a different path namespace', async () => {
    for (const cwd of ['/home/user/proj', 'D:\\work\\proj']) {
      const prompt = await codeSystemPrompt(cwd);
      expect(prompt).not.toContain('use a VIRTUAL root');
      expect(prompt).not.toContain('NOT a valid shell path');
      expect(prompt).not.toContain('path namespaces');
      // The positive half: whatever the cwd looks like, one real-path framing is what it carries,
      // so the absence above is not simply an empty prompt.
      expect(prompt).toContain('real absolute filesystem paths');
      expect(prompt).toContain('there is no virtual root');
    }
  });

  // GS2-34 — the resolved provider:model identity reaches the prompt, in ALL modes, by default, and
  // is fully removed under the `injectModelContext: false` opt-out.
  type Mode = 'code' | 'chat' | 'exec';
  async function promptFor(mode: Mode, over: Partial<GthConfig>): Promise<string | undefined> {
    getCurrentWorkDirMock.mockReturnValue('/home/user/proj');
    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    const { GthLangChainAgent } = await import('@gaunt-sloth/core/core/GthLangChainAgent.js');
    const agent = new GthLangChainAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(mode, makeConfig(over));
    return createAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string | undefined;
  }
  // A config whose live model resolves an identity: provider from _llmType(), model from
  // modelDisplayName → `anthropic:claude-sonnet-5`.
  const IDENTITY_OVER = {
    llm: { _llmType: () => 'anthropic', bindTools: () => ({}) },
    modelDisplayName: 'claude-sonnet-5',
  } as unknown as Partial<GthConfig>;

  it('injects the resolved provider:model identity by default (GS2-34)', async () => {
    // injectModelContext is UNSET here → the read-site default (inject-on) applies. This is the
    // behavioral proof that the default resolves to inject-on.
    const prompt = await promptFor('code', IDENTITY_OVER);
    expect(prompt).toContain('`anthropic:claude-sonnet-5`');
    expect(prompt).toContain('which model you are');
  });

  it('injects the identity in NON-code modes too (all-modes, not code-gated) (GS2-34)', async () => {
    // The mode-gate decision: unlike the code-only cwd/os-shell/commit notes, the identity is
    // present in chat/exec as well — "what model are you?" is answerable in any session.
    for (const mode of ['chat', 'exec'] as const) {
      expect(await promptFor(mode, IDENTITY_OVER)).toContain('`anthropic:claude-sonnet-5`');
    }
  });

  it('removes the identity line entirely under injectModelContext:false (GS2-34)', async () => {
    const over = { ...IDENTITY_OVER, injectModelContext: false } as unknown as Partial<GthConfig>;
    const prompt = await promptFor('code', over);

    expect(prompt).not.toContain('claude-sonnet-5');
    expect(prompt).not.toContain('The model currently serving this session');
    // EXT-83 — the opt-out covers the COMMIT TRAILER too: it means "keep my model identity out of
    // the prompt", and the trailer is prompt text. The trailer degrades to the plain default name
    // (the same path an unresolvable model takes), never to a partial or a placeholder.
    expect(prompt).toContain('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
    expect(prompt).not.toContain('Gaunt Sloth (');
    // Opt-out is additive-only: the rest of the composed code-mode prompt is intact.
    expect(prompt).toContain('SYSTEM PROMPT');
  });

  // EXT-83 — the trailer names the REAL model (the identity is SUPPLIED, rather than a list of
  // model names being forbidden); and the commit guidance is appended EXACTLY ONCE in the fully
  // composed prompt, i.e. with the model-context note applying as well.
  it('names the resolved model in the commit trailer, exactly once (EXT-83)', async () => {
    const prompt = await promptFor('code', IDENTITY_OVER);

    expect(prompt).toContain(
      'Co-Authored-By: Gaunt Sloth (anthropic:claude-sonnet-5) <code@gauntsloth.app>'
    );
    // Counted, not merely present. The sentinels each occur ONCE inside the note — unlike
    // `Co-Authored-By:`, which the note itself names twice (the trailer line and the
    // at-most-one-trailer rule), so it could never distinguish one note from two.
    expect(prompt?.match(/When you create a git commit/g)).toHaveLength(1);
    expect(prompt?.match(/before git ever runs/g)).toHaveLength(1);
  });
});
