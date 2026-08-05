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
// So the classification is anchored on the field the contract itself is anchored on — per-cell
// `sutOk` in results.json:
//
//   sutOk:false                  -> SKIP. The SUT never ran (missing/rotated key, transport, auth).
//                                  An environment fact, not a regression. Reported, never fatal.
//   sutOk:true  + verdict PASS   -> PASS. A real answer that met the assertions.
//   sutOk:true  + verdict FAIL   -> FAIL. A real, gradeable answer below the bar — a product signal.
//
// THE GATE IS RED IF ANY CELL FAILED, OR IF NOTHING PASSED. The second half is load-bearing: a run
// where every cell skipped has proven nothing, and `gth eval` would happily exit 2 for it. Without
// the >=1-pass rule, forgetting `secrets: inherit` on the reusable-workflow call would skip every
// cell and show up as a green release gate — precisely the silent-skip failure this node exists to
// end.
//
// A MISSING results.json is fatal, not a skip. A provider that validates its key EAGERLY (groq,
// openrouter, huggingface) throws from inside config construction, which loader.ts turns into an
// uncatchable exit(1) that aborts the whole matrix before any cell is graded and writes no output at
// all. That is indistinguishable here from a malformed suite, and neither may be reported green.

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
 * The gate rule: red on any real failure, and red when nothing actually passed.
 * @param {{pass: number, fail: number, skip: number}} counts
 * @returns {{ok: boolean, reason: string}}
 */
export function verdictOf(counts) {
  if (counts.fail > 0) {
    return { ok: false, reason: `${counts.fail} cell(s) produced a real answer that FAILED` };
  }
  if (counts.pass === 0) {
    return { ok: false, reason: 'no cell passed — the run proved nothing (every cell skipped?)' };
  }
  return { ok: true, reason: `${counts.pass} cell(s) passed, ${counts.skip} skipped` };
}

/**
 * @param {{pass: number, fail: number, skip: number, rows: Array<{cell: string, state: string, why: string}>}} summary
 * @param {{ok: boolean, reason: string}} verdict
 * @returns {string}
 */
export function renderReport(summary, verdict) {
  const lines = [
    `### Eval gate: ${verdict.ok ? 'PASS' : 'FAIL'}`,
    '',
    `${summary.pass} passed · ${summary.fail} failed · ${summary.skip} skipped — ${verdict.reason}`,
    '',
    '| cell | state | detail |',
    '| --- | --- | --- |',
  ];
  for (const row of summary.rows) {
    lines.push(`| ${row.cell} | ${row.state} | ${row.why || ''} |`);
  }
  if (summary.skip > 0) {
    lines.push(
      '',
      'A SKIP means the model never ran for that identity — normally an API key absent from CI ' +
        'secrets. It is an environment fact, not a regression, and it is reported here rather than ' +
        'being allowed to pass silently.'
    );
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write('usage: eval-gate.mjs <eval-output-dir>\n');
    process.exit(2);
  }
  const files = findResultsFiles(root);
  if (files.length === 0) {
    const message =
      `### Eval gate: FAIL\n\nNo results.json under ${root} — the eval aborted before grading ` +
      'anything, so nothing was proven. Usual causes: a suite that failed to parse, or an identity ' +
      'whose provider validates its API key eagerly (groq, openrouter, huggingface) and killed the ' +
      'whole matrix from config construction.\n';
    process.stderr.write(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
    process.exit(1);
  }
  const cases = files.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')).cases ?? []);
  const summary = summarize(cases);
  const verdict = verdictOf(summary);
  const report = renderReport(summary, verdict);
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  process.exit(verdict.ok ? 0 : 1);
}
