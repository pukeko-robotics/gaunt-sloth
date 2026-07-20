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
  // BATCH-12: a flat case normalizes to ONE turn (user = prompt) with ONE unscoped expectation
  // block (identities absent → applies to all). This test is also the required normalization proof.
  it('normalizes a flat case to turns[0] × one unscoped expectation, and parses every field', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const suite = parseEvalSuite(FULL_SUITE);

    expect(suite.target).toEqual({ type: 'gth-agent', profile: 'default' });
    expect(suite.identities).toBeUndefined();
    expect(suite.cases).toHaveLength(3);

    const checksOnly = suite.cases[0];
    expect(checksOnly).toEqual({
      id: 'checks-only',
      passThreshold: 6, // from suite defaults
      turns: [
        {
          user: 'say hello and goodbye',
          expectations: [
            {
              identities: undefined, // flat sugar → applies to every identity
              mustContain: ['hello', 'goodbye'],
              mustNotContain: ['rude'],
              shouldContainAny: ['hi', 'hey'],
              mustCall: [],
              mustNotCall: [],
              mustMatch: [],
              mustNotMatch: [],
              jsonPath: [],
              judgeRubric: undefined,
            },
          ],
        },
      ],
    });

    const judgeOnly = suite.cases[1];
    expect(judgeOnly.turns[0].user).toBe('explain the thing');
    expect(judgeOnly.turns[0].expectations).toHaveLength(1);
    expect(judgeOnly.turns[0].expectations[0].judgeRubric).toBe(
      'Answers with a ranked summary and correctly formatted values.'
    );
    expect(judgeOnly.passThreshold).toBe(6);

    const both = suite.cases[2];
    expect(both.turns[0].expectations[0].mustContain).toEqual(['ok']);
    expect(both.turns[0].expectations[0].judgeRubric).toEqual('Is polite.');
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
      const c = suite.cases[0].turns[0].expectations[0];
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
      const c = suite.cases[0].turns[0].expectations[0];
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
      expect(suite.cases[0].turns[0].expectations[0].mustCall).toEqual(['mcp__*']);
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
      expect(suite.cases[0].turns[0].expectations[0].jsonPath).toEqual([
        { path: 'a.b', equals: null },
      ]);
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
    it('rejects a judge_profile containing a path traversal sequence or separator', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      // Single-quoted YAML so a backslash stays literal (double quotes would treat `\b` as an escape).
      for (const bad of ['../../etc', 'a/b', 'a\\b', '..']) {
        expect(() =>
          parseEvalSuite(`
target: { type: gth-agent }
judge_profile: '${bad}'
cases:
  - id: c1
    prompt: "p"
    judge: "graded elsewhere"
`)
        ).toThrow(/judge_profile .* must be a plain profile name/);
      }
    });
  });

  // BATCH-12: the suite-level `identities` list + per-case `expect:` blocks (the identity matrix).
  describe('BATCH-12 identity matrix', () => {
    const MATRIX_SUITE = `
target: { type: gth-agent }
identities: [admin, limited]
cases:
  - id: list-contracts
    prompt: "list the contract types"
    expect:
      - identities: [admin]
        must_call: ["mcp__*"]
        judge: "returns the full list of contract types"
      - identities: [limited]
        must_not_call: ["mcp__*"]
        judge: "explains access is denied and does not fabricate data"
`;

    it('surfaces the suite-level identities list', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(MATRIX_SUITE);
      expect(suite.identities).toEqual(['admin', 'limited']);
    });

    it('normalizes an expect: array to per-identity expectation blocks on the single turn', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(MATRIX_SUITE);
      const c = suite.cases[0];
      expect(c.turns).toHaveLength(1);
      expect(c.turns[0].user).toBe('list the contract types');
      const [adminBlock, limitedBlock] = c.turns[0].expectations;
      expect(adminBlock.identities).toEqual(['admin']);
      expect(adminBlock.mustCall).toEqual(['mcp__*']);
      expect(adminBlock.judgeRubric).toBe('returns the full list of contract types');
      expect(limitedBlock.identities).toEqual(['limited']);
      expect(limitedBlock.mustNotCall).toEqual(['mcp__*']);
    });

    it('accepts a flat case in an identity suite (its one block applies to every identity)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
identities: [admin, limited]
cases:
  - id: sane
    prompt: "say ok"
    must_contain: ["ok"]
`);
      const block = suite.cases[0].turns[0].expectations[0];
      expect(block.identities).toBeUndefined(); // unscoped → applies to admin AND limited
      expect(block.mustContain).toEqual(['ok']);
    });

    it('allows an expect: array with unscoped blocks even when the suite declares no identities', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: multi
    prompt: "p"
    expect:
      - must_contain: ["a"]
      - must_call: ["mcp__*"]
`);
      expect(suite.identities).toBeUndefined();
      const blocks = suite.cases[0].turns[0].expectations;
      expect(blocks).toHaveLength(2);
      expect(blocks[0].identities).toBeUndefined();
      expect(blocks[1].mustCall).toEqual(['mcp__*']);
    });

    it('rejects a case declaring BOTH flat assertions and an expect: array', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
identities: [admin]
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
    expect:
      - identities: [admin]
        must_call: ["mcp__*"]
`)
      ).toThrow(/declares BOTH case-level assertions and an `expect:` array/);
    });

    it('rejects an expect: block referencing an identity the suite does not declare', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
identities: [admin]
cases:
  - id: c1
    prompt: "p"
    expect:
      - identities: [ghost]
        must_call: ["mcp__*"]
`)
      ).toThrow(/references identity "ghost" which the suite does not declare/);
    });

    it('rejects a (case × identity) with no applicable expect block (no-silent-pass, static)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      // `limited` is declared but no block covers it → nothing would grade limited.
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
identities: [admin, limited]
cases:
  - id: c1
    prompt: "p"
    expect:
      - identities: [admin]
        must_call: ["mcp__*"]
`)
      ).toThrow(/has no expectation block covering identity "limited"/);
    });

    it('rejects an expect: block with no checks and no judge', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
identities: [admin]
cases:
  - id: c1
    prompt: "p"
    expect:
      - identities: [admin]
`)
      ).toThrow(/expect block 0 has no checks and no judge rubric/);
    });

    it('rejects a duplicate identity name', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
identities: [admin, admin]
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
      ).toThrow(/duplicate identity "admin"/);
    });

    it('rejects an identity name with a path separator or traversal sequence', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      for (const bad of ['a/b', '..', '../../etc']) {
        expect(() =>
          parseEvalSuite(`
target: { type: gth-agent }
identities: ['${bad}']
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
        ).toThrow(/must be a plain profile name/);
      }
    });

    it('rejects an empty identities list (omit the key instead)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
identities: []
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
      ).toThrow(/`identities` must list at least one profile name/);
    });

    it('rejects a case declaring turns: (multi-turn is not supported yet)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    turns:
      - user: "first message"
        must_contain: ["a"]
      - user: "second message"
        must_contain: ["b"]
`)
      ).toThrow(/multi-turn suites are not supported yet/);
    });

    it('rejects a case with a missing prompt (and no turns)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    must_contain: ["x"]
`)
      ).toThrow(/must declare a non-empty `prompt`/);
    });
  });
});
