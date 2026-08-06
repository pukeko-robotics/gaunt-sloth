#!/usr/bin/env node
// OPS-41 — turn a `gth eval` run into a CI verdict, per cell.
//
//   node scripts/eval-gate.mjs <output-dir>       # the dir passed to `gth eval -o`
//
// WHY THIS EXISTS RATHER THAN READING THE EXIT CODE. `gth eval`'s three-way exit code (0 pass /
// 1 a case failed / 2 harness error) cannot express a MIXED run, which is the only kind a CI matrix
// ever produces. `classifyEvalExit` reaches 2 only when EVERY cell has `sutOk:false`; so a run where
// one identity answers correctly and another could not run at all (its API key is not a CI secret)
// exits 1 — byte-identical to a genuine product regression. Reading the code alone would fail a
// release for an absent secret.
//
// THIS GATE REFINES `gth eval`'s VERDICT, IT DOES NOT REPLACE IT. That distinction is the whole
// design. The measurement above justifies not TRUSTING exit 1 on its own; it does not justify
// discarding what the run reported. So where the eval's own signal is ambiguous (which of the two
// exit-1 routes fired) the classification below re-derives it from results.json, and where the
// signal is unambiguous the gate defers to it — see the metric gate rule below.
//
// The classification is anchored on the field the contract itself is anchored on — per-cell `sutOk`
// in results.json:
//
//   sutOk:false                  -> SKIP. The SUT never ran (missing/rotated key, transport, auth).
//                                  Reported, never fatal on its own. See KNOWN LIMITATION below.
//   sutOk:true  + verdict PASS   -> PASS. A real answer that met the assertions.
//   sutOk:true  + verdict FAIL   -> FAIL. A real, gradeable answer below the bar — a product signal.
//
// THE GATE IS RED IF ANY CELL FAILED, IF A METRIC GATE WAS BREACHED, OR IF NOTHING PASSED.
//
// The metric-gate rule is the unambiguous-signal case. A suite with a `classification:` block can
// declare a `gate: fail` threshold, and results.json records every breached one in
// `classification.gateFailures`. That is a product signal of exactly the same kind as a failed
// assertion — `classifyEvalExit` returns 1 for it — and it is the one a per-case pass/fail sweep
// CANNOT express, because a corpus can sit entirely within per-case tolerance while its aggregate
// (a false-approve rate, say) is unacceptable. This matters on the shipped dispatchable path: the
// approvals safety corpus in eval/approvals-anchoring.eval.yaml gates `wrapper_uncovered` at
// max_count 0 — "a catastrophic command that reaches the shell… not one case may do this". Ignoring
// gateFailures would report that run green while `gth eval` failed it.
//
// The nothing-passed half is load-bearing too: a run where every cell skipped has proven nothing,
// and `gth eval` would happily exit 2 for it. Without the >=1-pass rule, forgetting `secrets:
// inherit` on the reusable-workflow call would skip every cell and show up as a green release gate —
// precisely the silent-skip failure this node exists to end.
//
// A MISSING results.json is fatal, not a skip. A provider that validates its key EAGERLY throws from
// inside config construction, aborting the whole matrix before any cell is graded and writing no
// output at all. That is indistinguishable here from a malformed suite, and neither may be reported
// green. MEASURED through the real factories with a fake-key control, the eager set is SIX:
// anthropic, groq, deepseek, xai, openrouter, huggingface — anthropic being the common default, so
// do not read this as an exotic-provider footnote. The lazy set is openai, google-genai, vertexai,
// ollama. CFG-35 made that throw CATCHABLE (so a suite-level failure now exits 2 rather than killing
// the process at 1), but the suite still builds every identity's config up front, so a keyless
// identity still grades nothing and writes nothing. Ending that is OPS-43's job.
//
// KNOWN LIMITATION, PENDING A DECISION — a SKIP does not identify its cause. `sutOk:false` means
// only "no gradeable answer": an absent API key, a 4xx from a rejected tool schema, a timeout, a
// transport fault and an agent crash all produce a byte-identical record, because nothing on that
// path populates `cellResult.error`. This gate tolerates a skip whenever some other cell passed, so
// on the two-cell release subset a regression that breaks exactly one provider still reports green.
// The remedy is a live decision (require every named cell on the release path, a --min-pass floor,
// or recording the cause in results.json — each trades the coverage hole for a flake surface), so
// the limitation is stated in the step summary rather than silently patched here. Do not "fix" it
// by reclassifying non-running cells without that decision.

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {{sutOk?: boolean, verdict?: string}} cell one entry of results.json `cases`
 * @returns {'PASS'|'FAIL'|'SKIP'}
 */
export function classifyCell(cell) {
  if (!cell.sutOk) return 'SKIP';
  return cell.verdict === 'PASS' ? 'PASS' : 'FAIL';
}

/**
 * Collect every results.json under a root (a single suite writes one; several suites write one per
 * suite subdir).
 * @param {string} root
 * @returns {string[]}
 */
export function findResultsFiles(root) {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  const found = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) found.push(...findResultsFiles(path));
    else if (entry === 'results.json') found.push(path);
  }
  return found.sort();
}

/**
 * @param {Array<{id: string, identity?: string, sutOk?: boolean, verdict?: string, reasons?: string[]}>} cases
 * @returns {{pass: number, fail: number, skip: number, rows: Array<{cell: string, state: string, why: string}>}}
 */
export function summarize(cases) {
  const counts = { pass: 0, fail: 0, skip: 0 };
  const rows = cases.map((cell) => {
    const state = classifyCell(cell);
    counts[/** @type {'pass'|'fail'|'skip'} */ (state.toLowerCase())] += 1;
    return {
      cell: cell.identity ? `${cell.id} [${cell.identity}]` : cell.id,
      state,
      why: (cell.reasons ?? []).join('; '),
    };
  });
  return { ...counts, rows };
}

/**
 * Every breached `gate: fail` metric threshold across the parsed summaries, de-duplicated and
 * sorted. A suite with no `classification:` block omits the field entirely, so absence is normal
 * and is not an error.
 * @param {Array<{classification?: {gateFailures?: string[]}}>} summaries parsed results.json contents
 * @returns {string[]}
 */
export function collectGateFailures(summaries) {
  const names = summaries.flatMap((summary) => summary.classification?.gateFailures ?? []);
  return [...new Set(names)].sort();
}

/**
 * The gate rule: red on any real failure, red on a breached metric gate, and red when nothing
 * actually passed.
 * @param {{pass: number, fail: number, skip: number}} counts
 * @param {string[]} gateFailures breached metric names, from {@link collectGateFailures}
 * @returns {{ok: boolean, reason: string}}
 */
export function verdictOf(counts, gateFailures) {
  if (counts.fail > 0) {
    return { ok: false, reason: `${counts.fail} cell(s) produced a real answer that FAILED` };
  }
  if (gateFailures.length > 0) {
    return { ok: false, reason: `a declared metric gate was breached: ${gateFailures.join(', ')}` };
  }
  if (counts.pass === 0) {
    return { ok: false, reason: 'no cell passed — the run proved nothing (every cell skipped?)' };
  }
  return { ok: true, reason: `${counts.pass} cell(s) passed, ${counts.skip} skipped` };
}

/**
 * Make a value safe to place in a markdown table cell: a `|` would start a new column and a newline
 * would end the row, so a `must_contain` string containing either must not be able to break the
 * table it is being reported in.
 * @param {string} value
 * @returns {string}
 */
export function escapeTableCell(value) {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * @param {{pass: number, fail: number, skip: number, rows: Array<{cell: string, state: string, why: string}>}} summary
 * @param {{ok: boolean, reason: string}} verdict
 * @param {string[]} gateFailures breached metric names, from {@link collectGateFailures}
 * @returns {string}
 */
export function renderReport(summary, verdict, gateFailures) {
  const lines = [
    `### Eval gate: ${verdict.ok ? 'PASS' : 'FAIL'}`,
    '',
    `${summary.pass} passed · ${summary.fail} failed · ${summary.skip} skipped — ${verdict.reason}`,
    '',
    '| cell | state | detail |',
    '| --- | --- | --- |',
  ];
  for (const row of summary.rows) {
    lines.push(
      `| ${escapeTableCell(row.cell)} | ${row.state} | ${escapeTableCell(row.why || '')} |`
    );
  }
  // Rendered whenever a gate broke, not only when it is the headline reason: a run can fail a case
  // AND breach a metric gate, and a reader who is told only about the case would never learn the
  // second happened.
  if (gateFailures.length > 0) {
    lines.push(
      '',
      `**Metric gate breached: ${gateFailures.join(', ')}.** A declared \`gate: fail\` threshold ` +
        'was exceeded, which `gth eval` itself exits 1 for. The aggregate is out of bounds even ' +
        'where every individual case sat within tolerance, so this fails the gate on its own.'
    );
  }
  if (summary.skip > 0) {
    lines.push(
      '',
      'A SKIP means the model produced no gradeable answer for that identity — most often an API ' +
        'key that is absent from CI secrets. It is reported here rather than being allowed to ' +
        'pass silently.',
      '',
      '**Known limitation, pending a decision:** this gate cannot confirm that cause. ' +
        'results.json records no reason for a non-running cell, so an absent key is ' +
        'indistinguishable here from a provider-side regression — a rejected tool schema, a ' +
        'timeout, a transport fault or an agent crash all produce the same record. A skip is ' +
        'therefore tolerated whenever at least one other cell passed, which on the two-cell ' +
        'release subset means a fault affecting a single provider can still report green. Do not ' +
        'read a SKIP as evidence that nothing is wrong.'
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * The whole gate decision for one output root, with no IO beyond reading results.json — so the
 * shipped verdict is the tested verdict, including the missing-results.json path.
 * @param {string} root the dir passed to `gth eval -o`
 * @returns {{ok: boolean, exitCode: number, stream: 'stdout'|'stderr', report: string}}
 */
export function runGate(root) {
  const files = findResultsFiles(root);
  if (files.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      stream: 'stderr',
      report:
        `### Eval gate: FAIL\n\nNo results.json under ${root} — the eval aborted before grading ` +
        'anything, so nothing was proven. Usual causes: a suite that failed to parse, or an ' +
        'identity whose provider validates its API key eagerly (anthropic, groq, deepseek, xai, ' +
        'openrouter, huggingface) and aborted the whole matrix from config construction.\n',
    };
  }
  const summaries = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  const cases = summaries.flatMap((summary) => summary.cases ?? []);
  const gateFailures = collectGateFailures(summaries);
  const summary = summarize(cases);
  const verdict = verdictOf(summary, gateFailures);
  return {
    ok: verdict.ok,
    exitCode: verdict.ok ? 0 : 1,
    stream: 'stdout',
    report: renderReport(summary, verdict, gateFailures),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write('usage: eval-gate.mjs <eval-output-dir>\n');
    process.exit(2);
  }
  const result = runGate(root);
  const out = result.stream === 'stderr' ? process.stderr : process.stdout;
  out.write(result.report);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.report);
  process.exit(result.exitCode);
}
