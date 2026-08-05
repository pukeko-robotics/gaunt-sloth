import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GS2-79 — `readModePrompt`: the single per-command mode-prompt selection both agent backends and
 * the subagent profiles delegate to.
 *
 * It replaced an inline three-branch ternary that had been copied to each of those call sites. The
 * shape of that ternary is why the defect was silent: an unlisted command falls into the DEFAULT
 * branch and is served the chat prompt, so `review`/`pr` composed a chat prompt while the review
 * instructions were smuggled in as a caller-side leading SystemMessage — the second system message
 * Anthropic rejects.
 *
 * Each segment is stubbed to a marker derived from its own FILE NAME, so every assertion below
 * names the segment file the command must resolve to rather than a literal restated here.
 */

const fileUtilsMock = {
  getGslothConfigReadPath: vi.fn(),
  readFileFromInstallDir: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

const fsMock = { existsSync: vi.fn(), readFileSync: vi.fn() };
vi.mock('node:fs', () => fsMock);

describe('readModePrompt (GS2-79)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // No project-level prompt files: every segment falls through to its bundled default, which is
    // stubbed to a marker carrying the file name the segment is defined by.
    fsMock.existsSync.mockReturnValue(false);
    fileUtilsMock.getGslothConfigReadPath.mockImplementation((filename: string) => filename);
    fileUtilsMock.readFileFromInstallDir.mockImplementation(
      (filename: string) => `SEGMENT<${filename}>`
    );
  });

  // The mapping, stated against the constants the segments are defined by. `review` and `pr` are
  // the rows this node adds; the rest are the rows it must not disturb.
  it.each([
    ['review', 'PROJECT_REVIEW_INSTRUCTIONS'],
    ['pr', 'PROJECT_REVIEW_INSTRUCTIONS'],
    ['code', 'GSLOTH_CODE_PROMPT'],
    ['exec', 'GSLOTH_EXEC_PROMPT'],
    ['chat', 'GSLOTH_CHAT_PROMPT'],
    ['ask', 'GSLOTH_CHAT_PROMPT'],
    ['api', 'GSLOTH_CHAT_PROMPT'],
  ] as const)('resolves %s to the %s segment', async (command, constantName) => {
    const constants = await import('#src/constants.js');
    const { readModePrompt } = await import('#src/utils/llmUtils.js');

    const expectedFile = constants[constantName];
    expect(readModePrompt(command, {})).toBe(`SEGMENT<${expectedFile}>`);
  });

  it('falls back to the chat segment for an unknown/absent command', async () => {
    const { GSLOTH_CHAT_PROMPT } = await import('#src/constants.js');
    const { readModePrompt } = await import('#src/utils/llmUtils.js');

    expect(readModePrompt(undefined, {})).toBe(`SEGMENT<${GSLOTH_CHAT_PROMPT}>`);
  });

  it('honours the review segment configuration rather than hardcoding the file', async () => {
    const { readModePrompt } = await import('#src/utils/llmUtils.js');

    // Retargeted: the configured path is read, not the default review file.
    expect(readModePrompt('review', { prompts: { review: { path: 'custom-review.md' } } })).toBe(
      'SEGMENT<custom-review.md>'
    );
    // Disabled: the segment drops out entirely, even its bundled default.
    expect(readModePrompt('pr', { prompts: { review: { enabled: false } } })).toBe('');
  });
});
