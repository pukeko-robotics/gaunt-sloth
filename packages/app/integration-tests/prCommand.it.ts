import { describe, expect, it } from 'vitest';
import { runCommandExpectingExitCode } from './support/commandRunner.ts';
import { extractReviewScore } from './support/reviewScoreExtractor.ts';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('PR Command Integration Tests', () => {
  // Test for PR review with rejection
  it('should reject PR #1 and exit with code 1', async () => {
    // Use real PR data instead of mock files
    const { output, exitCode } = await runCommandExpectingExitCode('npx', ['gth', 'pr', '1'], 1);

    expect(exitCode).toBe(1);
    expect(output).toContain('FAIL');
    expect(output).toContain('/10');
    // Check for rejection in the response (score < 6)
    const score = extractReviewScore(output);
    expect(score).not.toBeNull();
    expect(score).toBeLessThan(6); // Below default threshold of 6
  });
});
