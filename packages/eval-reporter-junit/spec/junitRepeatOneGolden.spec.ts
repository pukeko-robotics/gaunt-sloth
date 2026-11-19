import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalSuiteSummary } from '@gaunt-sloth/batch';

/**
 * BATCH-60 — **a suite that does not repeat its cases gets exactly the `results.xml` it got before
 * repeats existed.** The input is the `results.json` golden the batch package pins
 * (`packages/batch/spec/golden/repeat-one/`), so the chain from runner to XML is held at both
 * ends: that file fails on any field the runner adds, and this one on anything the reporter adds.
 * The comparison is a whole-string equality, so an added attribute or element cannot pass.
 */

const BATCH_GOLDEN = join(import.meta.dirname, '..', '..', 'batch', 'spec', 'golden', 'repeat-one');
const GOLDEN_DIR = join(import.meta.dirname, 'golden', 'repeat-one');

let scratch: string;

describe('BATCH-60 — JUnit output for a suite that does not repeat', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    scratch = mkdtempSync(join(tmpdir(), 'batch60-junit-golden-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  for (const stem of ['flat', 'matrix']) {
    it(`${stem}: results.xml matches the golden`, async () => {
      const { createJUnitReporter } = await import('#src/junitReporter.js');
      const summary = JSON.parse(
        readFileSync(join(BATCH_GOLDEN, stem, 'output', 'results.json'), 'utf-8')
      ) as EvalSuiteSummary;
      const reporter = createJUnitReporter();
      await reporter.onSuiteEnd?.(summary, { suitePath: `${stem}.yaml`, outputDir: scratch });

      await expect(readFileSync(join(scratch, 'results.xml'), 'utf-8')).toMatchFileSnapshot(
        join(GOLDEN_DIR, `${stem}.results.xml`)
      );
    });
  }
});
