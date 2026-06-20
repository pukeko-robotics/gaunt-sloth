import { describe, expect, it } from 'vitest';
import { runCommandWithArgs } from './support/commandRunner';

describe('Aiignore Integration Tests', () => {
  it('should hide aiignore entries when listing the current directory', async () => {
    const output = await runCommandWithArgs('npx', [
      'gth',
      'ask',
      '"Use the list_directory tool on . and return the raw tool output only. ' +
        'Do not add commentary or omit entries."',
    ]);

    expect(output).toContain('aiignore-visible.txt');
    expect(output).not.toContain('aiignore-hidden.txt');
  });
});
