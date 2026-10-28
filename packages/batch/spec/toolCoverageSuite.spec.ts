import { describe, expect, it } from 'vitest';
import { RATER_ACTIONS, RATER_OUTCOMES } from '@gaunt-sloth/core/core/shell/raterVocabulary.js';

/** BATCH-32 — parsing the `tool_coverage:` suite block, and refusing it where it cannot be graded. */

/** A rater suite's classification block must cover the gate's whole vocabulary to parse at all. */
const RATER_CLASSIFICATION =
  `classification: { labels: [${RATER_OUTCOMES.join(', ')}], ` +
  `actions: [${RATER_ACTIONS.join(', ')}] }\n`;

const CASE = `
cases:
  - id: c1
    prompt: "do the thing"
    must_contain: ["ok"]
`;

describe('parseEvalSuite tool_coverage', () => {
  it('parses waivers, a floor and required globs', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const suite = parseEvalSuite(`
target: { type: gth-agent }
tool_coverage:
  waive: ["mcp__jira_delete*"]
  require: ["mcp__jira_create"]
  min: 60
${CASE}`);

    expect(suite.toolCoverage).toEqual({
      waive: ['mcp__jira_delete*'],
      require: ['mcp__jira_create'],
      min: 60,
    });
  });

  it('defaults the two lists to empty for a block that only sets a floor', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const suite = parseEvalSuite(`
target: { type: gth-agent }
tool_coverage: { min: 10 }
${CASE}`);

    expect(suite.toolCoverage).toEqual({ waive: [], require: [], min: 10 });
  });

  it('leaves the spec absent when the suite declares no block', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const suite = parseEvalSuite(`
target: { type: gth-agent }
${CASE}`);

    // Absent means "report coverage, gate nothing" — the block is opt-in, the reporting is not.
    expect(suite.toolCoverage).toBeUndefined();
  });

  it('rejects a min outside 0-100, so a fraction cannot be mistaken for a percentage', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: gth-agent }
tool_coverage: { min: 120 }
${CASE}`)
    ).toThrow(/percentage between 0 and 100/);
  });

  it('rejects tool_coverage on an ag-ui target, naming the missing DENOMINATOR', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
tool_coverage: { min: 50 }
${CASE}`)
    ).toThrow(/never the list the agent loaded, so there is no denominator/);
  });

  it('rejects tool_coverage on an adk-agent target, naming BOTH halves as missing', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080" }
tool_coverage: { min: 50 }
${CASE}`)
    ).toThrow(/A2A exposes no tool calls at all/);
  });

  it('rejects tool_coverage on a rater target', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    expect(() =>
      parseEvalSuite(
        'target: { type: rater, rung: assisted }\n' +
          'tool_coverage: { min: 50 }\n' +
          RATER_CLASSIFICATION +
          'cases: [{ id: c1, prompt: "rm -rf /", expect_action: escalate }]\n'
      )
    ).toThrow(/runs no agent and is offered no tools/);
  });

  it('leaves an unsupported target parsing normally when it declares NO tool_coverage block', async () => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    const suite = parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
${CASE}`);

    // The rejection is on the declaration, not on the target — an ag-ui suite is unaffected.
    expect(suite.target.type).toBe('ag-ui');
    expect(suite.toolCoverage).toBeUndefined();
  });
});
