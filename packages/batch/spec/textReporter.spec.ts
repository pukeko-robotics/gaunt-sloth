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

  it('(b) a failing case joins its reasons with "; " and prints a warning total', async () => {
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
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      'FAIL  bad — missing "x"; forbidden "y"'
    );
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      'EVAL RESULT: 1/2 case(s) passed, 1 failed. Results written to /out/run-1'
    );
    // A failing run must NOT emit the success channel.
    expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();
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
});
