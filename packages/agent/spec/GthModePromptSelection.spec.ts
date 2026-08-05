import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';
import type { GthCommand } from '@gaunt-sloth/core/core/types.js';
import * as deepAgentPermissions from '#src/core/deepAgentPermissions.js';

/**
 * GS2-79 — WHICH mode prompt each command composes, on BOTH backends.
 *
 * `GthPromptParity.spec.ts` pins which prompt PIECES each backend carries; this pins which mode
 * prompt each COMMAND selects. The distinction is the whole defect: `review`/`pr` were absent from
 * the selection, so they fell through to the chat prompt — the default branch — and the review
 * instructions reached the model only as a caller-side leading `SystemMessage`, the second system
 * message that `@langchain/anthropic` rejects outright.
 *
 * That makes the naive fix (delete the caller's `SystemMessage`) actively worse than the bug: it
 * turns `gth review` green on Anthropic while quietly running it on the CHAT prompt, i.e. no longer
 * a review at all. This spec is what stops a future "simplification" walking back into that.
 *
 * The prompt readers are REAL here — deliberately. Every assertion compares the composed prompt
 * against `readReviewInstructions` / `readChatPrompt` / `readCodePrompt` / `readExecPrompt` output,
 * i.e. against the data it is composed FROM, never against a literal restated in this file. A test
 * that agreed with the code about a wrong literal is the failure mode this project keeps hitting;
 * there is no literal here to be wrong about.
 */

// Pinned so the deep backend's shouldUseVirtualFs() decision is the same on every platform: a
// POSIX cwd means virtualMode is off, so no deep-only note perturbs the composed prompt on Windows.
const getCurrentWorkDirMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  getCurrentWorkDir: () => getCurrentWorkDirMock(),
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

// Capture createAgent params (lean backend graph builder); keep the rest of langchain real.
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

async function leanSystemPrompt(command: GthCommand, config: GthConfig): Promise<string> {
  createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
  const { GthLangChainAgent } = await import('@gaunt-sloth/core/core/GthLangChainAgent.js');
  const agent = new GthLangChainAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
  await agent.init(command, config);
  return createAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string;
}

async function deepSystemPrompt(command: GthCommand, config: GthConfig): Promise<string> {
  createDeepAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
  const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
  const agent = new GthDeepAgent(vi.fn(), { resolveTools: vi.fn().mockResolvedValue([]) });
  await agent.init(command, config);
  return createDeepAgentMock.mock.calls.at(-1)?.[0].systemPrompt as string;
}

/** Both backends' composed system prompt for one command, in a fixed order. */
async function bothBackends(command: GthCommand, config: GthConfig): Promise<[string, string]> {
  return [await leanSystemPrompt(command, config), await deepSystemPrompt(command, config)];
}

describe('mode-prompt selection per command (GS2-79)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getCurrentWorkDirMock.mockReturnValue('/home/user/proj');
    vi.spyOn(deepAgentPermissions, 'guardFilesystemBackend').mockImplementation(
      (backend) => backend as never
    );
  });

  // The load-bearing acceptance: the REVIEW INSTRUCTIONS reach the model for `review` and `pr`, and
  // the chat prompt does not. Asserted as an equality against the composition the agent is supposed
  // to perform, so wiring the wrong reader cannot pass: with the readers real and distinct, the
  // only string that equals buildSystemMessages(config, readReviewInstructions(config)) is the one
  // built from the review instructions.
  it.each(['review', 'pr'] as const)(
    'composes the REVIEW INSTRUCTIONS (not the chat prompt) for %s, on BOTH backends',
    async (command) => {
      const llmUtils = await import('@gaunt-sloth/core/utils/llmUtils.js');
      const config = makeConfig();

      const reviewInstructions = llmUtils.readReviewInstructions(config);
      const chatPrompt = llmUtils.readChatPrompt(config);
      // Guard the guard: if the real prompt files ever became empty or identical, every assertion
      // below would pass vacuously. Fail loudly instead.
      expect(reviewInstructions.trim().length).toBeGreaterThan(0);
      expect(chatPrompt.trim().length).toBeGreaterThan(0);
      expect(reviewInstructions).not.toBe(chatPrompt);

      const expected = llmUtils.buildSystemMessages(config, reviewInstructions)[0]?.content;
      expect(typeof expected).toBe('string');

      for (const prompt of await bothBackends(command, config)) {
        expect(prompt).toBe(expected);
        expect(prompt).toContain(reviewInstructions);
        expect(prompt).not.toContain(chatPrompt);
      }
    }
  );

  // The discriminating control. Without it, "review composes the review instructions" would also
  // pass if EVERY command composed them; these are the commands that must NOT change, and they are
  // what proves the selection is per-command rather than a blanket swap.
  it('leaves the other commands on their own mode prompts, on BOTH backends', async () => {
    const llmUtils = await import('@gaunt-sloth/core/utils/llmUtils.js');
    const config = makeConfig();
    const reviewInstructions = llmUtils.readReviewInstructions(config);

    const expectations: Array<[GthCommand, string]> = [
      ['chat', llmUtils.readChatPrompt(config)],
      ['ask', llmUtils.readChatPrompt(config)],
      ['api', llmUtils.readChatPrompt(config)],
      ['code', llmUtils.readCodePrompt(config)],
      ['exec', llmUtils.readExecPrompt(config)],
    ];

    for (const [command, modePrompt] of expectations) {
      expect(modePrompt.trim().length).toBeGreaterThan(0);
      for (const prompt of await bothBackends(command, config)) {
        expect(prompt).toContain(modePrompt);
        expect(prompt).not.toContain(reviewInstructions);
      }
    }
  });

  // The selection reads the CONFIGURED review segment, not a hardcoded file: a user who retargets
  // `prompts.review` must see their own instructions in a review run. This is what makes the
  // equality above a statement about the segment rather than about one file on disk.
  it('honours a configured review prompt segment on BOTH backends', async () => {
    const llmUtils = await import('@gaunt-sloth/core/utils/llmUtils.js');
    const bundledReviewInstructions = llmUtils.readReviewInstructions(makeConfig());
    // `enabled: false` drops the segment entirely — a config-driven change to the composed prompt
    // that no hardcoded reader could produce.
    const config = makeConfig({
      prompts: { review: { enabled: false } },
    } as unknown as Partial<GthConfig>);

    expect(llmUtils.readReviewInstructions(config)).toBe('');
    for (const prompt of await bothBackends('review', config)) {
      expect(prompt).not.toContain(bundledReviewInstructions);
      expect(prompt).toBe(llmUtils.buildSystemMessages(config, '')[0]?.content);
    }
  });
});
