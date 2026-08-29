import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * OPS-98 — the hand-written release notes must stay wired into the release job.
 *
 * scripts/release-notes-for.mjs is unit-tested next door, but a script nothing invokes is the
 * failure mode that looks exactly like success: the Release page would go back to a list of merged
 * pull requests and every test would stay green. The helper reaches the release through strings in
 * a workflow file — a `run:` line and two `gh release create` invocations — none of which is
 * type-checked, executed by the unit suite, or referenced from any code path. That is the same
 * "preserved by nothing" problem docsRenderGateWired.spec.ts exists to solve for `docs:check`.
 *
 * Three properties are asserted beyond "the script is called", because each is a way this change
 * could break a release rather than merely undo itself:
 *
 *  - the `gh release view` skip stays, so a re-dispatch after a failed publish does not die;
 *  - the `--generate-notes` fallback stays, so a version with no notes file still gets a body;
 *  - the run block interpolates no `${{ }}` expression. An expression is spliced into the script as
 *    TEXT before bash parses it, and a release note title may contain a backtick
 *    (release-notes/v1_2_0.md) — which would then run as command substitution inside the release
 *    job. Values reach the block through `env:` instead, where an expanded variable is never
 *    rescanned. A green run cannot review that property; only this can.
 *
 * This asserts facts about the *files*. What the helper itself does is proven by running it, in
 * releaseNotesFor.spec.ts.
 */

const RELEASE_WORKFLOW = new URL('../../../.github/workflows/release.yml', import.meta.url);
const HELPER = new URL('../../../scripts/release-notes-for.mjs', import.meta.url);

const RELEASE_JOB = 'release';
const HELPER_COMMAND = 'node scripts/release-notes-for.mjs';
const RELEASE_STEP = 'Create GitHub Release';

/**
 * One job's text, from its `<id>:` key to the start of the next job. Same slicing as
 * docsRenderGateWired.spec.ts, and the terminator is `[^\s#]` for the same reason: a job id may
 * begin with `_` or be quoted, and against an identifier-shaped pattern the slice would run to end
 * of file, letting another job's steps satisfy an assertion about this one.
 */
function jobText(workflow: string, jobId: string): string {
  const start = workflow.indexOf(`\n  ${jobId}:`);
  if (start === -1) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[^\s#]/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * One step's text within a job, from its `- name: <name>` to the next step at the same indent.
 * Steps in this workflow are indented six spaces.
 */
function stepText(job: string, stepName: string): string {
  const start = job.indexOf(`\n      - name: ${stepName}\n`);
  if (start === -1) return '';
  const rest = job.slice(start + 1);
  const next = rest.search(/\n {6}- /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The shell body of a step's `run: |` block scalar — everything after the `run:` line. */
function runBlock(step: string): string {
  const match = /^[ \t]*run: \|[ \t]*$/m.exec(step);
  if (!match) return '';
  return step.slice(match.index + match[0].length);
}

/**
 * A command at the start of a line inside a block scalar. `^[ \t]*` admits only whitespace before
 * it, so a `#`-commented-out line cannot match — which a plain substring search cannot tell apart
 * from a live one, and commenting a line out is how a step usually gets "temporarily" disabled.
 */
function blockLine(command: string): RegExp {
  return new RegExp(`^[ \\t]*${command}`, 'm');
}

/** A single-line `run: <command>` step, as docsRenderGateWired.spec.ts matches one. */
function runStep(command: string): RegExp {
  return new RegExp(`^[ \\t]*run:[ \\t]*${command}`, 'm');
}

function releaseJob(): string {
  return jobText(readFileSync(RELEASE_WORKFLOW, 'utf8'), RELEASE_JOB);
}

describe('OPS-98 the release notes helper is wired into the release job', () => {
  it('has the helper script', () => {
    expect(existsSync(HELPER), 'scripts/release-notes-for.mjs is missing').toBe(true);
  });

  it('runs the helper as a step of the release job', () => {
    expect(
      runStep(HELPER_COMMAND).test(releaseJob()),
      `the "${RELEASE_JOB}" job in .github/workflows/release.yml must run "${HELPER_COMMAND}" — ` +
        'without it the Release page falls back to a list of merged pull requests and the ' +
        'hand-written release-notes/ file is read by nothing, with every test still green.'
    ).toBe(true);
  });

  it('passes the resolved notes to gh as a title and a notes file', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    expect(step, `the "${RELEASE_STEP}" step has no run block`).not.toBe('');
    expect(
      blockLine('gh release create .*--notes-file "\\$NOTES_BODY_FILE"').test(step),
      'the Release must be created with --notes-file pointing at the body the helper wrote'
    ).toBe(true);
    expect(
      blockLine('gh release create .*--title "\\$NOTES_TITLE"').test(step),
      'the Release title must come from the helper, not from a hardcoded version string'
    ).toBe(true);
  });

  it('keeps the --generate-notes fallback for a version with no notes file', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    expect(
      blockLine('gh release create .*--generate-notes').test(step),
      'a version nobody wrote notes for must still get a body — an empty Release is worse than ' +
        'a partial list of PRs. Removing this branch is a deliberate decision, not a cleanup.'
    ).toBe(true);
  });

  it('keeps the already-exists skip, so a re-dispatch does not die', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    expect(
      blockLine('if gh release view "v\\$\\{VERSION\\}" >/dev/null 2>&1; then').test(step),
      'a re-dispatch after a failed publish finds the Release already created by the first ' +
        'attempt; without this guard the second run fails on it.'
    ).toBe(true);
  });

  it('interpolates no workflow expression into the release shell', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    // Control: an empty slice would satisfy the assertion below for the wrong reason.
    expect(step).toContain('gh release create');
    expect(
      step.includes('${{'),
      'a ${{ }} expression is substituted into this block as TEXT before bash parses it, so a ' +
        'release note title containing a backtick would run as command substitution in the ' +
        'release job. Pass the value through `env:` and reference it as a quoted variable.'
    ).toBe(false);
  });

  it('slices only the named step, not the ones after it', () => {
    // Control for stepText: the step after "Create GitHub Release" publishes to npm, and if the
    // slice ran past the end of the step every assertion above would be reading the wrong text.
    const step = stepText(releaseJob(), RELEASE_STEP);
    expect(step).toContain('gh release create');
    expect(step).not.toContain('release:publish');
  });
});
