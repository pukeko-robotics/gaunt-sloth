import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('resolvePrIdFromArg', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads a PR id out of a bare number', async () => {
    const { resolvePrIdFromArg } = await import('#src/commands/commandUtils.js');

    expect(resolvePrIdFromArg('123')).toBe('123');
  });

  it('returns undefined when there is no argument, so branch discovery still applies', async () => {
    const { resolvePrIdFromArg } = await import('#src/commands/commandUtils.js');

    expect(resolvePrIdFromArg(undefined)).toBeUndefined();
  });

  it('treats non-numeric content as content rather than a PR id', async () => {
    const { resolvePrIdFromArg } = await import('#src/commands/commandUtils.js');

    // The same positional argument carries literal content in the non-GitHub flows.
    expect(resolvePrIdFromArg('diff --git a/x b/x')).toBeUndefined();
    expect(resolvePrIdFromArg('src/index.ts')).toBeUndefined();
    expect(resolvePrIdFromArg('')).toBeUndefined();
  });

  it('rejects anything a number is only part of, so nothing but digits reaches a command', async () => {
    const { resolvePrIdFromArg } = await import('#src/commands/commandUtils.js');

    expect(resolvePrIdFromArg('123; rm -rf /')).toBeUndefined();
    expect(resolvePrIdFromArg('#123')).toBeUndefined();
    expect(resolvePrIdFromArg(' 123')).toBeUndefined();
    expect(resolvePrIdFromArg('123\n')).toBeUndefined();
  });
});
