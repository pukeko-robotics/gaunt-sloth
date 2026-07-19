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
      // GS2-35 commit co-author note: default (unconfigured) identity + the model-name prohibition,
      // composed on BOTH backends.
      expect(prompt).toContain('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
      expect(prompt).toContain('NEVER attribute the co-author to the underlying model');
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
      // Opt-out is additive-only: the rest of the composed code-mode prompt is intact.
      expect(prompt).toContain('SYSTEM PROMPT');
    }
  });
});
