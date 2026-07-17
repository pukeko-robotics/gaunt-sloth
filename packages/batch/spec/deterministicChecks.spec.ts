import { describe, expect, it } from 'vitest';

describe('runDeterministicChecks', () => {
  it('passes when there are no checks at all', async () => {
    const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
    const result = runDeterministicChecks('anything goes', {
      mustContain: [],
      mustNotContain: [],
      shouldContainAny: [],
    });
    expect(result).toEqual({ passed: true, failures: [] });
  });

  describe('must_contain', () => {
    it('passes when every required substring is present (case-insensitive)', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const result = runDeterministicChecks('The Foo jumped over the BAR', {
        mustContain: ['foo', 'bar'],
        mustNotContain: [],
        shouldContainAny: [],
      });
      expect(result).toEqual({ passed: true, failures: [] });
    });

    it('fails and reports every missing substring', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const result = runDeterministicChecks('only foo here', {
        mustContain: ['foo', 'bar', 'baz'],
        mustNotContain: [],
        shouldContainAny: [],
      });
      expect(result.passed).toBe(false);
      expect(result.failures).toEqual(['missing "bar"', 'missing "baz"']);
    });
  });

  describe('must_not_contain', () => {
    it('passes when none of the forbidden substrings are present', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const result = runDeterministicChecks('a clean answer', {
        mustContain: [],
        mustNotContain: ['baz'],
        shouldContainAny: [],
      });
      expect(result).toEqual({ passed: true, failures: [] });
    });

    it('fails and reports every forbidden substring found (case-insensitive)', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const result = runDeterministicChecks('this has BAZ and qux in it', {
        mustContain: [],
        mustNotContain: ['baz', 'qux'],
        shouldContainAny: [],
      });
      expect(result.passed).toBe(false);
      expect(result.failures).toEqual(['forbidden "baz"', 'forbidden "qux"']);
    });
  });

  describe('should_contain_any', () => {
    it('passes when at least one option is present', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const result = runDeterministicChecks('contains y somewhere', {
        mustContain: [],
        mustNotContain: [],
        shouldContainAny: ['x', 'y'],
      });
      expect(result).toEqual({ passed: true, failures: [] });
    });

    it('fails with a single combined failure when none are present', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const result = runDeterministicChecks('neither option here', {
        mustContain: [],
        mustNotContain: [],
        shouldContainAny: ['x', 'y'],
      });
      expect(result.passed).toBe(false);
      expect(result.failures).toEqual(['none of [x | y]']);
    });
  });

  it('combines all three check types and reports every failure', async () => {
    const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
    const result = runDeterministicChecks('has baz but nothing else useful', {
      mustContain: ['qux'],
      mustNotContain: ['baz'],
      shouldContainAny: ['x', 'y'],
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(['missing "qux"', 'forbidden "baz"', 'none of [x | y]']);
  });

  it('combines all three check types and passes when every condition is satisfied', async () => {
    const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
    const result = runDeterministicChecks('has foo and x, no forbidden word', {
      mustContain: ['foo'],
      mustNotContain: ['baz'],
      shouldContainAny: ['x', 'y'],
    });
    expect(result).toEqual({ passed: true, failures: [] });
  });
});
