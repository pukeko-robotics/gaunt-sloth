import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runCommandWithArgs } from './support/commandRunner.ts';

const configContent = readFileSync(
  join(import.meta.dirname, 'workdir/.gsloth.config.json'),
  'utf-8'
);
const hasBinaryFormats = configContent.includes('binaryFormats');

describe('Binary Image Integration Tests', () => {
  it.skipIf(!hasBinaryFormats)('should recognize the image content (ball)', async () => {
    const output = await runCommandWithArgs('npx', [
      'gth',
      'ask',
      '"Use the gth_read_binary tool on image.png. What is on the picture image.png?"',
    ]);

    // The image has a picture of a soccer ball,
    // any kind of ball would include the word ball.
    expect(output.toLowerCase()).toContain('ball');
  });

  it.skipIf(!hasBinaryFormats)('should recognize the image content (bicycle)', async () => {
    const output = await runCommandWithArgs('npx', [
      'gth',
      'ask',
      '"Use the gth_read_binary tool on image2.png. What is on the picture image2.png?"',
    ]);

    // The picture contains a road bike,
    // any variations of bicycle would either include cycle or bike.
    expect(output.toLowerCase()).to.contain.oneOf(['cycle', 'bike']);
  });
});
