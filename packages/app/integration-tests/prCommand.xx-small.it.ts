import { describe, expect, it } from 'vitest';
import { runCommandExpectingExitCode } from './support/commandRunner.ts';
import { extractReviewScore } from './support/reviewScoreExtractor.ts';
import fs from 'fs';
import path from 'path';

const WORKDIR = path.resolve('./packages/app/integration-tests/workdir');

describe('PR Command Integration Tests', () => {
  // Test for PR review with approval
  it('should approve PR #130 with issue #133, write to a specified file path, and exit with code 0', async () => {
    // Use real PR data instead of mock files
    const { output, exitCode } = await runCommandExpectingExitCode(
      'npx',
      ['gaunt-sloth', '--write-output-to-file', 'testreview.md', 'pr', '130', '133'],
      0
    );

    expect(exitCode).toBe(0);
    // Assert that built-in file writing is enabled and advertised
    expect(output).toContain('This report can be found in');
    expect(output).toContain('PASS');
    expect(output).toContain('/10');

    // Check for approval in the response (score >= 6)
    const score = extractReviewScore(output);
    expect(score).not.toBeNull();
    expect(score).toBeGreaterThanOrEqual(6); // At or above default threshold of 6
    const testreview = fs.readFileSync(path.join(WORKDIR, 'testreview.md'), { encoding: 'utf8' });
    // REL-12 / GS2-101: the report a workflow reads back and posts carries the run header, because
    // the header is emitted after initSessionLogging and the session log captures it. Asserted on
    // the command half only — the model half is whichever provider this tier was run against. The
    // Workdir/Model preamble is NOT here: it belongs to the `debug` rung, and an unset
    // `output.header` resolves to `compact`.
    expect(testreview).toContain('Gaunt Sloth · pr ·');
    expect(testreview).toMatch(/(?:PASS|FAIL)\s+\d+\/10/);
  });
});
