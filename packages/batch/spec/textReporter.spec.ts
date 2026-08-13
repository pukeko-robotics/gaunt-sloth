import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalSuiteSummary } from '#src/evalTypes.js';
import type { EvalRunContext } from '#src/reporters/reporterTypes.js';

// The reporter emits ALL user-facing text through consoleUtils (AGENTS.md — never console.log). We
// spy the same scoped specifier the reporter imports so the byte-for-byte lines can be asserted.
const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const CTX: EvalRunContext = { suitePath: 'suite.yaml', outputDir: '/out/run-1' };

/** Every line the reporter put on the warning channel, in order. */
const warned = (): string[] =>
  consoleUtilsMock.displayWarning.mock.calls.map((call) => String(call[0]));

/** Drive a reporter over a summary in lifecycle order, exactly as the command's driver does, so the
 * asserted console lines are the ones a real run prints. */
async function drive(summary: EvalSuiteSummary, ctx: EvalRunContext = CTX) {
  const { createTextReporter } = await import('#src/reporters/textReporter.js');
  const reporter = createTextReporter();
  await reporter.onSuiteStart?.(ctx);
  for (const c of summary.cases) await reporter.onCellResult?.(c, ctx);
  await reporter.onSuiteEnd?.(summary, ctx);
}

describe('textReporter (byte-for-byte port of the former printSummary)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('(a) all-pass, no identities: PASS lines + a "case(s)" success total', async () => {
    const summary: EvalSuiteSummary = {
      total: 2,
      passed: 2,
      failed: 0,
      cases: [
        {
          id: 'case-a',
          verdict: 'PASS',
          passThreshold: 6,
          sutOk: true,
          durationMs: 1,
          reasons: [],
        },
        {
          id: 'case-b',
          verdict: 'PASS',
          passThreshold: 6,
          sutOk: true,
          durationMs: 2,
          reasons: [],
        },
      ],
    };

    await drive(summary);

    expect(consoleUtilsMock.display).toHaveBeenNthCalledWith(1, 'PASS  case-a');
    expect(consoleUtilsMock.display).toHaveBeenNthCalledWith(2, 'PASS  case-b');
    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
      'EVAL RESULT: 2/2 case(s) passed. Results written to /out/run-1'
    );
    // No failures anywhere: nothing on the warning channel, no judge line.
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(consoleUtilsMock.display).toHaveBeenCalledTimes(2);
  });

  it('(b) a failing case joins its reasons with "; ", frames them, and warns a total', async () => {
    const summary: EvalSuiteSummary = {
      total: 2,
      passed: 1,
      failed: 1,
      cases: [
        { id: 'ok', verdict: 'PASS', passThreshold: 6, sutOk: true, durationMs: 1, reasons: [] },
        {
          id: 'bad',
          verdict: 'FAIL',
          passThreshold: 6,
          sutOk: true,
          durationMs: 2,
          reasons: ['missing "x"', 'forbidden "y"'],
        },
      ],
    };

    await drive(summary);

    expect(consoleUtilsMock.display).toHaveBeenCalledWith('PASS  ok');
    // [[TUI-C71]] — the verdict keeps its own row and the reasons follow it inside the framing
    // gutter, because a reason is model-authored text and this reporter writes to a terminal.
    expect(warned()).toContain('FAIL  bad');
    expect(
      warned().some((row) => /^ +\d+ │ /.test(row) && row.includes('missing "x"; forbidden "y"'))
    ).toBe(true);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      'EVAL RESULT: 1/2 case(s) passed, 1 failed. Results written to /out/run-1'
    );
    // A failing run must NOT emit the success channel.
    expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();
  });

  /**
   * [[TUI-C71]] — **the stop reaches this reporter as a STRING, never as an `ApprovalStopError`.**
   *
   * `runConversation` catches the stop, records `err.message` as the turn's `error`, and
   * `evalRunner` folds that into `reasons` as `SUT run failed: …`. So `gth eval` multi-turn prints
   * a run-ending stop here — on a terminal — without this file ever seeing the error class, which
   * is exactly why enumerating the error object's consumers did not find this surface.
   *
   * **Asserted as a gutter row**, not as a surviving substring: the text is in the message either
   * way, so a substring assertion passes on the unframed one-liner this case exists to forbid.
   */
  it('(b3) frames a run-ending approvals stop that arrived as a reason string', async () => {
    const { AttackHaltError } = await import('@gaunt-sloth/core/core/shell/approvalStop.js');
    const command = `echo eval-stop-marker | cat${String.fromCodePoint(0x0d)}Approve?  [o]nce`;
    const stop = new AttackHaltError(command, 'pipes a remote script straight into a shell');
    const summary: EvalSuiteSummary = {
      total: 1,
      passed: 0,
      failed: 1,
      cases: [
        {
          id: 'bad',
          verdict: 'FAIL',
          passThreshold: 6,
          sutOk: false,
          durationMs: 1,
          reasons: [`SUT run failed: ${stop.message}`],
        },
      ],
    };

    await drive(summary);

    const rows = warned();
    expect(rows.some((row) => /^ +\d+ │ /.test(row))).toBe(true);
    expect(rows.some((row) => row.includes('eval-stop-marker'))).toBe(true);
    // The carriage return arrived as a printable escape (neutralised at construction) ...
    expect(rows.some((row) => row.includes('\\x0d'))).toBe(true);
    // ... and no row printed can be mistaken for an approval menu at the left edge.
    for (const row of rows) expect(row.trimEnd()).not.toMatch(/^Approve\?/);
  });

  it('(b2) a FAIL with no recorded reasons falls back to "no reason recorded"', async () => {
    const summary: EvalSuiteSummary = {
      total: 1,
      passed: 0,
      failed: 1,
      cases: [
        { id: 'bad', verdict: 'FAIL', passThreshold: 6, sutOk: false, durationMs: 1, reasons: [] },
      ],
    };

    await drive(summary);

    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith('FAIL  bad — no reason recorded');
  });

  it('(c) an identity-matrix run tags each cell and reports the "cell(s)" noun', async () => {
    const summary: EvalSuiteSummary = {
      total: 2,
      passed: 2,
      failed: 0,
      cases: [
        {
          id: 'greets',
          identity: 'admin',
          verdict: 'PASS',
          passThreshold: 6,
          sutOk: true,
          durationMs: 1,
          reasons: [],
        },
        {
          id: 'greets',
          identity: 'limited',
          verdict: 'PASS',
          passThreshold: 6,
          sutOk: true,
          durationMs: 1,
          reasons: [],
        },
      ],
    };

    await drive(summary);

    expect(consoleUtilsMock.display).toHaveBeenCalledWith('PASS  greets [admin]');
    expect(consoleUtilsMock.display).toHaveBeenCalledWith('PASS  greets [limited]');
    // M1: a matrix run counts CELLS, so the noun is "cell(s)", not "case(s)".
    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
      'EVAL RESULT: 2/2 cell(s) passed. Results written to /out/run-1'
    );
  });

  it('(d) a judgeNotice leads with a single self-describing line (with model)', async () => {
    const summary: EvalSuiteSummary = {
      total: 1,
      passed: 1,
      failed: 0,
      cases: [
        { id: 'c', verdict: 'PASS', passThreshold: 6, sutOk: true, durationMs: 1, reasons: [] },
      ],
    };

    await drive(summary, {
      suitePath: 'suite.yaml',
      outputDir: '/out/run-1',
      judgeNotice: { profile: 'strict-judge', model: 'judge-model' },
    });

    expect(consoleUtilsMock.display).toHaveBeenNthCalledWith(
      1,
      'Judge: profile "strict-judge" (model: judge-model)'
    );
    expect(consoleUtilsMock.display).toHaveBeenNthCalledWith(2, 'PASS  c');
  });

  it('(d2) a judgeNotice without a model omits the "(model: …)" suffix', async () => {
    const summary: EvalSuiteSummary = {
      total: 1,
      passed: 1,
      failed: 0,
      cases: [
        { id: 'c', verdict: 'PASS', passThreshold: 6, sutOk: true, durationMs: 1, reasons: [] },
      ],
    };

    await drive(summary, {
      suitePath: 'suite.yaml',
      outputDir: '/out/run-1',
      judgeNotice: { profile: 'strict-judge' },
    });

    expect(consoleUtilsMock.display).toHaveBeenNthCalledWith(1, 'Judge: profile "strict-judge"');
  });

  it('emits NO judge line for the default (no-judge) run', async () => {
    const summary: EvalSuiteSummary = {
      total: 1,
      passed: 1,
      failed: 0,
      cases: [
        { id: 'c', verdict: 'PASS', passThreshold: 6, sutOk: true, durationMs: 1, reasons: [] },
      ],
    };

    await drive(summary);

    expect(consoleUtilsMock.display).not.toHaveBeenCalledWith(expect.stringContaining('Judge:'));
  });

  describe('BATCH-25 — the classification block is CONDITIONAL', () => {
    const plainSummary = (): EvalSuiteSummary => ({
      total: 1,
      passed: 1,
      failed: 0,
      cases: [
        { id: 'c', verdict: 'PASS', passThreshold: 6, sutOk: true, durationMs: 1, reasons: [] },
      ],
    });

    it("prints NOTHING extra for a suite with no `classification:` — #405's console contract", async () => {
      // The one assertion that would catch an accidental unconditional print. Every #405-era suite
      // has no classification block, so its output must be exactly the two lines it always was.
      await drive(plainSummary());

      expect(consoleUtilsMock.display.mock.calls).toEqual([['PASS  c']]);
      expect(consoleUtilsMock.displaySuccess.mock.calls).toEqual([
        ['EVAL RESULT: 1/1 case(s) passed. Results written to /out/run-1'],
      ]);
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    it('prints the coverage line, the matrix and the metrics when the suite declares one', async () => {
      const summary: EvalSuiteSummary = {
        ...plainSummary(),
        classification: {
          labels: ['safe', 'destructive'],
          actions: [],
          tags: [],
          coverage: { total: 2, scored: 1, excluded: 1 },
          labelMatrix: {
            dimension: 'label',
            rows: ['safe', 'destructive'],
            columns: ['safe', 'destructive'],
            counts: { safe: { safe: 1, destructive: 0 }, destructive: { safe: 0, destructive: 0 } },
            counted: 1,
            excluded: 1,
          },
          labelMatrixByTag: {},
          metrics: [
            {
              name: 'false_approve',
              overall: { numerator: 1, denominator: 2, value: 0.5 },
              byTag: {},
              coverage: { total: 2, scored: 1, excluded: 1, denominator: 2 },
              warnings: ['denominator covers 2/4 case(s) (50.0%) — a subset metric is blind.'],
              gate: { max: 0, mode: 'fail', passed: false, reason: '1/2 = 50.0% exceeds 0.0%' },
            },
          ],
          warnings: ['1/2 cell(s) produced no classification.'],
          gateFailures: ['false_approve'],
        },
      };

      await drive(summary);

      const printed = consoleUtilsMock.display.mock.calls.map((call) => call[0]).join('\n');
      const warned = consoleUtilsMock.displayWarning.mock.calls.map((call) => call[0]).join('\n');

      expect(printed).toMatch(/coverage: 1\/2 cell\(s\) classified, 1 excluded/);
      expect(printed).toMatch(/confusion \(label\) — rows = expected, cols = actual/);
      expect(printed).toMatch(/counted 1, EXCLUDED 1 \(not classified\)/);
      expect(printed).toMatch(/false_approve: 1\/2 \(50\.0%\) \[GATE FAILED/);

      // Warnings and the gate verdict go to the warning channel — they are the lines a reader must
      // not skim past.
      expect(warned).toMatch(/! 1\/2 cell\(s\) produced no classification\./);
      expect(warned).toMatch(/! denominator covers 2\/4 case\(s\)/);
      expect(warned).toMatch(/METRIC GATE FAILED: false_approve/);
    });
  });
});
