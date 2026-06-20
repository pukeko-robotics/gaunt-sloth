import { describe, expect, it } from 'vitest';
import { runCommandWithArgs, startChildProcess, waitForCursor } from './support/commandRunner';
import { checkOutputForExpectedContent } from './support/outputChecker';

describe('Chat Command Integration Tests', () => {
  it('should respond to initial message', async () => {
    const output = await runCommandWithArgs(
      'npx',
      ['gth', 'chat', '"Hello, can you help me?"'],
      ' >'
    );

    // Check for expected content in the response
    expect(checkOutputForExpectedContent(output, ['help', 'assist', 'hello'])).toBe(true);
    // Check that the response mentions the file path
    expect(checkOutputForExpectedContent(output, 'gth_')).toBe(true);
    expect(checkOutputForExpectedContent(output, '_CHAT.md')).toBe(true);
    expect(checkOutputForExpectedContent(output, 'write_file')).toBe(false);
    expect(checkOutputForExpectedContent(output, 'edit_file')).toBe(false);
  });

  it('should start interactive session without initial message', async () => {
    const output = await runCommandWithArgs('npx', ['gth', 'chat'], ' >');

    // Check for expected content in the response
    expect(
      checkOutputForExpectedContent(output, 'Gaunt Sloth is ready to chat. Type your prompt.')
    ).toBe(true);

    expect(checkOutputForExpectedContent(output, 'write_file')).toBe(false);
    expect(checkOutputForExpectedContent(output, 'edit_file')).toBe(false);
  });

  it('should answer to users questions, should have memory', async () => {
    const child = startChildProcess('npx', ['gth', '--nopipe', 'chat'], 'pipe');

    child.stderr.on('data', (data) => {
      throw new Error(data.toString());
    });

    child.on('close', (code) => {
      if (code !== 0) {
        new Error(`Command failed with code ${code}`);
      }
    });

    await waitForCursor(child);
    child.stdin.write('Hi! I want to talk about JavaScript.\n');
    await waitForCursor(child);
    child.stdin.write('What was that we were talking about?\n');
    const output = await waitForCursor(child);
    expect(output.toLowerCase()).toContain('javascript');
  });

  it('--verbose should set LangChain to verbose mode in interactiveSessionModule', async () => {
    const child = startChildProcess('npx', ['gth', '--verbose', '--nopipe', 'chat'], 'pipe');

    child.stderr.on('data', (data) => {
      throw new Error(data.toString());
    });

    child.on('close', (code) => {
      if (code !== 0) {
        new Error(`Command failed with code ${code}`);
      }
    });

    await waitForCursor(child);
    child.stdin.write('ping.\n');
    const output = await waitForCursor(child);
    child.stdin.write('What was that we were talking about?\n');
    expect(output).toContain('Entering LLM run with input: {');
  });
});
