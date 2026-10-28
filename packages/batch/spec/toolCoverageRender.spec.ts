import { describe, expect, it } from 'vitest';
import type { ToolCoverageReport } from '#src/toolCoverage.js';

/** BATCH-32 — the console block. */

function report(fields: Partial<ToolCoverageReport> = {}): ToolCoverageReport {
  return {
    covered: [],
    uncovered: [],
    waived: [],
    filteredOut: [],
    unnamed: 0,
    byServer: [],
    warnings: [],
    gateFailures: [],
    ...fields,
  };
}

describe('renderToolCoverage', () => {
  it('leads with the fraction and lists every uncovered tool', async () => {
    const { renderToolCoverage } = await import('#src/toolCoverageRender.js');
    const lines = renderToolCoverage(report({ covered: ['a'], uncovered: ['c', 'b'] }));

    expect(lines[0]).toBe('TOOL COVERAGE: 1/3 tools exercised');
    expect(lines).toContain('  uncovered: b, c');
  });

  it('puts the waived count on the HEADLINE, not in a detail row', async () => {
    const { renderToolCoverage } = await import('#src/toolCoverageRender.js');
    const lines = renderToolCoverage(report({ covered: ['a'], waived: ['b', 'c'] }));

    // A suite waiving most of the surface reads 100%; the qualifier has to arrive in the same
    // glance as the number it qualifies.
    expect(lines[0]).toBe('TOOL COVERAGE: 1/1 tools exercised — 2 waived');
  });

  it('names the allowedTools-filtered tools and the unnamed count on the headline too', async () => {
    const { renderToolCoverage } = await import('#src/toolCoverageRender.js');
    const lines = renderToolCoverage(
      report({ covered: ['a'], uncovered: ['b'], filteredOut: ['b'], unnamed: 2 })
    );

    expect(lines[0]).toBe(
      'TOOL COVERAGE: 1/2 tools exercised — 1 filtered out by allowedTools, 2 unnamed (not counted)'
    );
    expect(lines).toContain('  filtered out by allowedTools: b');
  });

  it('states that a call counts as coverage, errored result or not', async () => {
    const { renderToolCoverage } = await import('#src/toolCoverageRender.js');
    const lines = renderToolCoverage(report({ covered: ['a'] }));

    expect(lines).toContain(
      '  a tool counts as covered once a case CALLED it, error result or not'
    );
  });

  it('prints the per-server breakdown once more than one server is configured', async () => {
    const { renderToolCoverage } = await import('#src/toolCoverageRender.js');
    const lines = renderToolCoverage(
      report({
        covered: ['mcp__jira_create'],
        uncovered: ['mcp__uni_buy'],
        byServer: [
          { kind: 'mcp', server: 'jira', covered: ['mcp__jira_create'], uncovered: [] },
          { kind: 'mcp', server: 'uni', covered: [], uncovered: ['mcp__uni_buy'] },
        ],
      })
    );

    expect(lines).toContain('  by server:');
    expect(lines).toContain('    jira: 1/1');
    expect(lines).toContain('    uni: 0/1 — uncovered: mcp__uni_buy');
  });

  it('suppresses the breakdown for a single server, where it only restates the headline', async () => {
    const { renderToolCoverage } = await import('#src/toolCoverageRender.js');
    const lines = renderToolCoverage(
      report({
        covered: ['mcp__jira_create'],
        byServer: [{ kind: 'mcp', server: 'jira', covered: ['mcp__jira_create'], uncovered: [] }],
      })
    );

    expect(lines).not.toContain('  by server:');
  });

  it('labels the non-server buckets rather than printing an empty name', async () => {
    const { renderToolCoverage } = await import('#src/toolCoverageRender.js');
    const lines = renderToolCoverage(
      report({
        covered: ['read_file'],
        uncovered: ['mcp__ghost_x'],
        byServer: [
          { kind: 'mcp', server: 'a', covered: [], uncovered: [] },
          { kind: 'mcp', server: 'b', covered: [], uncovered: [] },
          { kind: 'builtin', covered: ['read_file'], uncovered: [] },
          { kind: 'unresolved', covered: [], uncovered: ['mcp__ghost_x'] },
        ],
      })
    );

    expect(lines).toContain('    built-in / config tools: 1/1');
    expect(lines).toContain('    unattributed MCP tools: 0/1 — uncovered: mcp__ghost_x');
  });

  it('renders warnings and gate failures on their own marked lines', async () => {
    const { renderToolCoverage } = await import('#src/toolCoverageRender.js');
    const lines = renderToolCoverage(
      report({
        covered: ['a'],
        warnings: ['something is off'],
        gateFailures: ['min 90%: covered 1/1 (100%)'],
      })
    );

    expect(lines).toContain('  ! something is off');
    expect(lines).toContain('TOOL COVERAGE GATE FAILED — min 90%: covered 1/1 (100%)');
  });

  it('scopes the headline for the run-level aggregate', async () => {
    const { renderToolCoverage } = await import('#src/toolCoverageRender.js');
    const lines = renderToolCoverage(report({ covered: ['a'] }), { scope: 'TOTAL' });

    expect(lines[0]).toBe('TOOL COVERAGE TOTAL: 1/1 tools exercised');
  });
});
