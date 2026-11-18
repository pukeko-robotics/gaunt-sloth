import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEvalSuite } from '#src/evalSuite.js';
import { expandWorkspaceTemplate, findUnknownWorkspaceToken } from '#src/workspaceTemplate.js';
import { delimiter } from 'node:path';

// BATCH-58 — parsing a `command` case's `workspace`: the default and the wholesale per-case
// override, the template check, the setup split, the tokens, and the refusal on every other target.

let suiteDir: string;
beforeAll(() => {
  suiteDir = mkdtempSync(join(tmpdir(), 'gth-eval-ws-parse-'));
  mkdirSync(join(suiteDir, 'fixtures', 'tiny-repo'), { recursive: true });
  mkdirSync(join(suiteDir, 'fixtures', 'other'), { recursive: true });
  writeFileSync(join(suiteDir, 'fixtures', 'a-file.txt'), 'not a directory\n');
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

describe('parseEvalSuite — command workspace', () => {
  it('resolves the default workspace onto every case, template against the suite directory', () => {
    const suite = parse(`${TARGET}
defaults:
  workspace:
    template: fixtures/tiny-repo
    setup: ["git init -q", "git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init"]
    env: { PATH: "{{suite_dir}}/stubs{{path_delimiter}}{{env.PATH}}" }
cases:
  - { id: a, prompt: "x", must_contain: [ok] }
  - { id: b, prompt: "y", must_contain: [ok] }
`);
    const expected = {
      suiteDir,
      template: resolve(suiteDir, 'fixtures/tiny-repo'),
      setup: [
        { run: 'git init -q', argv: ['git', 'init', '-q'] },
        {
          run: 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init',
          argv: [
            'git',
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@t',
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            'init',
          ],
        },
      ],
      env: { PATH: '{{suite_dir}}/stubs{{path_delimiter}}{{env.PATH}}' },
    };
    expect(suite.cases[0].workspace).toStrictEqual(expected);
    expect(suite.cases[1].workspace).toStrictEqual(expected);
  });

  it("replaces the default wholesale with a case's own block, and `false` opts out", () => {
    const suite = parse(`${TARGET}
defaults:
  workspace:
    template: fixtures/tiny-repo
    env: { A: "1" }
cases:
  - { id: own, prompt: "x", must_contain: [ok], workspace: { setup: ["echo hi"] } }
  - { id: out, prompt: "x", must_contain: [ok], workspace: false }
  - { id: inherits, prompt: "x", must_contain: [ok] }
`);
    // No template and no env from the default: nothing is merged.
    expect(suite.cases[0].workspace).toStrictEqual({
      suiteDir,
      setup: [{ run: 'echo hi', argv: ['echo', 'hi'] }],
      env: {},
    });
    expect(Object.keys(suite.cases[1])).not.toContain('workspace');
    expect(suite.cases[2].workspace?.template).toBe(resolve(suiteDir, 'fixtures/tiny-repo'));
  });

  it('accepts an empty block as an empty directory', () => {
    const suite = parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: {} }
`);
    expect(suite.cases[0].workspace).toStrictEqual({ suiteDir, setup: [], env: {} });
  });

  it('leaves a suite with no workspace exactly as it was: no workspace key on any case', () => {
    const suite = parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok] }
`);
    expect(Object.keys(suite.cases[0]).sort()).toEqual(
      ['id', 'modelFree', 'passThreshold', 'tags', 'timeoutMs', 'turns'].sort()
    );
  });

  it('refuses a missing template at parse, naming the resolved path', () => {
    expect(() =>
      parse(`${TARGET}
defaults: { workspace: { template: fixtures/nope } }
cases:
  - { id: a, prompt: "x", must_contain: [ok] }
`)
    ).toThrow(
      `defaults.workspace: template "fixtures/nope" resolves to "${resolve(suiteDir, 'fixtures/nope')}", which does not exist`
    );
  });

  it('refuses a template that is a file', () => {
    expect(() =>
      parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { template: fixtures/a-file.txt } }
`)
    ).toThrow(/case "a" workspace: template "fixtures\/a-file.txt" .* which is not a directory/);
  });

  it('checks the default even when every case overrides it', () => {
    expect(() =>
      parse(`${TARGET}
defaults: { workspace: { template: fixtures/nope } }
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: false }
`)
    ).toThrow(/defaults.workspace: template "fixtures\/nope"/);
  });

  it('refuses an unknown token in a setup argument and in an env value', () => {
    expect(() =>
      parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { setup: ["cp {{suite-dir}}/x ."] } }
`)
    ).toThrow(
      /case "a" workspace: setup\[0\] \("cp \{\{suite-dir\}\}\/x \."\) uses the unknown token \{\{suite-dir\}\}/
    );
    expect(() =>
      parse(`${TARGET}
defaults: { workspace: { env: { HOME: "{{home}}" } } }
cases:
  - { id: a, prompt: "x", must_contain: [ok] }
`)
    ).toThrow(/defaults.workspace: env.HOME uses the unknown token \{\{home\}\}/);
  });

  it('refuses an unquoted spaced token in setup, pointing at quoting, and accepts the quoted one', () => {
    expect(() =>
      parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { setup: ["git init {{ workspace }}"] } }
`)
    ).toThrow(
      /setup\[0\] \("git init \{\{ workspace \}\}"\) has the argument "\{\{", where "\{\{" is not part of a complete token\. .*must be quoted, as in "\{\{ workspace \}\}"/
    );
    const suite = parse(`${TARGET}
cases:
  - id: a
    prompt: "x"
    must_contain: [ok]
    workspace: { setup: ['git init "{{ workspace }}"'] }
`);
    expect(suite.cases[0].workspace?.setup[0].argv).toEqual(['git', 'init', '{{ workspace }}']);
  });

  it('keeps stray braces in an env value as written, since env is never split, but still refuses an unknown token', () => {
    const suite = parse(`${TARGET}
defaults:
  workspace:
    env: { SETTINGS: '{"a":{"b":1}}', OPEN: "{{workspace}/home", CLOSE: "a}}" }
cases:
  - { id: a, prompt: "x", must_contain: [ok] }
`);
    expect(suite.cases[0].workspace?.env).toStrictEqual({
      SETTINGS: '{"a":{"b":1}}',
      OPEN: '{{workspace}/home',
      CLOSE: 'a}}',
    });
    expect(() =>
      parse(`${TARGET}
defaults: { workspace: { env: { SETTINGS: '{"a":{"b":1}} {{nope}}' } } }
cases:
  - { id: a, prompt: "x", must_contain: [ok] }
`)
    ).toThrow(/defaults.workspace: env.SETTINGS uses the unknown token \{\{nope\}\}/);
  });

  it('refuses a token in target.run, where tokens never expand', () => {
    expect(() =>
      parse(`
target:
  type: command
  run: claude -p --add-dir {{workspace}}
  transcript: claude-stream-json
cases:
  - { id: a, prompt: "x", must_contain: [ok] }
`)
    ).toThrow(
      /target.run contains a \{\{\.\.\.\}\} token, but tokens expand only in a workspace's `env` values and `setup` steps/
    );
  });

  it('refuses a setup line the splitter refuses, since setup has no shell either', () => {
    expect(() =>
      parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { setup: ["git init && git add -A"] } }
`)
    ).toThrow(/setup\[0\] \("git init && git add -A"\): `run` contains an unquoted "&"/);
  });

  it('refuses an unknown key inside the block', () => {
    expect(() =>
      parse(`${TARGET}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { templat: fixtures/tiny-repo } }
`)
    ).toThrow(/unknown key "templat"/);
  });

  for (const target of [
    'type: gth-agent',
    'type: ag-ui\n  url: http://localhost:3000\n  agent_id: gth',
    'type: adk-agent\n  url: http://localhost:8080',
  ]) {
    const type = target.split('\n')[0].slice('type: '.length);
    it(`refuses workspace on a "${type}" target, in defaults and on a case`, () => {
      expect(() =>
        parse(`
target:
  ${target}
defaults: { workspace: {} }
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: false }
`)
      ).toThrow(
        `defaults.workspace, case "a" workspace are only read by a "command" target, and this ` +
          `suite's target is "${type}"`
      );
      expect(() =>
        parse(`
target:
  ${target}
cases:
  - { id: a, prompt: "x", must_contain: [ok], workspace: { setup: ["true"] } }
`)
      ).toThrow(
        /case "a" workspace is only read by a "command" target.*shares one working directory/
      );
    });
  }
});

describe('workspace template tokens', () => {
  const values = {
    suiteDir: resolve('/suite'),
    workspace: resolve('/ws'),
    readEnv: (name: string) => (name === 'PATH' ? 'inherited' : undefined),
  };

  it('expands every token, an unset variable to empty, inside one string', () => {
    expect(
      expandWorkspaceTemplate(
        '{{suite_dir}}|{{ workspace }}|{{env.PATH}}|{{env.UNSET}}|{{path_delimiter}}',
        values
      )
    ).toBe(`${resolve('/suite')}|${resolve('/ws')}|inherited||${delimiter}`);
  });

  it('leaves text that is not a token alone and finds the first unknown one', () => {
    expect(expandWorkspaceTemplate('{ {x} } {{', values)).toBe('{ {x} } {{');
    expect(findUnknownWorkspaceToken('{{workspace}} {{env.}} {{nope}}')).toBe('{{env.}}');
    expect(findUnknownWorkspaceToken('{{workspace}}{{env.A_B}}')).toBeUndefined();
  });

  it('throws on an unknown token rather than passing it through', () => {
    expect(() => expandWorkspaceTemplate('{{nope}}', values)).toThrow(/unknown workspace token/);
  });
});
