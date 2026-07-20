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
      mustCall: [],
      mustNotCall: [],
      mustMatch: [],
      mustNotMatch: [],
      jsonPath: [],
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
      mustCall: [],
      mustNotCall: [],
      mustMatch: [],
      mustNotMatch: [],
      jsonPath: [],
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
    ).toThrow(/case "empty-case".*no checks.*no judge/s);
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

  // CI review finding (BATCH-2 PR #410, critical): case ids double as output filenames
  // (`evalOutput.ts` does `writeFileSync(join(outputDir, `${result.id}.json`), ...)`), so an
  // unvalidated id like `../../etc/passwd` would let a suite author write outside `outputDir`.
  // These must be rejected here, at parse time, not sanitized and not deferred to the write.
  it('rejects a case id containing a path traversal sequence', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: "../../etc/passwd"
    prompt: "p"
    must_contain: ["x"]
`)
    ).toThrow(/case id must be a valid filename/);
  });

  it('rejects a case id containing a path separator', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: "sub/dir"
    prompt: "p"
    must_contain: ["x"]
`)
    ).toThrow(/case id must be a valid filename/);
  });

  it('rejects a case id with characters unsafe on some filesystems', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: "bad:id"
    prompt: "p"
    must_contain: ["x"]
`)
    ).toThrow(/case id must be a valid filename/);
  });

  it('accepts a case id made only of alphanumerics, dashes, underscores, and dots', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: "Case_1.smoke-test"
    prompt: "p"
    must_contain: ["x"]
`);
    expect(suite.cases[0].id).toBe('Case_1.smoke-test');
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

  // BATCH-10 — the new assertion types.
  describe('BATCH-10 assertion types', () => {
    it('parses must_call / must_not_call / must_match / must_not_match / json_path', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: rich
    prompt: "p"
    must_call: ["mcp__unimarket__*"]
    must_not_call: ["read_file"]
    must_match: ["\\\\bRPP-\\\\d+\\\\b"]
    must_not_match: ["\\\\bERROR\\\\b"]
    json_path:
      - { path: "$.items[0].scope", equals: "caller" }
      - { path: "data.status", contains: "ok" }
`);
      const c = suite.cases[0];
      expect(c.mustCall).toEqual(['mcp__unimarket__*']);
      expect(c.mustNotCall).toEqual(['read_file']);
      // Regex strings are compiled to RegExp and stored.
      expect(c.mustMatch).toHaveLength(1);
      expect(c.mustMatch[0]).toBeInstanceOf(RegExp);
      expect(c.mustMatch[0].source).toBe('\\bRPP-\\d+\\b');
      expect(c.mustNotMatch[0]).toBeInstanceOf(RegExp);
      expect(c.jsonPath).toEqual([
        { path: '$.items[0].scope', equals: 'caller' },
        { path: 'data.status', contains: 'ok' },
      ]);
    });

    it('defaults every new assertion array to [] when absent', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`);
      const c = suite.cases[0];
      expect(c.mustCall).toEqual([]);
      expect(c.mustNotCall).toEqual([]);
      expect(c.mustMatch).toEqual([]);
      expect(c.mustNotMatch).toEqual([]);
      expect(c.jsonPath).toEqual([]);
    });

    it('counts a case with ONLY must_call (no substring, no judge) as valid', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: mcp-only
    prompt: "p"
    must_call: ["mcp__*"]
`);
      expect(suite.cases[0].mustCall).toEqual(['mcp__*']);
    });

    it('throws at parse time on an invalid must_match regex, with a clear message', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: bad-regex
    prompt: "p"
    must_match: ["([unterminated"]
`)
      ).toThrow(/invalid must_match pattern "\(\[unterminated"/);
    });

    it('throws at parse time on an invalid must_not_match regex', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: bad-regex
    prompt: "p"
    must_not_match: ["(?<"]
`)
      ).toThrow(/invalid must_not_match pattern/);
    });

    it('rejects a json_path entry that sets both equals and contains', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    json_path:
      - { path: "a.b", equals: 1, contains: "x" }
`)
      ).toThrow(/json_path entry for "a\.b" must set exactly one of "equals" or "contains"/);
    });

    it('rejects a json_path entry that sets neither equals nor contains', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    json_path:
      - { path: "a.b" }
`)
      ).toThrow(/must set exactly one of "equals" or "contains"/);
    });

    it('accepts a json_path entry whose equals target is explicitly null', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    json_path:
      - { path: "a.b", equals: null }
`);
      expect(suite.cases[0].jsonPath).toEqual([{ path: 'a.b', equals: null }]);
    });
  });

  // BATCH-10 Task 2: the optional top-level `judge_profile` field.
  describe('judge_profile', () => {
    it('surfaces a suite-level judge_profile as EvalSuite.judgeProfile', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
judge_profile: strict-judge
cases:
  - id: c1
    prompt: "p"
    judge: "Graded by a separate model."
`);
      expect(suite.judgeProfile).toBe('strict-judge');
    });

    it('leaves judgeProfile undefined when the suite declares no judge_profile (regression)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`);
      expect(suite.judgeProfile).toBeUndefined();
    });

    it('normalizes a blank/whitespace-only judge_profile to undefined (= no separate judge)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
judge_profile: "   "
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`);
      expect(suite.judgeProfile).toBeUndefined();
    });
  });
});
