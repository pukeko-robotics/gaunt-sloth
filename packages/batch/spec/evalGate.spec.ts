import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unit test for scripts/eval-gate.mjs — the script that decides the EVAL RELEASE GATE's red/green
// (OPS-41). `.github/workflows/evals.yml` deliberately swallows `gth eval`'s exit code, so this
// script is the only thing standing between a bad eval run and a published release; nothing else
// would notice if one of its rules were removed.
//
// It exercises the SAME exported functions the shipped CLI path calls (no reimplementation), and it
// drives `runGate` against real results.json files on disk rather than mocking node:fs, because the
// directory walk and the missing-results.json rule are two of the behaviours under test.
//
// The helper lives at the repo root's scripts/ dir; this spec sits in a package's spec/ dir only
// because that is where the vitest `include` glob looks. Its home in batch/ is thematic: the
// results.json shape it parses is `EvalSuiteSummary`, which packages/batch owns.
const HELPER = '../../../scripts/eval-gate.mjs';

/** One `cases[]` entry of results.json, in the shape the runner writes. */
const cell = (
  id: string,
  identity: string,
  sutOk: boolean,
  verdict: string,
  reasons: string[] = []
) => ({ id, identity, sutOk, verdict, reasons });

const PASSING_CELL = cell('read-marker', 'inception-mercury-2', true, 'PASS');
const FAILING_CELL = cell('read-marker', 'google-3.5-flash-lite', true, 'FAIL', [
  'must_contain: expected "GS-MARKER-7" in answer',
]);
const SKIPPED_CELL = cell('read-marker', 'google-3.5-flash-lite', false, 'FAIL', [
  'SUT run failed.',
]);

const roots: string[] = [];

/** Write a results.json into a fresh temp dir and return that dir, as `gth eval -o` would. */
function outputRoot(summary: Record<string, unknown>, subdir?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'eval-gate-'));
  roots.push(root);
  const dir = subdir ? join(root, subdir) : root;
  if (subdir) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.json'), JSON.stringify(summary, null, 2));
  return root;
}

/** A results.json aggregate around the given cells, with an optional classification block. */
function summaryOf(cases: ReturnType<typeof cell>[], gateFailures?: string[]) {
  const passed = cases.filter((c) => c.sutOk && c.verdict === 'PASS').length;
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    cases,
    ...(gateFailures ? { classification: { metrics: [], warnings: [], gateFailures } } : {}),
  };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('eval-gate (scripts/eval-gate.mjs)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // Guards this helper's entry in `server.deps.external` in vitest.config.ts. eval-gate.mjs is a
  // Node CLI script carrying a `#!` shebang; inlined by Vitest it is evaluated inside an
  // AsyncFunction wrapper where a surviving shebang is a hard `SyntaxError` — which is how
  // distTag.spec.ts failed on windows-latest and only there (OPS-26). A real ESM namespace exposes
  // a non-configurable DATA property; Vitest's inlined exports object exposes a configurable
  // GETTER. So dropping the config entry fails here on every platform instead of on Windows alone.
  it('imports the helper natively (externalized, not inlined by Vitest)', async () => {
    const mod = await import(HELPER);
    const descriptor = Object.getOwnPropertyDescriptor(mod, 'runGate');
    expect(typeof descriptor?.value).toBe('function');
    expect(descriptor?.get).toBeUndefined();
    expect(descriptor?.configurable).toBe(false);
  });

  describe('classifyCell', () => {
    it('maps a graded pass to PASS, a graded failure to FAIL, and a non-running cell to SKIP', async () => {
      const { classifyCell } = await import(HELPER);
      expect(classifyCell(PASSING_CELL)).toBe('PASS');
      expect(classifyCell(FAILING_CELL)).toBe('FAIL');
      expect(classifyCell(SKIPPED_CELL)).toBe('SKIP');
    });
  });

  describe('collectGateFailures', () => {
    it('reads breached metric names across every summary, de-duplicated and sorted', async () => {
      const { collectGateFailures } = await import(HELPER);
      expect(
        collectGateFailures([
          { classification: { gateFailures: ['wrapper_uncovered'] } },
          { classification: { gateFailures: ['false_approve_rate', 'wrapper_uncovered'] } },
        ])
      ).toEqual(['false_approve_rate', 'wrapper_uncovered']);
    });

    it('treats a suite with no classification block as no breached gates', async () => {
      const { collectGateFailures } = await import(HELPER);
      expect(collectGateFailures([{ total: 1, cases: [] }, {}])).toEqual([]);
      expect(collectGateFailures([{ classification: { gateFailures: [] } }])).toEqual([]);
    });
  });

  describe('verdictOf', () => {
    it('is green when a cell passed, no cell failed and no gate broke', async () => {
      const { verdictOf } = await import(HELPER);
      expect(verdictOf({ pass: 2, fail: 0, skip: 0 }, [])).toMatchObject({ ok: true });
    });

    it('is red when a cell produced a real answer that failed', async () => {
      const { verdictOf } = await import(HELPER);
      expect(verdictOf({ pass: 1, fail: 1, skip: 0 }, [])).toMatchObject({ ok: false });
    });

    // Important 1. `classifyEvalExit` has TWO routes to exit 1 and this script used to re-implement
    // only the per-case one, so a run whose aggregate breached a `gate: fail` threshold reported
    // green while `gth eval` failed it.
    it('is red on a breached metric gate even when every single cell passed', async () => {
      const { verdictOf } = await import(HELPER);
      const verdict = verdictOf({ pass: 2, fail: 0, skip: 0 }, ['wrapper_uncovered']);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('wrapper_uncovered');
    });

    it('is red when nothing passed, so a run that proved nothing cannot ship', async () => {
      const { verdictOf } = await import(HELPER);
      expect(verdictOf({ pass: 0, fail: 0, skip: 2 }, [])).toMatchObject({ ok: false });
    });
  });

  describe('renderReport', () => {
    it('names every breached gate even when a failed case is the headline reason', async () => {
      const { renderReport, summarize, verdictOf } = await import(HELPER);
      const summary = summarize([PASSING_CELL, FAILING_CELL]);
      const gateFailures = ['wrapper_uncovered'];
      const report = renderReport(summary, verdictOf(summary, gateFailures), gateFailures);
      // The headline is the case failure...
      expect(report).toContain('### Eval gate: FAIL');
      expect(report).toContain('1 cell(s) produced a real answer that FAILED');
      // ...and the breached gate is still reported, rather than being hidden behind it.
      expect(report).toContain('Metric gate breached: wrapper_uncovered');
    });

    it('escapes a pipe in the detail column so one reason cannot break the table', async () => {
      const { renderReport, summarize, verdictOf } = await import(HELPER);
      const piped = cell('read-marker', 'inception-mercury-2', true, 'FAIL', [
        'must_contain: expected "a|b" in answer',
      ]);
      const summary = summarize([PASSING_CELL, piped]);
      const report = renderReport(summary, verdictOf(summary, []), []);
      const row = report.split('\n').find((line) => line.includes('must_contain'))!;
      expect(row).toContain('a\\|b');
      // Escaped, the row still has exactly the table's three columns.
      expect(row.split(/(?<!\\)\|/).length - 2).toBe(3);
    });

    it('states the pending skip-versus-regression limitation wherever a skip is reported', async () => {
      const { renderReport, summarize, verdictOf } = await import(HELPER);
      const summary = summarize([PASSING_CELL, SKIPPED_CELL]);
      const report = renderReport(summary, verdictOf(summary, []), []);
      expect(report).toContain('Known limitation, pending a decision');
      expect(report).toContain('indistinguishable here from a provider-side regression');
    });

    it('omits the skip commentary entirely when no cell skipped', async () => {
      const { renderReport, summarize, verdictOf } = await import(HELPER);
      const summary = summarize([PASSING_CELL]);
      const report = renderReport(summary, verdictOf(summary, []), []);
      expect(report).not.toContain('Known limitation');
      expect(report).not.toContain('A SKIP means');
    });
  });

  describe('runGate (the shipped decision, end to end on real output dirs)', () => {
    it('passes a clean run', async () => {
      const { runGate } = await import(HELPER);
      const result = runGate(outputRoot(summaryOf([PASSING_CELL, PASSING_CELL])));
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.report).toContain('### Eval gate: PASS');
    });

    it('fails a run in which a cell produced a real answer below the bar', async () => {
      const { runGate } = await import(HELPER);
      const result = runGate(outputRoot(summaryOf([PASSING_CELL, FAILING_CELL])));
      expect(result.exitCode).toBe(1);
      expect(result.report).toContain('### Eval gate: FAIL');
    });

    // Important 1, end to end: the reviewer's exact scenario — every cell passing, one breached
    // metric gate — which reported `### Eval gate: PASS` and exit 0 before this fix.
    it('fails a run whose metric gate was breached though every cell passed', async () => {
      const { runGate } = await import(HELPER);
      const root = outputRoot(summaryOf([PASSING_CELL, PASSING_CELL], ['wrapper_uncovered']));
      const result = runGate(root);
      expect(result.exitCode).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.report).toContain('### Eval gate: FAIL');
      expect(result.report).toContain('wrapper_uncovered');
    });

    it('fails a run in which every cell skipped, because it proved nothing', async () => {
      const { runGate } = await import(HELPER);
      const result = runGate(outputRoot(summaryOf([SKIPPED_CELL, SKIPPED_CELL])));
      expect(result.exitCode).toBe(1);
      expect(result.report).toContain('the run proved nothing');
    });

    it('stays green on a partial run, where one cell passed and another skipped', async () => {
      const { runGate } = await import(HELPER);
      const result = runGate(outputRoot(summaryOf([PASSING_CELL, SKIPPED_CELL])));
      expect(result.exitCode).toBe(0);
      expect(result.report).toContain('### Eval gate: PASS');
      expect(result.report).toContain('SKIP');
    });

    // The eager-provider abort: the raise out of loader.ts ends the run as a harness error before
    // anything is graded, so no results.json is written at all. That must be fatal, never a skip.
    it('fails, on stderr, when no results.json was written anywhere under the root', async () => {
      const { runGate } = await import(HELPER);
      const empty = mkdtempSync(join(tmpdir(), 'eval-gate-'));
      roots.push(empty);
      const result = runGate(empty);
      expect(result.exitCode).toBe(1);
      expect(result.stream).toBe('stderr');
      expect(result.report).toContain('No results.json under');
    });

    it('fails when the root does not exist at all', async () => {
      const { runGate } = await import(HELPER);
      const result = runGate(join(tmpdir(), 'eval-gate-does-not-exist-9f3a'));
      expect(result.exitCode).toBe(1);
      expect(result.stream).toBe('stderr');
    });

    // A directory input runs one suite per direct-child subdir, each writing its own results.json.
    it('aggregates every results.json under the root, including a breached gate in a subdir', async () => {
      const { runGate } = await import(HELPER);
      const root = outputRoot(summaryOf([PASSING_CELL]), 'suite-a');
      mkdirSync(join(root, 'suite-b'));
      writeFileSync(
        join(root, 'suite-b', 'results.json'),
        JSON.stringify(summaryOf([PASSING_CELL], ['false_approve_rate']))
      );
      const result = runGate(root);
      expect(result.report).toContain('2 passed');
      expect(result.exitCode).toBe(1);
      expect(result.report).toContain('false_approve_rate');
    });
  });
});
