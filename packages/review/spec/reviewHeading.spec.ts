import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * REL-12 — the heading block `gth review` / `gth pr` open with.
 *
 * Pure: nothing is mocked, and every assertion is on the rendered text rather than on a call. The
 * heading is a CONSTANT a reader is meant to recognise across runs and repos, so it is pinned as a
 * literal here — if someone changes the string, this is the test that says so.
 */

/** The exact heading, written out rather than imported, so the test can disagree with the module. */
const HEADING = '## Gaunt Sloth: Code Review';

/** Split a rendered block into its lines, dropping the trailing blank the block ends with. */
const linesOf = (block: string): string[] => block.replace(/\n$/, '').split('\n');

/** The attribution line of a rendered block (heading, blank line, attribution). */
const attributionOf = (block: string): string => linesOf(block)[2];

describe('REL-12 review heading block', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('pins the heading text and the shape of the block', async () => {
    const { REVIEW_HEADING, reviewHeadingBlock } = await import('#src/modules/reviewHeading.js');

    expect(REVIEW_HEADING).toBe(HEADING);

    const block = reviewHeadingBlock('gemini-3.1-pro-preview', 'google-genai');
    const lines = linesOf(block);
    // A heading, a blank line, one attribution line — and nothing else. A review is read for its
    // findings; anything more here pushes the first one further down.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(HEADING);
    expect(lines[1]).toBe('');
    // Trailing newline, so the review body does not start flush against the attribution.
    expect(block.endsWith('\n')).toBe(true);
  });

  it('renders the mode and the shared model (provider) spelling when both resolve', async () => {
    const { reviewHeadingBlock } = await import('#src/modules/reviewHeading.js');

    expect(attributionOf(reviewHeadingBlock('gemini-3.1-pro-preview', 'google-genai'))).toBe(
      'stateless review · gemini-3.1-pro-preview (google-genai)'
    );
  });

  it('prints the bare model when the provider does not resolve', async () => {
    const { reviewHeadingBlock } = await import('#src/modules/reviewHeading.js');

    // A module config (`.gsloth.config.js`) hands the loader an already-built BaseChatModel and
    // legitimately carries no provider string, so this case is normal rather than an error.
    for (const provider of [undefined, '', '   ']) {
      const attribution = attributionOf(reviewHeadingBlock('claude-sonnet-5', provider));
      expect(attribution).toBe('stateless review · claude-sonnet-5');
      // No placeholder and no orphaned punctuation.
      expect(attribution).not.toMatch(/[()]/);
      expect(attribution).not.toMatch(/undefined|unknown/i);
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
      const block = reviewHeadingBlock(model, provider);
      const attribution = attributionOf(block);
      expect(attribution).toBe('stateless review');
      expect(attribution).not.toMatch(/[()·]/);
      expect(attribution).not.toMatch(/undefined|unknown/i);
      // The heading itself is unconditional — it is the part that must never vary.
      expect(linesOf(block)[0]).toBe(HEADING);
    }
  });

  it('keeps the mode out of the heading, so the constant stays constant', async () => {
    const { REVIEW_HEADING, REVIEW_MODE_LABEL } = await import('#src/modules/reviewHeading.js');

    // A second review mode must be able to land by changing the attribution line alone. If the mode
    // (or the model, or a version) ever reaches the heading, the string readers recognise starts
    // varying per run — and every future mode inherits an obligation to remember to edit it.
    expect(REVIEW_HEADING).not.toContain(REVIEW_MODE_LABEL);
    expect(REVIEW_HEADING).not.toMatch(/\d/);
  });
});
