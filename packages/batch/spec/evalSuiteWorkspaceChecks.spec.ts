import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEvalSuite } from '#src/evalSuite.js';
import { runEvalSuite, classifyEvalExit } from '#src/evalRunner.js';
import {
  compileWorkspaceGlob,
  findWorkspacePathProblem,
  matchesWorkspaceGlob,
} from '#src/workspaceChecks.js';
import type { RunCellFn } from '#src/types.js';

// BATCH-59 — parsing a `command` case's workspace assertions (`file_contains`, `must_not_exist`,
// `after`), the glob dialect, and how the eval runner grades the failures the command runner
// reports. The run-time half (reading the workspace, running the steps) is in the app package's
// `commandWorkspaceChecks.spec.ts`.

let suiteDir: string;
beforeAll(() => {
  suiteDir = mkdtempSync(join(tmpdir(), 'gth-eval-wschecks-parse-'));
});
afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

const TARGET = `
target:
  type: command
  run: claude -p --output-format stream-json --verbose
  transcript: claude-stream-json
`;

function parse(yaml: string) {
  return parseEvalSuite(yaml, 'suite.yaml', { suiteDir });
}

/** A one-case command suite with a default workspace and the given case keys. */
function withCase(caseYaml: string) {
  return parse(`${TARGET}
defaults:
  workspace: {}
cases:
  - id: c
    prompt: "x"
${caseYaml
  .trim()
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
`);
}

describe('parseEvalSuite — workspace assertions', () => {
  it("parses the node's example, with the git pathspec exclusion split as written", () => {
    const suite = withCase(`
file_contains: { "src/greet.mjs": "welcome banner" }
must_not_exist: ["notes/*"]
after:
  - { run: "git status --porcelain -- . ':!src/greet.mjs'", equals: "" }
`);
    const checks = suite.cases[0].workspaceChecks!;
    expect(checks.fileContains).toEqual([
      { path: 'src/greet.mjs', substrings: ['welcome banner'] },
    ]);
    expect(checks.mustNotExist.map((check) => check.pattern)).toEqual(['notes/*']);
    expect(checks.after).toEqual([
      {
        run: "git status --porcelain -- . ':!src/greet.mjs'",
        argv: ['git', 'status', '--porcelain', '--', '.', ':!src/greet.mjs'],
        expect: { kind: 'equals', value: '' },
      },
    ]);
  });

  it('accepts a case whose only assertions are about its workspace', () => {
    const suite = withCase(`must_not_exist: ["*.log"]`);
    expect(suite.cases[0].workspaceChecks?.mustNotExist).toHaveLength(1);
  });

  it('still refuses a command case with a workspace and no assertions at all', () => {
    expect(() => withCase(`description: "nothing to grade"`)).toThrow(
      /has no checks and no judge rubric/
    );
  });

  it('takes a list of strings for one file, and each after kind', () => {
    const suite = withCase(`
file_contains: { "a.txt": ["one", "two"] }
after:
  - { run: "node -v", contains: "v" }
  - { run: "node -e 0", exit_code: 0 }
`);
    const checks = suite.cases[0].workspaceChecks!;
    expect(checks.fileContains[0].substrings).toEqual(['one', 'two']);
    expect(checks.after.map((step) => step.expect)).toEqual([
      { kind: 'contains', value: 'v' },
      { kind: 'exit_code', code: 0 },
    ]);
  });

  it('leaves a case without them, and every non-command case, without the key', () => {
    const suite = withCase(`must_contain: [ok]`);
    expect('workspaceChecks' in suite.cases[0]).toBe(false);
  });

  it('grades the expect: blocks and the workspace assertions together on one case', () => {
    const suite = withCase(`
expect:
  - { must_contain: [ok] }
must_not_exist: ["x"]
`);
    expect(suite.cases[0].turns[0].expectations).toHaveLength(1);
    expect(suite.cases[0].workspaceChecks?.mustNotExist).toHaveLength(1);
  });

  it('refuses them inside an expect: block, where they are unknown keys', () => {
    expect(() =>
      withCase(`
expect:
  - { must_contain: [ok], must_not_exist: ["x"] }
`)
    ).toThrow(/must_not_exist/);
  });

  it('still refuses an expect: block with no checks of its own', () => {
    expect(() =>
      withCase(`
expect:
  - { must_contain: [] }
must_not_exist: ["x"]
`)
    ).toThrow(/expect block 0 has no checks and no judge rubric/);
  });

  it.each([
    ['file_contains', 'file_contains: { "a.txt": "x" }'],
    ['must_not_exist', 'must_not_exist: ["x"]'],
    ['after', 'after: [{ run: "node -v", exit_code: 0 }]'],
  ])('refuses %s on a case with no workspace', (key, yaml) => {
    expect(() =>
      parse(`${TARGET}
cases:
  - { id: c, prompt: "x", ${yaml} }
`)
    ).toThrow(new RegExp(`${key} needs a workspace, and this case has none\\.`));
  });

  it.each([
    ['file_contains', 'file_contains: { "a.txt": "x" }'],
    ['must_not_exist', 'must_not_exist: ["x"]'],
    ['after', 'after: [{ run: "node -v", exit_code: 0 }]'],
  ])('refuses %s on a case that opts out with workspace: false', (key, yaml) => {
    expect(() =>
      parse(`${TARGET}
defaults:
  workspace: {}
cases:
  - { id: c, prompt: "x", workspace: false, ${yaml} }
`)
    ).toThrow(new RegExp(`${key} needs a workspace.*\\(it sets \`workspace: false\`\\)`));
  });

  it.each(['gth-agent', 'ag-ui', 'adk-agent', 'rater'])(
    'refuses each of them on a %s target',
    (type) => {
      const target =
        type === 'gth-agent'
          ? 'target: { type: gth-agent }'
          : type === 'ag-ui'
            ? 'target: { type: ag-ui, url: "http://localhost:1", agent_id: a }'
            : type === 'adk-agent'
              ? 'target: { type: adk-agent, url: "http://localhost:1" }'
              : 'target: { type: rater, rung: assisted }\nclassification: { labels: [safe] }';
      for (const [key, yaml] of [
        ['file_contains', 'file_contains: { "a.txt": "x" }'],
        ['must_not_exist', 'must_not_exist: ["x"]'],
        ['after', 'after: [{ run: "node -v", exit_code: 0 }]'],
      ]) {
        expect(() =>
          parse(`${target}
cases:
  - { id: c, prompt: "x", must_contain: [ok], ${yaml} }
`)
        ).toThrow(
          new RegExp(`case "c" ${key} is only read by a "command" target.*A workspace needs`)
        );
      }
    }
  );

  it('refuses them on a turns: entry, where they are unknown keys', () => {
    expect(() =>
      parse(`target: { type: gth-agent }
cases:
  - id: c
    turns:
      - { user: "x", must_contain: [ok], must_not_exist: ["x"] }
`)
    ).toThrow(/must_not_exist/);
  });

  it.each([
    ['an absolute POSIX path', '/etc/passwd', /is absolute/],
    ['a .. segment', 'src/../../x', /has a "\.\." segment/],
    ['a bare ..', '..', /has a "\.\." segment/],
    ['a drive letter', 'C:/Windows/win.ini', /starts with a drive letter/],
    ['a drive-relative path', 'C:x', /starts with a drive letter/],
    ['a leading backslash', '\\x', /contains a backslash/],
    ['a UNC path', '\\\\server\\share\\x', /contains a backslash/],
    ['a backslash .. escape', '..\\x', /contains a backslash/],
    ['a leading ./', './a.txt', /empty or "\." segment/],
    ['an empty segment', 'a//b', /empty or "\." segment/],
    ['an empty path', '', /is empty/],
  ])('refuses a file_contains path with %s at parse', (_name, path, message) => {
    expect(() => withCase(`file_contains: { ${JSON.stringify(path)}: "x" }`)).toThrow(message);
  });

  it.each([
    ['an absolute path', '/tmp/*', /is absolute/],
    ['a .. segment', '../*', /has a "\.\." segment/],
    ['a drive letter', 'D:/x', /starts with a drive letter/],
    ['a backslash', 'notes\\*', /contains a backslash/],
    ['a character class', 'notes/[ab].txt', /uses "\["/],
    ['a brace alternative', 'notes/{a,b}', /uses "\{"/],
    ['a negation', '!keep.txt', /starts with "!"/],
    ['** inside a segment', 'a**b', /"\*\*" must be a whole segment/],
  ])('refuses a must_not_exist glob with %s at parse', (_name, pattern, message) => {
    expect(() => withCase(`must_not_exist: [${JSON.stringify(pattern)}]`)).toThrow(message);
  });

  it.each([
    ['an empty file_contains', 'file_contains: {}', /file_contains is empty/],
    ['an empty string list', 'file_contains: { "a.txt": [] }', /lists no strings/],
    ['an empty string', 'file_contains: { "a.txt": "" }', /an empty string, which every file/],
    ['an empty must_not_exist', 'must_not_exist: []', /must_not_exist is empty/],
    ['an empty after', 'after: []', /after is empty/],
    ['a step with no check', 'after: [{ run: "node -v" }]', /exactly one of.*asserts nothing/],
    [
      'a step with two checks',
      'after: [{ run: "node -v", equals: "", exit_code: 0 }]',
      /exactly one of.*sets equals and exit_code/,
    ],
    ['contains ""', 'after: [{ run: "node -v", contains: "" }]', /contains "", which every/],
    ['equals with padding', 'after: [{ run: "node -v", equals: " v1 " }]', /trimmed/],
    ['a shell pipe', 'after: [{ run: "git status | wc -l", equals: "0" }]', /unquoted "\|"/],
    [
      'an unknown token',
      'after: [{ run: "cat {{suite-dir}}/x", exit_code: 0 }]',
      /unknown token \{\{suite-dir\}\}/,
    ],
    [
      'a split token',
      'after: [{ run: "cat {{ workspace }}", exit_code: 0 }]',
      /not part of a complete token/,
    ],
  ])('refuses %s', (_name, yaml, message) => {
    expect(() => withCase(yaml)).toThrow(message);
  });

  it('keeps equals: "" and exit_code: 0, the two falsy values that matter most', () => {
    const suite = withCase(`
after:
  - { run: "git diff --stat", equals: "" }
  - { run: "node -e 0", exit_code: 0 }
`);
    expect(suite.cases[0].workspaceChecks?.after.map((step) => step.expect)).toEqual([
      { kind: 'equals', value: '' },
      { kind: 'exit_code', code: 0 },
    ]);
  });
});

describe('workspace path guard and glob dialect', () => {
  it('accepts plain relative paths', () => {
    expect(findWorkspacePathProblem('src/greet.mjs')).toBeUndefined();
    expect(findWorkspacePathProblem('.env')).toBeUndefined();
    expect(findWorkspacePathProblem('..cache/x')).toBeUndefined();
  });

  const matches = (pattern: string, path: string): boolean =>
    matchesWorkspaceGlob(compileWorkspaceGlob(pattern), path);

  it('matches a leading dot under * and ?, so notes/* catches notes/.hidden', () => {
    expect(matches('notes/*', 'notes/.hidden')).toBe(true);
    expect(matches('*', '.env')).toBe(true);
    expect(matches('?env', '.env')).toBe(true);
  });

  it('keeps * and ? inside one segment', () => {
    expect(matches('notes/*', 'notes/sub/deep.txt')).toBe(false);
    expect(matches('notes/*', 'notes')).toBe(false);
    expect(matches('a?c', 'a/c')).toBe(false);
  });

  it('matches zero or more whole segments with **', () => {
    expect(matches('notes/**', 'notes')).toBe(true);
    expect(matches('notes/**', 'notes/a/b/c')).toBe(true);
    expect(matches('**/*.log', 'debug.log')).toBe(true);
    expect(matches('**/*.log', 'a/.b/c.log')).toBe(true);
    expect(matches('**/*.log', 'a/b/c.txt')).toBe(false);
  });

  it('treats other characters literally and case-sensitively', () => {
    expect(matches('a.txt', 'a.txt')).toBe(true);
    expect(matches('a.txt', 'abtxt')).toBe(false);
    expect(matches('a+b(1).txt', 'a+b(1).txt')).toBe(true);
    expect(matches('A.txt', 'a.txt')).toBe(false);
  });

  it('stays fast with many ** segments on a deep path', () => {
    const pattern = Array.from({ length: 20 }, () => '**').join('/') + '/nope';
    const path = Array.from({ length: 60 }, (_, i) => `d${i}`).join('/');
    const started = Date.now();
    expect(matches(pattern, path)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('runEvalSuite — workspace failures from the command runner', () => {
  const suite = () => withCase(`must_not_exist: ["notes/*"]`);

  it('passes a case whose runner reported no workspace failures', async () => {
    const runCell: RunCellFn = async () => ({ ok: true, answer: 'done' });
    const summary = await runEvalSuite(suite(), { runCell });
    expect(summary.cases[0].verdict).toBe('PASS');
    expect(classifyEvalExit(summary)).toBe(0);
  });

  it('fails the case on a reported workspace failure, as a product signal (exit 1)', async () => {
    const runCell: RunCellFn = async () => ({
      ok: true,
      answer: 'done',
      workspaceFailures: ['must_not_exist "notes/*": the workspace has notes/.hidden'],
    });
    const summary = await runEvalSuite(suite(), { runCell });
    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].sutOk).toBe(true);
    expect(summary.cases[0].reasons).toEqual([
      'must_not_exist "notes/*": the workspace has notes/.hidden',
    ]);
    expect(classifyEvalExit(summary)).toBe(1);
  });
});
