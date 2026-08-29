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
 *  - a version with no notes file gets an EMPTY body, stated explicitly with `--notes ""`, and
 *    nothing synthesises one for it. `--generate-notes` would fill the page with merged pull
 *    requests, which here describe whatever happened to open one rather than the release — blank
 *    says nothing, that list says something untrue. The empty body is spelled out rather than left
 *    implicit so the step does not depend on `gh` deciding it cannot prompt;
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

  it('creates the Release with an explicitly empty body when there is no notes file', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    expect(step, `the "${RELEASE_STEP}" step has no run block`).not.toBe('');
    expect(
      blockLine('gh release create .*--notes ""').test(step),
      'a version nobody wrote notes for must still create the Release, with an empty body stated ' +
        'as `--notes ""`. Omitting the notes flags instead leaves the body to whatever `gh` does ' +
        'when it decides it cannot prompt, which is not a property this step should rest on.'
    ).toBe(true);
  });

  it('synthesises nothing to fill an empty Release body', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    // Control: an empty slice would satisfy the assertion below for the wrong reason.
    expect(step).toContain('gh release create');
    expect(
      step.includes('--generate-notes'),
      'the Release body is the notes we wrote or nothing. `--generate-notes` fills the page with ' +
        'merged pull requests, and branches here land by local merge and usually open none — so ' +
        'that list describes whatever happened to arrive as a PR, not this release. Blank says ' +
        'nothing; a plausible-looking list of unrelated changes says something untrue.'
    ).toBe(false);
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

  /**
   * The workflow is one of five places that described the generated-PR-list fallback: the step
   * itself, the helper's docblock, and three documents that tell a human (or an agent) what a
   * release does. Removing the behaviour from the shell while a document still promises it leaves
   * the repository stating something false, and the next person to touch the step reinstates it
   * from the doc. The list is hardcoded rather than a glob: archived notes under release-notes/
   * may name the flag as history, and those files are not ours to rewrite.
   */
  describe('nothing still promises the generated pull request list', () => {
    const FILES = [
      'AGENTS.md',
      'maintenance/RELEASE-HOWTO.md',
      'release-notes/RELEASE-NOTES-HOWTO.md',
      'scripts/release-notes-for.mjs',
      '.github/workflows/release.yml',
    ];

    it.each(FILES)('%s does not mention --generate-notes', (file) => {
      const text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
      // Control: a renamed file throws on the read above, but an emptied or stubbed one would
      // pass the sweep by having no content to fail on — the same result as the sweep succeeding.
      expect(text.length, `${file} is unexpectedly short`).toBeGreaterThan(200);
      expect(
        text.includes('--generate-notes'),
        `${file} still describes the Release body being synthesised from merged pull requests. ` +
          'The release job no longer does that; a document that says otherwise is how the branch ' +
          'gets put back.'
      ).toBe(false);
    });
  });

  it('slices only the named step, not the ones after it', () => {
    // Control for stepText: the step after "Create GitHub Release" publishes to npm, and if the
    // slice ran past the end of the step every assertion above would be reading the wrong text.
    const step = stepText(releaseJob(), RELEASE_STEP);
    expect(step).toContain('gh release create');
    expect(step).not.toContain('release:publish');
  });
});
