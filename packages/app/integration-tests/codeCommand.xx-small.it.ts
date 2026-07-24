import { describe, expect, it } from 'vitest';
import { runCommandWithArgs } from './support/commandRunner';
import { checkOutputForExpectedContent } from './support/outputChecker';

describe('Code Command Integration Tests', () => {
  it('should respond to initial message', async () => {
    // writeOutputToFile now defaults to false; opt in with -w true so this test
    // still exercises the session-logging path.
    const output = await runCommandWithArgs(
      'npx',
      ['gth', '-w', 'true', 'code', '"Hello, can you help me with some code?"'],
      ' >'
    );

    // Assert on the string itself (not a boolean wrapper) so a flake prints the
    // model's actual reply. The agent acknowledges and offers help; small models
    // phrase that tersely ("What do you need?"), so accept any opener.
    expect(output.toLowerCase()).toMatch(/help|assist|code|what do you need|how can i/);
    // Session is logged to gth_<timestamp>_CODE.md
    expect(output).toContain('gth_');
    expect(output).toContain('_CODE.md');
  });

  it('should start interactive session without initial message', async () => {
    const output = await runCommandWithArgs('npx', ['gth', 'code'], ' >');

    // Check for expected content in the response
    expect(checkOutputForExpectedContent(output, 'ready to code')).toBe(true);
    expect(checkOutputForExpectedContent(output, 'Type')).toBe(true);
  });
});
