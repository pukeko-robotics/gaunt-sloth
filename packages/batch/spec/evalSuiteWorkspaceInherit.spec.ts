import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEvalSuite } from '#src/evalSuite.js';

// BATCH-63 — parsing the three workspace additions: `cwd` (where the command starts), `inherit`
// (a case block merged over the default, key by key) and a `null` env value (removal).

let suiteDir: string;
beforeAll(() => {
  suiteDir = mkdtempSync(join(tmpdir(), 'gth-eval-ws-inherit-'));
  mkdirSync(join(suiteDir, 'fixtures', 'tiny-repo'), { recursive: true });
  mkdirSync(join(suiteDir, 'fixtures', 'other'), { recursive: true });
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

const DEFAULTS = `
defaults:
  workspace:
    template: fixtures/tiny-repo
    setup: ["git init -q", "git add -A"]
    env: { A: "1", B: "default-b", GH_TOKEN: "from-default" }
    cwd: sub/dir
`;

describe('parseEvalSuite — workspace cwd', () => {
  it('keeps cwd as written on the normalized workspace', () => {
    const suite = parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { cwd: worktrees/fix } }
`);
    expect(suite.cases[0].workspace).toStrictEqual({
      suiteDir,
      setup: [],
      env: {},
      cwd: 'worktrees/fix',
    });
  });

  for (const [cwd, reason] of [
    ['/abs/dir', 'is absolute'],
    ['../outside', 'has a ".." segment'],
    ['a/../../b', 'has a ".." segment'],
    ['a\\\\b', 'contains a backslash'],
    ['C:/x', 'starts with a drive letter'],
    ['./x', 'has an empty or "." segment'],
    ['{{workspace}}/x', 'uses a {{…}} token'],
  ] as const) {
    it(`refuses cwd ${JSON.stringify(cwd)} at parse`, () => {
      expect(() =>
        parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { cwd: "${cwd}" } }
`)
      ).toThrow(reason);
    });
  }

  it('refuses a bad cwd in defaults too, naming the block', () => {
    expect(() =>
      parse(`${TARGET}
defaults: { workspace: { cwd: "../x" } }
cases:
  - { id: a, prompt: "x", must_contain: [ok] }
`)
    ).toThrow('defaults.workspace: cwd "../x" has a ".." segment');
  });
});

describe('parseEvalSuite — workspace inherit', () => {
  it('merges key by key: omitted keys from the default, env by name, setup replaced whole', () => {
    const suite = parse(`${TARGET}${DEFAULTS}
cases:
  - id: merged
    prompt: "x"
    must_contain: [ok]
    workspace:
      inherit: true
      setup: ["echo one"]
      env: { B: "case-b", C: "3", GH_TOKEN: null }
`);
    expect(suite.cases[0].workspace).toStrictEqual({
      suiteDir,
      template: resolve(suiteDir, 'fixtures/tiny-repo'),
      // The case's one step, NOT the default's two followed or preceded by it.
      setup: [{ run: 'echo one', argv: ['echo', 'one'] }],
      // The null survives the merge, so it removes the default's value at run time too.
      env: { A: '1', B: 'case-b', C: '3', GH_TOKEN: null },
      cwd: 'sub/dir',
    });
  });

  it("keeps the default's setup when the case omits it, and clears it with setup: []", () => {
    const suite = parse(`${TARGET}${DEFAULTS}
cases:
  - { id: keeps, prompt: "x", must_contain: [ok], workspace: { inherit: true, env: { D: "4" } } }
  - { id: clears, prompt: "x", must_contain: [ok], workspace: { inherit: true, setup: [] } }
`);
    expect(suite.cases[0].workspace?.setup.map((step) => step.run)).toStrictEqual([
      'git init -q',
      'git add -A',
    ]);
    expect(suite.cases[0].workspace?.env).toStrictEqual({
      A: '1',
      B: 'default-b',
      GH_TOKEN: 'from-default',
      D: '4',
    });
    expect(suite.cases[1].workspace?.setup).toStrictEqual([]);
    expect(suite.cases[1].workspace?.env).toStrictEqual({
      A: '1',
      B: 'default-b',
      GH_TOKEN: 'from-default',
    });
  });

  it('replaces template and cwd when the case sets them', () => {
    const suite = parse(`${TARGET}${DEFAULTS}
cases:
  - id: own
    prompt: "x"
    must_contain: [ok]
    workspace: { inherit: true, template: fixtures/other, cwd: elsewhere }
`);
    expect(suite.cases[0].workspace?.template).toBe(resolve(suiteDir, 'fixtures/other'));
    expect(suite.cases[0].workspace?.cwd).toBe('elsewhere');
  });

  it('puts a case env key after the default ones, so its spelling is applied last', () => {
    const suite = parse(`${TARGET}
defaults: { workspace: { env: { Path: "d", A: "1" } } }
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { inherit: true, env: { Path: null } } }
`);
    expect(Object.keys(suite.cases[0].workspace!.env)).toStrictEqual(['A', 'Path']);
  });

  it('keeps the wholesale rule without inherit, and with inherit: false', () => {
    const suite = parse(`${TARGET}${DEFAULTS}
cases:
  - { id: plain, prompt: "x", must_contain: [ok], workspace: { setup: ["echo hi"] } }
  - { id: off, prompt: "x", must_contain: [ok], workspace: { inherit: false, setup: ["echo hi"] } }
`);
    for (const evalCase of suite.cases) {
      expect(evalCase.workspace).toStrictEqual({
        suiteDir,
        setup: [{ run: 'echo hi', argv: ['echo', 'hi'] }],
        env: {},
      });
    }
  });

  it('refuses inherit: true when the suite has no default workspace', () => {
    expect(() =>
      parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { inherit: true } }
`)
    ).toThrow('case "a" workspace: `inherit: true` needs a `defaults.workspace`');
  });

  it('refuses inherit inside defaults itself', () => {
    expect(() =>
      parse(`${TARGET}
defaults: { workspace: { inherit: true, template: fixtures/tiny-repo } }
cases:
  - { id: a, prompt: "x", must_contain: [ok] }
`)
    ).toThrow('defaults.workspace: `inherit` is a case key');
  });

  it('still validates the case block it merges: a bad token is refused', () => {
    expect(() =>
      parse(`${TARGET}${DEFAULTS}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { inherit: true, env: { X: "{{nope}}" } } }
`)
    ).toThrow('uses the unknown token {{nope}}');
  });
});

describe('parseEvalSuite — env null', () => {
  it('reads null, ~ and an empty YAML value as removal, and keeps "" as an empty value', () => {
    const suite = parse(`${TARGET}
cases:
  - id: a
    prompt: "x"
    must_contain: [ok]
    workspace:
      env:
        GONE: null
        TILDE: ~
        BARE:
        EMPTY: ""
`);
    expect(suite.cases[0].workspace?.env).toStrictEqual({
      GONE: null,
      TILDE: null,
      BARE: null,
      EMPTY: '',
    });
  });
});
