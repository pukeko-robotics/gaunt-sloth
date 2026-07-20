import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvalSuiteSummary } from '#src/evalTypes.js';

describe('writeEvalOutput', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gth-eval-output-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one JSON file per case plus an aggregate results.json', async () => {
    const { writeEvalOutput } = await import('#src/evalOutput.js');
    const outputDir = join(dir, 'run-1');
    const summary: EvalSuiteSummary = {
      total: 2,
      passed: 1,
      failed: 1,
      cases: [
        {
          id: 'case-a',
          verdict: 'PASS',
          passThreshold: 6,
          sutOk: true,
          answer: 'hi',
          durationMs: 12,
          checks: { passed: true, failures: [] },
          reasons: [],
        },
        {
          id: 'case-b',
          verdict: 'FAIL',
          passThreshold: 6,
          sutOk: true,
          answer: 'nope',
          durationMs: 5,
          checks: { passed: false, failures: ['missing "x"'] },
          reasons: ['missing "x"'],
        },
      ],
    };

    writeEvalOutput(outputDir, summary);

    const caseA = JSON.parse(readFileSync(join(outputDir, 'case-a.json'), 'utf8'));
    expect(caseA).toEqual(summary.cases[0]);

    const caseB = JSON.parse(readFileSync(join(outputDir, 'case-b.json'), 'utf8'));
    expect(caseB).toEqual(summary.cases[1]);

    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson).toEqual(summary);
  });

  it('names a matrix cell `<id>__<identity>.json` and a non-matrix cell `<id>.json`', async () => {
    const { writeEvalOutput } = await import('#src/evalOutput.js');
    const outputDir = join(dir, 'matrix');
    const summary: EvalSuiteSummary = {
      total: 3,
      passed: 3,
      failed: 0,
      cases: [
        // No identity → filename stays `<id>.json` (byte-for-byte as before BATCH-12).
        { id: 'plain', verdict: 'PASS', passThreshold: 6, sutOk: true, durationMs: 1, reasons: [] },
        {
          id: 'list',
          identity: 'admin',
          verdict: 'PASS',
          passThreshold: 6,
          sutOk: true,
          durationMs: 1,
          reasons: [],
        },
        {
          id: 'list',
          identity: 'limited',
          verdict: 'PASS',
          passThreshold: 6,
          sutOk: true,
          durationMs: 1,
          reasons: [],
        },
      ],
    };

    writeEvalOutput(outputDir, summary);

    expect(JSON.parse(readFileSync(join(outputDir, 'plain.json'), 'utf8'))).toEqual(
      summary.cases[0]
    );
    expect(JSON.parse(readFileSync(join(outputDir, 'list__admin.json'), 'utf8'))).toEqual(
      summary.cases[1]
    );
    expect(JSON.parse(readFileSync(join(outputDir, 'list__limited.json'), 'utf8'))).toEqual(
      summary.cases[2]
    );
  });

  it('creates the output directory (and parents) when it does not exist', async () => {
    const { writeEvalOutput } = await import('#src/evalOutput.js');
    const outputDir = join(dir, 'nested', 'deeper', 'run');

    writeEvalOutput(outputDir, { total: 0, passed: 0, failed: 0, cases: [] });

    const content = readFileSync(join(outputDir, 'results.json'), 'utf8');
    expect(JSON.parse(content)).toEqual({ total: 0, passed: 0, failed: 0, cases: [] });
  });
});
