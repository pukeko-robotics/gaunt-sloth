import { describe, expect, it } from 'vitest';
import type { EvalCase, EvalExpectation, EvalSuite } from '#src/evalTypes.js';
import type { AdvertisedToolInventory, ToolCoverageSpec } from '#src/toolCoverage.js';
import type { CellRunOutcome, MatrixCell, RunCellFn } from '#src/types.js';

/**
 * BATCH-32 — the runner's coverage wiring: the inventory reaching the summary, the numerator being
 * read from the graded results, and a declared gate reaching the exit contract.
 *
 * Separate from `evalRunner.spec.ts` so the existing file stays about grading.
 */

function makeExpectation(overrides: Partial<EvalExpectation> = {}): EvalExpectation {
  return {
    mustContain: [],
    mustNotContain: [],
    shouldContainAny: [],
    mustCall: [],
    mustNotCall: [],
    mustMatch: [],
    mustNotMatch: [],
    jsonPath: [],
    mustError: [],
    toolResultJsonPath: [],
    toolCallJsonPath: [],
    judgeRubric: undefined,
    ...overrides,
  };
}

function makeCase(id: string, turns = 1): EvalCase {
  return {
    id,
    passThreshold: 6,
    tags: [],
    modelFree: false,
    turns: Array.from({ length: turns }, (_, index) => ({
      user: `turn ${index + 1}`,
      expectations: [makeExpectation({ mustContain: ['ok'] })],
    })),
  };
}

function makeSuite(cases: EvalCase[], toolCoverage?: ToolCoverageSpec): EvalSuite {
  return {
    target: { type: 'gth-agent' },
    metrics: [],
    cases,
    ...(toolCoverage ? { toolCoverage } : {}),
  };
}

function inventory(names: string[], filteredOut: string[] = []): AdvertisedToolInventory {
  return {
    tools: names.map((name) => ({ name })),
    filteredOut: filteredOut.map((name) => ({ name })),
    unnamed: 0,
  };
}

function runCellReturning(outcomesById: Record<string, CellRunOutcome>): RunCellFn {
  return async (cell: MatrixCell) => outcomesById[cell.id] ?? { ok: false, error: 'no fixture' };
}

describe('runEvalSuite tool coverage', () => {
  it('attaches the coverage block from the cells own inventories, without the suite opting in', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const summary = await runEvalSuite(makeSuite([makeCase('c1')]), {
      runCell: runCellReturning({
        c1: {
          ok: true,
          answer: 'ok',
          tools: ['read_file'],
          advertisedTools: inventory(['read_file', 'write_file']),
        },
      }),
    });

    // No `tool_coverage:` in the suite — the number is reported anyway, which is the defect the
    // node exists to close ("nothing in a run says so").
    expect(summary.toolCoverage?.covered).toEqual(['read_file']);
    expect(summary.toolCoverage?.uncovered).toEqual(['write_file']);
  });

  it('omits the block entirely when no cell reported an inventory', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const summary = await runEvalSuite(makeSuite([makeCase('c1')]), {
      runCell: runCellReturning({ c1: { ok: true, answer: 'ok', tools: ['read_file'] } }),
    });

    expect(summary.toolCoverage).toBeUndefined();
  });

  it('reads the numerator from a MULTI-TURN cell per-turn trace', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const summary = await runEvalSuite(makeSuite([makeCase('c1', 2)]), {
      runConversation: async () => [
        {
          ok: true,
          answer: 'ok',
          tools: ['read_file'],
          advertisedTools: inventory(['read_file', 'write_file']),
        },
        {
          ok: true,
          answer: 'ok',
          tools: ['write_file'],
          advertisedTools: inventory(['read_file', 'write_file']),
        },
      ],
    });

    // A multi-turn cell leaves the top-level `tools` unset, so a numerator that read only that
    // field would report this suite as covering nothing.
    expect(summary.toolCoverage?.covered.sort()).toEqual(['read_file', 'write_file']);
    expect(summary.toolCoverage?.uncovered).toEqual([]);
  });

  it('unions the inventories across cells', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const summary = await runEvalSuite(makeSuite([makeCase('c1'), makeCase('c2')]), {
      runCell: runCellReturning({
        c1: { ok: true, answer: 'ok', tools: ['a'], advertisedTools: inventory(['a', 'b']) },
        c2: { ok: true, answer: 'ok', tools: ['b'], advertisedTools: inventory(['a', 'b', 'c']) },
      }),
    });

    expect(summary.toolCoverage?.covered.sort()).toEqual(['a', 'b']);
    expect(summary.toolCoverage?.uncovered).toEqual(['c']);
  });

  it('a breached coverage floor exits 1 even when every case PASSed', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const summary = await runEvalSuite(
      makeSuite([makeCase('c1')], { waive: [], require: [], min: 80 }),
      {
        runCell: runCellReturning({
          c1: {
            ok: true,
            answer: 'ok',
            tools: ['read_file'],
            advertisedTools: inventory(['read_file', 'write_file']),
          },
        }),
      }
    );

    expect(summary.failed).toBe(0);
    expect(summary.toolCoverage?.gateFailures).toEqual(['min 80%: covered 1/2 (50%)']);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('a met coverage floor leaves the run at 0', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const summary = await runEvalSuite(
      makeSuite([makeCase('c1')], { waive: [], require: [], min: 50 }),
      {
        runCell: runCellReturning({
          c1: {
            ok: true,
            answer: 'ok',
            tools: ['read_file'],
            advertisedTools: inventory(['read_file', 'write_file']),
          },
        }),
      }
    );

    expect(classifyEvalExit(summary)).toBe(0);
  });

  it('an unmet require entry exits 1', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const summary = await runEvalSuite(
      makeSuite([makeCase('c1')], { waive: [], require: ['mcp__jira_*'] }),
      {
        runCell: runCellReturning({
          c1: {
            ok: true,
            answer: 'ok',
            tools: ['read_file'],
            advertisedTools: inventory(['read_file', 'mcp__jira_create']),
          },
        }),
      }
    );

    expect(classifyEvalExit(summary)).toBe(1);
  });
});

describe('collectExercisedTools', () => {
  it('unions the flat trace and every turn trace, deduplicated', async () => {
    const { collectExercisedTools } = await import('#src/evalRunner.js');
    expect(
      collectExercisedTools([
        { tools: ['a', 'b'] },
        { turns: [{ tools: ['b', 'c'] }, { tools: ['d'] }] },
        {},
      ] as never)
    ).toEqual(['a', 'b', 'c', 'd']);
  });
});
