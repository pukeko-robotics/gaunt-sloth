import { describe, it, expect } from 'vitest';
import { runCommandExpectingExitCode } from './support/commandRunner.ts';
import { extractReviewScore } from './support/reviewScoreExtractor.ts';

describe('Review Command Integration Tests', () => {
  // Test for reviewing bad code
  it('should identify issues in bad code and exit with code 1', async () => {
    const { output, exitCode } = await runCommandExpectingExitCode(
      'npx',
      ['gth', 'review', 'filewithbadcode.js'],
      1
    );

    expect(exitCode).toBe(1);
    expect(output).toContain('FAIL');
    expect(output).toContain('/10');
    expect(output).toContain('REVIEW RATING');
    // Check for issue identification in the review (score < 5)
    const score = extractReviewScore(output);
    expect(score).not.toBeNull();
    expect(score).toBeLessThan(6); // Below default threshold of 6
  });
});
