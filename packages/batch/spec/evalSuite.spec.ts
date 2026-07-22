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
              mustError: [],
              toolResultJsonPath: [],
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

  // BATCH-14: the ADK (A2A) target — parses with a `url`, keeps the `gth-agent` default unchanged,
  // and enforces the honest boundaries (missing url / profile / identities / must_call).
  describe('BATCH-14 adk-agent target', () => {
    it('parses an adk-agent target with a url and grades content assertions as usual', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080" }
cases:
  - id: greets
    prompt: "greet the user"
    must_contain: ["hello"]
    judge: "Greets politely."
`);
      expect(suite.target).toEqual({
        type: 'adk-agent',
        url: 'http://localhost:8080',
        agentId: 'adk-agent',
      });
      // The whole content-assertion surface still normalizes exactly as for gth-agent.
      expect(suite.cases[0].turns[0].expectations[0].mustContain).toEqual(['hello']);
      expect(suite.cases[0].turns[0].expectations[0].judgeRubric).toBe('Greets politely.');
    });

    it('honors an explicit agent_id label', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080", agent_id: my-adk }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`);
      expect(suite.target).toEqual({
        type: 'adk-agent',
        url: 'http://localhost:8080',
        agentId: 'my-adk',
      });
    });

    it('rejects an adk-agent target with no url', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: adk-agent }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
      ).toThrow(/"adk-agent" target requires a `url`/);
    });

    it('rejects a profile on an adk-agent target', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080", profile: admin }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
      ).toThrow(/"adk-agent" target does not take a `profile`/);
    });

    it('rejects the identities matrix on an adk-agent target', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080" }
identities: [admin, limited]
cases:
  - id: c1
    prompt: "p"
    expect:
      - identities: [admin]
        must_contain: ["x"]
      - identities: [limited]
        must_contain: ["y"]
`)
      ).toThrow(/`identities` matrix is not supported for an "adk-agent" target/);
    });

    it('rejects must_call on an adk-agent target — the honest tool-trace boundary (no silent pass)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080" }
cases:
  - id: uses-tool
    prompt: "look it up"
    must_call: ["mcp__*"]
`)
      ).toThrow(/case "uses-tool" uses `must_call`.*not supported for an "adk-agent" target/s);
    });

    it('rejects must_not_call on an adk-agent target too, even when buried in a turn block', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080" }
cases:
  - id: multi
    turns:
      - user: "hi"
        must_contain: ["hello"]
      - user: "now do it"
        must_not_call: ["delete_file"]
`)
      ).toThrow(
        /case "multi" uses `must_call`\/`must_not_call`.*not supported for an "adk-agent"/s
      );
    });

    it('allows content assertions (must_contain / must_match / json_path / judge) on adk-agent', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080" }
cases:
  - id: rich
    prompt: "p"
    must_contain: ["ok"]
    must_match: ["\\\\bRPP-\\\\d+\\\\b"]
    json_path:
      - { path: "$.status", contains: "done" }
    judge: "Answers correctly."
`);
      expect(suite.target.type).toBe('adk-agent');
      expect(suite.cases[0].turns[0].expectations[0].mustMatch).toHaveLength(1);
    });
  });

  // BATCH-15: the AG-UI target — parses with a `url` + `agent_id`, keeps the `gth-agent` default
  // unchanged, and enforces its boundaries (missing url/agent_id / profile / identities). The KEY
  // difference from adk-agent: `must_call`/`must_not_call` ARE allowed (the AG-UI wire streams the
  // tool trace), so they must NOT be rejected at parse time.
  describe('BATCH-15 ag-ui target', () => {
    it('parses an ag-ui target with a url + agent_id and grades content assertions as usual', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: greets
    prompt: "greet the user"
    must_contain: ["hello"]
    judge: "Greets politely."
`);
      expect(suite.target).toEqual({
        type: 'ag-ui',
        url: 'http://localhost:3000',
        agentId: 'gth',
      });
      expect(suite.cases[0].turns[0].expectations[0].mustContain).toEqual(['hello']);
      expect(suite.cases[0].turns[0].expectations[0].judgeRubric).toBe('Greets politely.');
    });

    it('rejects an ag-ui target with no url', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: ag-ui, agent_id: gth }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
      ).toThrow(/"ag-ui" target requires a `url`/);
    });

    it('rejects an ag-ui target with no agent_id', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000" }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
      ).toThrow(/"ag-ui" target requires an `agent_id`/);
    });

    it('rejects a profile on an ag-ui target', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth, profile: admin }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`)
      ).toThrow(/"ag-ui" target does not take a `profile`/);
    });

    it('rejects the identities matrix on an ag-ui target (external agent has no per-identity gth config)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
identities: [admin, limited]
cases:
  - id: c1
    prompt: "p"
    expect:
      - identities: [admin]
        must_contain: ["x"]
      - identities: [limited]
        must_contain: ["y"]
`)
      ).toThrow(/`identities` matrix is not supported for an "ag-ui" target/);
    });

    it('ALLOWS must_call / must_not_call on an ag-ui target (the key difference from adk-agent)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: uses-tool
    prompt: "look it up"
    must_call: ["mcp__*"]
    must_not_call: ["delete_file"]
`);
      expect(suite.target.type).toBe('ag-ui');
      expect(suite.cases[0].turns[0].expectations[0].mustCall).toEqual(['mcp__*']);
      expect(suite.cases[0].turns[0].expectations[0].mustNotCall).toEqual(['delete_file']);
    });

    it('allows must_not_call buried in a multi-turn block on an ag-ui target too', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: multi
    turns:
      - user: "hi"
        must_contain: ["hello"]
      - user: "now do it"
        must_not_call: ["delete_file"]
`);
      expect(suite.target.type).toBe('ag-ui');
      expect(suite.cases[0].turns[1].expectations[0].mustNotCall).toEqual(['delete_file']);
    });
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

    describe('multi-turn cases (turns:) [Task 2]', () => {
      it('normalizes a turns: array into per-turn expectation blocks (flat sugar + expect array)', async () => {
        const { parseEvalSuite } = await import('#src/evalSuite.js');
        const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: remembers-context
    turns:
      - user: "what contract types exist?"
        must_contain: ["contract"]
        judge: "lists the contract types"
      - user: "how many did you just list?"
        must_match: ["\\\\b\\\\d+\\\\b"]
`);
        const c = suite.cases[0];
        expect(c.turns).toHaveLength(2);
        expect(c.turns[0].user).toBe('what contract types exist?');
        expect(c.turns[1].user).toBe('how many did you just list?');
        // Each turn's flat sugar → ONE unscoped block (identities absent).
        expect(c.turns[0].expectations).toHaveLength(1);
        expect(c.turns[0].expectations[0].identities).toBeUndefined();
        expect(c.turns[0].expectations[0].mustContain).toEqual(['contract']);
        expect(c.turns[0].expectations[0].judgeRubric).toBe('lists the contract types');
        expect(c.turns[1].expectations[0].mustMatch).toHaveLength(1);
      });

      it('scopes per-turn expect: blocks by identity (multi-turn × identities)', async () => {
        const { parseEvalSuite } = await import('#src/evalSuite.js');
        const suite = parseEvalSuite(`
target: { type: gth-agent }
identities: [admin, limited]
cases:
  - id: convo
    turns:
      - user: "list the contract types"
        expect:
          - identities: [admin]
            must_call: ["mcp__*"]
          - identities: [limited]
            must_not_call: ["mcp__*"]
      - user: "how many?"
        must_match: ["\\\\b\\\\d+\\\\b"]
`);
        const c = suite.cases[0];
        expect(c.turns).toHaveLength(2);
        expect(c.turns[0].expectations).toHaveLength(2);
        expect(c.turns[0].expectations[0].identities).toEqual(['admin']);
        expect(c.turns[0].expectations[1].identities).toEqual(['limited']);
        // Turn 2 is an unscoped flat block → applies to both identities.
        expect(c.turns[1].expectations).toHaveLength(1);
        expect(c.turns[1].expectations[0].identities).toBeUndefined();
      });

      it('rejects a case declaring BOTH prompt and turns', async () => {
        const { parseEvalSuite } = await import('#src/evalSuite.js');
        expect(() =>
          parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "hi"
    turns:
      - user: "first"
        must_contain: ["a"]
`)
        ).toThrow(/declares BOTH `prompt` and `turns:`/);
      });

      it('rejects a multi-turn case that also declares case-level assertions', async () => {
        const { parseEvalSuite } = await import('#src/evalSuite.js');
        expect(() =>
          parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    must_contain: ["x"]
    turns:
      - user: "first"
        must_contain: ["a"]
`)
        ).toThrow(/multi-turn case "c1".*declares case-level assertions/s);
      });

      it('rejects an empty turns: array', async () => {
        const { parseEvalSuite } = await import('#src/evalSuite.js');
        expect(() =>
          parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    turns: []
`)
        ).toThrow(/has an empty `turns:` array/);
      });

      it('rejects a turn with a missing/blank user message', async () => {
        const { parseEvalSuite } = await import('#src/evalSuite.js');
        expect(() =>
          parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    turns:
      - must_contain: ["a"]
`)
        ).toThrow(/turn 0 must declare a non-empty `user` message/);
      });

      it('rejects a turn with no checks and no judge rubric', async () => {
        const { parseEvalSuite } = await import('#src/evalSuite.js');
        expect(() =>
          parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    turns:
      - user: "hi"
`)
        ).toThrow(/turn 0 has no checks and no judge rubric/);
      });

      it('NO-SILENT-PASS: rejects a (turn × identity) uncovered by any block', async () => {
        const { parseEvalSuite } = await import('#src/evalSuite.js');
        // Turn 1 covers both identities; turn 2 only names admin → limited is uncovered on turn 2.
        expect(() =>
          parseEvalSuite(`
target: { type: gth-agent }
identities: [admin, limited]
cases:
  - id: c1
    turns:
      - user: "one"
        must_contain: ["a"]
      - user: "two"
        expect:
          - identities: [admin]
            must_contain: ["b"]
`)
        ).toThrow(/turn 1 has no expectation block covering identity "limited"/);
      });

      it('rejects a per-turn expect: block referencing an undeclared identity', async () => {
        const { parseEvalSuite } = await import('#src/evalSuite.js');
        expect(() =>
          parseEvalSuite(`
target: { type: gth-agent }
identities: [admin]
cases:
  - id: c1
    turns:
      - user: "one"
        expect:
          - identities: [ghost]
            must_contain: ["a"]
`)
        ).toThrow(/turn 0 expect block 0 references identity "ghost"/);
      });
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

  // BATCH-21: the tool-RESULT assertion surface — `must_error` + `tool_result_json_path` parse
  // into camelCase with `[]` defaults, count as checks, and are rejected at parse time against
  // BOTH external targets (only the in-process gth-agent surfaces tool results).
  describe('BATCH-21 tool-result assertions', () => {
    it('parses must_error and tool_result_json_path (equals / contains / existence) into camelCase', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: denied
    prompt: "get the data"
    must_error: ["mcp__authz__*"]
    tool_result_json_path:
      - { tool: "mcp__authz__*", path: "error.code", equals: "MODULE_DISABLED" }
      - { tool: "mcp__authz__*", path: "error.message", contains: "denied" }
      - { tool: "mcp__authz__*", path: "error" }
`);
      const block = suite.cases[0].turns[0].expectations[0];
      expect(block.mustError).toEqual(['mcp__authz__*']);
      expect(block.toolResultJsonPath).toEqual([
        { tool: 'mcp__authz__*', path: 'error.code', equals: 'MODULE_DISABLED' },
        { tool: 'mcp__authz__*', path: 'error.message', contains: 'denied' },
        { tool: 'mcp__authz__*', path: 'error' }, // existence check: no equals/contains key at all
      ]);
    });

    it('defaults both to [] when absent', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    must_contain: ["x"]
`);
      const block = suite.cases[0].turns[0].expectations[0];
      expect(block.mustError).toEqual([]);
      expect(block.toolResultJsonPath).toEqual([]);
    });

    it('counts a must_error-only block as having checks (no "no checks" rejection)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: only-error
    prompt: "p"
    must_error: ["mcp__*"]
`);
      expect(suite.cases[0].turns[0].expectations[0].mustError).toEqual(['mcp__*']);
    });

    it('rejects a tool_result_json_path entry setting BOTH equals and contains', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    tool_result_json_path:
      - { tool: "t", path: "a.b", equals: "x", contains: "y" }
`)
      ).toThrow(
        /tool_result_json_path entry for "a\.b" must set at most one of "equals" or "contains"/
      );
    });

    it('rejects a tool_result_json_path entry missing its tool pattern or path', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    tool_result_json_path:
      - { path: "a.b" }
`)
      ).toThrow(/Invalid eval suite/);
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
cases:
  - id: c1
    prompt: "p"
    tool_result_json_path:
      - { tool: "t" }
`)
      ).toThrow(/Invalid eval suite/);
    });

    it('treats the new keys as flat assertions for flat-vs-expect exclusivity', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: gth-agent }
identities: [admin]
cases:
  - id: c1
    prompt: "p"
    must_error: ["mcp__*"]
    expect:
      - identities: [admin]
        must_contain: ["x"]
`)
      ).toThrow(/declares BOTH case-level assertions and an `expect:` array/);
    });

    it('rejects must_error on an ag-ui target — no result payloads on that wire (→ exit 2 via the eval command catch)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: denied
    prompt: "get the data"
    must_error: ["mcp__*"]
`)
      ).toThrow(
        /case "denied" uses `must_error`.*tool-result assertions require target\.type: gth-agent/s
      );
    });

    it('rejects tool_result_json_path on an ag-ui target, even buried in a turn expect block', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: multi
    turns:
      - user: "hi"
        must_contain: ["hello"]
      - user: "now fetch"
        expect:
          - tool_result_json_path:
              - { tool: "mcp__*", path: "error.code", equals: "DENIED" }
`)
      ).toThrow(/tool-result assertions require target\.type: gth-agent/);
    });

    it('rejects must_error on an adk-agent target (its tool trace is invisible entirely)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      expect(() =>
        parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080" }
cases:
  - id: denied
    prompt: "get the data"
    must_error: ["mcp__*"]
`)
      ).toThrow(/tool-result assertions require target\.type: gth-agent/);
    });

    it('still ALLOWS must_call alongside a rejected-free ag-ui suite (BATCH-15 behavior unchanged)', async () => {
      const { parseEvalSuite } = await import('#src/evalSuite.js');
      const suite = parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: uses-tool
    prompt: "look it up"
    must_call: ["mcp__*"]
`);
      expect(suite.cases[0].turns[0].expectations[0].mustCall).toEqual(['mcp__*']);
    });
  });
});
