import { describe, expect, it } from 'vitest';
import { parseEvalSuite } from '#src/evalSuite.js';
import { COMMAND_TARGET_DEFAULT_TIMEOUT_MS } from '#src/evalTypes.js';

// BATCH-57 — parsing the `command` target: what it accepts, what it normalises, and every key it
// refuses because it cannot honour it.

const TARGET = `
target:
  type: command
  run: claude -p --output-format stream-json --verbose
  transcript: claude-stream-json
`;

const CASE = `
cases:
  - id: one
    prompt: "hello"
    must_call: [Read]
`;

describe('parseEvalSuite — command target', () => {
  it('splits run into argv and defaults prompt delivery and the timeout', () => {
    const suite = parseEvalSuite(TARGET + CASE);
    expect(suite.target).toEqual({
      type: 'command',
      run: 'claude -p --output-format stream-json --verbose',
      argv: ['claude', '-p', '--output-format', 'stream-json', '--verbose'],
      transcript: 'claude-stream-json',
      prompt: 'arg',
    });
    expect(suite.cases[0].timeoutMs).toBe(COMMAND_TARGET_DEFAULT_TIMEOUT_MS);
  });

  it('takes the case timeout over the suite default', () => {
    const suite = parseEvalSuite(`${TARGET}  prompt: stdin
defaults: { timeout_ms: 5000 }
cases:
  - { id: a, prompt: "x", must_call: [Read] }
  - { id: b, prompt: "x", must_call: [Read], timeout_ms: 900 }
`);
    expect(suite.target.type === 'command' && suite.target.prompt).toBe('stdin');
    expect(suite.cases.map((c) => c.timeoutMs)).toEqual([5000, 900]);
  });

  it('accepts every tool assertion, including the tool-result ones', () => {
    const suite = parseEvalSuite(`${TARGET}
cases:
  - id: all
    prompt: "x"
    must_call: [Read]
    must_not_call: [Write]
    must_error: [Read]
    tool_result_json_path: [{ tool: Bash, path: a, equals: 1 }]
    tool_call_json_path: [{ tool: Read, path: file_path, contains: x }]
    tool_trajectory: { calls: [Read, Bash] }
`);
    expect(suite.cases[0].turns[0].expectations[0].mustError).toEqual(['Read']);
  });

  it('accepts a decoder module path', () => {
    const suite = parseEvalSuite(
      TARGET.replace('claude-stream-json\n', './decoders/mine.mjs\n') + CASE
    );
    expect(suite.target.type === 'command' && suite.target.transcript).toBe('./decoders/mine.mjs');
  });

  it.each([
    ['a missing run', TARGET.replace(/ {2}run: .*\n/, ''), /requires `run`/],
    ['a missing transcript', TARGET.replace(/ {2}transcript: .*\n/, ''), /requires `transcript`/],
    [
      'an unknown decoder name',
      TARGET.replace('claude-stream-json\n', 'codex-json\n'),
      /unknown target.transcript "codex-json"/,
    ],
    [
      'a run with an unquoted pipe',
      TARGET.replace('--verbose', '--verbose | tee log'),
      /target.run: `run` contains an unquoted "\|"/,
    ],
    ['an unterminated quote', TARGET.replace('--verbose', '"--verbose'), /unterminated " quote/],
    ['a profile', `${TARGET}  profile: default\n`, /does not take `profile`/],
    ['a url', `${TARGET}  url: http://x\n`, /does not take `url`/],
    ['a rung', `${TARGET}  rung: assisted\n`, /does not take `rung`/],
    ['a prompt mode other than arg or stdin', `${TARGET}  prompt: file\n`, /prompt/],
  ])('rejects %s', (_label, target, message) => {
    expect(() => parseEvalSuite(target + CASE)).toThrow(message);
  });

  it('rejects the identities matrix', () => {
    expect(() =>
      parseEvalSuite(`${TARGET}identities: [a]
cases:
  - { id: one, prompt: "x", must_call: [Read] }
`)
    ).toThrow(/`identities` matrix is not supported for a "command" target/);
  });

  it('rejects a sweep', () => {
    expect(() =>
      parseEvalSuite(`${TARGET}sweep:
  axes:
    - name: m
      values: [{ name: a, model: x }]
${CASE}`)
    ).toThrow(/`sweep` is not supported for a "command" target/);
  });

  it('rejects tool_coverage with a reason that names the command target', () => {
    expect(() => parseEvalSuite(`${TARGET}tool_coverage: { min: 50 }\n${CASE}`)).toThrow(
      /`tool_coverage` is not supported for a "command" target — a transcript decoder reports/
    );
  });

  it('rejects a multi-turn case', () => {
    expect(() =>
      parseEvalSuite(`${TARGET}
cases:
  - id: chat
    turns:
      - { user: "a", must_call: [Read] }
      - { user: "b", must_call: [Read] }
`)
    ).toThrow(/case "chat" \(index 0\) declares `turns:`, which a "command" target does not/);
  });

  it('rejects model_free, which only the rater can honour', () => {
    expect(() =>
      parseEvalSuite(`${TARGET}
cases:
  - { id: one, prompt: "x", must_call: [Read], model_free: true }
`)
    ).toThrow(/model_free: true`, which the "command" target cannot honour/);
  });

  it('rejects a zero or fractional timeout', () => {
    expect(() =>
      parseEvalSuite(`${TARGET}
cases:
  - { id: one, prompt: "x", must_call: [Read], timeout_ms: 0 }
`)
    ).toThrow(/timeout_ms must be a positive number of ms/);
    expect(() =>
      parseEvalSuite(`${TARGET}
defaults: { timeout_ms: 1.5 }
${CASE}`)
    ).toThrow(/timeout_ms/);
  });
});

describe('parseEvalSuite — command keys on other targets', () => {
  it.each([
    [
      'run',
      'target:\n  type: gth-agent\n  run: claude -p\n',
      /target.run is only read by a "command"/,
    ],
    [
      'transcript and prompt',
      'target:\n  type: ag-ui\n  url: http://x\n  agent_id: a\n  transcript: claude-stream-json\n  prompt: stdin\n',
      /target.transcript, target.prompt are only read by a "command" target, and this suite's target is "ag-ui"/,
    ],
    [
      'a suite default timeout',
      'target: { type: gth-agent }\ndefaults: { timeout_ms: 100 }\n',
      /defaults.timeout_ms is only read by a "command"/,
    ],
  ])('rejects %s', (_label, head, message) => {
    expect(() => parseEvalSuite(head + CASE)).toThrow(message);
  });

  it('rejects a case timeout on a gth-agent suite, and leaves its cases without one', () => {
    expect(() =>
      parseEvalSuite(`target: { type: gth-agent }
cases:
  - { id: one, prompt: "x", must_call: [Read], timeout_ms: 100 }
`)
    ).toThrow(/case "one" timeout_ms is only read by a "command"/);
    const suite = parseEvalSuite(`target: { type: gth-agent }\n${CASE}`);
    expect('timeoutMs' in suite.cases[0]).toBe(false);
  });
});
