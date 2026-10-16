import { describe, expect, it } from 'vitest';
import type { ToolCallRecord } from '#src/types.js';

describe('runToolCallChecks', () => {
  it('passes when every must_call pattern matched and no must_not_call pattern did', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['mcp__unimarket__search', 'thinking'], {
      mustCall: ['mcp__*'],
      mustNotCall: ['read_file', 'gth_grep'],
    });
    expect(failures).toEqual([]);
  });

  it('fails a must_call pattern that no called tool matches', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['read_file'], {
      mustCall: ['mcp__*'],
      mustNotCall: [],
    });
    expect(failures).toEqual(['did not call "mcp__*"']);
  });

  it('fails each forbidden tool that was called, naming the tool and the matched pattern', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['read_file', 'gth_grep', 'thinking'], {
      mustCall: [],
      mustNotCall: ['read_file', 'gth_grep'],
    });
    expect(failures).toEqual([
      'called forbidden tool "read_file" (matched "read_file")',
      'called forbidden tool "gth_grep" (matched "gth_grep")',
    ]);
  });

  it('matches must_not_call by glob too', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['mcp__unimarket__buy'], {
      mustCall: [],
      mustNotCall: ['mcp__*'],
    });
    expect(failures).toEqual(['called forbidden tool "mcp__unimarket__buy" (matched "mcp__*")']);
  });

  it('combines a must_call miss and a must_not_call hit (the acceptance shape)', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    // tools === ['read_file'] must FAIL both: it never called mcp, and it called a forbidden tool.
    const failures = runToolCallChecks(['read_file'], {
      mustCall: ['mcp__*'],
      mustNotCall: ['read_file', 'gth_grep'],
    });
    expect(failures).toEqual([
      'did not call "mcp__*"',
      'called forbidden tool "read_file" (matched "read_file")',
    ]);
  });

  it('reports a repeated forbidden tool only once (de-duped, not once per call)', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['read_file', 'read_file', 'read_file'], {
      mustCall: [],
      mustNotCall: ['read_file'],
    });
    expect(failures).toEqual(['called forbidden tool "read_file" (matched "read_file")']);
  });

  it('passes trivially when both lists are empty (nothing to assert)', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    expect(runToolCallChecks(['anything'], { mustCall: [], mustNotCall: [] })).toEqual([]);
  });

  it('fails a must_call when no tools were called at all', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    expect(runToolCallChecks([], { mustCall: ['mcp__*'], mustNotCall: [] })).toEqual([
      'did not call "mcp__*"',
    ]);
  });
});

describe('runToolCallArgChecks — tool_call_json_path (BATCH-52)', () => {
  const search = (args: string, extra: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
    name: 'mcp__shop__search',
    args,
    ...extra,
  });

  it('passes on equals, contains and existence against a matching call’s arguments', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks(
      [search('{"query":"laptop bags","filters":{"status":"open"}}')],
      {
        toolCallJsonPath: [
          { tool: 'mcp__shop__search', path: 'filters.status', equals: 'open' },
          { tool: 'mcp__shop__*', path: 'query', contains: 'laptop' },
          { tool: 'mcp__shop__search', path: 'filters' },
        ],
      }
    );
    expect(failures).toEqual([]);
  });

  it('fails with the value it found when equals does not hold', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([search('{"filters":{"status":"closed"}}')], {
      toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'filters.status', equals: 'open' }],
    });
    expect(failures).toEqual([
      'tool_call_json_path "filters.status" (tool "mcp__shop__search"): is "closed", expected "open"',
    ]);
  });

  it('passes when ANY of several calls to the tool satisfies it', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([search('{"page":1}'), search('{"page":2}')], {
      toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'page', equals: 2 }],
    });
    expect(failures).toEqual([]);
  });

  it('fails when no call matches the tool pattern', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([{ name: 'read_file', args: '{"path":"a"}' }], {
      toolCallJsonPath: [{ tool: 'mcp__shop__*', path: 'query' }],
    });
    expect(failures).toEqual([
      'tool_call_json_path "query" (tool "mcp__shop__*"): no call to a matching tool',
    ]);
  });

  it('fails deterministically on arguments that are not JSON', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([search('{"query":')], {
      toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'query' }],
    });
    expect(failures).toEqual([
      'tool_call_json_path "query" (tool "mcp__shop__search"): arguments are not JSON',
    ]);
  });

  it('grades a call with no arguments as an empty object', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([search('')], {
      toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'query' }],
    });
    expect(failures).toEqual([
      'tool_call_json_path "query" (tool "mcp__shop__search"): path did not resolve',
    ]);
  });

  it('names toolResultCaptureMaxBytes when the arguments were cut, even if the prefix parses', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks(
      [search('{"query":"x"}', { argsTruncated: true, argsOriginalBytes: 9000 })],
      { toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'query' }] }
    );
    expect(failures).toEqual([
      'tool_call_json_path "query" (tool "mcp__shop__search"): arguments were truncated at ' +
        'toolResultCaptureMaxBytes (the call sent 9000 bytes); raise toolResultCaptureMaxBytes ' +
        'to capture them whole',
    ]);
  });

  it('matches the string at the path against a regular expression', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const calls = [search('{"query":"laptop bags"}')];
    expect(
      runToolCallArgChecks(calls, {
        toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'query', matches: /^laptop\b/ }],
      })
    ).toEqual([]);
    expect(
      runToolCallArgChecks(calls, {
        toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'query', matches: /^bags/ }],
      })
    ).toEqual(['tool_call_json_path "query" (tool "mcp__shop__search"): does not match /^bags/']);
  });

  it('fails matches on a value that is not a string', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([search('{"page":2}')], {
      toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'page', matches: /2/ }],
    });
    expect(failures).toEqual([
      'tool_call_json_path "page" (tool "mcp__shop__search"): is 2 (matches check requires a string)',
    ]);
  });

  describe('present: false', () => {
    const absent = { tool: 'mcp__shop__search', path: 'filters.status', present: false };

    it('passes when the path does not resolve', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      expect(
        runToolCallArgChecks([search('{"query":"x"}')], { toolCallJsonPath: [absent] })
      ).toEqual([]);
    });

    it('fails when the path resolves, naming the value', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      expect(
        runToolCallArgChecks([search('{"filters":{"status":"open"}}')], {
          toolCallJsonPath: [absent],
        })
      ).toEqual([
        'tool_call_json_path "filters.status" (tool "mcp__shop__search"): path is present with "open"',
      ]);
    });

    it('treats a path that resolves to null as present', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      expect(
        runToolCallArgChecks([search('{"filters":{"status":null}}')], {
          toolCallJsonPath: [absent],
        })
      ).toEqual([
        'tool_call_json_path "filters.status" (tool "mcp__shop__search"): path is present with null',
      ]);
    });

    it('passes without all_calls when at least one call omits the argument', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      expect(
        runToolCallArgChecks([search('{"filters":{"status":"open"}}'), search('{}')], {
          toolCallJsonPath: [absent],
        })
      ).toEqual([]);
    });

    it('still fails when no call matches the tool pattern', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      expect(runToolCallArgChecks([], { toolCallJsonPath: [absent] })).toEqual([
        'tool_call_json_path "filters.status" (tool "mcp__shop__search"): no call to a matching tool',
      ]);
    });
  });

  describe('all_calls: true', () => {
    it('passes when every matching call satisfies the entry', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      const failures = runToolCallArgChecks([search('{"page":2}'), search('{"page":2}')], {
        toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'page', equals: 2, allCalls: true }],
      });
      expect(failures).toEqual([]);
    });

    it('fails when any matching call does not, reporting each distinct reason once', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      const failures = runToolCallArgChecks(
        [search('{"page":1}'), search('{"page":2}'), search('{"page":3}'), search('{"page":1}')],
        {
          toolCallJsonPath: [
            { tool: 'mcp__shop__search', path: 'page', equals: 2, allCalls: true },
          ],
        }
      );
      expect(failures).toEqual([
        'tool_call_json_path "page" (tool "mcp__shop__search"): is 1, expected 2; is 3, expected 2',
      ]);
    });

    it('ignores calls to other tools', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      const failures = runToolCallArgChecks(
        [search('{"page":2}'), { name: 'read_file', args: '{"path":"a"}' }],
        {
          toolCallJsonPath: [
            { tool: 'mcp__shop__search', path: 'page', equals: 2, allCalls: true },
          ],
        }
      );
      expect(failures).toEqual([]);
    });

    it('still fails when no call matches the tool pattern', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      const failures = runToolCallArgChecks([], {
        toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'page', allCalls: true }],
      });
      expect(failures).toEqual([
        'tool_call_json_path "page" (tool "mcp__shop__search"): no call to a matching tool',
      ]);
    });

    it('with present: false, fails if any call carries the argument', async () => {
      const { runToolCallArgChecks } = await import('#src/toolChecks.js');
      const check = {
        tool: 'mcp__shop__search',
        path: 'filters.status',
        present: false,
        allCalls: true,
      };
      expect(
        runToolCallArgChecks([search('{}'), search('{"filters":{"status":"open"}}')], {
          toolCallJsonPath: [check],
        })
      ).toEqual([
        'tool_call_json_path "filters.status" (tool "mcp__shop__search"): path is present with "open"',
      ]);
      expect(
        runToolCallArgChecks([search('{}'), search('{"query":"x"}')], {
          toolCallJsonPath: [check],
        })
      ).toEqual([]);
    });
  });
});

describe('runToolTrajectoryChecks — tool_trajectory (BATCH-54)', () => {
  const calls = (...names: string[]): ToolCallRecord[] =>
    names.map((name, index) => ({ name, id: `call_${index + 1}` }));
  const grade = async (
    toolCalls: ToolCallRecord[],
    patterns: string[],
    strict = false
  ): Promise<string[]> => {
    const { runToolTrajectoryChecks } = await import('#src/toolChecks.js');
    return runToolTrajectoryChecks(toolCalls, { toolTrajectory: { calls: patterns, strict } });
  };

  it('asserts nothing when the block declares no trajectory', async () => {
    const { runToolTrajectoryChecks } = await import('#src/toolChecks.js');
    expect(runToolTrajectoryChecks(calls('a'), {})).toEqual([]);
    expect(runToolTrajectoryChecks([], { toolTrajectory: undefined })).toEqual([]);
  });

  describe('not strict (an ordered subsequence)', () => {
    it('passes with extra calls before, between and after the expected ones', async () => {
      expect(await grade(calls('x', 'get', 'y', 'z', 'create', 'w'), ['get', 'create'])).toEqual(
        []
      );
    });

    it('fails when the expected calls came in the other order', async () => {
      expect(await grade(calls('create', 'get'), ['get', 'create'])).toEqual([
        'tool_trajectory: pattern 2 "create" has no matching call after call 2 ("get"); ' +
          'expected in order ["get", "create"], calls were ["create", "get"]',
      ]);
    });

    it('names the first pattern with no match at all, without an "after" clause', async () => {
      expect(await grade(calls('a', 'b'), ['c', 'a'])).toEqual([
        'tool_trajectory: pattern 1 "c" has no matching call; ' +
          'expected in order ["c", "a"], calls were ["a", "b"]',
      ]);
    });

    it('needs a repeated pattern to match that many calls', async () => {
      expect(await grade(calls('list', 'update', 'list'), ['list', 'list'])).toEqual([]);
      expect(await grade(calls('list', 'update'), ['list', 'list'])).toEqual([
        'tool_trajectory: pattern 2 "list" has no matching call after call 1 ("list"); ' +
          'expected in order ["list", "list"], calls were ["list", "update"]',
      ]);
    });

    it('matches glob patterns with the must_call matcher', async () => {
      expect(
        await grade(calls('mcp__shop__get_customer', 'mcp__shop__create_order'), [
          'mcp__shop__get_*',
          'mcp__shop__*',
        ])
      ).toEqual([]);
      expect(await grade(calls('mcp__crm__get'), ['mcp__shop__*'])).toHaveLength(1);
    });

    // The greedy left-to-right scan takes, for each pattern, the EARLIEST call after the previous
    // match. These cases are the ones where a greedy choice could look wrong — an overlapping glob
    // taking a call a later exact pattern also wanted — and show it still finds the embedding.
    it('greedy matching finds an embedding wherever one exists, overlapping globs included', async () => {
      // `*` takes `a` (the earliest), leaving `a` at 3 for the exact pattern.
      expect(await grade(calls('a', 'b', 'a'), ['*', 'a'])).toEqual([]);
      // The glob could take `get_b` or `get_a`; greedy takes `get_a` and `get_b` remains.
      expect(await grade(calls('get_a', 'get_b'), ['get_*', 'get_b'])).toEqual([]);
      // No embedding exists, and greedy agrees: only one `a` comes after a `b`.
      expect(await grade(calls('a', 'b', 'a'), ['b', 'a', 'a'])).toHaveLength(1);
    });

    it('greedy agrees with an exhaustive search on every small trace', async () => {
      const { toolNameMatchesPattern } = await import('@gaunt-sloth/core/utils/toolMatching.js');
      const exhaustive = (names: string[], patterns: string[]): boolean => {
        const embed = (n: number, p: number): boolean =>
          p === patterns.length ||
          (n < names.length &&
            ((toolNameMatchesPattern(names[n], patterns[p]) && embed(n + 1, p + 1)) ||
              embed(n + 1, p)));
        return embed(0, 0);
      };
      const alphabet = ['a', 'b', 'ab'];
      const patternAlphabet = ['a', 'b', 'a*', '*'];
      const sequences = <T>(items: T[], max: number): T[][] => {
        const out: T[][] = [[]];
        for (let length = 1; length <= max; length++) {
          for (const prefix of out.filter((sequence) => sequence.length === length - 1)) {
            for (const item of items) out.push([...prefix, item]);
          }
        }
        return out;
      };
      for (const names of sequences(alphabet, 4)) {
        for (const patterns of sequences(patternAlphabet, 3).filter((p) => p.length > 0)) {
          const greedyPasses = (await grade(calls(...names), patterns)).length === 0;
          expect(greedyPasses, `${names.join(',')} vs ${patterns.join(',')}`).toBe(
            exhaustive(names, patterns)
          );
        }
      }
    });
  });

  describe('strict (the exact sequence)', () => {
    it('passes on the same calls in the same order', async () => {
      expect(await grade(calls('list', 'update'), ['list', 'update'], true)).toEqual([]);
    });

    it('fails an extra call, naming the first position past the expected list', async () => {
      expect(await grade(calls('list', 'update', 'delete'), ['list', 'update'], true)).toEqual([
        'tool_trajectory (strict): differs at position 3: expected no further call, called "delete"; ' +
          'expected exactly ["list", "update"], calls were ["list", "update", "delete"]',
      ]);
    });

    it('fails an extra call in the middle at that position', async () => {
      expect(await grade(calls('list', 'peek', 'update'), ['list', 'update'], true)).toEqual([
        'tool_trajectory (strict): differs at position 2: expected "update", called "peek"; ' +
          'expected exactly ["list", "update"], calls were ["list", "peek", "update"]',
      ]);
    });

    it('fails a missing call at the first position with no call', async () => {
      expect(await grade(calls('list'), ['list', 'update'], true)).toEqual([
        'tool_trajectory (strict): differs at position 2: expected "update", no call; ' +
          'expected exactly ["list", "update"], calls were ["list"]',
      ]);
    });

    it('counts repeats: a pattern listed once does not cover two calls', async () => {
      expect(await grade(calls('list', 'list'), ['list'], true)).toHaveLength(1);
      expect(await grade(calls('list', 'list'), ['list', 'list'], true)).toEqual([]);
    });

    it('matches each position by glob', async () => {
      expect(
        await grade(calls('mcp__shop__get', 'mcp__shop__put'), ['mcp__shop__*', '*put'], true)
      ).toEqual([]);
    });
  });

  it('grades parallel calls from one message in the order they were recorded', async () => {
    // One model message requesting three calls is recorded as three entries in emission order;
    // the trajectory sees exactly that sequence, repeats included.
    const parallel = calls('gamma', 'alpha', 'gamma');
    expect(await grade(parallel, ['gamma', 'alpha', 'gamma'], true)).toEqual([]);
    expect(await grade(parallel, ['alpha', 'gamma', 'gamma'], true)).toHaveLength(1);
    expect(await grade(parallel, ['alpha', 'gamma'])).toEqual([]);
  });

  it('counts a call with no id or arguments like any other', async () => {
    expect(await grade([{ name: 'a' }, { name: 'b' }], ['a', 'b'], true)).toEqual([]);
  });

  it('fails any non-empty trajectory on a run with no calls, in both modes', async () => {
    expect(await grade([], ['a'])).toEqual([
      'tool_trajectory: pattern 1 "a" has no matching call; ' +
        'expected in order ["a"], calls were [] (no tool was called)',
    ]);
    expect(await grade([], ['a'], true)).toEqual([
      'tool_trajectory (strict): differs at position 1: expected "a", no call; ' +
        'expected exactly ["a"], calls were [] (no tool was called)',
    ]);
  });
});
