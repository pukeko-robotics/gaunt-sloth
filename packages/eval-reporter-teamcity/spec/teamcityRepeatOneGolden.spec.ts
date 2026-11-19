import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalSuiteSummary } from '@gaunt-sloth/batch';

/**
 * BATCH-60 — **a suite that does not repeat its cases gets exactly the TeamCity stream it got
 * before repeats existed.** The input is the `results.json` golden the batch package pins
 * (`packages/batch/spec/golden/repeat-one/`), driven through the reporter in lifecycle order; the
 * whole emitted stream is compared as one string, so an added service message or attribute cannot
 * pass.
 */

const BATCH_GOLDEN = join(import.meta.dirname, '..', '..', 'batch', 'spec', 'golden', 'repeat-one');
const GOLDEN_DIR = join(import.meta.dirname, 'golden', 'repeat-one');

describe('BATCH-60 — TeamCity output for a suite that does not repeat', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  for (const stem of ['flat', 'matrix']) {
    it(`${stem}: the service-message stream matches the golden`, async () => {
      const { createTeamCityReporter } = await import('#src/teamcityReporter.js');
      const summary = JSON.parse(
        readFileSync(join(BATCH_GOLDEN, stem, 'output', 'results.json'), 'utf-8')
      ) as EvalSuiteSummary;
      const chunks: string[] = [];
      const reporter = createTeamCityReporter((chunk) => chunks.push(chunk));
      const ctx = { suitePath: `${stem}.yaml`, outputDir: `out/${stem}` };
      await reporter.onSuiteStart?.(ctx);
      for (const result of summary.cases) await reporter.onCellResult?.(result, ctx);
      await reporter.onSuiteEnd?.(summary, ctx);

      await expect(chunks.join('')).toMatchFileSnapshot(join(GOLDEN_DIR, `${stem}.teamcity.txt`));
    });
  }
});
