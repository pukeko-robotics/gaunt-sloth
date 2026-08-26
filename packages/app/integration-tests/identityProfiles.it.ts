import { describe, expect, it } from 'vitest';
import { runGthExpectingExitCode, runGth } from './support/commandRunner.ts';
import path from 'node:path';

const PROFILES_WORKDIR = path.resolve('./packages/app/integration-tests/workdir-with-profiles');

describe('Review Command Integration Tests', () => {
  it('should work with default profile', async () => {
    const output = await runGth(['ask', '"what is your name?"'], undefined, PROFILES_WORKDIR);

    expect(output).toContain('Voreinstellung');

    const favouriteFishOutput = await runGth(
      ['ask', '"What is your favourite fish?"'],
      undefined,
      PROFILES_WORKDIR
    );

    expect(favouriteFishOutput, 'should use default profile guidelines').toContain('Snapper');
  });

  it('should work with sorcerer profile name', async () => {
    const nameOutput = await runGth(
      ['-i sorcerer', 'ask', '"what is your name?"'],
      undefined,
      PROFILES_WORKDIR
    );
    expect(nameOutput).toContain('Bomp');
  });

  it('should approve good spell with sorcerer profile', async () => {
    const spellReviewOutput = await runGth(
      ['-i sorcerer', 'review', 'good-spell.js'],
      undefined,
      PROFILES_WORKDIR
    );
    expect(spellReviewOutput.toLowerCase()).toContain('axios');
  });

  it('should reject bad spell with sorcerer profile', async () => {
    const failedSpellOutput = await runGthExpectingExitCode(
      ['-i sorcerer', 'review', 'bad-spell.js'],
      1,
      PROFILES_WORKDIR
    );
    // Rejection is proven deterministically by the exit code 1 the wrapper already
    // enforces (it only resolves when the process exits 1). Assert the review's own
    // FAIL verdict marker (emitted by reviewModule's displayError → stdout) rather
    // than the absence of the word "axios": a correct rejection can legitimately
    // mention "axios" while declining to award it, so the old word-absence check
    // was fragile to model phrasing. FAIL is product-emitted and phrasing-independent.
    expect(failedSpellOutput.output).toContain('FAIL');
  });

  it('should work with fisher-alt profile', async () => {
    const output = await runGth(
      ['-i fisher-alt', 'ask', '"what is your name?"'],
      undefined,
      PROFILES_WORKDIR
    );

    expect(
      output,
      'Should fall back to install backstory, when profile has no backstory'
    ).toContain('Gaunt Sloth');

    const favouriteFishOutput = await runGth(
      ['-i fisher-alt', 'ask', '"What is your favourite fish?"'],
      undefined,
      PROFILES_WORKDIR
    );

    expect(favouriteFishOutput, 'should use profile guidelines').toContain('Flounder');
  });
});
