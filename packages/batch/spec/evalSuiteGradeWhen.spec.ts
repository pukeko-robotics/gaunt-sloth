import { describe, expect, it } from 'vitest';
import { parseEvalSuite } from '#src/evalSuite.js';

// BATCH-62 — parsing `grade_when`: where it may appear, how a case's list composes with the
// target's, and every entry it refuses.

const COMMAND_TARGET = `
target:
  type: command
  run: claude -p --output-format stream-json --verbose --max-turns 3
  transcript: claude-stream-json
`;

function commandSuite(targetExtra: string, cases: string) {
  return parseEvalSuite(`${COMMAND_TARGET}${targetExtra}
cases:
${cases}`);
}

describe('parseEvalSuite — grade_when on a command target', () => {
  it("gives every case the target's list", () => {
    const suite = commandSuite(
      '  grade_when: [error_max_turns, error_max_budget_usd]',
      `  - { id: a, prompt: x, must_call: [Skill] }
  - { id: b, prompt: x, must_call: [Skill] }`
    );
    expect(suite.cases.map((c) => c.gradeWhen)).toEqual([
      ['error_max_turns', 'error_max_budget_usd'],
      ['error_max_turns', 'error_max_budget_usd'],
    ]);
    // The list lives on the cases; the target keeps the shape it has without the key.
    expect(Object.keys(suite.target).sort()).toEqual(
      ['argv', 'prompt', 'run', 'transcript', 'type'].sort()
    );
  });

  it("lets a case's list replace the target's, and [] restore the strict default", () => {
    const suite = commandSuite(
      '  grade_when: [error_max_turns]',
      `  - { id: inherits, prompt: x, must_call: [Skill] }
  - { id: replaces, prompt: x, must_call: [Skill], grade_when: [error_max_budget_usd] }
  - { id: strict, prompt: x, must_call: [Skill], grade_when: [] }`
    );
    const byId = Object.fromEntries(suite.cases.map((c) => [c.id, c]));
    expect(byId.inherits.gradeWhen).toEqual(['error_max_turns']);
    expect(byId.replaces.gradeWhen).toEqual(['error_max_budget_usd']);
    expect('gradeWhen' in byId.strict).toBe(false);
  });

  it('accepts a list on a case alone, and leaves the other cases strict', () => {
    const suite = commandSuite(
      '',
      `  - { id: routing, prompt: x, must_call: [Skill], grade_when: [error_max_turns] }
  - { id: behaviour, prompt: x, must_call: [Skill] }`
    );
    expect(suite.cases[0].gradeWhen).toEqual(['error_max_turns']);
    expect('gradeWhen' in suite.cases[1]).toBe(false);
  });

  it('trims entries and drops duplicates', () => {
    const suite = commandSuite(
      '  grade_when: [" error_max_turns ", error_max_turns]',
      '  - { id: a, prompt: x, must_call: [Skill] }'
    );
    expect(suite.cases[0].gradeWhen).toEqual(['error_max_turns']);
  });

  it('composes with repeat: each case keeps both', () => {
    const suite = commandSuite(
      '  grade_when: [error_max_turns]',
      '  - { id: a, prompt: x, must_call: [Skill], repeat: 3, pass_rate: 0.67 }'
    );
    expect(suite.cases[0]).toMatchObject({
      repeat: 3,
      passRate: 0.67,
      gradeWhen: ['error_max_turns'],
    });
  });

  it.each([
    ['success', /grade_when must not list "success"/],
    ['""', /grade_when entries must not be empty/],
    ['"   "', /grade_when entries must not be empty/],
    ['3', /grade_when entries must be strings/],
    ['{ a: 1 }', /grade_when entries must be strings/],
  ])('rejects the entry %s on the target', (entry, message) => {
    expect(() =>
      commandSuite(`  grade_when: [${entry}]`, '  - { id: a, prompt: x, must_call: [Skill] }')
    ).toThrow(message);
  });

  it.each([
    ['success', /grade_when must not list "success"/],
    ['""', /grade_when entries must not be empty/],
    ['7', /grade_when entries must be strings/],
  ])('rejects the entry %s on a case', (entry, message) => {
    expect(() =>
      commandSuite('', `  - { id: a, prompt: x, must_call: [Skill], grade_when: [${entry}] }`)
    ).toThrow(message);
  });

  it('rejects a list that is not a list', () => {
    expect(() =>
      commandSuite('  grade_when: error_max_turns', '  - { id: a, prompt: x, must_call: [Skill] }')
    ).toThrow(/grade_when/);
  });
});

describe('parseEvalSuite — grade_when on other targets', () => {
  it.each([
    ['gth-agent', 'target: { type: gth-agent, grade_when: [error_max_turns] }'],
    [
      'ag-ui',
      'target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth, grade_when: [x] }',
    ],
    ['adk-agent', 'target: { type: adk-agent, url: "http://localhost:8080", grade_when: [x] }'],
  ])('rejects target.grade_when on a %s target', (_type, target) => {
    expect(() =>
      parseEvalSuite(`${target}
cases:
  - { id: a, prompt: x, must_contain: [y] }
`)
    ).toThrow(/target\.grade_when is only read by a "command" target/);
  });

  it('rejects a case grade_when on a gth-agent target, naming the case', () => {
    expect(() =>
      parseEvalSuite(`target: { type: gth-agent }
cases:
  - { id: capped, prompt: x, must_contain: [y], grade_when: [error_max_turns] }
`)
    ).toThrow(/case "capped" grade_when is only read by a "command" target/);
  });
});
