import { describe, expect, it } from 'vitest';

const FULL_SUITE = `
target: { type: gth-agent, profile: default }
defaults: { pass_threshold: 6 }

cases:
  - id: checks-only
    prompt: "say hello and goodbye"
    must_contain: ["hello", "goodbye"]
    must_not_contain: ["rude"]
    should_contain_any: ["hi", "hey"]

  - id: judge-only
    prompt: "explain the thing"
    judge: "Answers with a ranked summary and correctly formatted values."

  - id: both
    prompt: "do both"
    must_contain: ["ok"]
    judge: "Is polite."
    pass_threshold: 8
`;

describe('parseEvalSuite', () => {
  it('parses target, defaults, and every case field', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const suite = parseEvalSuite(FULL_SUITE);

    expect(suite.target).toEqual({ type: 'gth-agent', profile: 'default' });
    expect(suite.cases).toHaveLength(3);

    const checksOnly = suite.cases[0];
    expect(checksOnly).toEqual({
      id: 'checks-only',
      prompt: 'say hello and goodbye',
      mustContain: ['hello', 'goodbye'],
      mustNotContain: ['rude'],
      shouldContainAny: ['hi', 'hey'],
      judgeRubric: undefined,
      passThreshold: 6, // from suite defaults
    });

    const judgeOnly = suite.cases[1];
    expect(judgeOnly).toEqual({
      id: 'judge-only',
      prompt: 'explain the thing',
      mustContain: [],
      mustNotContain: [],
      shouldContainAny: [],
      judgeRubric: 'Answers with a ranked summary and correctly formatted values.',
      passThreshold: 6,
    });

    const both = suite.cases[2];
    expect(both.mustContain).toEqual(['ok']);
    expect(both.judgeRubric).toEqual('Is polite.');
    expect(both.passThreshold).toBe(8); // per-case override wins over suite default
  });

  it('defaults pass_threshold to 6 when the suite declares no `defaults` block at all', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`);
    expect(suite.cases[0].passThreshold).toBe(6);
  });

  it('rejects malformed YAML', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() => parseEvalSuite('target: [this is: not valid: yaml')).toThrow(
      /Failed to parse eval suite YAML/
    );
  });

  it('rejects a suite missing required top-level fields', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() => parseEvalSuite('target: { type: gth-agent }\n')).toThrow(/Invalid eval suite/);
  });

  it('rejects an unsupported target.type (pluggable targets are out of scope)', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: http, url: "https://example.com" }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
    ).toThrow(/unsupported target\.type "http"/);
  });

  it('rejects an unsupported target.profile (identity switching is out of scope)', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: gth-agent, profile: admin }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
    ).toThrow(/unsupported target\.profile "admin"/);
  });

  it('rejects a case with neither deterministic checks nor a judge rubric', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: empty-case
    prompt: "p"
`)
    ).toThrow(/case "empty-case".*no deterministic.*no judge/s);
  });

  it('rejects a case whose judge rubric is only whitespace, when it has no checks either', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: blank-judge
    prompt: "p"
    judge: "   "
`)
    ).toThrow(/case "blank-judge"/);
  });

  it('rejects duplicate case ids', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: dup
    prompt: "p1"
    must_contain: ["x"]
  - id: dup
    prompt: "p2"
    must_contain: ["y"]
`)
    ).toThrow(/duplicate case id "dup"/);
  });

  it('rejects a suite with zero cases', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: gth-agent }
cases: []
`)
    ).toThrow(/Invalid eval suite/);
  });

  it('includes the source path in error messages when supplied', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() => parseEvalSuite('not: [valid', 'suite.yaml')).toThrow(/\(suite\.yaml\)/);
  });
});
