import { describe, expect, it } from 'vitest';
import type { EvalCase, EvalExpectation, EvalSuite, JudgeFn } from '#src/evalTypes.js';
import type { CellRunOutcome, MatrixCell, RunCellFn } from '#src/types.js';

/** Build one {@link EvalExpectation} with all assertion arrays defaulted to `[]` — the BATCH-12
 * atom a flat case's single block, or a matrix case's identity-scoped block, both reduce to. */
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
    judgeRubric: undefined,
    ...overrides,
  };
}

type CaseOverrides = Partial<EvalExpectation> & {
  id?: string;
  prompt?: string;
  passThreshold?: number;
};

/** Build a single-turn, single-unscoped-expectation {@link EvalCase} (the flat-case normalization),
 * accepting the same assertion-field overrides the pre-BATCH-12 helper did so the existing tests
 * carry over unchanged. */
function makeCase(overrides: CaseOverrides = {}): EvalCase {
  const { id = 'case-1', prompt = 'say hello', passThreshold = 6, ...expectation } = overrides;
  return {
    id,
    passThreshold,
    turns: [{ user: prompt, expectations: [makeExpectation(expectation)] }],
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
    // BATCH-12 back-compat: a no-identities cell carries NO `identity` key at all (not
    // `undefined`-valued), so its `<id>.json` output stays byte-for-byte identical to before.
    expect('identity' in summary.cases[0]).toBe(false);
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

// BATCH-10: tool-trace assertions (must_call / must_not_call) graded end-to-end, proving the
// captured `cellResult.tools` are threaded into gradeCase and drive the verdict.
describe('runEvalSuite tool-call assertions', () => {
  it('PASSes a case that called an mcp tool and no forbidden tool (glob + exact)', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ mustCall: ['mcp__*'], mustNotCall: ['read_file', 'gth_grep'] }),
    ]);
    const runCell = runCellReturning({
      'case-1': { ok: true, answer: 'done', tools: ['mcp__unimarket__search'] },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0]).toMatchObject({ verdict: 'PASS', reasons: [] });
  });

  it('FAILs a case that skipped mcp and called a forbidden tool (both reasons reported)', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ mustCall: ['mcp__*'], mustNotCall: ['read_file', 'gth_grep'] }),
    ]);
    const runCell = runCellReturning({
      'case-1': { ok: true, answer: 'done', tools: ['read_file'] },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual([
      'did not call "mcp__*"',
      'called forbidden tool "read_file" (matched "read_file")',
    ]);
  });

  it('treats a missing tool trace as "no tools called" (must_call still fails)', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ mustCall: ['mcp__*'] })]);
    const runCell = runCellReturning({ 'case-1': { ok: true, answer: 'done' } }); // no tools field

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual(['did not call "mcp__*"']);
  });

  it('merges tool-call failures after substring failures in reasons', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ mustContain: ['hello'], mustNotCall: ['read_file'] })]);
    const runCell = runCellReturning({
      'case-1': { ok: true, answer: 'goodbye', tools: ['read_file'] },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0].reasons).toEqual([
      'missing "hello"',
      'called forbidden tool "read_file" (matched "read_file")',
    ]);
  });
});

// BATCH-11 (#405 his #6): the three-way exit-code classification, driven end-to-end through
// runEvalSuite with synthetic cell outcomes so the exact pass/fail/harness boundary is pinned.
describe('classifyEvalExit', () => {
  it('returns 0 when every case passed (real, gradeable results, all above the bar)', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ id: 'a', mustContain: ['x'] }),
      makeCase({ id: 'b', mustContain: ['y'] }),
    ]);
    const runCell = runCellReturning({
      a: { ok: true, answer: 'has x' },
      b: { ok: true, answer: 'has y' },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(classifyEvalExit(summary)).toBe(0);
  });

  it('returns 1 when the suite ran but ≥1 case FAILED (product regression)', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ id: 'a', mustContain: ['x'] }),
      makeCase({ id: 'b', mustContain: ['y'] }),
    ]);
    const runCell = runCellReturning({
      a: { ok: true, answer: 'has x' },
      b: { ok: true, answer: 'missing it' }, // sutOk:true, but fails its check
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('returns 2 when EVERY case failed its SUT run (no gradeable results — harness error)', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ id: 'a', mustContain: ['x'] }),
      makeCase({ id: 'b', mustContain: ['y'] }),
    ]);
    const runCell = runCellReturning({
      a: { ok: false, error: 'connect ECONNREFUSED' },
      b: { ok: false, error: 'connect ECONNREFUSED' },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases.every((c) => !c.sutOk)).toBe(true);
    expect(classifyEvalExit(summary)).toBe(2);
  });

  it('returns 1 (not 2) for a MIX of sutOk:false and a passing case — some real results exist', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ id: 'ran', mustContain: ['x'] }),
      makeCase({ id: 'broke', mustContain: ['y'] }),
    ]);
    const runCell = runCellReturning({
      ran: { ok: true, answer: 'has x' }, // gradeable, passes
      broke: { ok: false, error: 'transport failure' }, // sutOk:false
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.failed).toBe(1);
    expect(summary.cases.some((c) => c.sutOk)).toBe(true);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('returns 1 (not 2) when the SUT ran but the judge errored — sutOk:true is a real result', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ id: 'a', judgeRubric: 'be nice' })]);
    const runCell = runCellReturning({ a: { ok: true, answer: 'an answer' } });
    const judge: JudgeFn = async () => ({ attempted: true, ok: false, error: 'judge timed out' });

    const summary = await runEvalSuite(suite, { runCell, judge });

    expect(summary.cases[0]).toMatchObject({ verdict: 'FAIL', sutOk: true });
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('returns 2 for an empty suite (no cases to grade at all)', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const summary = await runEvalSuite(makeSuite([]), { runCell: runCellReturning({}) });

    expect(summary).toMatchObject({ total: 0, passed: 0, failed: 0 });
    expect(classifyEvalExit(summary)).toBe(2);
  });
});

// BATCH-12: the identity matrix — one cell per (case × identity), each identity's block graded for
// that identity, each running under its OWN runCell (per-identity `initConfig` in production). No
// live multi-identity MCP here, so these use FAKE per-identity runCells returning distinct
// answers/tool-traces — the real authorization scenario is unverified pending the reporter's pass.
describe('runEvalSuite identity matrix', () => {
  /** A two-identity matrix suite: one case whose admin block requires an mcp call, whose limited
   * block forbids one (the reporter's #405 Appendix-B authorization shape). */
  function makeMatrixSuite(): EvalSuite {
    return {
      target: { type: 'gth-agent' },
      identities: ['admin', 'limited'],
      cases: [
        {
          id: 'list-contracts',
          passThreshold: 6,
          turns: [
            {
              user: 'list the contract types',
              expectations: [
                makeExpectation({ identities: ['admin'], mustCall: ['mcp__*'] }),
                makeExpectation({ identities: ['limited'], mustNotCall: ['mcp__*'] }),
              ],
            },
          ],
        },
      ],
    };
  }

  it('runs one cell per (case × identity), grading each identity by its own block', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const contentSeenBy: Record<string, string> = {};
    const runCellByIdentity = new Map<string, RunCellFn>([
      [
        'admin',
        async (cell: MatrixCell) => {
          contentSeenBy.admin = cell.content;
          return { ok: true, answer: 'contracts: A, B, C', tools: ['mcp__unimarket__list'] };
        },
      ],
      [
        'limited',
        async (cell: MatrixCell) => {
          contentSeenBy.limited = cell.content;
          return { ok: true, answer: 'access denied', tools: [] };
        },
      ],
    ]);

    const summary = await runEvalSuite(makeMatrixSuite(), { runCellByIdentity });

    // Two cells: list-contracts × {admin, limited}.
    expect(summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
    const admin = summary.cases.find((c) => c.identity === 'admin')!;
    const limited = summary.cases.find((c) => c.identity === 'limited')!;
    // Both keep the case id; the identity distinguishes the two cells.
    expect(admin).toMatchObject({ id: 'list-contracts', identity: 'admin', verdict: 'PASS' });
    expect(limited).toMatchObject({ id: 'list-contracts', identity: 'limited', verdict: 'PASS' });
    // admin graded by the admin block (mcp called), limited by the limited block (no mcp called).
    expect(admin.tools).toEqual(['mcp__unimarket__list']);
    expect(limited.tools).toEqual([]);
    // Each identity ran under ITS OWN runCell with the case prompt.
    expect(contentSeenBy.admin).toContain('list the contract types');
    expect(contentSeenBy.limited).toContain('list the contract types');
  });

  it('FAILs only the offending identity when it violates its own block (authorization regression)', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const runCellByIdentity = new Map<string, RunCellFn>([
      // admin correctly calls mcp → PASS its must_call block.
      ['admin', async () => ({ ok: true, answer: 'contracts: A, B, C', tools: ['mcp__x__list'] })],
      // limited leaks: it DID call an mcp tool it must not → FAIL its must_not_call block.
      [
        'limited',
        async () => ({ ok: true, answer: 'contracts: A, B, C', tools: ['mcp__x__list'] }),
      ],
    ]);

    const summary = await runEvalSuite(makeMatrixSuite(), { runCellByIdentity });

    expect(summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    const admin = summary.cases.find((c) => c.identity === 'admin')!;
    const limited = summary.cases.find((c) => c.identity === 'limited')!;
    expect(admin.verdict).toBe('PASS');
    expect(limited.verdict).toBe('FAIL');
    expect(limited.reasons).toEqual(['called forbidden tool "mcp__x__list" (matched "mcp__*")']);
    // Some cell failed but every cell produced a gradeable answer → product regression, exit 1.
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('applies a flat (unscoped) case block to every identity in the suite', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite: EvalSuite = {
      target: { type: 'gth-agent' },
      identities: ['admin', 'limited'],
      cases: [
        {
          id: 'sane',
          passThreshold: 6,
          // One unscoped block (identities absent) — the flat-case sugar — applies to BOTH.
          turns: [{ user: 'say ok', expectations: [makeExpectation({ mustContain: ['ok'] })] }],
        },
      ],
    };
    const runCellByIdentity = new Map<string, RunCellFn>([
      ['admin', async () => ({ ok: true, answer: 'ok admin' })],
      ['limited', async () => ({ ok: true, answer: 'nope' })], // misses "ok" → FAIL
    ]);

    const summary = await runEvalSuite(suite, { runCellByIdentity });

    expect(summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(summary.cases.find((c) => c.identity === 'admin')!.verdict).toBe('PASS');
    const limited = summary.cases.find((c) => c.identity === 'limited')!;
    expect(limited.verdict).toBe('FAIL');
    expect(limited.reasons).toEqual(['missing "ok"']);
  });

  it('NO-SILENT-PASS backstop: a (case × identity) with no applicable block FAILs, never passes', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    // Constructed directly (bypassing the parser, which rejects this statically) to exercise the
    // runner's runtime guard: `limited` has no applicable block.
    const suite: EvalSuite = {
      target: { type: 'gth-agent' },
      identities: ['admin', 'limited'],
      cases: [
        {
          id: 'c1',
          passThreshold: 6,
          turns: [
            {
              user: 'p',
              expectations: [makeExpectation({ identities: ['admin'], mustCall: ['mcp__*'] })],
            },
          ],
        },
      ],
    };
    const runCellByIdentity = new Map<string, RunCellFn>([
      ['admin', async () => ({ ok: true, answer: 'done', tools: ['mcp__x'] })],
      ['limited', async () => ({ ok: true, answer: 'done', tools: ['mcp__x'] })],
    ]);

    const summary = await runEvalSuite(suite, { runCellByIdentity });

    const limited = summary.cases.find((c) => c.identity === 'limited')!;
    expect(limited.verdict).toBe('FAIL');
    expect(limited.sutOk).toBe(true); // it ran, it just has nothing that would grade it
    expect(limited.reasons[0]).toContain('no applicable expectation block for identity "limited"');
  });
});
