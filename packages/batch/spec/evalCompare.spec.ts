import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EvalCaseResult, EvalSuiteSummary, EvalSweep } from '#src/evalTypes.js';

/** BATCH-25 — the sweep expansion, the config merge, and the run-over-run diff. */
describe('evalCompare', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('expandSweep', () => {
    it('produces the CARTESIAN PRODUCT of the axes, not a zip of them', async () => {
      // A cartesian bug (2 cells instead of 4, or values paired positionally) is invisible to every
      // other test and produces a comparison table that looks entirely reasonable.
      const { expandSweep } = await import('#src/evalCompare.js');
      const sweep: EvalSweep = {
        axes: [
          {
            name: 'rung',
            values: [
              { name: 'assisted', config: { approvals: { rung: 'assisted' } } },
              { name: 'auto', config: { approvals: { rung: 'auto' } } },
            ],
          },
          {
            name: 'model',
            values: [
              { name: 'flash', model: 'gemini-3.6-flash' },
              { name: 'gemma', model: 'gemma4:12b' },
            ],
          },
        ],
      };

      const cells = expandSweep(sweep);
      expect(cells).toHaveLength(4);
      expect(cells.map((cell) => cell.name)).toEqual([
        'rung=assisted · model=flash',
        'rung=assisted · model=gemma',
        'rung=auto · model=flash',
        'rung=auto · model=gemma',
      ]);
      expect(cells.map((cell) => cell.dirName)).toEqual([
        'rung-assisted__model-flash',
        'rung-assisted__model-gemma',
        'rung-auto__model-flash',
        'rung-auto__model-gemma',
      ]);
      // Each cell carries BOTH axes' contributions.
      expect(cells[0]).toMatchObject({
        model: 'gemini-3.6-flash',
        config: { approvals: { rung: 'assisted' } },
      });
      expect(cells[3]).toMatchObject({
        model: 'gemma4:12b',
        config: { approvals: { rung: 'auto' } },
      });
    });

    it('handles a single axis as a plain list of settings', async () => {
      const { expandSweep } = await import('#src/evalCompare.js');
      const cells = expandSweep({
        axes: [
          {
            name: 'backend',
            values: [
              { name: 'lean', config: { agent: { backend: 'lean' } } },
              { name: 'deep', config: { agent: { backend: 'deep' } } },
            ],
          },
        ],
      });
      expect(cells).toHaveLength(2);
      expect(cells[0].name).toBe('backend=lean');
    });
  });

  describe('deepMerge', () => {
    it('merges nested objects rather than replacing them wholesale', async () => {
      const { deepMerge } = await import('#src/evalCompare.js');
      expect(deepMerge({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 9 } })).toEqual({
        a: { x: 1, y: 9 },
        b: 3,
      });
    });

    it('REPLACES arrays and scalars — an override that appended would silently keep the base value', async () => {
      const { deepMerge } = await import('#src/evalCompare.js');
      expect(deepMerge({ tools: ['a', 'b'] }, { tools: ['c'] })).toEqual({ tools: ['c'] });
      expect(deepMerge({ n: 1 }, { n: 2 })).toEqual({ n: 2 });
    });

    it('skips prototype-polluting keys — a suite file is only semi-trusted input', async () => {
      const { deepMerge } = await import('#src/evalCompare.js');
      const merged = deepMerge({ safe: true }, JSON.parse('{"__proto__": {"polluted": true}}'));
      expect(merged).toEqual({ safe: true });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(
        deepMerge({ safe: true }, JSON.parse('{"constructor": {"x": 1}, "prototype": {"y": 2}}'))
      ).toEqual({ safe: true });
    });
  });

  describe('diffRuns', () => {
    const result = (over: Partial<EvalCaseResult>): EvalCaseResult => ({
      id: 'a',
      verdict: 'PASS',
      passThreshold: 6,
      sutOk: true,
      durationMs: 1,
      reasons: [],
      ...over,
    });
    const summaryOf = (cases: EvalCaseResult[]): EvalSuiteSummary => ({
      total: cases.length,
      passed: cases.filter((c) => c.verdict === 'PASS').length,
      failed: cases.filter((c) => c.verdict === 'FAIL').length,
      cases,
    });

    it('separates regressions from fixes', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        summaryOf([
          result({ id: 'a', verdict: 'PASS' }),
          result({ id: 'b', verdict: 'FAIL', reasons: ['x'] }),
        ]),
        summaryOf([
          result({ id: 'a', verdict: 'FAIL', reasons: ['y'] }),
          result({ id: 'b', verdict: 'PASS' }),
        ])
      );
      expect(diff.compared).toBe(2);
      expect(diff.regressed).toEqual([{ id: 'a', before: 'PASS', after: 'FAIL' }]);
      expect(diff.fixed).toEqual([{ id: 'b', before: 'FAIL', after: 'PASS' }]);
    });

    it('reports a RECLASSIFICATION even when the verdict did not move', async () => {
      // The signal a pass-rate comparison structurally cannot see: the label under a still-passing
      // case moved, which is exactly what a rating-prompt edit does.
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        summaryOf([result({ id: 'a', classification: { actualLabel: 'destructive' } })]),
        summaryOf([result({ id: 'a', classification: { actualLabel: 'exfiltration' } })])
      );
      expect(diff.regressed).toEqual([]);
      expect(diff.reclassified).toEqual([
        { id: 'a', before: 'destructive', after: 'exfiltration' },
      ]);
    });

    it('WARNS when the two runs do not cover the same cases — a vanished case cannot regress', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        summaryOf([result({ id: 'a' }), result({ id: 'gone' })]),
        summaryOf([result({ id: 'a' }), result({ id: 'new' })])
      );
      expect(diff.compared).toBe(1);
      expect(diff.onlyInBefore).toEqual(['gone']);
      expect(diff.onlyInAfter).toEqual(['new']);
      expect(diff.warnings.join('\n')).toMatch(/"no regressions" here is not "nothing broke"/);
    });

    it('keys matrix cells by id AND identity, so two identities never collide', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        summaryOf([
          result({ id: 'a', identity: 'admin', verdict: 'PASS' }),
          result({ id: 'a', identity: 'limited', verdict: 'PASS' }),
        ]),
        summaryOf([
          result({ id: 'a', identity: 'admin', verdict: 'PASS' }),
          result({ id: 'a', identity: 'limited', verdict: 'FAIL', reasons: ['x'] }),
        ])
      );
      expect(diff.compared).toBe(2);
      expect(diff.regressed).toEqual([{ id: 'a__limited', before: 'PASS', after: 'FAIL' }]);
    });

    it('computes metric deltas for metrics both runs produced', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const withMetric = (value: number): EvalSuiteSummary => ({
        ...summaryOf([result({ id: 'a' })]),
        classification: {
          labels: ['safe'],
          actions: [],
          tags: [],
          coverage: { total: 1, scored: 1, excluded: 0 },
          labelMatrix: {
            dimension: 'label',
            rows: [],
            columns: [],
            counts: {},
            counted: 1,
            excluded: 0,
          },
          labelMatrixByTag: {},
          metrics: [
            {
              name: 'false_approve',
              overall: { numerator: 1, denominator: 4, value },
              byTag: {},
              coverage: { total: 4, scored: 4, excluded: 0, denominator: 4 },
              warnings: [],
            },
          ],
          warnings: [],
          gateFailures: [],
        },
      });
      const diff = diffRuns(withMetric(0.5), withMetric(0.25));
      expect(diff.metricDeltas).toEqual([
        { name: 'false_approve', before: 0.5, after: 0.25, delta: -0.25 },
      ]);
    });
  });
});
