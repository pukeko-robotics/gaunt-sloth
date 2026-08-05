import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';
import * as deepAgentPermissions from '#src/core/deepAgentPermissions.js';

/**
 * GS2-27 — deep/lean system-prompt PARITY guard.
 *
 * GS2-21 fixed the main composed prompt (backstory + guidelines + mode + identity) drifting
 * deep-only; GS2-27 closes the residual gap (the code-mode OS/shell + real-cwd notes). This spec
 * pins WHICH prompt pieces each backend carries so a FUTURE accidental deep-only drift fails here.
 *
 * The split it enforces (code mode):
 *   SHARED (both backends): base prompt + real-cwd/path-model note (EXT-13) + OS/shell-dialect
 *     note (EXT-26) — backend-agnostic (both expose run_shell_command and run on the real fs cwd).
 *   DEEP-ONLY: the deepagents virtual-fs-namespace guidance (appendVirtualCwdNote /
 *     PATH_NAMESPACE_GUIDANCE) — an artifact of deepagents' virtual `/` root; lean never runs
 *     virtualMode, so it must NEVER appear in the lean prompt.
 *
 * It drives BOTH real `init()` paths and inspects the systemPrompt each backend hands to its graph
 * builder (createAgent / createDeepAgent). The append notes themselves are REAL (not mocked) so the
 * assertions check actual composed content; only the on-disk prompt readers are stubbed.
 */

// getCurrentWorkDir drives GthDeepAgent.shouldUseVirtualFs() (real cwd not `/`-rooted → virtualMode)
// and feeds the real-cwd note on both backends. Partial mock so other systemUtils members stay real.
const getCurrentWorkDirMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  getCurrentWorkDir: () => getCurrentWorkDirMock(),
}));

// Deterministic base prompt: stub the on-disk prompt readers + composer so composition does not hit
// the gsloth config path. This is the SHARED core module both backends import (lean via #src/…,
// deep via @gaunt-sloth/core/… → same module identity under the workspace resolver).
const buildSystemMessagesMock = vi.fn();
const readChatPromptMock = vi.fn();
const readCodePromptMock = vi.fn();
const readExecPromptMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', () => ({
  buildSystemMessages: buildSystemMessagesMock,
  readChatPrompt: readChatPromptMock,
  readCodePrompt: readCodePromptMock,
  readExecPrompt: readExecPromptMock,
  formatToolCalls: vi.fn(() => ''),
}));

// Capture createDeepAgent params (deep backend graph builder); stub FilesystemBackend as a marker.
const createDeepAgentMock = vi.fn();
class FilesystemBackendStub {
  options: unknown;
  constructor(options: unknown) {
    this.options = options;
  }
}
vi.mock('deepagents', () => ({
  createDeepAgent: createDeepAgentMock,
  FilesystemBackend: FilesystemBackendStub,
}));

// Capture createAgent params (lean backend graph builder); keep the rest of langchain real
// (createMiddleware is used by both backends to build their middleware).
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

/** Compose the lean code-mode systemPrompt handed to createAgent, for the given cwd. */
async function leanCodeSystemPrompt(cwd: string): Promise<string> {
  getCurrentWorkDirMock.mockReturnValue(cwd);
  createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
  const { GthLangChainAgent } = await import('@gaunt-sloth/core/core/GthLangChainAgent.js');
  const agent = new GthLangChainAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
  await agent.init('code', makeConfig());
  return createAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string;
}

/** Compose the deep code-mode systemPrompt handed to createDeepAgent, for the given cwd. */
async function deepCodeSystemPrompt(cwd: string): Promise<string> {
  getCurrentWorkDirMock.mockReturnValue(cwd);
  createDeepAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
  const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
  const agent = new GthDeepAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
  await agent.init('code', makeConfig());
  return createDeepAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string;
}

describe('deep/lean system-prompt parity (GS2-27)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readChatPromptMock.mockReturnValue('chat-mode-prompt');
    readCodePromptMock.mockReturnValue('code-mode-prompt');
    readExecPromptMock.mockReturnValue('exec-mode-prompt');
    buildSystemMessagesMock.mockReturnValue([{ content: 'SYSTEM PROMPT' }]);
    // Deep wraps the FilesystemBackend via guardFilesystemBackend; make it an identity pass-through.
    vi.spyOn(deepAgentPermissions, 'guardFilesystemBackend').mockImplementation(
      (backend) => backend as never
    );
  });

  it('composes the SHARED code-mode pieces (base + real-cwd note + OS/shell note) on BOTH backends', async () => {
    const { OS_SHELL_GUIDANCE } = await import('@gaunt-sloth/core/utils/systemPromptNotes.js');
    const lean = await leanCodeSystemPrompt('/home/user/proj');
    const deep = await deepCodeSystemPrompt('/home/user/proj');

    for (const prompt of [lean, deep]) {
      // base prompt
      expect(prompt).toContain('SYSTEM PROMPT');
      // EXT-13 real-cwd / path-model note (the dynamic cwd value + real-path framing)
      expect(prompt).toContain('Working directory: /home/user/proj');
      expect(prompt).toContain('real absolute filesystem paths');
      // EXT-26 OS/shell-dialect note
      expect(prompt).toContain('Host operating system:');
      expect(prompt).toContain(OS_SHELL_GUIDANCE);
      // GS2-35 commit co-author note: default (unconfigured) identity, composed on BOTH backends.
      // No model resolves from makeConfig(), so the name is the bare default.
      expect(prompt).toContain('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
      // EXT-83 commit-message rules, likewise on BOTH backends: plain English, passed by file, and
      // the MECHANISM that makes the inline form dangerous rather than a bare prohibition.
      expect(prompt).toContain('Write the commit message in plain English');
      expect(prompt).toContain('Never pass a commit message inline with the -m option');
      expect(prompt).toContain('before git ever runs');
      expect(prompt).toContain('git commit -F');
    }
  });

  it('injects a CONFIGURED commit co-author identity on BOTH backends (GS2-35)', async () => {
    getCurrentWorkDirMock.mockReturnValue('/home/user/proj');
    const over = { commit: { coAuthor: { name: 'Acme Bot', email: 'bot@acme.test' } } };

    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    const { GthLangChainAgent } = await import('@gaunt-sloth/core/core/GthLangChainAgent.js');
    const leanAgent = new GthLangChainAgent(vi.fn(), {
      resolveTools: vi.fn().mockResolvedValue([]),
    });
    await leanAgent.init('code', makeConfig(over));
    const lean = createAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string;

    createDeepAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const deepAgent = new GthDeepAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
    await deepAgent.init('code', makeConfig(over));
    const deep = createDeepAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string;

    for (const prompt of [lean, deep]) {
      expect(prompt).toContain('Co-Authored-By: Acme Bot <bot@acme.test>');
      expect(prompt).not.toContain('code@gauntsloth.app');
    }
  });

  // EXT-84 — the commit note's tool-naming clause is gated on the effective `filesystem`, and the
  // gate must be wired on BOTH backends: each composes the note from its own call site, so a fix
  // applied to one leaves the other telling the model to call a tool that is not registered. Both
  // directions are asserted, because a gate wired on one backend passes a one-directional check.
  async function bothCodePrompts(over: Partial<GthConfig>): Promise<string[]> {
    getCurrentWorkDirMock.mockReturnValue('/home/user/proj');

    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    const { GthLangChainAgent } = await import('@gaunt-sloth/core/core/GthLangChainAgent.js');
    const leanAgent = new GthLangChainAgent(vi.fn(), {
      resolveTools: vi.fn().mockResolvedValue([]),
    });
    await leanAgent.init('code', makeConfig(over));
    const lean = createAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string;

    createDeepAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const deepAgent = new GthDeepAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
    await deepAgent.init('code', makeConfig(over));
    const deep = createDeepAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string;

    return [lean, deep];
  }

  it('names the commit-message write tool on BOTH backends when filesystem registers it', async () => {
    for (const filesystem of ['all', ['all'], ['write_file']] as GthConfig['filesystem'][]) {
      for (const prompt of await bothCodePrompts({ filesystem })) {
        expect(prompt).toContain('Write the message to a file with the write_file tool');
      }
    }
  });

  it('drops the tool name on BOTH backends when filesystem does not register it', async () => {
    // The string modes AND an array form that excludes the write tool — the array is the case a
    // two-value check would miss, and it must fail on either backend that was left unwired.
    for (const filesystem of [
      'read',
      'none',
      ['read'],
      ['read_file'],
    ] as GthConfig['filesystem'][]) {
      for (const prompt of await bothCodePrompts({ filesystem })) {
        expect(prompt).not.toContain('Write the message to a file with the write_file tool');
        // The prohibitions and the file form survive, and so does the path that remains.
        expect(prompt).toContain('Never pass a commit message inline with the -m option');
        expect(prompt).toContain('git commit -F');
        expect(prompt).toContain(
          'If nothing in this session can write that file, do not create the commit yourself'
        );
      }
    }
  });

  it('follows a command scoped filesystem override on BOTH backends', async () => {
    // `commands.code.filesystem` is merged INSIDE the agent (getEffectiveConfig), not by the
    // loader, and it is the natural way a user expresses this node's trigger. Both directions are
    // asserted, so a backend reading the raw root value instead of the merged one fails whichever
    // way the override points.
    for (const prompt of await bothCodePrompts({
      filesystem: 'all',
      commands: { code: { filesystem: 'read' } },
    } as unknown as Partial<GthConfig>)) {
      expect(prompt).not.toContain('Write the message to a file with the write_file tool');
      expect(prompt).toContain('If nothing in this session can write that file');
    }

    for (const prompt of await bothCodePrompts({
      filesystem: 'read',
      commands: { code: { filesystem: 'all' } },
    } as unknown as Partial<GthConfig>)) {
      expect(prompt).toContain('Write the message to a file with the write_file tool');
    }
  });

  it('composes the same commit note on both backends for the same filesystem value', async () => {
    // Parity as an equality, not two independent substring checks: whatever the gate decides, the
    // two backends decide it identically, so one of them cannot silently keep the old text.
    for (const filesystem of ['all', 'read', ['read_file']] as GthConfig['filesystem'][]) {
      const [lean, deep] = await bothCodePrompts({ filesystem });
      const commitNoteOf = (p: string) => p.slice(p.indexOf('When you create a git commit'));
      expect(commitNoteOf(lean)).toBe(commitNoteOf(deep));
    }
  });

  it('keeps the deepagents virtual-fs-namespace note DEEP-ONLY (never leaks to lean)', async () => {
    // PATH_NAMESPACE_GUIDANCE is exported from GthDeepAgent; appendVirtualCwdNote injects it into
    // the deep code prompt in virtualMode. It is the one deep-only piece — enumerate it explicitly.
    const { PATH_NAMESPACE_GUIDANCE } = await import('#src/core/GthDeepAgent.js');
    const DEEP_ONLY_PIECES = [PATH_NAMESPACE_GUIDANCE];

    // Deep in virtualMode (non-POSIX cwd) carries the virtual-fs-namespace note.
    const deepVirtual = await deepCodeSystemPrompt('D:\\work\\proj');
    expect(deepVirtual).toContain(PATH_NAMESPACE_GUIDANCE);

    // Lean has NO virtualMode concept (always real-fs). Even with the same non-POSIX cwd it must
    // never carry any deep-only piece.
    const leanNonPosix = await leanCodeSystemPrompt('D:\\work\\proj');
    const leanPosix = await leanCodeSystemPrompt('/home/user/proj');
    for (const piece of DEEP_ONLY_PIECES) {
      expect(leanNonPosix).not.toContain(piece);
      expect(leanPosix).not.toContain(piece);
    }
  });

  // GS2-34 — the resolved provider:model identity reaches BOTH backends, in ALL modes, by default,
  // and is fully removed under the `injectModelContext: false` opt-out.
  type Mode = 'code' | 'chat' | 'exec';
  async function leanPrompt(mode: Mode, over: Partial<GthConfig>): Promise<string | undefined> {
    getCurrentWorkDirMock.mockReturnValue('/home/user/proj');
    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    const { GthLangChainAgent } = await import('@gaunt-sloth/core/core/GthLangChainAgent.js');
    const agent = new GthLangChainAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(mode, makeConfig(over));
    return createAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string | undefined;
  }
  async function deepPrompt(mode: Mode, over: Partial<GthConfig>): Promise<string | undefined> {
    getCurrentWorkDirMock.mockReturnValue('/home/user/proj');
    createDeepAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(mode, makeConfig(over));
    return createDeepAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string | undefined;
  }
  // A config whose live model resolves an identity: provider from _llmType(), model from
  // modelDisplayName → `anthropic:claude-sonnet-5`.
  const IDENTITY_OVER = {
    llm: { _llmType: () => 'anthropic', bindTools: () => ({}) },
    modelDisplayName: 'claude-sonnet-5',
  } as unknown as Partial<GthConfig>;

  it('injects the resolved provider:model identity on BOTH backends by default (GS2-34)', async () => {
    // injectModelContext is UNSET here → the read-site default (inject-on) applies. This is the
    // behavioral proof that the default resolves to inject-on.
    const lean = await leanPrompt('code', IDENTITY_OVER);
    const deep = await deepPrompt('code', IDENTITY_OVER);
    for (const prompt of [lean, deep]) {
      expect(prompt).toContain('`anthropic:claude-sonnet-5`');
      expect(prompt).toContain('which model you are');
    }
  });

  it('injects the identity in NON-code modes too (all-modes, not code-gated) on BOTH backends (GS2-34)', async () => {
    // The mode-gate decision: unlike the code-only cwd/os-shell/commit notes, the identity is present
    // in chat/exec as well — "what model are you?" is answerable in any session.
    for (const mode of ['chat', 'exec'] as const) {
      expect(await leanPrompt(mode, IDENTITY_OVER)).toContain('`anthropic:claude-sonnet-5`');
      expect(await deepPrompt(mode, IDENTITY_OVER)).toContain('`anthropic:claude-sonnet-5`');
    }
  });

  it('removes the identity line entirely under injectModelContext:false on BOTH backends (GS2-34)', async () => {
    const over = { ...IDENTITY_OVER, injectModelContext: false } as unknown as Partial<GthConfig>;
    const lean = await leanPrompt('code', over);
    const deep = await deepPrompt('code', over);
    for (const prompt of [lean, deep]) {
      expect(prompt).not.toContain('claude-sonnet-5');
      expect(prompt).not.toContain('The model currently serving this session');
      // EXT-83 — the opt-out covers the COMMIT TRAILER too: it means "keep my model identity out of
      // the prompt", and the trailer is prompt text. The trailer degrades to the plain default name
      // (the same path an unresolvable model takes), never to a partial or a placeholder.
      expect(prompt).toContain('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
      expect(prompt).not.toContain('Gaunt Sloth (');
      // Opt-out is additive-only: the rest of the composed code-mode prompt is intact.
      expect(prompt).toContain('SYSTEM PROMPT');
    }
  });

  // EXT-83 — the trailer names the REAL model (the identity is SUPPLIED, rather than a list of
  // model names being forbidden), on BOTH backends; and the commit guidance is appended EXACTLY
  // ONCE in the fully composed prompt, i.e. with the model-context note applying as well.
  it('names the resolved model in the commit trailer, exactly once, on BOTH backends (EXT-83)', async () => {
    const lean = await leanPrompt('code', IDENTITY_OVER);
    const deep = await deepPrompt('code', IDENTITY_OVER);
    for (const prompt of [lean, deep]) {
      expect(prompt).toContain(
        'Co-Authored-By: Gaunt Sloth (anthropic:claude-sonnet-5) <code@gauntsloth.app>'
      );
      // Counted, not merely present. The sentinels each occur ONCE inside the note — unlike
      // `Co-Authored-By:`, which the note itself names twice (the trailer line and the
      // at-most-one-trailer rule), so it could never distinguish one note from two.
      expect(prompt?.match(/When you create a git commit/g)).toHaveLength(1);
      expect(prompt?.match(/before git ever runs/g)).toHaveLength(1);
    }
  });
});
