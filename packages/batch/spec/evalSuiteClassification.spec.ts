import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BATCH-25 — the classifier parse surface.
 *
 * Everything here is a rejection with a reason, or an acceptance that would previously have been a
 * rejection. Both matter: the rejections are the honest boundaries (an assertion that cannot be
 * graded must never silently pass), and the acceptances are the two traps in the pre-existing
 * parser — `FLAT_ASSERTION_KEYS` and `hasChecks` — that a new assertion type has to be threaded
 * into or a classifier suite is unusable.
 */
describe('parseEvalSuite — classification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const parse = async (yaml: string) => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    return parseEvalSuite(yaml);
  };

  describe('the classification block', () => {
    it('parses labels, actions and extractors, defaulting label_from to `answer`', async () => {
      const suite = await parse(`
target: { type: gth-agent }
classification:
  labels: [safe, destructive]
  actions: [approve, refuse]
  action_from: { json_path: "$.action" }
cases:
  - id: a
    prompt: "p"
    expect_label: safe
`);
      expect(suite.classification).toEqual({
        labels: ['safe', 'destructive'],
        actions: ['approve', 'refuse'],
        labelFrom: { kind: 'answer' },
        actionFrom: { kind: 'json_path', path: '$.action' },
      });
    });

    it('rejects an enum value that collides with the synthetic buckets or is not a plain token', async () => {
      await expect(
        parse(
          'target: { type: gth-agent }\nclassification: { labels: ["(unrecognized)"] }\n' +
            'cases: [{ id: a, prompt: p, must_contain: [x] }]\n'
        )
      ).rejects.toThrow(/must be a plain token/);
    });

    it('rejects duplicate enum values', async () => {
      await expect(
        parse(
          'target: { type: gth-agent }\nclassification: { labels: [safe, safe] }\n' +
            'cases: [{ id: a, prompt: p, must_contain: [x] }]\n'
        )
      ).rejects.toThrow(/duplicate `classification.labels` value "safe"/);
    });

    it('rejects `actions` with no `action_from` — nothing would read the dimension', async () => {
      await expect(
        parse(
          'target: { type: gth-agent }\n' +
            'classification: { labels: [safe], actions: [approve] }\n' +
            'cases: [{ id: a, prompt: p, must_contain: [x] }]\n'
        )
      ).rejects.toThrow(/`classification.action_from` is not/);
    });
  });

  describe('expect_label / expect_action', () => {
    it('ACCEPTS a case whose only assertion is expect_label (the primary classifier shape)', async () => {
      // Trap 1: `hasChecks` in `buildExpectation` rejects a block with "no checks and no judge
      // rubric". Without the classification keys in that disjunction, every classifier case would
      // be a parse error.
      const suite = await parse(`
target: { type: gth-agent }
classification: { labels: [safe, destructive] }
cases:
  - id: a
    prompt: "ls -la"
    expect_label: safe
`);
      expect(suite.cases[0].turns[0].expectations[0].expectLabel).toBe('safe');
    });

    it('REJECTS a case declaring both expect_label and an `expect:` array', async () => {
      // Trap 2: `FLAT_ASSERTION_KEYS` drives the flat-vs-`expect:` exclusivity check. Without the
      // classification keys in it, a suite could declare both surfaces and have one silently
      // ignored.
      await expect(
        parse(`
target: { type: gth-agent }
identities: [admin]
classification: { labels: [safe, destructive] }
cases:
  - id: a
    prompt: "p"
    expect_label: safe
    expect:
      - identities: [admin]
        expect_label: destructive
`)
      ).rejects.toThrow(/declares BOTH case-level assertions and an `expect:` array/);
    });

    it('REJECTS expect_label on a MULTI-TURN case at case level (assertions live per round)', async () => {
      await expect(
        parse(`
target: { type: gth-agent }
classification: { labels: [safe] }
cases:
  - id: a
    expect_label: safe
    turns:
      - user: "x"
        must_contain: [y]
`)
      ).rejects.toThrow(/declares case-level assertions or an `expect:` array/);
    });

    it('scopes expect_label PER ROUND on a multi-turn case', async () => {
      const suite = await parse(`
target: { type: gth-agent }
classification:
  labels: [destructive]
  actions: [reject, escalate]
  action_from: answer
cases:
  - id: n1
    tags: [negotiation]
    turns:
      - user: "rm -rf ~/.ssh"
        expect_action: reject
      - user: "rm -rf ~/.ssh"
        expect_action: escalate
`);
      expect(suite.cases[0].turns.map((turn) => turn.expectations[0].expectAction)).toEqual([
        'reject',
        'escalate',
      ]);
    });

    it('rejects expect_label with no classification block', async () => {
      await expect(
        parse('target: { type: gth-agent }\ncases: [{ id: a, prompt: p, expect_label: safe }]\n')
      ).rejects.toThrow(/uses `expect_label` but the suite declares no `classification:` block/);
    });

    it('rejects a label outside the declared enum — a typo would be a case that can never pass', async () => {
      await expect(
        parse(
          'target: { type: gth-agent }\nclassification: { labels: [safe, destructive] }\n' +
            'cases: [{ id: a, prompt: p, expect_label: danger }]\n'
        )
      ).rejects.toThrow(
        /expects label "danger", which is not in the suite's `classification.labels`/
      );
    });

    it('rejects expect_action when the suite declares no actions enum', async () => {
      await expect(
        parse(
          'target: { type: gth-agent }\nclassification: { labels: [safe] }\n' +
            'cases: [{ id: a, prompt: p, expect_action: refuse }]\n'
        )
      ).rejects.toThrow(/declares no `actions:` enum/);
    });
  });

  describe('tags and model_free', () => {
    it('de-duplicates tags and rejects a blank one', async () => {
      const suite = await parse(
        'target: { type: gth-agent }\n' +
          'cases: [{ id: a, prompt: p, must_contain: [x], tags: [rce, rce, injection] }]\n'
      );
      expect(suite.cases[0].tags).toEqual(['rce', 'injection']);
      await expect(
        parse(
          'target: { type: gth-agent }\ncases: [{ id: a, prompt: p, must_contain: [x], tags: ["  "] }]\n'
        )
      ).rejects.toThrow(/has a blank tag/);
    });

    it('REJECTS model_free for every target that exists, naming the Half-B rater target', async () => {
      // Running a case through an agent IS a model call. A flag that silently meant nothing is
      // worse than an absent one.
      await expect(
        parse(
          'target: { type: gth-agent }\nclassification: { labels: [safe] }\n' +
            'cases: [{ id: a, prompt: p, expect_label: safe, model_free: true }]\n'
        )
      ).rejects.toThrow(/`model_free: true`, which the "gth-agent" target cannot honour/);
    });
  });

  describe('metrics', () => {
    it('parses a metric, defaulting `gate` to fail when a threshold is declared', async () => {
      const suite = await parse(`
target: { type: gth-agent }
classification:
  labels: [safe, destructive]
  actions: [approve, escalate]
  action_from: answer
metrics:
  - name: false_approve
    where: ["expected.label != safe", "actual.action == approve"]
    max: 0
  - name: over_escalation
    where: "actual.action == escalate"
    over: "expected.label == safe"
    max: 0.05
    gate: report
cases:
  - id: a
    prompt: "p"
    expect_label: safe
`);
      expect(suite.metrics).toHaveLength(2);
      expect(suite.metrics[0]).toMatchObject({ name: 'false_approve', max: 0, gate: 'fail' });
      expect(suite.metrics[0].where).toHaveLength(2);
      expect(suite.metrics[0].over).toBeUndefined(); // corpus-wide by construction
      expect(suite.metrics[1]).toMatchObject({ gate: 'report' });
      expect(suite.metrics[1].over).toHaveLength(1);
    });

    it('rejects metrics with no classification block', async () => {
      await expect(
        parse(
          'target: { type: gth-agent }\n' +
            'metrics: [{ name: m, where: "actual.label == x" }]\n' +
            'cases: [{ id: a, prompt: p, must_contain: [x] }]\n'
        )
      ).rejects.toThrow(/`metrics` requires a `classification:` block/);
    });

    it('rejects an empty `over:` — omitting it is what scores the whole corpus', async () => {
      await expect(
        parse(
          'target: { type: gth-agent }\nclassification: { labels: [safe] }\n' +
            'metrics: [{ name: m, where: "actual.label == safe", over: [] }]\n' +
            'cases: [{ id: a, prompt: p, expect_label: safe }]\n'
        )
      ).rejects.toThrow(/omit the key entirely to score the WHOLE corpus/);
    });

    it('rejects a fraction threshold outside 0..1, and points at the COUNT form instead', async () => {
      // The redirect matters: someone writing `max: 5` almost certainly means five CASES, and the
      // count form is the one that expresses that without drifting as the corpus grows.
      await expect(
        parse(
          'target: { type: gth-agent }\nclassification: { labels: [safe] }\n' +
            'metrics: [{ name: m, where: "actual.label == safe", max: 5 }]\n' +
            'cases: [{ id: a, prompt: p, expect_label: safe }]\n'
        )
      ).rejects.toThrow(/use `max_count: 5` — it does not drift as the corpus grows/);
    });

    it('parses COUNT thresholds — an absolute target invariant to corpus size', async () => {
      const suite = await parse(`
target: { type: gth-agent }
classification:
  labels: [safe, destructive]
  actions: [approve, escalate]
  action_from: answer
metrics:
  - name: false_approve
    where: ["expected.label != safe", "actual.action == approve"]
    max_count: 0
  - name: over_escalation
    where: ["actual.action == escalate"]
    over: ["expected.label == safe"]
    max_count: 2
    gate: report
cases:
  - id: a
    prompt: "p"
    expect_label: safe
`);
      expect(suite.metrics[0]).toMatchObject({ maxCount: 0, gate: 'fail' });
      expect(suite.metrics[0].max).toBeUndefined();
      expect(suite.metrics[1]).toMatchObject({ maxCount: 2, gate: 'report' });
    });

    it('REJECTS mixing the fraction and count forms on one metric', async () => {
      await expect(
        parse(
          'target: { type: gth-agent }\nclassification: { labels: [safe] }\n' +
            'metrics: [{ name: m, where: "actual.label == safe", max: 0.1, max_count: 2 }]\n' +
            'cases: [{ id: a, prompt: p, expect_label: safe }]\n'
        )
      ).rejects.toThrow(/declares BOTH fraction thresholds .* and count thresholds/);
    });

    it('rejects a non-integer or negative count threshold', async () => {
      for (const value of ['2.5', '-1']) {
        await expect(
          parse(
            'target: { type: gth-agent }\nclassification: { labels: [safe] }\n' +
              `metrics: [{ name: m, where: "actual.label == safe", max_count: ${value} }]\n` +
              'cases: [{ id: a, prompt: p, expect_label: safe }]\n'
          )
        ).rejects.toThrow(/a count threshold is a whole, non-negative number of cases/);
      }
    });

    it('rejects a duplicate metric name', async () => {
      await expect(
        parse(
          'target: { type: gth-agent }\nclassification: { labels: [safe] }\n' +
            'metrics: [{ name: m, where: "actual.label == safe" }, ' +
            '{ name: m, where: "actual.label == safe" }]\n' +
            'cases: [{ id: a, prompt: p, expect_label: safe }]\n'
        )
      ).rejects.toThrow(/duplicate metric name "m"/);
    });
  });

  describe('sweep', () => {
    it('parses axes and values', async () => {
      const suite = await parse(`
target: { type: gth-agent }
sweep:
  axes:
    - name: rung
      values:
        - { name: auto-safe, config: { approvals: { rung: auto-safe } } }
        - { name: full-auto, config: { approvals: { rung: full-auto } } }
    - name: model
      values:
        - { name: flash, model: gemini-3.6-flash }
cases:
  - id: a
    prompt: "p"
    must_contain: [x]
`);
      expect(suite.sweep?.axes).toHaveLength(2);
      expect(suite.sweep?.axes[1].values[0]).toEqual({
        name: 'flash',
        model: 'gemini-3.6-flash',
        config: undefined,
      });
    });

    it('REJECTS `config.llm` — it is a constructed instance, not data', async () => {
      await expect(
        parse(`
target: { type: gth-agent }
sweep:
  axes:
    - name: m
      values:
        - { name: x, config: { llm: { model: foo } } }
cases: [{ id: a, prompt: p, must_contain: [x] }]
`)
      ).rejects.toThrow(/`llm` holds a CONSTRUCTED model instance, not data/);
    });

    it('rejects a sweep value that overrides nothing', async () => {
      await expect(
        parse(`
target: { type: gth-agent }
sweep:
  axes:
    - name: m
      values: [{ name: x }]
cases: [{ id: a, prompt: p, must_contain: [x] }]
`)
      ).rejects.toThrow(/declares neither `model:` nor `config:`/);
    });

    it('rejects a value name that is not path-safe — it becomes an output-dir component', async () => {
      await expect(
        parse(`
target: { type: gth-agent }
sweep:
  axes:
    - name: m
      values: [{ name: "../escape", model: x }]
cases: [{ id: a, prompt: p, must_contain: [x] }]
`)
      ).rejects.toThrow(/must be a plain token/);
    });

    it('REJECTS a sweep for an out-of-process target — the overrides would change nothing', async () => {
      await expect(
        parse(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
sweep:
  axes:
    - name: m
      values: [{ name: x, model: y }]
cases: [{ id: a, prompt: p, must_contain: [x] }]
`)
      ).rejects.toThrow(/a `sweep` is not supported for a "ag-ui" target/);
    });
  });

  it('leaves a #405-era suite entirely untouched by the classifier layer', async () => {
    const suite = await parse(`
target: { type: gth-agent }
identities: [admin, limited]
cases:
  - id: list-contracts
    prompt: "list the contract types"
    expect:
      - identities: [admin]
        must_call: ["mcp__*"]
      - identities: [limited]
        must_not_call: ["mcp__*"]
        must_error: ["mcp__*"]
`);
    expect(suite.classification).toBeUndefined();
    expect(suite.metrics).toEqual([]);
    expect(suite.sweep).toBeUndefined();
    expect(suite.cases[0].tags).toEqual([]);
    expect(suite.cases[0].modelFree).toBe(false);
    expect(suite.cases[0].turns[0].expectations[0].mustCall).toEqual(['mcp__*']);
    expect(suite.cases[0].turns[0].expectations[1].mustError).toEqual(['mcp__*']);
  });
});
