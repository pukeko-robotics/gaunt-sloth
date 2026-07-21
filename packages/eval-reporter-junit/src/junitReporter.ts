import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
// Type-only from the package ROOT (`@gaunt-sloth/batch`): the reporter contract and the eval result
// shapes are re-exported there as ONE public plugin surface. Erased at build, so batch is only a
// peer/dev dependency (no runtime dependency on it — the seam is the shared TYPES, nothing more).
import type {
  EvalCaseResult,
  EvalReporter,
  EvalRunContext,
  EvalSuiteSummary,
} from '@gaunt-sloth/batch';

/**
 * XML-escape a dynamic string for use in an attribute value OR a text node. `&` MUST be replaced
 * first (it is the escape char of every other entity). Judge rationale and assertion reasons carry
 * `< > & " '` freely, so without this a single raw `<` or `&` makes `results.xml` unparseable —
 * exactly the failure a "parsed green by a real JUnit reader" acceptance guards against.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `basename(suitePath)` with its extension removed, e.g. `eval/authz-matrix.yaml` → `authz-matrix`.
 * Used as the `<testsuites>`/`<testsuite>`/`classname` name. */
function suiteStem(suitePath: string): string {
  const base = basename(suitePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** The SAME label the text reporter prints: `<id> [<identity>]` for a matrix cell, else `<id>`. */
function cellLabel(result: EvalCaseResult): string {
  return result.identity ? `${result.id} [${result.identity}]` : result.id;
}

/**
 * Best-effort `<system-out>` context, escaped. A `judge: <rate>/10` line when the cell was actually
 * graded by the judge, and a `tools: <a, b>` line when the cell captured a tool trace. Returns
 * `undefined` when neither applies (multi-turn cells carry neither at the top level), so the caller
 * omits the element entirely.
 */
function systemOutText(result: EvalCaseResult): string | undefined {
  const lines: string[] = [];
  if (result.judge?.attempted && result.judge.ok && result.judge.verdict) {
    lines.push(`judge: ${result.judge.verdict.rate}/10`);
  }
  if (result.tools?.length) {
    lines.push(`tools: ${result.tools.join(', ')}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Render one cell as a `<testcase>`. The failure-vs-error split mirrors the eval exit philosophy
 * (2-vs-1): a gradeable result below the bar (`verdict==='FAIL' && sutOk`) is an assertion
 * `<failure>`; a cell whose SUT never produced a gradeable answer (`!sutOk` — transport/auth/config/
 * harness) is an `<error>`; a `PASS` has no child. CI tools treat the two categories differently, so
 * the distinction is load-bearing, not cosmetic.
 */
function renderTestcase(result: EvalCaseResult, stem: string): string {
  const attrs =
    `classname="${escapeXml(stem)}" name="${escapeXml(cellLabel(result))}" ` +
    `time="${result.durationMs / 1000}"`;

  const children: string[] = [];
  const reasonsBody = escapeXml(result.reasons.join('\n'));
  if (!result.sutOk) {
    const message = escapeXml(result.reasons[0] ?? 'SUT run failed');
    children.push(`      <error message="${message}">${reasonsBody}</error>`);
  } else if (result.verdict === 'FAIL') {
    const message = escapeXml(result.reasons[0] ?? 'assertion failed');
    children.push(`      <failure message="${message}">${reasonsBody}</failure>`);
  }
  const sysOut = systemOutText(result);
  if (sysOut !== undefined) {
    children.push(`      <system-out>${escapeXml(sysOut)}</system-out>`);
  }

  if (children.length === 0) {
    return `    <testcase ${attrs}/>`;
  }
  return `    <testcase ${attrs}>\n${children.join('\n')}\n    </testcase>`;
}

/** Build the whole Ant-JUnit document from a completed run. No `timestamp` attribute (kept
 * deterministic — TeamCity keys freshness off file mtime, not the attr). */
function buildJUnitXml(summary: EvalSuiteSummary, ctx: EvalRunContext): string {
  const stem = escapeXml(suiteStem(ctx.suitePath));
  const failures = summary.cases.filter((c) => c.verdict === 'FAIL' && c.sutOk).length;
  const errors = summary.cases.filter((c) => !c.sutOk).length;
  const totalTime = summary.cases.reduce((sum, c) => sum + c.durationMs, 0) / 1000;
  const suiteAttrs = `tests="${summary.total}" failures="${failures}" errors="${errors}" time="${totalTime}"`;
  const testcases = summary.cases
    .map((c) => renderTestcase(c, suiteStem(ctx.suitePath)))
    .join('\n');

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${stem}" ${suiteAttrs}>`,
    `  <testsuite name="${stem}" ${suiteAttrs}>`,
  ];
  if (testcases) {
    lines.push(testcases);
  }
  lines.push('  </testsuite>', '</testsuites>', '');
  return lines.join('\n');
}

/**
 * Create the JUnit XML reporter. It implements `onSuiteEnd` ONLY — it needs the full result set to
 * write a single `results.xml` — writing that file into `ctx.outputDir` ALONGSIDE the always-on
 * `results.json` (never instead of it). `ctx.outputDir` already exists (the command's
 * `writeEvalOutput` created it), but `mkdirSync(..., {recursive:true})` is a cheap, safe guard.
 */
export function createJUnitReporter(): EvalReporter {
  return {
    onSuiteEnd(summary: EvalSuiteSummary, ctx: EvalRunContext): void {
      mkdirSync(ctx.outputDir, { recursive: true });
      writeFileSync(join(ctx.outputDir, 'results.xml'), buildJUnitXml(summary, ctx));
    },
  };
}
