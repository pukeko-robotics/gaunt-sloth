import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runCommandWithArgs } from './support/commandRunner.ts';

const configContent = readFileSync(
  join(import.meta.dirname, 'workdir/.gsloth.config.json'),
  'utf-8'
);
const hasBinaryFormats = configContent.includes('binaryFormats');

describe('Binary File Integration Tests', () => {
  it.skipIf(!hasBinaryFormats)('should read the title of PDF (Hello boys and girls!)', async () => {
    const output = await runCommandWithArgs('npx', [
      'gth',
      'ask',
      '"Use the gth_read_binary tool on file.pdf; What is the text in this document?"',
    ]);

    // The image has a picture of a soccer ball,
    // any kind of ball would include the word ball.
    expect(output).toContain('Hello boys and girls!');
  });
});
