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

  describe('must_match / must_not_match (regex over the raw answer)', () => {
    const base = { mustContain: [], mustNotContain: [], shouldContainAny: [] };

    it('passes when every must_match pattern matches and no must_not_match does', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const result = runDeterministicChecks('ticket RPP-42 is done', {
        ...base,
        mustMatch: [/\bRPP-\d+\b/],
        mustNotMatch: [/\bERROR\b/],
      });
      expect(result).toEqual({ passed: true, failures: [] });
    });

    it('reports each must_match miss and each must_not_match hit', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const result = runDeterministicChecks('an ERROR happened', {
        ...base,
        mustMatch: [/\bRPP-\d+\b/],
        mustNotMatch: [/\bERROR\b/],
      });
      expect(result.passed).toBe(false);
      expect(result.failures).toEqual([
        'answer did not match /\\bRPP-\\d+\\b/',
        'answer matched forbidden /\\bERROR\\b/',
      ]);
    });

    it('does NOT case-fold — the pattern owns its flags (case-sensitive by default)', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const sensitive = runDeterministicChecks('the answer is error', {
        ...base,
        mustMatch: [/ERROR/],
      });
      expect(sensitive.passed).toBe(false); // lowercase "error" does not match /ERROR/
      const insensitive = runDeterministicChecks('the answer is error', {
        ...base,
        mustMatch: [/ERROR/i],
      });
      expect(insensitive.passed).toBe(true); // author opted into the i flag
    });

    it('is not confused by a stored g-flag regex (no lastIndex statefulness)', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const re = /a/g;
      // Two evaluations of the same stored RegExp must behave identically.
      const first = runDeterministicChecks('aaa', { ...base, mustMatch: [re] });
      const second = runDeterministicChecks('aaa', { ...base, mustMatch: [re] });
      expect(first).toEqual({ passed: true, failures: [] });
      expect(second).toEqual({ passed: true, failures: [] });
    });
  });

  describe('json_path (over the answer parsed as JSON)', () => {
    const base = { mustContain: [], mustNotContain: [], shouldContainAny: [] };

    it('passes an equals hit', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const answer = JSON.stringify({ items: [{ scope: 'caller' }] });
      const result = runDeterministicChecks(answer, {
        ...base,
        jsonPath: [{ path: '$.items[0].scope', equals: 'caller' }],
      });
      expect(result).toEqual({ passed: true, failures: [] });
    });

    it('fails an equals miss with the resolved and expected values', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const answer = JSON.stringify({ items: [{ scope: 'other' }] });
      const result = runDeterministicChecks(answer, {
        ...base,
        jsonPath: [{ path: '$.items[0].scope', equals: 'caller' }],
      });
      expect(result.passed).toBe(false);
      expect(result.failures).toEqual([
        'json_path "$.items[0].scope" is "other", expected "caller"',
      ]);
    });

    it('supports deep-equal against objects/arrays/null (via isDeepStrictEqual)', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const answer = JSON.stringify({ meta: { tags: [1, 2], owner: null } });
      const result = runDeterministicChecks(answer, {
        ...base,
        jsonPath: [
          { path: 'meta.tags', equals: [1, 2] },
          { path: 'meta.owner', equals: null },
        ],
      });
      expect(result).toEqual({ passed: true, failures: [] });
    });

    it('passes a contains hit and fails a contains miss', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const answer = JSON.stringify({ data: { status: 'all ok here' } });
      const hit = runDeterministicChecks(answer, {
        ...base,
        jsonPath: [{ path: 'data.status', contains: 'ok' }],
      });
      expect(hit).toEqual({ passed: true, failures: [] });
      const miss = runDeterministicChecks(answer, {
        ...base,
        jsonPath: [{ path: 'data.status', contains: 'nope' }],
      });
      expect(miss.passed).toBe(false);
      expect(miss.failures).toEqual(['json_path "data.status" does not contain "nope"']);
    });

    it('fails a contains check whose resolved value is not a string', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const answer = JSON.stringify({ data: { count: 3 } });
      const result = runDeterministicChecks(answer, {
        ...base,
        jsonPath: [{ path: 'data.count', contains: '3' }],
      });
      expect(result.passed).toBe(false);
      expect(result.failures).toEqual([
        'json_path "data.count" is 3 (contains check requires a string)',
      ]);
    });

    it('fails clearly when the path does not resolve', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const answer = JSON.stringify({ items: [] });
      const result = runDeterministicChecks(answer, {
        ...base,
        jsonPath: [{ path: '$.items[0].scope', equals: 'caller' }],
      });
      expect(result.passed).toBe(false);
      expect(result.failures).toEqual([
        'json_path "$.items[0].scope" did not resolve (no such path in answer)',
      ]);
    });

    it('fails the whole group ONCE with a graceful reason when the answer is not JSON', async () => {
      const { runDeterministicChecks } = await import('#src/deterministicChecks.js');
      const result = runDeterministicChecks('this is plainly not json', {
        ...base,
        jsonPath: [
          { path: 'a', equals: 1 },
          { path: 'b', contains: 'x' },
        ],
      });
      expect(result.passed).toBe(false);
      // A single reason, not one per entry, and no thrown error.
      expect(result.failures).toEqual([
        'answer is not JSON (json_path checks require a JSON answer)',
      ]);
    });
  });
});

describe('resolveJsonPath (minimal path accessor)', () => {
  it('resolves dot keys and [n] array indices, with or without a leading $.', async () => {
    const { resolveJsonPath } = await import('#src/deterministicChecks.js');
    const root = { items: [{ id: 10 }, { id: 20 }], data: { rows: [{ id: 'z' }] } };
    expect(resolveJsonPath(root, '$.items[1].id')).toEqual({ found: true, value: 20 });
    expect(resolveJsonPath(root, 'items[0].id')).toEqual({ found: true, value: 10 });
    expect(resolveJsonPath(root, 'data.rows[0].id')).toEqual({ found: true, value: 'z' });
  });

  it('resolves the whole document for an empty/root path', async () => {
    const { resolveJsonPath } = await import('#src/deterministicChecks.js');
    expect(resolveJsonPath({ a: 1 }, '$')).toEqual({ found: true, value: { a: 1 } });
  });

  it('resolves a value that is legitimately null (found, not missing)', async () => {
    const { resolveJsonPath } = await import('#src/deterministicChecks.js');
    expect(resolveJsonPath({ a: null }, 'a')).toEqual({ found: true, value: null });
  });

  it('reports not-found for a missing key, out-of-range index, or type mismatch', async () => {
    const { resolveJsonPath } = await import('#src/deterministicChecks.js');
    expect(resolveJsonPath({ a: 1 }, 'b')).toEqual({ found: false });
    expect(resolveJsonPath({ xs: [1] }, 'xs[5]')).toEqual({ found: false });
    expect(resolveJsonPath({ a: 1 }, 'a[0]')).toEqual({ found: false }); // index into non-array
    expect(resolveJsonPath({ xs: [1] }, 'xs.key')).toEqual({ found: false }); // key into array
  });
});
