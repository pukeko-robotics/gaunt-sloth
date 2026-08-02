// Runner for the Stage D PTY e2e (Ink TUI). tui-test copies its cwd tree into a transpiled
// cache and reads config/tests relative to process.cwd(), so the e2e MUST run from the
// `tui-e2e` folder (otherwise it would copy the whole package — including deliberately broken
// IT fixtures — and swc would choke). `npm run` + `npx` reorients cwd unpredictably, so we
// spawn the runner ourselves with an explicit cwd instead of relying on a shell `cd`.
//
// QA-13: stdout/stderr are piped and teed rather than inherited, so the run's report can be read
// back and a *flaky* outcome escapes the log. tui-test exits 0 on a flake (it counts only
// genuinely-failed tests), which is the right exit code but leaves the flake as one yellow line
// in a green job that nobody opens. See tui-e2e-report.mjs for why this is done by parsing.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { analyseRun, githubAnnotations, repoPath, stepSummaryMarkdown } from './tui-e2e-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = path.join(here, 'tui-e2e');
const bin = createRequire(import.meta.url).resolve('@microsoft/tui-test');

// Keep the child's environment byte-identical to what it was under `stdio: 'inherit'`. tui-test
// derives `FORCE_COLOR` for its test workers from whether ITS OWN stdout supports colour, and
// that env reaches the `gth` processes under test (the fixtures spread `process.env`). Piping
// would make its stdout a non-TTY and silently drop the variable, changing what the TUI renders
// mid-test. Setting it from *our* TTY-ness reproduces the old value exactly. In CI nothing is a
// TTY and chalk keys off the CI vendor instead, which is unchanged either way.
const env = { ...process.env, ...(process.stdout.isTTY ? { FORCE_COLOR: '1' } : {}) };

// Only stdout is captured for parsing. The list reporter writes the summary and the numbered
// headers exclusively to stdout; stderr carries just the fatal paths (a bad filter, the global
// timeout), each of which exits non-zero anyway and is preserved as such below. Folding stderr in
// would let an async write interleave mid-line and break a line-anchored match, turning a healthy
// run into a hard "the flake check went blind" failure. Both streams are still teed through.
const stdoutChunks = [];
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  cwd: e2eDir,
  stdio: ['inherit', 'pipe', 'pipe'],
  env,
});
child.stdout.on('data', (chunk) => {
  stdoutChunks.push(chunk);
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

// `close` rather than `exit`: it fires once the piped streams are drained, so nothing is missed.
child.on('close', (code) => {
  const childCode = code ?? 1;
  // Concatenate as Buffers before decoding: a multi-byte character split across two chunks would
  // be corrupted by decoding each chunk separately.
  const analysis = analyseRun(Buffer.concat(stdoutChunks).toString('utf8'));

  if (analysis.problem) {
    // The flake check has gone blind. Reporting "no flakes" here would be a green light from a
    // gate that measured nothing, so say so and fail even if tui-test itself was happy.
    process.stderr.write(
      `\n✗ tui-e2e flake check could not read the run report: ${analysis.problem}\n`
    );
    process.exit(childCode === 0 ? 1 : childCode);
  }

  if (analysis.flaky.length > 0) {
    const lines = analysis.flaky.map(
      (entry) => `    ${repoPath(entry)}:${entry.row} › ${entry.title}`
    );
    process.stdout.write(
      `\n⚠ ${analysis.flaky.length} FLAKY test(s) — passed only on a retry, so this run is green ` +
        `but the defect is real:\n${lines.join('\n')}\n` +
        `  Record it in docs/known-flakes.md (takahe) so the next person mid-merge does not have ` +
        `to re-derive it.\n`
    );

    if (process.env.GITHUB_ACTIONS) {
      for (const annotation of githubAnnotations(analysis.flaky)) {
        process.stdout.write(`${annotation}\n`);
      }
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        stepSummaryMarkdown(analysis.flaky, { os: process.platform }),
        'utf8'
      );
    }
  }

  // A flake stays green: tui-test's own exit code is the authority on pass/fail, and the node's
  // acceptance asks for a flake to be *reported as flaky rather than as a pass*, not to be turned
  // into a failure. Promoting a flake to a hard failure is the promote-after-soak rule, which
  // belongs to OPS-14.
  process.exit(childCode);
});
