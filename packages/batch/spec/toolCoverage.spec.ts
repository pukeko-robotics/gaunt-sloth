import { describe, expect, it } from 'vitest';
import type { AdvertisedToolInventory, ToolCoverageReport } from '#src/toolCoverage.js';

/** One advertised-tool inventory, as a cell would report it. */
function inventory(
  names: (string | { name: string; server?: string })[],
  extra: { filteredOut?: string[]; unnamed?: number } = {}
): AdvertisedToolInventory {
  return {
    tools: names.map((entry) => (typeof entry === 'string' ? { name: entry } : entry)),
    filteredOut: (extra.filteredOut ?? []).map((name) => ({ name })),
    unnamed: extra.unnamed ?? 0,
  };
}

describe('computeToolCoverage', () => {
  it('reports the fraction and names every tool no case called', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['read_file', 'write_file', 'gh_pr'])],
      exercised: ['read_file'],
    })!;

    expect(report.covered).toEqual(['read_file']);
    expect(report.uncovered).toEqual(['write_file', 'gh_pr']);
  });

  /**
   * The node's design question (1), and the assertion this whole feature turns on.
   *
   * The trap it avoids: a fixture that advertises exactly the tools it calls reads 100% whether the
   * denominator is the advertised list or the post-`allowedTools` one, so it cannot tell a correct
   * implementation from the flattering one. Here the two answers differ — 1/3 against 1/1 — so only
   * the pre-filter denominator passes.
   */
  it('counts allowedTools-filtered tools in the DENOMINATOR and reports them as their own category', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [
        inventory(['read_file', 'write_file', 'gh_pr'], { filteredOut: ['write_file', 'gh_pr'] }),
      ],
      exercised: ['read_file'],
    })!;

    expect(report.covered.length).toBe(1);
    expect(report.covered.length + report.uncovered.length).toBe(3);
    expect(report.filteredOut).toEqual(['write_file', 'gh_pr']);
    expect(report.warnings).toContainEqual(expect.stringContaining('removed by allowedTools'));
  });

  it('a waived tool leaves the denominator and is reported beside the fraction', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['read_file', 'write_file', 'delete_file'])],
      exercised: ['read_file'],
      spec: { waive: ['write_file', 'delete_file'], require: [] },
    })!;

    expect(report.covered).toEqual(['read_file']);
    expect(report.uncovered).toEqual([]);
    expect(report.waived).toEqual(['write_file', 'delete_file']);
  });

  it('warns when waivers cover a large share of the surface', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['a', 'b', 'c', 'd'])],
      exercised: ['a'],
      spec: { waive: ['b', 'c', 'd'], require: [] },
    })!;

    // 1/1 = "100% covered" over a surface of four tools. The warning is what stops that reading as
    // full coverage — the BATCH-25 blind-denominator lesson, applied here.
    expect(report.covered.length + report.uncovered.length).toBe(1);
    expect(report.warnings).toContainEqual(
      expect.stringContaining('3 of 4 advertised tool(s) are waived')
    );
  });

  it('does not warn when the waived share is below the threshold', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['a', 'b', 'c', 'd'])],
      exercised: ['a'],
      spec: { waive: ['b'], require: [] },
    })!;

    expect(report.warnings).not.toContainEqual(expect.stringContaining('are waived'));
  });

  it('warns about a waiver that matches no advertised tool', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['read_file'])],
      exercised: ['read_file'],
      spec: { waive: ['renamed_tool'], require: [] },
    })!;

    expect(report.warnings).toContainEqual(
      'waive "renamed_tool" matched no advertised tool — stale waiver, or a typo'
    );
  });

  it('fails a declared min floor and states the number it measured', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['a', 'b', 'c', 'd'])],
      exercised: ['a'],
      spec: { waive: [], require: [], min: 50 },
    })!;

    expect(report.gateFailures).toEqual(['min 50%: covered 1/4 (25%)']);
  });

  it('passes a min floor the run meets exactly', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['a', 'b'])],
      exercised: ['a'],
      spec: { waive: [], require: [], min: 50 },
    })!;

    expect(report.gateFailures).toEqual([]);
  });

  it('fails a min floor over an EMPTY denominator rather than passing it vacuously', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory([])],
      exercised: [],
      spec: { waive: [], require: [], min: 50 },
    })!;

    // The run where every tool went missing is the one a vacuous pass would hide, because 0/0 is
    // indistinguishable from perfect coverage.
    expect(report.gateFailures).toEqual([
      'min 50%: no tools remain in the denominator — the agent advertised none',
    ]);
  });

  it('fails a min floor when every advertised tool was waived away', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['a', 'b'])],
      exercised: [],
      spec: { waive: ['*'], require: [], min: 50 },
    })!;

    expect(report.gateFailures).toEqual([
      'min 50%: no tools remain in the denominator — all 2 advertised tool(s) are waived',
    ]);
  });

  it('fails a require glob no case exercised, and passes one that was', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const unmet = computeToolCoverage({
      inventories: [inventory(['mcp__jira_create', 'read_file'])],
      exercised: ['read_file'],
      spec: { waive: [], require: ['mcp__jira_*'] },
    })!;
    expect(unmet.gateFailures).toEqual([
      'require "mcp__jira_*": no case exercised a tool matching it',
    ]);

    const met = computeToolCoverage({
      inventories: [inventory(['mcp__jira_create', 'read_file'])],
      exercised: ['mcp__jira_create'],
      spec: { waive: [], require: ['mcp__jira_*'] },
    })!;
    expect(met.gateFailures).toEqual([]);
  });

  it('returns no report at all when no cell reported an inventory', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    // An external target, or a run whose SUT never initialised. `0/0` would look like a
    // measurement; silence is the honest answer.
    expect(computeToolCoverage({ inventories: [], exercised: ['read_file'] })).toBeUndefined();
  });

  it('DOES report for an observed-but-empty inventory', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({ inventories: [inventory([])], exercised: [] })!;
    expect(report).toBeDefined();
    expect(report.covered.length + report.uncovered.length).toBe(0);
  });

  it('unions disagreeing cells rather than shrinking to the smallest, and says they disagreed', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      // The second cell's MCP server failed to connect, so it advertised one tool fewer.
      inventories: [inventory(['read_file', 'mcp__jira_create']), inventory(['read_file'])],
      exercised: ['read_file'],
    })!;

    // Taking the shorter list would make coverage IMPROVE because a server broke.
    expect(report.uncovered).toEqual(['mcp__jira_create']);
    expect(report.warnings).toContainEqual(
      expect.stringContaining('did not all advertise the same tools')
    );
  });

  it('counts an unnamed tool in neither half, and does not multiply it across cells', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['a'], { unnamed: 2 }), inventory(['a'], { unnamed: 2 })],
      exercised: ['a'],
    })!;

    expect(report.covered.length + report.uncovered.length).toBe(1);
    expect(report.unnamed).toBe(2);
  });

  it('warns about an exercised tool the inventory never advertised, without inflating the numerator', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [inventory(['read_file'])],
      exercised: ['read_file', 'mystery_tool'],
    })!;

    expect(report.covered).toEqual(['read_file']);
    expect(report.warnings).toContainEqual(expect.stringContaining('mystery_tool'));
  });

  it('breaks coverage down per configured server, keeping built-ins in their own bucket', async () => {
    const { computeToolCoverage } = await import('#src/toolCoverage.js');
    const report = computeToolCoverage({
      inventories: [
        inventory([
          { name: 'mcp__jira_create', server: 'jira' },
          { name: 'mcp__jira_search', server: 'jira' },
          { name: 'mcp__unimarket_buy', server: 'unimarket' },
          { name: 'read_file' },
        ]),
      ],
      exercised: ['mcp__jira_create', 'read_file'],
    })!;

    expect(report.byServer).toEqual([
      {
        kind: 'mcp',
        server: 'jira',
        covered: ['mcp__jira_create'],
        uncovered: ['mcp__jira_search'],
      },
      { kind: 'mcp', server: 'unimarket', covered: [], uncovered: ['mcp__unimarket_buy'] },
      { kind: 'builtin', covered: ['read_file'], uncovered: [] },
    ]);
  });
});

describe('aggregateToolCoverage', () => {
  const report = (fields: Partial<ToolCoverageReport>): ToolCoverageReport => ({
    covered: [],
    uncovered: [],
    waived: [],
    filteredOut: [],
    unnamed: 0,
    byServer: [],
    warnings: [],
    gateFailures: [],
    ...fields,
  });

  it('unions rather than sums, so one agent advertising 3 tools to 2 suites stays 3 tools', async () => {
    const { aggregateToolCoverage } = await import('#src/toolCoverage.js');
    const aggregate = aggregateToolCoverage([
      report({ covered: ['a'], uncovered: ['b', 'c'] }),
      report({ covered: ['b'], uncovered: ['a', 'c'] }),
    ])!;

    // The point of a directory-level figure: one suite covering `a` and its sibling covering `b`
    // leaves only `c` uncovered, and the denominator is still 3 rather than 6.
    expect(aggregate.covered.sort()).toEqual(['a', 'b']);
    expect(aggregate.uncovered).toEqual(['c']);
  });

  it('a tool one suite waived but another measured stays counted in the run', async () => {
    const { aggregateToolCoverage } = await import('#src/toolCoverage.js');
    const aggregate = aggregateToolCoverage([
      report({ covered: ['a'], waived: ['b'] }),
      report({ covered: ['a', 'b'] }),
    ])!;

    expect(aggregate.covered.sort()).toEqual(['a', 'b']);
    expect(aggregate.waived).toEqual([]);
  });

  it('carries no gate failures of its own — a gate belongs to the suite that declared it', async () => {
    const { aggregateToolCoverage } = await import('#src/toolCoverage.js');
    const aggregate = aggregateToolCoverage([
      report({ covered: ['a'], gateFailures: ['min 90%: covered 1/2 (50%)'] }),
    ])!;

    // Re-deriving a gate here would make the same suite pass alone and fail inside a directory.
    expect(aggregate.gateFailures).toEqual([]);
  });

  it('merges per-server buckets across suites', async () => {
    const { aggregateToolCoverage } = await import('#src/toolCoverage.js');
    const aggregate = aggregateToolCoverage([
      report({ byServer: [{ kind: 'mcp', server: 'jira', covered: ['x'], uncovered: ['y'] }] }),
      report({ byServer: [{ kind: 'mcp', server: 'jira', covered: ['y'], uncovered: ['x'] }] }),
    ])!;

    expect(aggregate.byServer).toEqual([
      { kind: 'mcp', server: 'jira', covered: ['x', 'y'], uncovered: [] },
    ]);
  });

  it('returns nothing when no suite produced a report', async () => {
    const { aggregateToolCoverage } = await import('#src/toolCoverage.js');
    expect(aggregateToolCoverage([])).toBeUndefined();
  });
});

/**
 * BATCH-48 — the run-level floor, graded by its own function against the aggregate rather than by
 * re-applying a suite's `min:` inside {@link aggregateToolCoverage}.
 *
 * The fixture that decides the shape: two suites, each clearing its OWN floor, whose union does not
 * clear the run's. A design that promoted a suite floor to the aggregate would grade each suite's
 * 100% and could not fail this; only a separately declared run floor can.
 */
describe('gradeRunToolCoverage', () => {
  const report = (fields: Partial<ToolCoverageReport>): ToolCoverageReport => ({
    covered: [],
    uncovered: [],
    waived: [],
    filteredOut: [],
    unnamed: 0,
    byServer: [],
    warnings: [],
    gateFailures: [],
    ...fields,
  });

  it('fails a directory whose suites each clear their own floor but whose aggregate does not', async () => {
    const { aggregateToolCoverage, gradeRunToolCoverage } = await import('#src/toolCoverage.js');
    // Each suite covers the one tool it did not waive, so each is 1/1 against its own `min: 100`.
    // The reconciled aggregate keeps every tool either suite counted, so it is 2/4.
    const aggregate = aggregateToolCoverage([
      report({ covered: ['a'], uncovered: ['b'], waived: ['c', 'd'] }),
      report({ covered: ['c'], uncovered: ['d'], waived: ['a', 'b'] }),
    ])!;

    const grade = gradeRunToolCoverage(aggregate, { min: 75, waive: [] }, { kind: 'project' });

    expect(aggregate.covered.sort()).toEqual(['a', 'c']);
    expect(aggregate.uncovered.sort()).toEqual(['b', 'd']);
    expect(grade.gateFailures).toEqual([
      'evalToolCoverage.min 75% from the project config: covered 2/4 (50%)',
    ]);
    expect(grade.sourceLine).toBe(
      'graded against evalToolCoverage.min 75% from the project config'
    );
  });

  it('names the profile the floor was read from', async () => {
    const { gradeRunToolCoverage } = await import('#src/toolCoverage.js');
    const grade = gradeRunToolCoverage(
      report({ covered: ['a'], uncovered: ['b', 'c', 'd'] }),
      { min: 50, waive: [] },
      { kind: 'profile', profile: 'mcp-eval-root' }
    );

    expect(grade.gateFailures[0]).toContain('profile mcp-eval-root');
    expect(grade.sourceLine).toBe(
      'graded against evalToolCoverage.min 50% from profile mcp-eval-root'
    );
  });

  it('a run-level waive removes a tool no suite waived, and a suite-only waive does not', async () => {
    const { aggregateToolCoverage, gradeRunToolCoverage } = await import('#src/toolCoverage.js');
    // `b` is waived in one suite and counted in the other, so the reconciliation keeps it counted.
    // `c` is counted in both. Only the run-level list may take either out of the run denominator.
    const aggregate = aggregateToolCoverage([
      report({ covered: ['a'], uncovered: ['c'], waived: ['b'] }),
      report({ covered: ['a'], uncovered: ['b', 'c'] }),
    ])!;
    expect(aggregate.uncovered.sort()).toEqual(['b', 'c']);

    const suiteOnly = gradeRunToolCoverage(aggregate, { min: 50, waive: [] }, { kind: 'project' });
    expect(suiteOnly.report?.uncovered.sort()).toEqual(['b', 'c']);
    expect(suiteOnly.gateFailures).toEqual([
      'evalToolCoverage.min 50% from the project config: covered 1/3 (33.3%)',
    ]);

    const runWaived = gradeRunToolCoverage(
      aggregate,
      { min: 50, waive: ['c'] },
      { kind: 'project' }
    );
    expect(runWaived.report?.uncovered).toEqual(['b']);
    expect(runWaived.report?.waived).toContain('c');
    expect(runWaived.gateFailures).toEqual([]);
  });

  it('a run-level waive of a covered tool leaves the numerator, as a suite waive does', async () => {
    const { computeToolCoverage, gradeRunToolCoverage } = await import('#src/toolCoverage.js');
    const suite = computeToolCoverage({
      inventories: [inventory(['read_file', 'write_file'])],
      exercised: ['read_file', 'write_file'],
      spec: { waive: ['write_file'], require: [] },
    })!;
    expect(suite.covered).toEqual(['read_file']);
    expect(suite.waived).toEqual(['write_file']);

    const grade = gradeRunToolCoverage(
      report({ covered: ['read_file', 'write_file'] }),
      { waive: ['write_file'] },
      { kind: 'project' }
    );
    expect(grade.report?.covered).toEqual(['read_file']);
    expect(grade.report?.waived).toEqual(['write_file']);
    expect(grade.gateFailures).toEqual([]);
  });

  it('warns when a run-level waive matches no advertised tool, naming the key', async () => {
    const { gradeRunToolCoverage } = await import('#src/toolCoverage.js');
    const grade = gradeRunToolCoverage(
      report({ covered: ['a'], uncovered: ['b'] }),
      { min: 50, waive: ['renamed_tool'] },
      { kind: 'project' }
    );

    expect(grade.warnings).toEqual([
      'evalToolCoverage.waive "renamed_tool" matched no advertised tool — stale waiver, or a typo',
    ]);
    expect(grade.gateFailures).toEqual([]);
  });

  it('a floor with nothing to grade fails rather than passing quietly', async () => {
    const { gradeRunToolCoverage } = await import('#src/toolCoverage.js');
    const grade = gradeRunToolCoverage(
      undefined,
      { min: 13, waive: ['read_file'] },
      { kind: 'profile', profile: 'mcp-eval-root' }
    );

    expect(grade.report).toBeUndefined();
    expect(grade.gateFailures).toEqual([
      'evalToolCoverage.min 13% from profile mcp-eval-root could not be graded: no suite produced ' +
        'a coverage report',
    ]);
  });

  it('a floor over a denominator the run-level waive emptied fails', async () => {
    const { gradeRunToolCoverage } = await import('#src/toolCoverage.js');
    const grade = gradeRunToolCoverage(
      report({ covered: ['a'] }),
      { min: 13, waive: ['a'] },
      { kind: 'project' }
    );

    expect(grade.gateFailures).toEqual([
      'evalToolCoverage.min 13% from the project config: no tools remain in the denominator — ' +
        'all 1 advertised tool(s) are waived',
    ]);
  });

  it('holds when the aggregate clears the floor, and says so without a gate failure', async () => {
    const { gradeRunToolCoverage } = await import('#src/toolCoverage.js');
    const grade = gradeRunToolCoverage(
      report({ covered: ['a', 'b'], uncovered: ['c'] }),
      { min: 50, waive: [] },
      { kind: 'project' }
    );

    expect(grade.gateFailures).toEqual([]);
    expect(grade.report?.covered.sort()).toEqual(['a', 'b']);
  });
});
