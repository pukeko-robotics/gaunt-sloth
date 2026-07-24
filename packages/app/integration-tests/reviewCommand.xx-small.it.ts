import { describe, it, expect } from 'vitest';
import { runCommandExpectingExitCode } from './support/commandRunner.ts';
import { extractReviewScore } from './support/reviewScoreExtractor.ts';

describe('Review Command Integration Tests', () => {
  // Test for reviewing good code
  it('should provide positive review for good code and exit with code 0', async () => {
    const { output, exitCode } = await runCommandExpectingExitCode(
      'npx',
      ['gth', '-wn', 'review', 'filewithgoodcode.js'],
      0
    );

    expect(exitCode).toBe(0);
    expect(output, '-wn should disable session logging').not.toContain(
      'This report can be found in'
    );
    expect(output).toContain('PASS');
    expect(output).toContain('/10');
    // Check for positive feedback in the review (score >= 6)
    const score = extractReviewScore(output);
    expect(score).not.toBeNull();
    expect(score).toBeGreaterThanOrEqual(6); // At or above default threshold of 6
  });
});
