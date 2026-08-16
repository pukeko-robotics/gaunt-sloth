import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * REL-12 / GS2-95 — the header line `gth review` / `gth pr` open with.
 *
 * Pure: nothing is mocked, and every assertion is on the rendered text rather than on a call. The
 * format is the ruled one every command shares, so it is pinned as a literal here — if someone
 * changes the string, this is the test that says so.
 */

/** Split a rendered block into its lines, dropping the trailing blank the block ends with. */
const linesOf = (block: string): string[] => block.replace(/\n$/, '').split('\n');

describe('REL-12 review heading block', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is one line, with no markdown prefix on it', async () => {
    const { reviewHeadingBlock } = await import('#src/modules/reviewHeading.js');

    const block = reviewHeadingBlock('review', 'gemini-3.1-pro-preview', 'google-genai');
    // A review is read for its findings; anything more here pushes the first one further down.
    // The `##` a markdown heading would carry is gone in every mode: whether a sink renders
    // markdown is the SINK's property, and one run has several at once.
    expect(linesOf(block)).toHaveLength(1);
    expect(block.startsWith('#')).toBe(false);
    // Trailing newline, so the review body does not start flush against the header.
    expect(block.endsWith('\n')).toBe(true);
  });

  it('names the command and renders the shared model (provider) spelling when both resolve', async () => {
    const { reviewHeadingBlock } = await import('#src/modules/reviewHeading.js');

    expect(linesOf(reviewHeadingBlock('review', 'gemini-3.1-pro-preview', 'google-genai'))).toEqual(
      ['Gaunt Sloth · review · gemini-3.1-pro-preview (google-genai)']
    );
  });

  // The word after the product name is the command the USER typed. `pr` is a different command from
  // `review` and says so — this is the half a fixed heading constant could never carry, and the one
  // fact a reader of a review detached from its invocation cannot recover for themselves.
  it('names pr as pr, not as review', async () => {
    const { reviewHeadingBlock } = await import('#src/modules/reviewHeading.js');

    expect(linesOf(reviewHeadingBlock('pr', 'claude-sonnet-5', 'anthropic'))).toEqual([
      'Gaunt Sloth · pr · claude-sonnet-5 (anthropic)',
    ]);
  });

  it('prints the bare model when the provider does not resolve', async () => {
    const { reviewHeadingBlock } = await import('#src/modules/reviewHeading.js');

    // A module config (`.gsloth.config.js`) hands the loader an already-built BaseChatModel and
    // legitimately carries no provider string, so this case is normal rather than an error.
    for (const provider of [undefined, '', '   ']) {
      const [header] = linesOf(reviewHeadingBlock('review', 'claude-sonnet-5', provider));
      expect(header).toBe('Gaunt Sloth · review · claude-sonnet-5');
      // No placeholder and no orphaned punctuation.
      expect(header).not.toMatch(/[()]/);
      expect(header).not.toMatch(/undefined|unknown/i);
    }
  });

  it('drops the model half entirely when the model does not resolve', async () => {
    const { reviewHeadingBlock } = await import('#src/modules/reviewHeading.js');

    // Including the case where only the PROVIDER resolved: a provider name would sit exactly where
    // a model name sits and be read as one, so it is dropped rather than allowed to mislead.
    for (const [model, provider] of [
      [undefined, undefined],
      [undefined, 'google-genai'],
      ['', 'google-genai'],
      ['   ', undefined],
    ] as Array<[string | undefined, string | undefined]>) {
      const [header] = linesOf(reviewHeadingBlock('review', model, provider));
      // The line ends after the command: no trailing separator, no empty parentheses.
      expect(header).toBe('Gaunt Sloth · review');
      expect(header).not.toMatch(/[()]/);
      expect(header).not.toMatch(/undefined|unknown/i);
    }
  });

  it('renders through the shared run-header builder, so it cannot drift from the agent', async () => {
    const { reviewHeadingBlock } = await import('#src/modules/reviewHeading.js');
    const { runHeaderLine } = await import('@gaunt-sloth/core/core/runHeader.js');

    // The agent's `compact` rung emits `runHeaderLine(...)` for every other command. Comparing
    // against the builder rather than against a second literal is what makes "one settled format"
    // a property of the code instead of a coincidence between two tests.
    expect(reviewHeadingBlock('review', 'claude-sonnet-5', 'anthropic')).toBe(
      runHeaderLine('review', 'claude-sonnet-5 (anthropic)') + '\n'
    );
    expect(reviewHeadingBlock('pr')).toBe(runHeaderLine('pr') + '\n');
  });
});
