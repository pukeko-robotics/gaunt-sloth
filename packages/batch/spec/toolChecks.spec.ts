import { describe, expect, it } from 'vitest';

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
