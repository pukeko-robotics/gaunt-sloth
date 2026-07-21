import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * BATCH-19 A3 acceptance fixture: a tiny CUSTOM `gth eval` reporter declared in config as
 * `reporters: { mine: '<this file>' }`. Its DEFAULT export is the `EvalReporterFactory`. To prove
 * the config-referenced local module registered over the SAME seam the bundled reporters use and was
 * driven over the run's cells, it records the cell labels it observed into a marker file in the run's
 * output dir — which the test then reads back.
 */
export default function createMineReporter() {
  const observed = [];
  return {
    onCellResult(result) {
      observed.push(result.identity ? `${result.id} [${result.identity}]` : result.id);
    },
    onSuiteEnd(summary, ctx) {
      writeFileSync(
        join(ctx.outputDir, 'mine-reporter.json'),
        JSON.stringify({ observed, total: summary.total }, null, 2)
      );
    },
  };
}
