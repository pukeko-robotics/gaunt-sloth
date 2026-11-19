import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A minimal suite with one case, with `defaults` and case keys spliced in as YAML lines. */
function suiteYaml(options: { defaults?: string; caseKeys?: string; target?: string } = {}) {
  return [
    `target: { type: ${options.target ?? 'gth-agent'} }`,
    ...(options.defaults ? [`defaults: { ${options.defaults} }`] : []),
    'cases:',
    '  - id: c1',
    '    prompt: say hello',
    '    must_contain: [hello]',
    ...(options.caseKeys ? options.caseKeys.split('\n').map((line) => `    ${line}`) : []),
  ].join('\n');
}

describe('BATCH-60 — the whole-percent rate arithmetic', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes 2 of 3 at pass_rate 0.67: 67% against a required 67%', async () => {
    const { meetsPassRate, passRatePercent, toWholePercent } = await import('#src/evalRepeat.js');
    expect(passRatePercent(2, 3)).toBe(67);
    expect(toWholePercent(0.67)).toBe(67);
    // The raw fraction is BELOW the rate; the whole-percent comparison is what makes this pass.
    expect(2 / 3 < 0.67).toBe(true);
    expect(meetsPassRate(2, 3, 0.67)).toBe(true);
  });

  it('fails 2 of 3 at pass_rate 0.68: 67% against a required 68%', async () => {
    const { meetsPassRate } = await import('#src/evalRepeat.js');
    expect(meetsPassRate(2, 3, 0.68)).toBe(false);
  });

  it('requires every run at pass_rate 1: 2 of 3 fails, 3 of 3 passes', async () => {
    const { meetsPassRate } = await import('#src/evalRepeat.js');
    expect(meetsPassRate(2, 3, 1)).toBe(false);
    expect(meetsPassRate(3, 3, 1)).toBe(true);
  });

  it('rounds half up, and is not moved across a half by floating point', async () => {
    const { toWholePercent, passRatePercent } = await import('#src/evalRepeat.js');
    expect(passRatePercent(1, 8)).toBe(13);
    // 0.145 * 100 is 14.499999999999998 as a double; the author meant 14.5%.
    expect(0.145 * 100 < 14.5).toBe(true);
    expect(toWholePercent(0.145)).toBe(15);
    expect(passRatePercent(0, 3)).toBe(0);
    expect(passRatePercent(3, 3)).toBe(100);
  });
});

describe('BATCH-60 — parsing repeat and pass_rate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('a case that runs once carries no repeat or passRate key', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const parsed = parseEvalSuite(suiteYaml());
    expect('repeat' in parsed.cases[0]).toBe(false);
    expect('passRate' in parsed.cases[0]).toBe(false);
  });

  it('takes repeat and pass_rate from defaults', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const parsed = parseEvalSuite(suiteYaml({ defaults: 'repeat: 3, pass_rate: 0.67' }));
    expect(parsed.cases[0].repeat).toBe(3);
    expect(parsed.cases[0].passRate).toBe(0.67);
  });

  it('lets a case override both defaults', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const parsed = parseEvalSuite(
      suiteYaml({ defaults: 'repeat: 3, pass_rate: 0.67', caseKeys: 'repeat: 5\npass_rate: 0.8' })
    );
    expect(parsed.cases[0].repeat).toBe(5);
    expect(parsed.cases[0].passRate).toBe(0.8);
  });

  it('requires every run to pass when a repeated case declares no pass_rate', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const parsed = parseEvalSuite(suiteYaml({ caseKeys: 'repeat: 4' }));
    expect(parsed.cases[0].repeat).toBe(4);
    expect(parsed.cases[0].passRate).toBe(1);
  });

  it('accepts and ignores pass_rate when the case runs once', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const parsed = parseEvalSuite(
      suiteYaml({ defaults: 'repeat: 3, pass_rate: 0.67', caseKeys: 'repeat: 1' })
    );
    expect('repeat' in parsed.cases[0]).toBe(false);
    expect('passRate' in parsed.cases[0]).toBe(false);
  });

  it('applies to every target, not only command', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const parsed = parseEvalSuite(
      suiteYaml({ target: 'ag-ui, url: "http://localhost:1", agent_id: a', caseKeys: 'repeat: 2' })
    );
    expect(parsed.cases[0].repeat).toBe(2);
  });

  it.each([
    ['repeat: 0', /repeat must be at least 1/],
    ['repeat: -2', /repeat must be at least 1/],
    ['repeat: 2.5', /repeat must be a whole number of runs/],
    ['repeat: 101', /repeat must be at most 100/],
    ['repeat: 3\npass_rate: 0', /pass_rate must be greater than 0/],
    ['repeat: 3\npass_rate: 1.01', /pass_rate must be at most 1/],
    ['repeat: 3\npass_rate: 0.004', /rounds to 0%/],
  ])('rejects a case with %s', async (caseKeys, message) => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() => parseEvalSuite(suiteYaml({ caseKeys }))).toThrow(message);
  });

  it('accepts the cap and the 1% floor', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const parsed = parseEvalSuite(suiteYaml({ caseKeys: 'repeat: 100\npass_rate: 0.01' }));
    expect(parsed.cases[0].repeat).toBe(100);
  });

  it.each([
    ['repeat: 0', /repeat must be at least 1/],
    ['pass_rate: 0', /pass_rate must be greater than 0/],
    ['pass_rate: 2', /pass_rate must be at most 1/],
  ])('rejects defaults with %s', async (defaults, message) => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() => parseEvalSuite(suiteYaml({ defaults }))).toThrow(message);
  });
});
