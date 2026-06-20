import { describe, expect, it } from 'vitest';
import { runCommandWithArgs } from './support/commandRunner';
import { checkOutputForExpectedContent } from './support/outputChecker';

describe('Ask Command Integration Tests', () => {
  // Test for the ask command
  it('should respond correctly to basic programming question', async () => {
    const output = await runCommandWithArgs('npx', [
      'gth',
      'ask',
      '"Which programming language does JS stand for?"',
    ]);

    // Check for expected content in the response
    expect(checkOutputForExpectedContent(output, 'JavaScript')).toBe(true);
  });

  it('should use file read tool', async () => {
    const output = await runCommandWithArgs('npx', [
      'gth',
      'ask',
      '"read file filewithgoodcode.js"',
    ]);

    // Check for expected content in the response
    expect(checkOutputForExpectedContent(output, 'prime')).toBe(true);
  });

  it('should use multiple tools', async () => {
    const output = await runCommandWithArgs('npx', [
      'gth',
      'ask',
      '"list current dir and present list of files; read file filewithgoodcode.js"',
    ]);

    // Check for expected content in the response
    expect(checkOutputForExpectedContent(output, 'file.pdf')).toBe(true);
    expect(checkOutputForExpectedContent(output, 'prime')).toBe(true);
  });

  it('--verbose should set LangChain to verbose mode in llmUtils invoke', async () => {
    const output = await runCommandWithArgs('npx', ['gth', '--verbose', 'ask', '"ping"']);

    // Check for expected content in the response
    expect(checkOutputForExpectedContent(output, 'Entering LLM run with input: {')).toBe(true);
  });
});
