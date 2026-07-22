import { describe, expect, it } from 'vitest';
import type {
  EvalCase,
  EvalExpectation,
  EvalSuite,
  JudgeFn,
  RunConversationFn,
} from '#src/evalTypes.js';
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
    mustError: [],
    toolResultJsonPath: [],
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

// BATCH-21: tool-RESULT assertions graded end-to-end through the runner — the acceptance scenario
// is "the restricted identity CALLED the tool AND the call came back denied", deterministic (no
// judge), from a fake runCell that stubs the captured `toolResults`.
describe('runEvalSuite tool-result assertions', () => {
  it('PASSes called-AND-denied deterministically (must_call + must_error + payload path)', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({
        mustCall: ['mcp__authz__*'],
        mustError: ['mcp__authz__*'],
        toolResultJsonPath: [
          { tool: 'mcp__authz__*', path: 'error.code', equals: 'MODULE_DISABLED' },
        ],
      }),
    ]);
    const runCell = runCellReturning({
      'case-1': {
        ok: true,
        answer: 'Access to that module is disabled for your account.',
        tools: ['mcp__authz__get_data'],
        toolResults: [
          {
            name: 'mcp__authz__get_data',
            isError: true,
            content: '{"error":{"code":"MODULE_DISABLED"}}',
          },
        ],
      },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0]).toMatchObject({ verdict: 'PASS', reasons: [] });
    expect(classifyEvalExit(summary)).toBe(0);
  });

  it('FAILs (exit 1) when the tool was called but returned real data instead of the denial', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({
        mustCall: ['mcp__authz__*'],
        mustError: ['mcp__authz__*'],
        toolResultJsonPath: [
          { tool: 'mcp__authz__*', path: 'error.code', equals: 'MODULE_DISABLED' },
        ],
      }),
    ]);
    const runCell = runCellReturning({
      'case-1': {
        ok: true,
        answer: 'Here are the rows.',
        tools: ['mcp__authz__get_data'],
        toolResults: [
          { name: 'mcp__authz__get_data', isError: false, content: '{"rows":[1,2,3]}' },
        ],
      },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual([
      'tool "mcp__authz__*" did not return an error',
      'tool_result_json_path "error.code" (tool "mcp__authz__*"): path did not resolve',
    ]);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('FAILs deterministically on a NON-JSON tool payload (no throw, a graded reason)', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({
        toolResultJsonPath: [{ tool: 'mcp__authz__*', path: 'error.code' }],
      }),
    ]);
    const runCell = runCellReturning({
      'case-1': {
        ok: true,
        answer: 'denied',
        tools: ['mcp__authz__get_data'],
        toolResults: [
          { name: 'mcp__authz__get_data', isError: true, content: 'Error: access denied' },
        ],
      },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual([
      'tool_result_json_path "error.code" (tool "mcp__authz__*"): result payload is not JSON',
    ]);
  });

  it('treats a missing toolResults capture as "no results" (must_error fails, never passes silently)', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ mustError: ['mcp__*'] })]);
    // Outcome has tools but NO toolResults field (e.g. an older/fake producer).
    const runCell = runCellReturning({
      'case-1': { ok: true, answer: 'done', tools: ['mcp__authz__get_data'] },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual(['tool "mcp__*" did not return an error']);
  });

  it('merges tool-result failures after answer + tool-call failures in reasons', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([
      makeCase({ mustContain: ['denied'], mustCall: ['mcp__*'], mustError: ['mcp__*'] }),
    ]);
    const runCell = runCellReturning({
      'case-1': { ok: true, answer: 'here you go', tools: ['read_file'], toolResults: [] },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0].reasons).toEqual([
      'missing "denied"',
      'did not call "mcp__*"',
      'tool "mcp__*" did not return an error',
    ]);
  });

  it('threads toolResults through to the EvalCaseResult (parallel to tools)', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const toolResults = [
      { name: 'mcp__authz__get_data', isError: true, content: '{"error":{"code":"X"}}' },
    ];
    const suite = makeSuite([makeCase({ mustError: ['mcp__authz__*'] })]);
    const runCell = runCellReturning({
      'case-1': { ok: true, answer: 'denied', tools: ['mcp__authz__get_data'], toolResults },
    });

    const summary = await runEvalSuite(suite, { runCell });

    expect(summary.cases[0].toolResults).toEqual(toolResults);
    // And when the runner captured none, the field stays absent (pre-BATCH-21 JSON byte-stable).
    const summary2 = await runEvalSuite(makeSuite([makeCase({ mustContain: ['hi'] })]), {
      runCell: runCellReturning({ 'case-1': { ok: true, answer: 'hi' } }),
    });
    expect(summary2.cases[0].toolResults).toBeUndefined();
  });

  it('grades EACH turn of a multi-turn case against its OWN per-turn toolResults delta', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const evalCase: EvalCase = {
      id: 'conv-1',
      passThreshold: 6,
      turns: [
        {
          user: 'fetch as admin scope',
          expectations: [makeExpectation({ mustCall: ['mcp__authz__*'] })],
        },
        {
          user: 'now fetch the restricted module',
          expectations: [makeExpectation({ mustError: ['mcp__authz__*'] })],
        },
      ],
    };
    const runConversation: RunConversationFn = async () => [
      {
        ok: true,
        answer: 'rows',
        tools: ['mcp__authz__get_data'],
        toolResults: [{ name: 'mcp__authz__get_data', isError: false, content: '{"rows":[1]}' }],
      },
      {
        ok: true,
        answer: 'denied',
        tools: ['mcp__authz__get_data'],
        toolResults: [
          { name: 'mcp__authz__get_data', isError: true, content: '{"error":"denied"}' },
        ],
      },
    ];

    const summary = await runEvalSuite(makeSuite([evalCase]), { runConversation });

    expect(summary.cases[0].verdict).toBe('PASS');
    expect(summary.cases[0].turns).toHaveLength(2);
    expect(summary.cases[0].turns![0].toolResults).toEqual([
      { name: 'mcp__authz__get_data', isError: false, content: '{"rows":[1]}' },
    ]);
    expect(summary.cases[0].turns![1].toolResults).toEqual([
      { name: 'mcp__authz__get_data', isError: true, content: '{"error":"denied"}' },
    ]);
  });

  it('FAILs the right turn when only turn 2 misses its tool-result assertion', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const evalCase: EvalCase = {
      id: 'conv-2',
      passThreshold: 6,
      turns: [
        { user: 'one', expectations: [makeExpectation({ mustContain: ['ok'] })] },
        { user: 'two', expectations: [makeExpectation({ mustError: ['mcp__*'] })] },
      ],
    };
    const runConversation: RunConversationFn = async () => [
      { ok: true, answer: 'ok', tools: [], toolResults: [] },
      {
        ok: true,
        answer: 'here',
        tools: ['mcp__x__y'],
        toolResults: [{ name: 'mcp__x__y', isError: false, content: '{}' }],
      },
    ];

    const summary = await runEvalSuite(makeSuite([evalCase]), { runConversation });

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual(['turn 2: tool "mcp__*" did not return an error']);
    expect(summary.cases[0].turns![0].verdict).toBe('PASS');
    expect(summary.cases[0].turns![1].verdict).toBe('FAIL');
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

  it('NO-SILENT-PASS backstop (M2): a (case × identity) with no applicable block THROWS (harness error), never silently passes', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    // Constructed directly (bypassing the parser, which rejects this statically) to exercise the
    // runner's runtime guard: `limited` has no applicable block. M2 — this is a suite-AUTHORING
    // error, not a product regression, so the runner THROWS (→ the eval command's catch → exit 2)
    // rather than emitting a `sutOk:true` FAIL that `classifyEvalExit` would read as a product exit 1.
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

    await expect(runEvalSuite(suite, { runCellByIdentity })).rejects.toThrow(
      /no applicable expectation block for cell "c1__limited" \(identity "limited"\)/
    );
  });

  it('I1: keys dispatch+grading by inputIndex, not the composite cellId, so colliding cell ids never cross-grade', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    // The exact review case. identities [z, y__z] × cases [x, x__y] make TWO distinct cells collapse
    // to the SAME composite cellId `x__y__z`: (case x × identity y__z) and (case x__y × identity z).
    // If dispatch/grading were keyed by cellId, one of those two cells would run+grade under the
    // WRONG identity and the other would be silently dropped. Keyed by the unique inputIndex, every
    // authored (case × identity) cell runs and grades under its OWN identity.
    const suite: EvalSuite = {
      target: { type: 'gth-agent' },
      identities: ['z', 'y__z'],
      cases: [
        {
          id: 'x',
          passThreshold: 6,
          turns: [{ user: 'p', expectations: [makeExpectation({ mustContain: ['a'] })] }],
        },
        {
          id: 'x__y',
          passThreshold: 6,
          turns: [{ user: 'p', expectations: [makeExpectation({ mustContain: ['a'] })] }],
        },
      ],
    };
    // Route answers by IDENTITY: identity `z` → "no" (missing "a" → FAIL), identity `y__z` → "a"
    // (→ PASS). So if any cell were graded under the wrong identity its verdict would FLIP — the
    // discriminator that a `total`/count-only assertion would miss (the buggy code also yields 4).
    const runCellByIdentity = new Map<string, RunCellFn>([
      ['z', async () => ({ ok: true, answer: 'no' })],
      ['y__z', async () => ({ ok: true, answer: 'a' })],
    ]);

    const summary = await runEvalSuite(suite, { runCellByIdentity });

    // All FOUR authored cells present — none dropped, none duplicated.
    expect(summary).toMatchObject({ total: 4, passed: 2, failed: 2 });
    const cellFor = (id: string, identity: string) =>
      summary.cases.filter((c) => c.id === id && c.identity === identity);
    // The colliding pair: each present EXACTLY once, each under its OWN identity, verdicts flipped.
    expect(cellFor('x', 'y__z')).toHaveLength(1);
    expect(cellFor('x', 'y__z')[0].verdict).toBe('PASS'); // ran under y__z → "a"
    expect(cellFor('x__y', 'z')).toHaveLength(1);
    expect(cellFor('x__y', 'z')[0].verdict).toBe('FAIL'); // ran under z → "no"
    // The two non-colliding cells, for completeness.
    expect(cellFor('x', 'z')[0].verdict).toBe('FAIL');
    expect(cellFor('x__y', 'y__z')[0].verdict).toBe('PASS');
  });
});

// BATCH-12 Task 2: multi-turn cases — a case whose `turns.length > 1` is ONE conversation graded
// turn-by-turn. No live MCP/conversation here, so these use a FAKE `RunConversationFn` returning
// scripted per-turn answers + tool traces; the real memory/authorization behaviour is unverified
// pending the reporter's live pass. Single-turn cases keep flowing through `runCell` (proven path).
describe('runEvalSuite multi-turn', () => {
  /** A 2-turn no-identities case: turn 1 checks a substring, turn 2 checks a digit. */
  function twoTurnCase(): EvalCase {
    return {
      id: 'convo',
      passThreshold: 6,
      turns: [
        {
          user: 'what contract types exist?',
          expectations: [makeExpectation({ mustContain: ['contract'] })],
        },
        {
          user: 'how many did you just list?',
          expectations: [makeExpectation({ mustMatch: [/\d+/] })],
        },
      ],
    };
  }

  it('runs the whole conversation through ONE call (agent built once), grading each turn by its own blocks', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    let calls = 0;
    let received: string[] | undefined;
    const runConversation: RunConversationFn = async (userMessages) => {
      calls++;
      received = userMessages;
      return [
        { ok: true, answer: 'the contract types are A and B' },
        { ok: true, answer: 'there are 2 of them' },
      ];
    };

    const summary = await runEvalSuite(makeSuite([twoTurnCase()]), { runConversation });

    // The conversation ran through exactly ONE RunConversationFn call (not one per turn), and it
    // received ALL the user messages in order (the agent/tools are built once for the whole convo).
    expect(calls).toBe(1);
    expect(received).toEqual(['what contract types exist?', 'how many did you just list?']);
    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(summary.cases[0]).toMatchObject({ id: 'convo', verdict: 'PASS', sutOk: true });
    expect(summary.cases[0].turns).toHaveLength(2);
    expect(summary.cases[0].turns![0]).toMatchObject({ ok: true, verdict: 'PASS' });
    expect(summary.cases[0].turns![1]).toMatchObject({ ok: true, verdict: 'PASS' });
  });

  it('FAILs the cell (exit 1) when a LATER turn fails, naming the failing turn', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const runConversation: RunConversationFn = async () => [
      { ok: true, answer: 'the contract types are A and B' }, // turn 1 PASSes (has "contract")
      { ok: true, answer: 'quite a lot actually' }, // turn 2 FAILs (no digit)
    ];

    const summary = await runEvalSuite(makeSuite([twoTurnCase()]), { runConversation });

    expect(summary.cases[0]).toMatchObject({ verdict: 'FAIL', sutOk: true });
    expect(summary.cases[0].turns![0].verdict).toBe('PASS');
    expect(summary.cases[0].turns![1].verdict).toBe('FAIL');
    // The cell's reasons pinpoint the failing turn.
    expect(summary.cases[0].reasons.some((r) => r.startsWith('turn 2:'))).toBe(true);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('composes with the identity matrix: one conversation per identity, per-turn identity scoping', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const suite: EvalSuite = {
      target: { type: 'gth-agent' },
      identities: ['admin', 'limited'],
      cases: [
        {
          id: 'convo',
          passThreshold: 6,
          turns: [
            {
              user: 'list the contract types',
              expectations: [
                makeExpectation({ identities: ['admin'], mustCall: ['mcp__*'] }),
                makeExpectation({ identities: ['limited'], mustNotCall: ['mcp__*'] }),
              ],
            },
            { user: 'how many?', expectations: [makeExpectation({ mustContain: ['count'] })] },
          ],
        },
      ],
    };
    const seenBy: Record<string, string[]> = {};
    const runConversationByIdentity = new Map<string, RunConversationFn>([
      [
        'admin',
        async (m) => {
          seenBy.admin = m;
          return [
            { ok: true, answer: 'types: A, B', tools: ['mcp__x__list'] }, // called mcp → PASS admin block
            { ok: true, answer: 'the count is 2' }, // has "count" → PASS
          ];
        },
      ],
      [
        'limited',
        async (m) => {
          seenBy.limited = m;
          return [
            { ok: true, answer: 'here they are: A, B', tools: ['mcp__x__list'] }, // LEAK → FAIL must_not_call
            { ok: true, answer: 'the count is 2' },
          ];
        },
      ],
    ]);

    const summary = await runEvalSuite(suite, { runConversationByIdentity });

    // Two conversations (one per identity), each handed ALL its user messages.
    expect(seenBy.admin).toEqual(['list the contract types', 'how many?']);
    expect(seenBy.limited).toEqual(['list the contract types', 'how many?']);
    expect(summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    const admin = summary.cases.find((c) => c.identity === 'admin')!;
    const limited = summary.cases.find((c) => c.identity === 'limited')!;
    expect(admin.verdict).toBe('PASS');
    expect(limited.verdict).toBe('FAIL');
    // The authorization leak is turn 1 of the limited conversation.
    expect(limited.turns![0].verdict).toBe('FAIL');
    expect(limited.turns![1].verdict).toBe('PASS');
    expect(limited.reasons.some((r) => r.startsWith('turn 1:') && r.includes('mcp__x__list'))).toBe(
      true
    );
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('a mid-conversation SUT failure → cell FAIL, sutOk TRUE (a turn ran) → exit 1', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const runConversation: RunConversationFn = async () => [
      { ok: true, answer: 'the contract types are A and B' }, // turn 1 ran + PASSes
      { ok: false, error: 'connect ECONNREFUSED' }, // turn 2 SUT failed (no answer)
    ];

    const summary = await runEvalSuite(makeSuite([twoTurnCase()]), { runConversation });

    expect(summary.cases[0]).toMatchObject({ verdict: 'FAIL', sutOk: true });
    expect(summary.cases[0].turns![1].ok).toBe(false);
    expect(summary.cases[0].reasons.some((r) => /^turn 2:.*ECONNREFUSED/.test(r))).toBe(true);
    // A real (partial) result → product signal, exit 1, NOT harness exit 2.
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('a totally-failed conversation (short outcomes) → sutOk FALSE, un-run turns padded → exit 2', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    // The runner aborts after turn 1 errors — it returns only ONE outcome for a 2-turn case.
    const runConversation: RunConversationFn = async () => [
      { ok: false, error: 'agent init failed' },
    ];

    const summary = await runEvalSuite(makeSuite([twoTurnCase()]), { runConversation });

    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].turns).toHaveLength(2);
    expect(summary.cases[0].turns![0].ok).toBe(false);
    // Turn 2 was never attempted → padded as a failure with a clear reason.
    expect(summary.cases[0].turns![1].ok).toBe(false);
    expect(summary.cases[0].turns![1].reasons[0]).toMatch(/ended before this turn/);
    // No gradeable result at all → harness/environment error, exit 2.
    expect(classifyEvalExit(summary)).toBe(2);
  });

  it('surfaces a THROWN conversation error (no stash) on turn 1 → sutOk FALSE', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    // A runner that throws (e.g. agent init blew up) is caught by runBatchMatrix as a failed cell;
    // no per-turn stash exists, so the thrown message is surfaced on turn 1.
    const runConversation: RunConversationFn = async () => {
      throw new Error('boom during init');
    };

    const summary = await runEvalSuite(makeSuite([twoTurnCase()]), { runConversation });

    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(/^turn 1:.*boom during init/);
  });

  it('runs a PER-TURN judge through the shared grader (that turn answer reaches the judge and drives the verdict)', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    // Turn 2 declares a judge rubric (the brief's own example shape); turn 1 is a deterministic check.
    const suite = makeSuite([
      {
        id: 'convo',
        passThreshold: 6,
        turns: [
          { user: 'greet me', expectations: [makeExpectation({ mustContain: ['hi'] })] },
          { user: 'now be formal', expectations: [makeExpectation({ judgeRubric: 'is formal' })] },
        ],
      },
    ]);
    const runConversation: RunConversationFn = async () => [
      { ok: true, answer: 'hi there' }, // turn 1 PASSes its check
      { ok: true, answer: 'yo dude' }, // turn 2 goes to the judge
    ];
    const judgedAnswers: string[] = [];
    const judge: JudgeFn = async (answer) => {
      judgedAnswers.push(answer);
      return { attempted: true, ok: true, verdict: { rate: 2, reason: 'too casual' } };
    };

    const summary = await runEvalSuite(suite, { runConversation, judge });

    // The judge saw TURN 2's answer specifically (per-turn answer routing, not turn 1's).
    expect(judgedAnswers).toEqual(['yo dude']);
    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].turns![0].verdict).toBe('PASS');
    expect(summary.cases[0].turns![1].verdict).toBe('FAIL');
    // The judge outcome is attached to THAT turn's result, and drives the cell reason.
    expect(summary.cases[0].turns![1].judge).toMatchObject({ ok: true, verdict: { rate: 2 } });
    expect(
      summary.cases[0].reasons.some((r) => r.startsWith('turn 2:') && r.includes('below threshold'))
    ).toBe(true);
  });

  it('routes single-turn cases through runCell and multi-turn cases through runConversation in ONE suite', async () => {
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const suite = makeSuite([makeCase({ id: 'single', mustContain: ['hi'] }), twoTurnCase()]);
    const runCell = runCellReturning({ single: { ok: true, answer: 'hi there' } });
    const runConversation: RunConversationFn = async () => [
      { ok: true, answer: 'the contract types are A and B' },
      { ok: true, answer: 'there are 2' },
    ];

    const summary = await runEvalSuite(suite, { runCell, runConversation });

    expect(summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
    // The single-turn cell keeps its flat shape (no per-turn breakdown); the multi-turn cell has one.
    const single = summary.cases.find((c) => c.id === 'single')!;
    const convo = summary.cases.find((c) => c.id === 'convo')!;
    expect(single.turns).toBeUndefined();
    expect(convo.turns).toHaveLength(2);
  });
});
