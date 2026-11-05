import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * OPS-156 — nothing in this repository starts on a pull request, and the AI review runs by hand.
 *
 * Scanners look for workflows that run on a PR event and open malicious PRs against them. They do
 * not get anywhere, but they are noise, so the repository stops advertising the trigger at all.
 * That is why the literal `pull_request_target` is banned from the whole of each file, comments
 * included, rather than only from `on:`: a scanner matching on the string does not read YAML.
 *
 * Every file is found by reading the directory, so a workflow added later is covered without
 * anyone remembering to list it. The list is asserted non-empty, and every file must yield a
 * non-empty `on:` value, so a broken path or a reader that stopped matching goes red rather than
 * passing with nothing to check.
 *
 * The rest pins what dispatching changes in `review.yml`. A dispatched run has no pull request in
 * its event payload, so anything still reading the number from there fails only once a real run
 * reaches it. The input is free text to anything that dispatches through the API, so it reaches
 * shell and script bodies through `env:` alone. And the review step is unconditional, because a
 * skipped step would turn a keyless run into a green build with no review.
 *
 * Asserted against the workflow text: nothing executes these files in the unit suite, nothing
 * type-checks them, and no code path references them, so a refactor can drop any of it with no
 * signal at all. Same reasoning as `reviewWorkflowReportGuard.spec.ts`.
 */
const WORKFLOWS_DIR = new URL('../../../.github/workflows/', import.meta.url);

const REVIEW_WORKFLOW = 'review.yml';
const SCANNED_LITERAL = 'pull_request_target';
const PR_STARTED_EVENT = /\b(?:pull_request\w*|issue_comment)\b/g;
const ON_KEY = /^["']?on["']?\s*:/;

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name));
}

function readWorkflow(name: string): string {
  return readFileSync(new URL(name, WORKFLOWS_DIR), 'utf8');
}

/**
 * What the top-level `on:` key holds, comments stripped: the rest of its own line plus everything
 * up to the next top-level key. One slice serves the block, inline-list, inline-map and scalar
 * forms, and because it stops at the next key, the `github.event.pull_request.head.sha ||
 * github.sha` expressions further down a workflow are not read as triggers. They are dead on a
 * non-PR run, not a way to start one.
 */
function onValue(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => ON_KEY.test(line));
  expect(start, 'expected a top-level on: key').toBeGreaterThanOrEqual(0);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[^\s#\]}]/.test(line));
  const body = end === -1 ? rest : rest.slice(0, end);

  return [lines[start].replace(ON_KEY, ''), ...body]
    .map((line) => line.replace(/(?:^|\s)#.*$/, ''))
    .join('\n');
}

function prStartedEvents(text: string): string[] {
  return onValue(text).match(PR_STARTED_EVENT) ?? [];
}

/** The keys directly under `on:`, which is what a workflow's triggers are in the block form. */
function triggers(text: string): string[] {
  const lines = onValue(text)
    .split('\n')
    .filter((line) => line.trim() !== '');
  const indentOf = (line: string): number => line.search(/\S/);
  const outermost = Math.min(...lines.map(indentOf));
  return lines
    .filter((line) => indentOf(line) === outermost)
    .map((line) => line.trim().replace(/:.*$/, ''));
}

/**
 * A workflow's steps, split on the `- name:`/`- uses:` that opens each one, so a step's text
 * carries its own `if:` and nobody else's — the same splitter, and the same reason for it, as
 * `reviewWorkflowReportGuard.spec.ts`.
 */
function steps(): string[] {
  return readWorkflow(REVIEW_WORKFLOW)
    .split(/^ {6}- (?=name:|uses:)/m)
    .slice(1);
}

function stepNamed(name: string): string {
  const found = steps().filter((step) => step.startsWith(`name: ${name}`));
  expect(found, `expected one step named ${name}`).toHaveLength(1);
  return found[0];
}

describe('the on: reader', () => {
  it.each([
    ['block', 'on:\n  pull_request:\n    types: [opened]\njobs:\n  a:\n'],
    ['block list', 'on:\n  - push\n  - issue_comment\njobs:\n  a:\n'],
    ['inline list', 'on: [push, pull_request]\njobs:\n  a:\n'],
    ['multi-line list', 'on: [\n  push,\n  pull_request_review\n]\njobs:\n  a:\n'],
    ['inline map', 'on: { pull_request: { branches: [main] } }\njobs:\n  a:\n'],
    ['scalar', 'on: pull_request\njobs:\n  a:\n'],
    ['quoted key', '"on":\n  pull_request_target:\njobs:\n  a:\n'],
    ['last key in the file', 'name: x\non:\n  pull_request:\n'],
  ])('finds a PR event in the %s form', (_form, text) => {
    expect(prStartedEvents(text)).toHaveLength(1);
  });

  it('does not read a dead PR expression further down the file as a trigger', () => {
    const text =
      'on:\n  push:\njobs:\n  a:\n    steps:\n      - with:\n' +
      '          ref: ${{ github.event.pull_request.head.sha || github.sha }}\n';
    expect(prStartedEvents(text)).toEqual([]);
  });

  it('ignores a comment inside the on: block', () => {
    expect(prStartedEvents('on:\n  # not pull_request\n  push:\njobs:\n  a:\n')).toEqual([]);
  });
});

describe('.github/workflows', () => {
  it('finds the workflows by reading the directory', () => {
    const files = workflowFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(REVIEW_WORKFLOW);
  });

  it.each(workflowFiles())('%s starts on no pull request event', (name) => {
    const text = readWorkflow(name);
    expect(onValue(text).trim(), `expected ${name} to have an on: value`).not.toBe('');
    expect(prStartedEvents(text)).toEqual([]);
  });

  it.each(workflowFiles())('%s does not carry the literal scanners match on', (name) => {
    expect(readWorkflow(name)).not.toContain(SCANNED_LITERAL);
  });
});

describe('review.yml runs by hand against a PR number', () => {
  it('has workflow_dispatch as its only trigger', () => {
    expect(triggers(readWorkflow(REVIEW_WORKFLOW))).toEqual(['workflow_dispatch']);
  });

  it('requires the PR number as a number', () => {
    const [, input] = onValue(readWorkflow(REVIEW_WORKFLOW)).split('pr_number:');
    expect(input, 'expected a pr_number input').toBeDefined();
    expect(input).toContain('required: true');
    expect(input).toContain('type: number');
  });

  it('runs one job, under the environment that holds the keys and has no reviewers to wait on', () => {
    const environments = readWorkflow(REVIEW_WORKFLOW).match(/^ *environment: .*$/gm) ?? [];
    expect(environments.map((line) => line.trim())).toEqual(['environment: review-internal']);
  });

  it('quotes the run name, because an unquoted # would cut the number off it', () => {
    expect(readWorkflow(REVIEW_WORKFLOW)).toMatch(
      /^run-name: '[^'\n]*#\$\{\{ inputs\.pr_number \}\}'$/m
    );
  });

  it('validates the input first, before any step that can see a secret', () => {
    const [first] = steps();
    expect(first).toContain('[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]');
    expect(first).toContain('exit 1');
    expect(first).not.toContain('secrets.');
  });

  it('does not make the review step conditional, so a keyless run cannot skip to green', () => {
    expect(stepNamed('Perform code review')).not.toMatch(/^\s*if:/m);
  });

  it('reads nothing from a pull request event payload', () => {
    const text = readWorkflow(REVIEW_WORKFLOW);
    expect(text).not.toContain('context.issue.number');
    expect(text).not.toContain('github.event.pull_request');
  });

  it('posts to the dispatched PR from env, in both comment calls', () => {
    const step = stepNamed('Hide older AI review comments and post new one');
    expect(step).toContain('const prNumber = Number(process.env.PR_NUMBER);');
    expect(step.match(/issue_number: prNumber,/g) ?? []).toHaveLength(2);
  });

  /**
   * An allowlist rather than a search of `run:` and `script:` bodies: an expression naming either
   * number may sit in the run name or as the whole value of an `env:` entry, and nowhere else. That
   * leaves no shape of script body to get wrong. The two exact entries are asserted first, so an
   * empty match cannot pass. The match ignores case because GitHub expressions do:
   * `inputs.PR_NUMBER` reads the same input.
   */
  it('never writes either number into a script body as an expression', () => {
    const interpolated = readWorkflow(REVIEW_WORKFLOW)
      .split('\n')
      .filter((line) => /\$\{\{[^}]*(?:pr_number|issue_number)[^}]*\}\}/i.test(line))
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('run-name:'));

    expect(interpolated).toContain('PR_NUMBER: ${{ inputs.pr_number }}');
    expect(interpolated).toContain('ISSUE_NUMBER: ${{ steps.extract_issue.outputs.issue_number }}');
    for (const line of interpolated) {
      expect(line).toMatch(/^[A-Z_]+: \$\{\{ [^}]+ \}\}$/);
    }
  });
});
