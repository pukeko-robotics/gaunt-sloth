import { describe, expect, it } from 'vitest';
import type { EvalCase, EvalSuite, JudgeFn } from '#src/evalTypes.js';
import type { CellRunOutcome, MatrixCell, RunCellFn } from '#src/types.js';

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'case-1',
    prompt: 'say hello',
    mustContain: [],
    mustNotContain: [],
    shouldContainAny: [],
    judgeRubric: undefined,
    passThreshold: 6,
    ...overrides,
  };
}

function makeSuite(cases: EvalCase[]): EvalSuite {
  return { target: { type: 'gth-agent' }, cases };
}

/** A `RunCellFn` that returns a fixed outcome per case id, keyed by `cell.id` (== case id, per
 * `runEvalSuite`'s `buildEvalCells`). */
function runCellReturning(outcomesById: Record<string, CellRunOutcome>): RunCellFn {
  return async (cell: MatrixCell) => outcomesById[cell.id] ?? { ok: false, error: 'no fixture' };
}

describe('runEvalSuite', () => {
  it('PASSes a checks-only case whose answer satisfies every deterministic check', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ mustContain: ['hello'] })]);
    const runCell = runCellReturning({ 'case-1': { ok: true, answer: 'hello there' } });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(summary.cases[0]).toMatchObject({
      id: 'case-1',
      verdict: 'PASS',
      sutOk: true,
      reasons: [],
    });
  });

  it('FAILs a checks-only case whose answer misses a required substring', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ mustContain: ['hello'] })]);
    const runCell = runCellReturning({ 'case-1': { ok: true, answer: 'goodbye' } });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual(['missing "hello"']);
  });

  it('PASSes a judge-only case when the judge rate is at/above the threshold', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ judgeRubric: 'be nice', passThreshold: 6 })]);
    const runCell = runCellReturning({ 'case-1': { ok: true, answer: 'a nice answer' } });
    const judge: JudgeFn = async () => ({
      attempted: true,
      ok: true,
      verdict: { rate: 7, reason: 'Nice enough.' },
    });

    const summary = await runEvalSuite(suite, { runCell, judge });

    expect(summary.cases[0]).toMatchObject({ verdict: 'PASS', reasons: [] });
  });

  it('FAILs a judge-only case when the judge rate is below the threshold', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ judgeRubric: 'be nice', passThreshold: 6 })]);
    const runCell = runCellReturning({ 'case-1': { ok: true, answer: 'a rude answer' } });
    const judge: JudgeFn = async () => ({
      attempted: true,
      ok: true,
      verdict: { rate: 3, reason: 'Quite rude.' },
    });

    const summary = await runEvalSuite(suite, { runCell, judge });

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual(['judge rate 3/10 below threshold 6: Quite rude.']);
  });

  it('requires BOTH checks and judge to pass when a case declares both', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ mustContain: ['hello'], judgeRubric: 'be nice', passThreshold: 6 }),
    ]);
    const runCell = runCellReturning({ 'case-1': { ok: true, answer: 'hello, rude answer' } });
    const judge: JudgeFn = async () => ({
      attempted: true,
      ok: true,
      verdict: { rate: 2, reason: 'Rude.' },
    });

    const summary = await runEvalSuite(suite, { runCell, judge });

    // Deterministic check passes ("hello" present) but judge fails -> overall FAIL.
    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual(['judge rate 2/10 below threshold 6: Rude.']);
  });

  it('FAILs the case (without crashing the suite) when the judge errors/times out', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ id: 'case-1', judgeRubric: 'be nice' }),
      makeCase({ id: 'case-2', mustContain: ['ok'] }),
    ]);
    const runCell = runCellReturning({
      'case-1': { ok: true, answer: 'anything' },
      'case-2': { ok: true, answer: 'ok fine' },
    });
    const judge: JudgeFn = async () => ({
      attempted: true,
      ok: false,
      error: 'Judge timed out after 30000ms.',
    });

    const summary = await runEvalSuite(suite, { runCell, judge });

    expect(summary.total).toBe(2);
    const case1 = summary.cases.find((c) => c.id === 'case-1')!;
    const case2 = summary.cases.find((c) => c.id === 'case-2')!;
    expect(case1.verdict).toBe('FAIL');
    expect(case1.reasons).toEqual(['judge error: Judge timed out after 30000ms.']);
    // The other case is unaffected — one case's judge failure doesn't crash the suite.
    expect(case2.verdict).toBe('PASS');
  });

  it('FAILs a judge-rubric case with a clear reason when no judge is configured at all', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ judgeRubric: 'be nice' })]);
    const runCell = runCellReturning({ 'case-1': { ok: true, answer: 'anything' } });

    const summary = await runEvalSuite(suite, { runCell }); // no `judge` option

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual(['judge: not configured']);
  });

  it('FAILs a case outright when the SUT run itself failed, without running checks/judge', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ mustContain: ['x'] })]);
    let judgeCalled = false;
    const runCell = runCellReturning({ 'case-1': { ok: false, error: 'tool error' } });
    const judge: JudgeFn = async () => {
      judgeCalled = true;
      return { attempted: true, ok: true, verdict: { rate: 10, reason: 'n/a' } };
    };

    const summary = await runEvalSuite(suite, { runCell, judge });

    expect(summary.cases[0]).toMatchObject({
      verdict: 'FAIL',
      sutOk: false,
      reasons: ['SUT run failed: tool error'],
    });
    expect(judgeCalled).toBe(false);
  });

  it('aggregates suite-level pass/fail counts across multiple cases', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ id: 'a', mustContain: ['x'] }),
      makeCase({ id: 'b', mustContain: ['y'] }),
      makeCase({ id: 'c', mustContain: ['z'] }),
    ]);
    const runCell = runCellReturning({
      a: { ok: true, answer: 'has x' },
      b: { ok: true, answer: 'has NOTHING useful' },
      c: { ok: true, answer: 'has z' },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary).toMatchObject({ total: 3, passed: 2, failed: 1 });
  });

  it('honors a per-case pass_threshold override distinct from other cases', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ id: 'lenient', judgeRubric: 'ok', passThreshold: 3 }),
      makeCase({ id: 'strict', judgeRubric: 'ok', passThreshold: 9 }),
    ]);
    const runCell = runCellReturning({
      lenient: { ok: true, answer: 'a' },
      strict: { ok: true, answer: 'a' },
    });
    const judge: JudgeFn = async () => ({
      attempted: true,
      ok: true,
      verdict: { rate: 5, reason: 'middling' },
    });

    const summary = await runEvalSuite(suite, { runCell, judge });

    expect(summary.cases.find((c) => c.id === 'lenient')!.verdict).toBe('PASS');
    expect(summary.cases.find((c) => c.id === 'strict')!.verdict).toBe('FAIL');
  });

  it('threads tokens/tools/durationMs through from the cell result', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ mustContain: ['ok'] })]);
    const runCell: RunCellFn = async () => ({
      ok: true,
      answer: 'ok',
      tokensInput: 12,
      tokensOutput: 34,
      tools: ['read_file'],
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0]).toMatchObject({
      tokensInput: 12,
      tokensOutput: 34,
      tools: ['read_file'],
    });
    expect(summary.cases[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs cases through the concurrency pool (reuses runBatchMatrix, no second mechanism)', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const cases = Array.from({ length: 6 }, (_, i) =>
      makeCase({ id: `c${i}`, mustContain: ['x'] })
    );
    const suite = makeSuite(cases);
    let inFlight = 0;
    let maxInFlight = 0;
    const runCell: RunCellFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, answer: 'has x' };
    };

    const summary = await runEvalSuite(suite, { runCell, concurrency: 2 });

    expect(summary.total).toBe(6);
    expect(maxInFlight).toBe(2);
  });
});
