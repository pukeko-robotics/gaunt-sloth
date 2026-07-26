import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClassifiedCell } from '#src/classificationTypes.js';

/** BATCH-25 — the extractor and the confusion matrix. */
describe('classification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const LABELS = ['safe', 'destructive', 'exfiltration'];

  describe('extractClassificationValue — `answer` mode', () => {
    it('matches a declared label case-insensitively, ignoring surrounding whitespace', async () => {
      const { extractClassificationValue } = await import('#src/classification.js');
      expect(extractClassificationValue('  Safe\n', { kind: 'answer' }, LABELS)).toBe('safe');
      expect(extractClassificationValue('DESTRUCTIVE', { kind: 'answer' }, LABELS)).toBe(
        'destructive'
      );
    });

    it('strips wrapping quotes/backticks and a trailing full stop (formatting, not content)', async () => {
      const { extractClassificationValue } = await import('#src/classification.js');
      expect(extractClassificationValue('"safe"', { kind: 'answer' }, LABELS)).toBe('safe');
      expect(extractClassificationValue('`exfiltration`', { kind: 'answer' }, LABELS)).toBe(
        'exfiltration'
      );
      expect(extractClassificationValue('safe.', { kind: 'answer' }, LABELS)).toBe('safe');
    });

    it('NEVER substring-matches — "this is not safe" is unrecognized, not `safe`', async () => {
      // The whole point of the extractor being total and literal: a fuzzy match here would read a
      // negation as an approval, which is the silent misreading a classifier eval must not do.
      const { extractClassificationValue } = await import('#src/classification.js');
      const { UNRECOGNIZED_LABEL } = await import('#src/classificationTypes.js');
      expect(extractClassificationValue('this is not safe', { kind: 'answer' }, LABELS)).toBe(
        UNRECOGNIZED_LABEL
      );
      expect(
        extractClassificationValue('The command is safe because…', { kind: 'answer' }, LABELS)
      ).toBe(UNRECOGNIZED_LABEL);
    });

    it('reports an absent or blank answer as unrecognized rather than dropping it', async () => {
      const { extractClassificationValue } = await import('#src/classification.js');
      const { UNRECOGNIZED_LABEL } = await import('#src/classificationTypes.js');
      expect(extractClassificationValue(undefined, { kind: 'answer' }, LABELS)).toBe(
        UNRECOGNIZED_LABEL
      );
      expect(extractClassificationValue('   ', { kind: 'answer' }, LABELS)).toBe(UNRECOGNIZED_LABEL);
    });
  });

  describe('extractClassificationValue — `json_path` mode', () => {
    it('resolves the path against the answer parsed as JSON', async () => {
      const { extractClassificationValue } = await import('#src/classification.js');
      const answer = JSON.stringify({ verdict: { label: 'exfiltration' } });
      expect(
        extractClassificationValue(answer, { kind: 'json_path', path: 'verdict.label' }, LABELS)
      ).toBe('exfiltration');
    });

    it('is unrecognized — never a throw — for a non-JSON answer or an unresolved path', async () => {
      const { extractClassificationValue } = await import('#src/classification.js');
      const { UNRECOGNIZED_LABEL } = await import('#src/classificationTypes.js');
      expect(
        extractClassificationValue('not json at all', { kind: 'json_path', path: 'x' }, LABELS)
      ).toBe(UNRECOGNIZED_LABEL);
      expect(
        extractClassificationValue('{"a":1}', { kind: 'json_path', path: 'b.c' }, LABELS)
      ).toBe(UNRECOGNIZED_LABEL);
    });
  });

  describe('buildConfusionMatrix', () => {
    const cell = (over: Partial<ClassifiedCell>): ClassifiedCell => ({
      id: 'c',
      tags: [],
      scored: true,
      ...over,
    });

    it('places each scored cell at (expected, actual) and keeps declared order on both axes', async () => {
      const { buildConfusionMatrix } = await import('#src/classification.js');
      const matrix = buildConfusionMatrix(
        [
          cell({ id: 'a', expectedLabel: 'safe', actualLabel: 'safe' }),
          cell({ id: 'b', expectedLabel: 'exfiltration', actualLabel: 'destructive' }),
          cell({ id: 'c', expectedLabel: 'destructive', actualLabel: 'safe' }),
        ],
        'label',
        LABELS
      );

      expect(matrix.rows).toEqual(LABELS);
      expect(matrix.columns).toEqual(LABELS);
      // Which WAY it is wrong is the signal: exfiltration→destructive is a prompt instead of a
      // halt; destructive→safe is a security incident. They must be distinguishable.
      expect(matrix.counts.exfiltration.destructive).toBe(1);
      expect(matrix.counts.destructive.safe).toBe(1);
      expect(matrix.counts.safe.safe).toBe(1);
      expect(matrix.counts.safe.destructive).toBe(0);
    });

    it('keeps a declared value on the axes even at zero — a never-emitted tier is itself a finding', async () => {
      // The QA-5 result that killed the four-tier scale was "the caution tier was never emitted".
      // A matrix that dropped empty rows could not have shown it.
      const { buildConfusionMatrix } = await import('#src/classification.js');
      const matrix = buildConfusionMatrix(
        [cell({ expectedLabel: 'safe', actualLabel: 'safe' })],
        'label',
        LABELS
      );
      expect(matrix.rows).toContain('exfiltration');
      expect(matrix.columns).toContain('exfiltration');
      expect(matrix.counts.exfiltration.exfiltration).toBe(0);
    });

    it('accounts for EVERY cell: counted + excluded === total (no silent caps)', async () => {
      const { buildConfusionMatrix } = await import('#src/classification.js');
      const cells = [
        cell({ id: 'a', expectedLabel: 'safe', actualLabel: 'safe' }),
        cell({ id: 'b', expectedLabel: 'safe', scored: false }),
        cell({ id: 'c', expectedLabel: 'destructive', scored: false }),
      ];
      const matrix = buildConfusionMatrix(cells, 'label', LABELS);

      expect(matrix.counted).toBe(1);
      expect(matrix.excluded).toBe(2);
      expect(matrix.counted + matrix.excluded).toBe(cells.length);

      // And an unscored cell contributes NOTHING to any bucket — it is not a wrong answer.
      const placed = matrix.rows.reduce(
        (sum, row) => sum + matrix.columns.reduce((rowSum, col) => rowSum + matrix.counts[row][col], 0),
        0
      );
      expect(placed).toBe(matrix.counted);
    });

    it('adds the (unrecognized) column only when a cell actually produced one', async () => {
      const { buildConfusionMatrix } = await import('#src/classification.js');
      const { UNRECOGNIZED_LABEL } = await import('#src/classificationTypes.js');

      const clean = buildConfusionMatrix(
        [cell({ expectedLabel: 'safe', actualLabel: 'safe' })],
        'label',
        LABELS
      );
      expect(clean.columns).not.toContain(UNRECOGNIZED_LABEL);

      const messy = buildConfusionMatrix(
        [cell({ expectedLabel: 'safe', actualLabel: UNRECOGNIZED_LABEL })],
        'label',
        LABELS
      );
      expect(messy.columns).toContain(UNRECOGNIZED_LABEL);
      expect(messy.counts.safe[UNRECOGNIZED_LABEL]).toBe(1);
    });

    it('adds the (none) bucket for a cell that declares or produces no value', async () => {
      const { buildConfusionMatrix } = await import('#src/classification.js');
      const { NO_EXPECTATION } = await import('#src/classificationTypes.js');
      const matrix = buildConfusionMatrix(
        [cell({ expectedLabel: undefined, actualLabel: 'safe' })],
        'label',
        LABELS
      );
      expect(matrix.rows).toContain(NO_EXPECTATION);
      expect(matrix.counts[NO_EXPECTATION].safe).toBe(1);
    });
  });

  describe('collectTags', () => {
    it('returns every tag any cell declares, sorted and de-duplicated', async () => {
      const { collectTags } = await import('#src/classification.js');
      expect(
        collectTags([
          { id: 'a', tags: ['rce', 'injection'], scored: true },
          { id: 'b', tags: ['injection'], scored: true },
          { id: 'c', tags: [], scored: false },
        ])
      ).toEqual(['injection', 'rce']);
    });
  });
});
