import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalCase, EvalExpectation, EvalSuite, JudgeFn } from '#src/evalTypes.js';
import type { CellRunOutcome, MatrixCell, RunCellFn } from '#src/types.js';

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

/** A single-turn case requiring "hello", repeated `repeat` times at `passRate`. */
function repeatedCase(repeat: number, passRate: number, id = 'c1'): EvalCase {
  return {
    id,
    passThreshold: 6,
    tags: [],
    modelFree: false,
    turns: [{ user: 'say hello', expectations: [makeExpectation({ mustContain: ['hello'] })] }],
    repeat,
    passRate,
  };
}

function suiteOf(cases: EvalCase[], identities?: string[]): EvalSuite {
  return {
    target: { type: 'gth-agent' },
    cases,
    ...(identities ? { identities } : {}),
  } as EvalSuite;
}

/** A runCell whose outcome is chosen per run number (1-based), recording every cell it saw. */
function perRun(
  outcomes: Record<number, CellRunOutcome>,
  seen: MatrixCell[] = []
): { runCell: RunCellFn; seen: MatrixCell[] } {
  return {
    seen,
    runCell: async (cell) => {
      seen.push(cell);
      return outcomes[cell.run ?? 0] ?? { ok: false, error: 'no fixture' };
    },
  };
}

const PASS: CellRunOutcome = { ok: true, answer: 'hello' };
const FAIL: CellRunOutcome = { ok: true, answer: 'goodbye' };

describe('BATCH-60 — a repeated case through runEvalSuite', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes 2 of 3 at pass_rate 0.67, reporting the rate and every run', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const { runCell, seen } = perRun({ 1: PASS, 2: FAIL, 3: PASS });
    const summary = await runEvalSuite(suiteOf([repeatedCase(3, 0.67)]), { runCell });

    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    const result = summary.cases[0];
    expect(result.verdict).toBe('PASS');
    expect(result.sutOk).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.repeat).toEqual({
      runs: 3,
      passed: 2,
      ratePercent: 67,
      passRate: 0.67,
      requiredPercent: 67,
    });
    expect(result.runs?.map((run) => [run.run, run.verdict])).toEqual([
      [1, 'PASS'],
      [2, 'FAIL'],
      [3, 'PASS'],
    ]);
    // One dispatch per run, all under the case's own id, each with its own run number.
    expect(seen.map((cell) => [cell.id, cell.run])).toEqual([
      ['c1', 1],
      ['c1', 2],
      ['c1', 3],
    ]);
    expect(classifyEvalExit(summary)).toBe(0);
  });

  it('fails 2 of 3 at pass_rate 0.68, leading with the rate and naming the failing run', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const { runCell } = perRun({ 1: PASS, 2: FAIL, 3: PASS });
    const summary = await runEvalSuite(suiteOf([repeatedCase(3, 0.68)]), { runCell });

    const result = summary.cases[0];
    expect(result.verdict).toBe('FAIL');
    expect(result.sutOk).toBe(true);
    expect(result.reasons).toEqual([
      'pass rate 2/3 (67%) is below the required 68%',
      'run 2: missing "hello"',
    ]);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('fails at pass_rate 1 when one run of three fails', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const { runCell } = perRun({ 1: PASS, 2: PASS, 3: FAIL });
    const summary = await runEvalSuite(suiteOf([repeatedCase(3, 1)]), { runCell });

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].repeat).toMatchObject({ passed: 2, requiredPercent: 100 });
    expect(summary.cases[0].reasons[0]).toBe('pass rate 2/3 (67%) is below the required 100%');
  });

  it('makes a harness error in one run of three a harness error for the case: exit 2', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const { runCell } = perRun({ 1: PASS, 2: { ok: false, error: 'connection refused' }, 3: PASS });
    // pass_rate 0.5: the two finished runs would pass the case on their own (2/2, or 2/3 = 67%).
    const summary = await runEvalSuite(suiteOf([repeatedCase(3, 0.5)]), { runCell });

    const result = summary.cases[0];
    expect(result.sutOk).toBe(false);
    expect(result.verdict).toBe('FAIL');
    expect(result.reasons[0]).toMatch(/^1 of 3 runs did not finish \(run 2\)/);
    expect(result.reasons).toContain('run 2: SUT run failed: connection refused');
    // The other runs' detail is still reported.
    expect(result.runs?.map((run) => run.sutOk)).toEqual([true, false, true]);
    expect(result.runs?.[0].answer).toBe('hello');
    expect(classifyEvalExit(summary)).toBe(2);
  });

  it('runs repeats concurrently under -j, each its own dispatch', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    let inFlight = 0;
    let peak = 0;
    const runCell: RunCellFn = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return PASS;
    };
    await runEvalSuite(suiteOf([repeatedCase(3, 1)]), { runCell, concurrency: 3 });
    expect(peak).toBe(3);
  });

  it('repeats every identity of a matrix suite', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const seen: string[] = [];
    const byIdentity =
      (name: string): RunCellFn =>
      async (cell) => {
        seen.push(`${name}#${cell.run}`);
        return PASS;
      };
    const summary = await runEvalSuite(suiteOf([repeatedCase(2, 1)], ['admin', 'guest']), {
      runCellByIdentity: new Map([
        ['admin', byIdentity('admin')],
        ['guest', byIdentity('guest')],
      ]),
    });
    expect(seen).toEqual(['admin#1', 'admin#2', 'guest#1', 'guest#2']);
    expect(summary.cases.map((c) => [c.identity, c.repeat?.runs])).toEqual([
      ['admin', 2],
      ['guest', 2],
    ]);
  });

  it('repeats a whole multi-turn conversation', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const evalCase: EvalCase = {
      ...repeatedCase(2, 1),
      turns: [
        { user: 'one', expectations: [makeExpectation({ mustContain: ['one'] })] },
        { user: 'two', expectations: [makeExpectation({ mustContain: ['two'] })] },
      ],
    };
    let conversations = 0;
    const summary = await runEvalSuite(suiteOf([evalCase]), {
      runConversation: async (messages) => {
        conversations += 1;
        return messages.map((m) => ({ ok: true, answer: m }));
      },
    });
    expect(conversations).toBe(2);
    expect(summary.cases[0].verdict).toBe('PASS');
    expect(summary.cases[0].runs?.every((run) => run.turns?.length === 2)).toBe(true);
  });

  it('judges every run on its own', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const rates = [9, 3, 8];
    let calls = 0;
    const judge: JudgeFn = async () => ({
      attempted: true,
      ok: true,
      verdict: { rate: rates[calls++], reason: 'r' },
    });
    const evalCase: EvalCase = {
      ...repeatedCase(3, 0.67),
      turns: [{ user: 'x', expectations: [makeExpectation({ judgeRubric: 'good?' })] }],
    };
    const summary = await runEvalSuite(suiteOf([evalCase]), {
      runCell: async () => PASS,
      judge,
    });
    expect(calls).toBe(3);
    expect(summary.cases[0].runs?.map((run) => run.verdict)).toEqual(['PASS', 'FAIL', 'PASS']);
    expect(summary.cases[0].verdict).toBe('PASS');
  });

  it('counts tools from every run toward coverage, and every run as a classified cell', async () => {
    const { collectExercisedTools, runEvalSuite, toClassifiedCells } =
      await import('#src/evalRunner.js');
    const { runCell } = perRun({
      1: { ok: true, answer: 'hello', tools: ['read_file'] },
      2: { ok: true, answer: 'hello', tools: ['write_file'] },
    });
    const summary = await runEvalSuite(suiteOf([repeatedCase(2, 1)]), { runCell });
    expect(collectExercisedTools(summary.cases).sort()).toEqual(['read_file', 'write_file']);
    expect(toClassifiedCells(summary.cases).map((cell) => cell.id)).toEqual(['c1#run1', 'c1#run2']);
  });

  it('sums the runs into durationMs and leaves the single-run fields unset', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const { runCell } = perRun({ 1: PASS, 2: PASS });
    const summary = await runEvalSuite(suiteOf([repeatedCase(2, 1)]), { runCell });
    const result = summary.cases[0];
    expect(result.durationMs).toBe(
      (result.runs ?? []).reduce((sum, run) => sum + run.durationMs, 0)
    );
    expect('answer' in result).toBe(false);
    expect('checks' in result).toBe(false);
  });
});
