import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommandTarget,
  EvalCaseResult,
  EvalSuite,
  TranscriptDecoder,
} from '@gaunt-sloth/batch';
import type { CommandRunResult, CommandSpawnRequest } from '#src/commands/commandEvalRunner.js';

// BATCH-62 — `grade_when` end to end: the REAL parser, decoder, command runner, eval runner,
// output writer and text reporter. A `--max-turns`-capped Claude Code run is faked by replaying a
// capped transcript, through a real child process where the exit code matters and through the spawn
// seam where only the seam can produce the case (a signal kill, a timeout). The real `claude` is
// never started.

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
const { classifyEvalExit, runEvalSuite } = await import('@gaunt-sloth/batch/evalRunner.js');
const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');
const { createTextReporter } = await import('@gaunt-sloth/batch/reporters/textReporter.js');
const { decodeClaudeStreamJson } =
  await import('@gaunt-sloth/batch/transcripts/claudeStreamJson.js');
const { buildCommandRunCell } = await import('#src/commands/commandEvalRunner.js');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE_CLI = resolve(HERE, 'fixtures/commandTarget/fake-cli.mjs');
const CAPTURE = readFileSync(
  resolve(HERE, '../../batch/spec/fixtures/claude-stream-json/capture.jsonl'),
  'utf8'
);

/** The capture cut after its two tool rounds (Read, Read, Bash) and ended on `subtype`, the way
 * `--max-turns` ends a Claude Code run: no final text and no `result` string. Synthetic, built here
 * so the committed capture stays exactly what Claude Code printed. */
function cappedTranscript(subtype = 'error_max_turns'): string {
  const lines = CAPTURE.trimEnd().split('\n').slice(0, 7);
  // `usage` is there so a graded run's token counts can be pinned: what a capped case costs is
  // the reason the key exists.
  lines.push(
    JSON.stringify({
      type: 'result',
      subtype,
      is_error: true,
      num_turns: 3,
      usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 },
    })
  );
  return `${lines.join('\n')}\n`;
}

let scratch: string;
let cappedFile: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'batch62-grade-when-'));
  cappedFile = join(scratch, 'capped.jsonl');
  writeFileSync(cappedFile, cappedTranscript());
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
});

/** A `run` line starting the fake CLI under this node, quoted so a path with spaces survives. */
function fakeRun(...args: string[]): string {
  return [process.execPath, FAKE_CLI, ...args].map((arg) => `"${arg}"`).join(' ');
}

function suiteOf(
  run: string,
  targetExtra: string,
  cases: string,
  transcript = 'claude-stream-json'
): EvalSuite {
  return parseEvalSuite(
    `
target:
  type: command
  run: ${JSON.stringify(run)}
  transcript: ${JSON.stringify(transcript)}
${targetExtra}
cases:
${cases}
`,
    join(scratch, 'suite.yaml')
  );
}

function targetOf(suite: EvalSuite): CommandTarget {
  if (suite.target.type !== 'command') throw new Error('not a command suite');
  return suite.target;
}

/** A spawn seam that answers each prompt from `byPrompt`, and every prompt-less step from `step`. */
function seam(
  byPrompt: Record<string, CommandRunResult>,
  step?: (request: CommandSpawnRequest) => CommandRunResult
) {
  return async (request: CommandSpawnRequest): Promise<CommandRunResult> => {
    if (request.promptDelivery === 'none') {
      if (!step) throw new Error('no step fake');
      return step(request);
    }
    const run = byPrompt[request.prompt];
    if (!run) throw new Error(`no fake for ${request.prompt}`);
    return run;
  };
}

const capped = (exitCode: number | null, subtype?: string): CommandRunResult => ({
  stdout: cappedTranscript(subtype),
  stderr: '',
  exitCode,
  timedOut: false,
});

async function run(
  suite: EvalSuite,
  options: Parameters<typeof buildCommandRunCell>[3] = {},
  decoder: TranscriptDecoder = decodeClaudeStreamJson
) {
  const runCell = buildCommandRunCell(targetOf(suite), suite, decoder, {
    cwd: scratch,
    ...options,
  });
  const summary = await runEvalSuite(suite, { runCell });
  return { summary, byId: Object.fromEntries(summary.cases.map((c) => [c.id, c])) };
}

function expectHarnessError(result: EvalCaseResult, reason: RegExp): void {
  expect(result.sutOk).toBe(false);
  expect(result.verdict).toBe('FAIL');
  expect(result.reasons[0]).toMatch(reason);
  expect('outcome' in result).toBe(false);
}

describe('grade_when — a --max-turns-capped run through a real child (exit 1)', () => {
  const CASES = `
  - id: routes
    prompt: "which tool?"
    must_call: [Read, Bash]
    must_not_call: [Write]
  - id: misroutes
    prompt: "which tool?"
    must_call: [Skill]
`;

  it('grades the capped transcript, both PASS and FAIL, when the outcome is listed', async () => {
    const suite = suiteOf(
      fakeRun('exit', '1', cappedFile),
      '  grade_when: [error_max_turns]',
      CASES
    );
    const { summary, byId } = await run(suite);

    expect(byId.routes).toMatchObject({ verdict: 'PASS', sutOk: true, outcome: 'error_max_turns' });
    // A graded run reports what it cost: input counts the cached prompt tokens, as the decoder does.
    expect(byId.routes).toMatchObject({ tokensInput: 105, tokensOutput: 20 });
    expect(byId.routes.reasons).toEqual([]);
    expect(byId.routes.toolCalls?.map((call) => call.name)).toEqual(['Read', 'Read', 'Bash']);

    expect(byId.misroutes).toMatchObject({
      verdict: 'FAIL',
      sutOk: true,
      outcome: 'error_max_turns',
    });
    expect(byId.misroutes.reasons.join('\n')).toMatch(/Skill/);
    // A graded FAIL is the agent's result: exit 1, not the harness's 2.
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('is a harness error without the key, as before (exit 2)', async () => {
    const suite = suiteOf(fakeRun('exit', '1', cappedFile), '', CASES);
    const { summary, byId } = await run(suite);
    for (const id of ['routes', 'misroutes']) {
      expectHarnessError(
        byId[id],
        /the command exited with code 1; transcript "claude-stream-json": Claude Code ended the run with result "error_max_turns"/
      );
    }
    expect(classifyEvalExit(summary)).toBe(2);
  });

  it("is a harness error again under a case's grade_when: [], beside a case that inherits", async () => {
    const suite = suiteOf(
      fakeRun('exit', '1', cappedFile),
      '  grade_when: [error_max_turns]',
      `
  - id: inherits
    prompt: "which tool?"
    must_call: [Read]
  - id: strict
    prompt: "which tool?"
    must_call: [Read]
    grade_when: []
`
    );
    const { byId } = await run(suite);
    expect(byId.inherits).toMatchObject({ verdict: 'PASS', outcome: 'error_max_turns' });
    expectHarnessError(byId.strict, /ended the run with result "error_max_turns"/);
  });
});

describe('grade_when — what is never graded with the key set', () => {
  const LISTED = '  grade_when: [error_max_turns]';
  const ONE = `
  - id: c
    prompt: p
    must_call: [Read]
`;

  it('an unlisted outcome is a harness error naming it', async () => {
    const suite = suiteOf('fake-agent', LISTED, ONE);
    const { byId } = await run(suite, {
      spawnCommand: seam({ p: capped(1, 'error_max_budget_usd') }),
    });
    expectHarnessError(byId.c, /ended the run with result "error_max_budget_usd"/);
  });

  it('a decoder throw, even one whose message names a listed outcome', async () => {
    const suite = suiteOf('fake-agent', LISTED, ONE);
    const throwing: TranscriptDecoder = () => {
      throw new Error('cut off before the result line (error_max_turns expected)');
    };
    const { byId } = await run(suite, { spawnCommand: seam({ p: capped(1) }) }, throwing);
    expectHarnessError(byId.c, /exited with code 1; transcript "claude-stream-json": cut off/);
  });

  it('output with no result line, at exit 0', async () => {
    const suite = suiteOf('fake-agent', LISTED, ONE);
    const { byId } = await run(suite, {
      spawnCommand: seam({
        p: {
          stdout: CAPTURE.split('\n').slice(0, 7).join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        },
      }),
    });
    expectHarnessError(byId.c, /could not be decoded: the transcript has no final "result" line/);
  });

  it('a run killed by a signal, even when what it printed ends on a listed result', async () => {
    const suite = suiteOf('fake-agent', LISTED, ONE);
    const { byId } = await run(suite, { spawnCommand: seam({ p: capped(null) }) });
    expectHarnessError(byId.c, /exited with code null; .*"error_max_turns"/);
  });

  it('a run that timed out', async () => {
    const suite = suiteOf('fake-agent', LISTED, ONE);
    const { byId } = await run(suite, {
      spawnCommand: seam({ p: { ...capped(null), timedOut: true } }),
    });
    expectHarnessError(byId.c, /timeout and its process tree was killed/);
  });

  it('a success transcript with a non-zero exit', async () => {
    const suite = suiteOf('fake-agent', LISTED, ONE);
    const { byId } = await run(suite, {
      spawnCommand: seam({ p: { stdout: CAPTURE, stderr: '', exitCode: 1, timedOut: false } }),
    });
    expectHarnessError(byId.c, /^SUT run failed: the command exited with code 1$/);
  });
});

describe('grade_when — custom decoders', () => {
  const ONE = `
  - id: c
    prompt: p
    must_contain: [done]
`;
  const finished = { stdout: 'x', stderr: '', exitCode: 0, timedOut: false };

  it('a decoder written before the outcome field grades as success under the key', async () => {
    const legacy: TranscriptDecoder = () => ({ answer: 'done', toolCalls: [], toolResults: [] });
    const suite = suiteOf('fake-agent', '  grade_when: [error_max_turns]', ONE);
    const { byId } = await run(suite, { spawnCommand: seam({ p: finished }) }, legacy);
    expect(byId.c).toMatchObject({ verdict: 'PASS', sutOk: true });
    expect('outcome' in byId.c).toBe(false);
  });

  it("an outcome of its own is graded when listed, and otherwise reads the decoder's reason", async () => {
    const capping: TranscriptDecoder = () => ({
      answer: 'done',
      toolCalls: [],
      toolResults: [],
      outcome: 'hit_step_limit',
      outcomeReason: 'the agent stopped at its step limit',
    });
    const listed = suiteOf('fake-agent', '  grade_when: [hit_step_limit]', ONE);
    const graded = await run(listed, { spawnCommand: seam({ p: finished }) }, capping);
    expect(graded.byId.c).toMatchObject({ verdict: 'PASS', outcome: 'hit_step_limit' });

    const strict = suiteOf('fake-agent', '', ONE);
    const refused = await run(strict, { spawnCommand: seam({ p: finished }) }, capping);
    expectHarnessError(
      refused.byId.c,
      /^SUT run failed: transcript "claude-stream-json" could not be decoded: the agent stopped at its step limit$/
    );
  });

  it('an outcome without a reason gets a generic one', async () => {
    const bare: TranscriptDecoder = () => ({
      answer: 'done',
      toolCalls: [],
      toolResults: [],
      outcome: 'hit_step_limit',
    });
    const suite = suiteOf('fake-agent', '', ONE);
    const { byId } = await run(suite, { spawnCommand: seam({ p: finished }) }, bare);
    expectHarnessError(byId.c, /the run ended with outcome "hit_step_limit"/);
  });
});

describe('grade_when — composition', () => {
  it('runs the workspace after steps on a graded run, and their failure FAILs it', async () => {
    const steps: string[][] = [];
    const suite = suiteOf(
      'fake-agent',
      `  grade_when: [error_max_turns]
defaults:
  workspace: {}`,
      `
  - id: c
    prompt: p
    must_call: [Read]
    after:
      - { run: "check-tree", exit_code: 0 }
`
    );
    const { byId } = await run(suite, {
      spawnCommand: seam({ p: capped(1) }, (request) => {
        steps.push(request.argv);
        return { stdout: '', stderr: '', exitCode: 3, timedOut: false };
      }),
    });
    expect(steps).toEqual([['check-tree']]);
    expect(byId.c).toMatchObject({ verdict: 'FAIL', sutOk: true, outcome: 'error_max_turns' });
    expect(byId.c.reasons.join('\n')).toMatch(/expected exit code 0, got 3/);
  });

  it('grades each run of a repeated case on its own ending, and rates them together', async () => {
    let calls = 0;
    const suite = suiteOf(
      'fake-agent',
      '  grade_when: [error_max_turns]',
      `
  - id: c
    prompt: p
    must_call: [Read]
    repeat: 2
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      cwd: scratch,
      // The first run is capped, the second finishes.
      spawnCommand: async () =>
        (calls += 1) === 1
          ? capped(1)
          : { stdout: CAPTURE, stderr: '', exitCode: 0, timedOut: false },
    });
    const summary = await runEvalSuite(suite, { runCell });
    const [result] = summary.cases;
    expect(result).toMatchObject({ verdict: 'PASS', sutOk: true });
    expect('outcome' in result).toBe(false);
    expect(result.runs?.map((r) => r.outcome)).toEqual(['error_max_turns', undefined]);
    expect('outcome' in result.runs![1]).toBe(false);
  });
});

describe('grade_when — the outcome is visible in every output', () => {
  it('in the case JSON, results.json and the text report, and only on the graded run', async () => {
    const suite = suiteOf(
      'fake-agent',
      '  grade_when: [error_max_turns]',
      `
  - id: capped
    prompt: capped
    must_call: [Read]
  - id: finished
    prompt: finished
    must_call: [Read]
  - id: repeated
    prompt: capped
    must_call: [Read]
    repeat: 2
  - id: misroutes
    prompt: capped
    must_call: [Skill]
`
    );
    const { summary } = await run(suite, {
      spawnCommand: seam({
        capped: capped(1),
        finished: { stdout: CAPTURE, stderr: '', exitCode: 0, timedOut: false },
      }),
    });
    const outputDir = join(scratch, 'visible');
    writeEvalOutput(outputDir, summary);

    const caseJson = JSON.parse(readFileSync(join(outputDir, 'capped.json'), 'utf8'));
    expect(caseJson.outcome).toBe('error_max_turns');
    // Beside `sutOk`, so a reader sees it with the field it qualifies.
    const keys = Object.keys(caseJson);
    expect(keys.indexOf('outcome')).toBe(keys.indexOf('sutOk') + 1);
    expect('outcome' in JSON.parse(readFileSync(join(outputDir, 'finished.json'), 'utf8'))).toBe(
      false
    );
    const results = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    const byId = Object.fromEntries(
      results.cases.map((c: EvalCaseResult) => [c.id, c] as const)
    ) as Record<string, EvalCaseResult>;
    expect(byId.capped.outcome).toBe('error_max_turns');
    expect('outcome' in byId.finished).toBe(false);
    expect(byId.repeated.runs?.map((r) => r.outcome)).toEqual([
      'error_max_turns',
      'error_max_turns',
    ]);

    const reporter = createTextReporter();
    const ctx = { suitePath: 'suite.yaml', outputDir: 'out' };
    for (const result of summary.cases) await reporter.onCellResult?.(result, ctx);
    const printed = consoleUtilsMock.display.mock.calls.map((call) => String(call[0]));
    expect(printed).toContain('PASS  capped (ended on error_max_turns)');
    expect(printed).toContain('PASS  finished');
    expect(printed).toContain(
      '      runs 1: PASS (ended on error_max_turns) · 2: PASS (ended on error_max_turns)'
    );
    // A graded FAIL is the row most easily misread as a finished run's verdict.
    const warned = consoleUtilsMock.displayWarning.mock.calls.map((call) => String(call[0]));
    expect(warned).toContain('FAIL  misroutes (ended on error_max_turns)');
  });
});

describe('grade_when — the outcome in the public custom-decoder contract', () => {
  // A decoder MODULE, loaded the way a suite names one, and a real child process.
  const DECODER = `
export default function decode(stdout) {
  const text = stdout.trim();
  if (!text) throw new Error('the agent printed nothing');
  const [marker, ...answer] = text.split(' ');
  const transcript = { answer: answer.join(' '), toolCalls: [], toolResults: [] };
  if (marker === 'STOPPED') {
    return { ...transcript, outcome: 'hit_step_limit', outcomeReason: 'the agent hit its step limit' };
  }
  return transcript;
}
`;

  it('grades a case on a module decoder outcome that grade_when lists, whatever the exit code', async () => {
    const { loadTranscriptDecoder } = await import('#src/commands/commandEvalRunner.js');
    const decoderPath = join(scratch, 'step-limit-decoder.mjs');
    writeFileSync(decoderPath, DECODER);
    const decoder = await loadTranscriptDecoder(
      './step-limit-decoder.mjs',
      join(scratch, 'suite.yaml')
    );

    const cases = `
  - id: c
    prompt: p
    must_contain: [halfway]
`;
    const listed = suiteOf(
      fakeRun('print', 'STOPPED halfway there', '1'),
      '  grade_when: [hit_step_limit]',
      cases
    );
    const graded = await run(listed, {}, decoder);
    expect(graded.byId.c).toMatchObject({
      verdict: 'PASS',
      sutOk: true,
      outcome: 'hit_step_limit',
      answer: 'halfway there',
    });

    const strict = suiteOf(fakeRun('print', 'STOPPED halfway there', '1'), '', cases);
    const refused = await run(strict, {}, decoder);
    expectHarnessError(
      refused.byId.c,
      /exited with code 1; transcript "claude-stream-json": the agent hit its step limit/
    );
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a number', 42],
    ['null', null],
    ['an object', { name: 'hit_step_limit' }],
  ])(
    'refuses %s as an outcome with a harness error naming the decoder, even when listed',
    async (_label, value) => {
      const malformed = (() => ({
        answer: 'done',
        toolCalls: [],
        toolResults: [],
        outcome: value,
      })) as unknown as TranscriptDecoder;
      const suite = suiteOf(
        'fake-agent',
        '  grade_when: [hit_step_limit]',
        `
  - id: c
    prompt: p
    must_contain: [done]
`
      );
      const { byId } = await run(
        suite,
        { spawnCommand: seam({ p: { stdout: 'x', stderr: '', exitCode: 0, timedOut: false } }) },
        malformed
      );
      expectHarnessError(
        byId.c,
        /^SUT run failed: transcript "claude-stream-json" returned an invalid outcome .*: it must be a non-empty string/
      );
    }
  );

  // BATCH-65 — JSON.stringify throws on these two, which used to replace the reason with the
  // formatter's own message, so the decoder was not named.
  it.each([
    ['a BigInt', () => 10n, '10n'],
    [
      'a circular object',
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
      '[object Object]',
    ],
  ])(
    'refuses %s as an outcome with a harness error naming the decoder',
    async (_label, make, shown) => {
      const malformed = (() => ({
        answer: 'done',
        toolCalls: [],
        toolResults: [],
        outcome: make(),
      })) as unknown as TranscriptDecoder;
      const suite = suiteOf(
        'fake-agent',
        '  grade_when: [hit_step_limit]',
        `
  - id: c
    prompt: p
    must_contain: [done]
`,
        './my-decoder.mjs'
      );
      const { byId } = await run(
        suite,
        { spawnCommand: seam({ p: { stdout: 'x', stderr: '', exitCode: 0, timedOut: false } }) },
        malformed
      );
      expect(byId.c.reasons).toEqual([
        `SUT run failed: transcript "./my-decoder.mjs" returned an invalid outcome ${shown}: it ` +
          'must be a non-empty string naming how the run ended, or left out for a run that finished',
      ]);
      expect(byId.c.sutOk).toBe(false);
    }
  );

  /**
   * A decoder module that returns whatever the command printed, as JSON. The suite names it in
   * `target.transcript` and it is loaded from that name the way `gth eval` loads it, so a reason
   * that names the decoder must name THIS module, not the built-in.
   */
  const ECHO_DECODER = `
export default function decode(stdout) {
  return { toolCalls: [], toolResults: [], ...JSON.parse(stdout) };
}
`;
  const ECHO_NAME = './echo-decoder.mjs';

  async function runEcho(
    targetExtra: string,
    printed: Record<string, unknown>,
    exitCode: number,
    stderr = ''
  ): Promise<EvalCaseResult> {
    const { loadTranscriptDecoder } = await import('#src/commands/commandEvalRunner.js');
    writeFileSync(join(scratch, 'echo-decoder.mjs'), ECHO_DECODER);
    const suite = suiteOf(
      'fake-agent',
      targetExtra,
      `
  - id: c
    prompt: p
    must_contain: [done]
`,
      ECHO_NAME
    );
    const decoder = await loadTranscriptDecoder(
      targetOf(suite).transcript,
      join(scratch, 'suite.yaml')
    );
    const { byId } = await run(
      suite,
      {
        spawnCommand: seam({
          p: { stdout: JSON.stringify(printed), stderr, exitCode, timedOut: false },
        }),
      },
      decoder
    );
    return byId.c;
  }

  it('reads outcome "success" from a decoder as a finished run, at exit 0 and exit 1', async () => {
    // The docs promise it: "return the transcript with no `outcome`, or with `outcome: "success"`".
    const finished = await runEcho(
      '  grade_when: [hit_step_limit]',
      { answer: 'done', outcome: 'success' },
      0
    );
    expect(finished).toMatchObject({ verdict: 'PASS', sutOk: true });
    expect('outcome' in finished).toBe(false);

    // A finished transcript with a non-zero exit is the plain exit-code harness error, as for a
    // decoder that sets no outcome: no outcome sentence is added to it.
    const exited = await runEcho('', { answer: 'done', outcome: 'success' }, 1);
    expectHarnessError(exited, /^SUT run failed: the command exited with code 1$/);
  });

  it('names the custom decoder module, and quotes stderr, when its outcome is invalid', async () => {
    const result = await runEcho(
      '  grade_when: [hit_step_limit]',
      { answer: 'done', outcome: '' },
      0,
      'agent: something went wrong'
    );
    expectHarnessError(
      result,
      /^SUT run failed: transcript "\.\/echo-decoder\.mjs" returned an invalid outcome "": it must be a non-empty string .*; stderr: agent: something went wrong$/
    );
  });

  it.each([
    ['an empty', ''],
    ['a whitespace-only', '   '],
  ])('falls back to a generic reason for %s outcomeReason', async (_label, outcomeReason) => {
    const result = await runEcho(
      '',
      { answer: 'done', outcome: 'hit_step_limit', outcomeReason },
      0
    );
    expectHarnessError(
      result,
      /^SUT run failed: transcript "\.\/echo-decoder\.mjs" could not be decoded: the run ended with outcome "hit_step_limit"$/
    );
  });
});
