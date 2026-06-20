import { describe, expect, it } from 'vitest';
import { runCommandExpectingExitCode, runCommandWithArgs } from './support/commandRunner.ts';
import path from 'node:path';

const PROFILES_WORKDIR = path.resolve('./packages/app/integration-tests/workdir-with-profiles');

describe('Review Command Integration Tests', () => {
  it('should work with default profile', async () => {
    const output = await runCommandWithArgs(
      'npx',
      ['gth', 'ask', '"what is your name?"'],
      undefined,
      PROFILES_WORKDIR
    );

    expect(output).toContain('Voreinstellung');

    const favouriteFishOutput = await runCommandWithArgs(
      'npx',
      ['gth', 'ask', '"What is your favourite fish?"'],
      undefined,
      PROFILES_WORKDIR
    );

    expect(favouriteFishOutput, 'should use default profile guidelines').toContain('Snapper');
  });

  it('should work with sorcerer profile name', async () => {
    const nameOutput = await runCommandWithArgs(
      'npx',
      ['gth', '-i sorcerer', 'ask', '"what is your name?"'],
      undefined,
      PROFILES_WORKDIR
    );
    expect(nameOutput).toContain('Bomp');
  });

  it('should approve good spell with sorcerer profile', async () => {
    const spellReviewOutput = await runCommandWithArgs(
      'npx',
      ['gth', '-i sorcerer', 'review', 'good-spell.js'],
      undefined,
      PROFILES_WORKDIR
    );
    expect(spellReviewOutput.toLowerCase()).toContain('axios');
  });

  it('should reject bad spell with sorcerer profile', async () => {
    const failedSpellOutput = await runCommandExpectingExitCode(
      'npx',
      ['gth', '-i sorcerer', 'review', 'bad-spell.js'],
      1,
      PROFILES_WORKDIR
    );
    expect(failedSpellOutput.output.toLowerCase()).not.toContain('axios');
  });

  it('should work with fisher-alt profile', async () => {
    const output = await runCommandWithArgs(
      'npx',
      ['gth', '-i fisher-alt', 'ask', '"what is your name?"'],
      undefined,
      PROFILES_WORKDIR
    );

    expect(
      output,
      'Should fall back to install backstory, when profile has no backstory'
    ).toContain('Gaunt Sloth');

    const favouriteFishOutput = await runCommandWithArgs(
      'npx',
      ['gth', '-i fisher-alt', 'ask', '"What is your favourite fish?"'],
      undefined,
      PROFILES_WORKDIR
    );

    expect(favouriteFishOutput, 'should use profile guidelines').toContain('Flounder');
  });
});
