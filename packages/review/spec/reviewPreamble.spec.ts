import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

const llmUtilsMock = {
  readBackstory: vi.fn(),
  readGuidelines: vi.fn(),
  readReviewInstructions: vi.fn(),
  readSystemPrompt: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async () => {
  const actual = await vi.importActual<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>(
    '@gaunt-sloth/core/utils/llmUtils.js'
  );
  return {
    ...actual,
    ...llmUtilsMock,
  };
});

describe('getReviewPreamble', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    llmUtilsMock.readBackstory.mockReturnValue('BACKSTORY');
    llmUtilsMock.readGuidelines.mockReturnValue('GUIDELINES');
    llmUtilsMock.readReviewInstructions.mockReturnValue('REVIEW INSTRUCTIONS');
    llmUtilsMock.readSystemPrompt.mockReturnValue('');
  });

  it('composes backstory + guidelines + review instructions, not a literal mode name', async () => {
    const { getReviewPreamble } = await import('#src/commands/commandUtils.js');

    const preamble = getReviewPreamble({} as GthConfig);

    // The load-bearing assertion: the preamble is exactly the composed prompt segments.
    expect(preamble).toBe('BACKSTORY\nGUIDELINES\nREVIEW INSTRUCTIONS');
    // Regression guard for the standalone review CLI wart: it used to call
    // buildSystemMessages(config, 'pr'), injecting the literal string "pr" into the
    // system prompt instead of the review-instructions segment.
    expect(preamble).not.toContain('pr');
  });

  it('appends the project system prompt when present', async () => {
    llmUtilsMock.readSystemPrompt.mockReturnValue('SYSTEM PROMPT');

    const { getReviewPreamble } = await import('#src/commands/commandUtils.js');

    expect(getReviewPreamble({} as GthConfig)).toBe(
      'BACKSTORY\nGUIDELINES\nREVIEW INSTRUCTIONS\nSYSTEM PROMPT'
    );
  });

  it('drops empty segments instead of leaving blank lines', async () => {
    llmUtilsMock.readBackstory.mockReturnValue('');

    const { getReviewPreamble } = await import('#src/commands/commandUtils.js');

    expect(getReviewPreamble({} as GthConfig)).toBe('GUIDELINES\nREVIEW INSTRUCTIONS');
  });
});
