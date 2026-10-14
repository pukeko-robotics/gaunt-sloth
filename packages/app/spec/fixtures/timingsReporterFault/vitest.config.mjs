/**
 * Fixture for `vitestTestTimings.spec.ts`: a real vitest run whose timings reporter faults in both
 * of its per-run hooks. The subclass breaks only the INPUTS the hooks read, so the hooks' own guards
 * are what is exercised. The run must still pass.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import TestTimingsReporter from '../../../../../scripts/vitest-test-timings.mjs';

class FaultingInputs extends TestTimingsReporter {
  onInit() {
    // A vitest whose config shape moved.
    super.onInit({});
  }
  onTestCaseResult() {
    // A test case whose shape moved.
    super.onTestCaseResult({});
  }
}

export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    include: ['passes.check.mjs'],
    reporters: ['default', new FaultingInputs({ outputFile: process.env.GTH_TEST_TIMINGS_FILE })],
  },
});
