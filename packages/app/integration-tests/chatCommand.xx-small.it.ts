import { describe, expect, it } from 'vitest';
import { runCommandWithArgs, startChildProcess, waitForCursor } from './support/commandRunner';
import { checkOutputForExpectedContent } from './support/outputChecker';

describe('Chat Command Integration Tests', () => {
  it('should respond to initial message', async () => {
    // writeOutputToFile now defaults to false; opt in with -w true so this test
    // still exercises the session-logging path.
    const output = await runCommandWithArgs(
      'npx',
      ['gth', '-w', 'true', 'chat', '"Hello, can you help me?"'],
      ' >'
    );

    // Assert on the string itself (not a boolean wrapper) so a flake prints the
    // model's actual reply. The agent acknowledges and offers help, but the exact
    // wording is model-dependent: small/terse models (e.g. Mistral) skip the
    // pleasantries and answer with a bare affirmation plus a prompt for the task
    // ("Yes. State your problem or task."). Accept any affirmative, help-offering,
    // or "tell me what you need" opener rather than a fixed greeting phrase.
    expect(output.toLowerCase()).toMatch(
      /\b(yes|sure|hi|hello|hey|of course|absolutely|happy to|glad to|help|assist|how can i|what can i|what do you need|state (your|the)|tell me|let me know|go ahead|what'?s your)\b/
    );
    // Session is logged to gth_<timestamp>_CHAT.md
    expect(output).toContain('gth_');
    expect(output).toContain('_CHAT.md');
    // A plain greeting must not trigger file-mutation tools
    expect(output).not.toContain('write_file');
    expect(output).not.toContain('edit_file');
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
