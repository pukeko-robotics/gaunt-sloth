import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { EvalCaseResult, EvalSuiteSummary } from '@gaunt-sloth/batch';

/** A repeated case as batch reports it: 1 of 3 passing at a required 67%. Built as a plain object
 * because this package's batch types may predate the repeat fields. */
function repeatedFailing(): EvalCaseResult {
  const run = (n: number, verdict: 'PASS' | 'FAIL', reasons: string[]) => ({
    id: 'flaky-case',
    run: n,
    verdict,
    passThreshold: 6,
    sutOk: true,
    durationMs: 100,
    reasons,
    judge: { attempted: true, ok: true, verdict: { rate: n === 1 ? 8 : 4, reason: 'r' } },
  });
  return {
    id: 'flaky-case',
    verdict: 'FAIL',
    passThreshold: 6,
    sutOk: true,
    durationMs: 300,
    reasons: [
      'pass rate 1/3 (33%) is below the required 67%',
      'run 2: missing "x"',
      'run 3: missing "x"',
    ],
    repeat: { runs: 3, passed: 1, ratePercent: 33, passRate: 0.67, requiredPercent: 67 },
    runs: [run(1, 'PASS', []), run(2, 'FAIL', ['missing "x"']), run(3, 'FAIL', ['missing "x"'])],
  } as EvalCaseResult;
}

let scratch: string;

describe('BATCH-60 — JUnit keeps one testcase per repeated case', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    scratch = mkdtempSync(join(tmpdir(), 'batch60-junit-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('emits one testcase with the rate in the failure message and each run in system-out', async () => {
    const { createJUnitReporter } = await import('#src/junitReporter.js');
    const summary: EvalSuiteSummary = {
      total: 1,
      passed: 0,
      failed: 1,
      cases: [repeatedFailing()],
    };
    await createJUnitReporter().onSuiteEnd?.(summary, {
      suitePath: 'suite.yaml',
      outputDir: scratch,
    });
    const xml = readFileSync(join(scratch, 'results.xml'), 'utf-8');
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const suite = parsed.testsuites.testsuite;

    expect(suite.tests).toBe('1');
    // One testcase, not one per run: a single object, not an array of three.
    expect(Array.isArray(suite.testcase)).toBe(false);
    expect(suite.testcase.name).toBe('flaky-case');
    expect(suite.testcase.failure.message).toBe('pass rate 1/3 (33%) is below the required 67%');
    expect(suite.testcase['system-out']).toBe(
      [
        'pass rate: 1/3 (33%), required 67%',
        'run 1: PASS (judge 8/10)',
        'run 2: FAIL (judge 4/10) — missing "x"',
        'run 3: FAIL (judge 4/10) — missing "x"',
      ].join('\n')
    );
  });
});
