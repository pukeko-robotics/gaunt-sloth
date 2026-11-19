import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommandTarget,
  EvalCaseResult,
  EvalSuite,
  EvalSuiteSummary,
  TranscriptDecoder,
} from '@gaunt-sloth/batch';
import type { CommandRunResult, CommandSpawnRequest } from '#src/commands/commandEvalRunner.js';

// BATCH-65 — the cost an agent reports for its run, end to end: the REAL parser, decoder, command
// runner, eval runner, output writer and text reporter, with the command faked behind the spawn
// seam. The real `claude` is never started.

const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stdout: { columns: 200 },
}));

const { parseEvalSuite } = await import('@gaunt-sloth/batch/evalSuite.js');
const { runEvalSuite } = await import('@gaunt-sloth/batch/evalRunner.js');
const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');
const { createTextReporter } = await import('@gaunt-sloth/batch/reporters/textReporter.js');
const { decodeClaudeStreamJson } =
  await import('@gaunt-sloth/batch/transcripts/claudeStreamJson.js');
const { buildCommandRunCell } = await import('#src/commands/commandEvalRunner.js');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CAPTURE = readFileSync(
  resolve(HERE, '../../batch/spec/fixtures/claude-stream-json/capture.jsonl'),
  'utf8'
);

/** The capture cut after its two tool rounds and ended the way `--max-turns` ends it, reporting
 * what the run cost so far. Synthetic, so the committed capture stays what Claude Code printed. */
function cappedTranscript(cost: number): string {
  const lines = CAPTURE.trimEnd().split('\n').slice(0, 7);
  lines.push(
    JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 3,
      total_cost_usd: cost,
    })
  );
  return `${lines.join('\n')}\n`;
}

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'batch65-cost-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
});

function suiteOf(targetExtra: string, cases: string, transcript = 'claude-stream-json'): EvalSuite {
  return parseEvalSuite(
    `
target:
  type: command
  run: fake-agent -p
  transcript: ${JSON.stringify(transcript)}
${targetExtra}
cases:
${cases}
`,
    join(scratch, 'suite.yaml')
  );
}

const ok = (stdout: string, exitCode: number | null = 0): CommandRunResult => ({
  stdout,
  stderr: '',
  exitCode,
  timedOut: false,
});

/** A spawn seam that answers each prompt with the next of its runs, in order. */
function seam(byPrompt: Record<string, CommandRunResult[]>) {
  const next = new Map<string, number>();
  return async (request: CommandSpawnRequest): Promise<CommandRunResult> => {
    const runs = byPrompt[request.prompt];
    if (!runs) throw new Error(`no fake for ${request.prompt}`);
    const index = next.get(request.prompt) ?? 0;
    next.set(request.prompt, index + 1);
    return runs[Math.min(index, runs.length - 1)];
  };
}

/** A decoder for a one-line JSON stdout, `{ "answer": …, "cost": … }`, that passes `cost` through
 * as `costUsd` exactly as it parsed, when the key is present. */
const jsonDecoder: TranscriptDecoder = (stdout) => {
  const run = JSON.parse(stdout) as { answer: string; cost?: unknown };
  return {
    answer: run.answer,
    toolCalls: [],
    toolResults: [],
    ...('cost' in run ? { costUsd: run.cost as number } : {}),
  };
};

async function run(
  suite: EvalSuite,
  byPrompt: Record<string, CommandRunResult[]>,
  decoder: TranscriptDecoder = decodeClaudeStreamJson
) {
  if (suite.target.type !== 'command') throw new Error('not a command suite');
  const runCell = buildCommandRunCell(suite.target as CommandTarget, suite, decoder, {
    cwd: scratch,
    spawnCommand: seam(byPrompt),
  });
  const summary = await runEvalSuite(suite, { runCell });
  return { summary, byId: Object.fromEntries(summary.cases.map((c) => [c.id, c])) };
}

async function textReport(summary: EvalSuiteSummary): Promise<string[]> {
  const ctx = { suitePath: 'suite.yaml', outputDir: 'out' };
  const reporter = createTextReporter();
  for (const result of summary.cases) await reporter.onCellResult?.(result, ctx);
  await reporter.onSuiteEnd?.(summary, ctx);
  return [
    ...consoleUtilsMock.display.mock.calls,
    ...consoleUtilsMock.displayWarning.mock.calls,
    ...consoleUtilsMock.displaySuccess.mock.calls,
  ].map((call) => String(call[0]));
}

/** An object that refers to itself, which JSON.stringify cannot serialise. */
function circular(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

const ONE = `
  - id: c
    prompt: p
    must_contain: [done]
`;

describe('cost — a custom decoder', () => {
  it.each([
    ['zero', 0],
    ['a fraction of a cent', 0.0004],
  ])('carries %s through as the case cost', async (_label, cost) => {
    const { byId } = await run(
      suiteOf('', ONE),
      { p: [ok(JSON.stringify({ answer: 'done', cost }))] },
      jsonDecoder
    );
    expect(byId.c).toMatchObject({ verdict: 'PASS', sutOk: true, costUsd: cost });
  });

  it('adds no cost key when the decoder reports none', async () => {
    const { byId } = await run(
      suiteOf('', ONE),
      { p: [ok(JSON.stringify({ answer: 'done' }))] },
      jsonDecoder
    );
    expect(byId.c.verdict).toBe('PASS');
    expect(Object.keys(byId.c)).not.toContain('costUsd');
  });

  it.each([
    ['a negative', -0.01, '-0.01'],
    ['a string', '0.25', '"0.25"'],
    ['null', null, 'null'],
    ['NaN', Number.NaN, 'NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    // JSON.stringify throws on these two; the reason must still name the decoder.
    ['a BigInt', 10n, '10n'],
    ['a circular object', circular(), '[object Object]'],
  ])('is a harness error naming the decoder for %s cost', async (_label, cost, shown) => {
    const decoder: TranscriptDecoder = () => ({
      answer: 'done',
      toolCalls: [],
      toolResults: [],
      costUsd: cost as number,
    });
    const { byId } = await run(
      suiteOf('', ONE, './my-decoder.mjs'),
      { p: [ok('anything')] },
      decoder
    );
    expect(byId.c).toMatchObject({ verdict: 'FAIL', sutOk: false });
    expect(byId.c.reasons).toEqual([
      `SUT run failed: transcript "./my-decoder.mjs" returned an invalid costUsd ${shown}: it ` +
        'must be a finite, non-negative number of US dollars, or left out when the agent reports ' +
        'no cost',
    ]);
    expect('costUsd' in byId.c).toBe(false);
  });
});

describe('cost — grade_when', () => {
  it('a graded capped run keeps the cost it reported, whatever the exit code', async () => {
    const suite = suiteOf(
      '  grade_when: [error_max_turns]',
      `
  - id: c
    prompt: p
    must_call: [Read]
`
    );
    const { byId } = await run(suite, { p: [ok(cappedTranscript(0.05), 1)] });
    expect(byId.c).toMatchObject({
      verdict: 'PASS',
      outcome: 'error_max_turns',
      costUsd: 0.05,
    });
  });

  it('an unlisted capped run is a harness error, and a harness error has no cost', async () => {
    const { byId } = await run(suiteOf('', ONE), { p: [ok(cappedTranscript(0.05), 1)] });
    expect(byId.c.sutOk).toBe(false);
    expect('costUsd' in byId.c).toBe(false);
  });
});

describe('cost — a repeated case', () => {
  const REPEATED = `
  - id: r
    prompt: p
    repeat: 3
    must_contain: [done]
`;
  const reporting = (cost: number) => ok(JSON.stringify({ answer: 'done', cost }));
  const silent = ok(JSON.stringify({ answer: 'done' }));

  it('is the sum over its runs, with each run keeping its own', async () => {
    const { byId } = await run(
      suiteOf('', REPEATED),
      { p: [reporting(0.1), reporting(0.2), reporting(0.4)] },
      jsonDecoder
    );
    expect(byId.r.costUsd).toBe(0.7);
    expect(byId.r.runs!.map((entry: EvalCaseResult) => entry.costUsd)).toEqual([0.1, 0.2, 0.4]);
  });

  it('has no cost when one run reported none, so its total never understates silently', async () => {
    const { byId } = await run(
      suiteOf('', REPEATED),
      { p: [reporting(0.1), silent, reporting(0.4)] },
      jsonDecoder
    );
    expect(byId.r.repeat).toMatchObject({ runs: 3, passed: 3 });
    expect('costUsd' in byId.r).toBe(false);
  });
});

describe('cost — in every output', () => {
  const CASES = `
  - id: costed
    prompt: costed
    must_contain: [done]
  - id: free
    prompt: free
    must_contain: [done]
  - id: twice
    prompt: twice
    repeat: 2
    must_contain: [done]
`;

  it('the case JSON, results.json and one total line, labelled as reported by the agent', async () => {
    const { summary } = await run(
      suiteOf('', CASES),
      {
        costed: [ok(JSON.stringify({ answer: 'done', cost: 0.1 }))],
        free: [ok(JSON.stringify({ answer: 'done' }))],
        twice: [ok(JSON.stringify({ answer: 'done', cost: 0.2 }))],
      },
      jsonDecoder
    );
    const outputDir = join(scratch, 'out-costed');
    writeEvalOutput(outputDir, summary);
    const results = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8')) as {
      cases: EvalCaseResult[];
    };
    expect(results.cases.map((c) => [c.id, c.costUsd])).toEqual([
      ['costed', 0.1],
      ['free', undefined],
      ['twice', 0.4],
    ]);
    const costed = JSON.parse(readFileSync(join(outputDir, 'costed.json'), 'utf8'));
    expect(costed.costUsd).toBe(0.1);

    const lines = await textReport(summary);
    expect(lines.filter((line) => line.startsWith('COST'))).toEqual([
      'COST (reported by agent): 0.5 USD for 2 of 3 case(s)',
    ]);
  });

  it('no total line, and no cost key, when no case reported a cost', async () => {
    const { summary } = await run(
      suiteOf('', CASES),
      {
        costed: [ok(JSON.stringify({ answer: 'done' }))],
        free: [ok(JSON.stringify({ answer: 'done' }))],
        twice: [ok(JSON.stringify({ answer: 'done' }))],
      },
      jsonDecoder
    );
    const outputDir = join(scratch, 'out-free');
    writeEvalOutput(outputDir, summary);
    expect(readFileSync(join(outputDir, 'results.json'), 'utf8')).not.toContain('costUsd');
    const lines = await textReport(summary);
    expect(lines.some((line) => /^COST|reported by agent/.test(line))).toBe(false);
    expect(lines.at(-1)).toMatch(/^EVAL RESULT: 3\/3 case\(s\) passed/);
  });
});

describe('cost — the eval runner', () => {
  it('drops a cost a runner set on a run that did not finish', async () => {
    const suite = suiteOf('', ONE);
    const summary = await runEvalSuite(suite, {
      runCell: async () => ({ ok: false, error: 'boom', costUsd: 0.3 }),
    });
    expect(summary.cases[0].sutOk).toBe(false);
    expect('costUsd' in summary.cases[0]).toBe(false);
  });
});
