import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The bundled `review` prompt is what every user without a project prompt of their own receives,
 * and this pins one instruction in it against silent loss.
 *
 * Why a content pin rather than a behavioural test: no unit spec asserts prompt text — every spec
 * touching these segments mocks the reader — so nothing else in the suite would notice this line
 * disappearing, and no live-model test can show it working either, since the failure it prevents
 * (a confidently invented dependency version) is intermittent by nature.
 *
 * Why this line specifically: users hit the failure often enough to write their own review prompts
 * carrying an equivalent instruction, which is a workaround the shipped default should make
 * unnecessary. GS2-94 re-authors all seven bundled prompts; this assertion is what makes the
 * instruction survive that rewrite by force rather than by memory.
 */
describe('bundled review prompt', () => {
  const reviewPrompt = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.gsloth.review.md'),
    'utf8'
  );

  it('tells the model not to speculate about dependency versions past its knowledge cutoff', () => {
    expect(reviewPrompt).toContain('Do not speculate about version numbers');
    expect(reviewPrompt).toContain('knowledge cut-off');
  });

  it('still carries the review invariants this file is relied on for', () => {
    // A rewrite that drops these changes what `review`/`pr` produce for every user, and
    // scripts/review-node.mjs in the takahe coordinator repo depends on the requirements check.
    expect(reviewPrompt).toContain('requirements');
    expect(reviewPrompt).toContain('✅⚠️❌');
    expect(reviewPrompt).toContain('git diff');
  });
});
