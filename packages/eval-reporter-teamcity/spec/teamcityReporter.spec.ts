import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalCaseResult, EvalRunContext, EvalSuiteSummary } from '@gaunt-sloth/batch';

// A reason string carrying EVERY TeamCity metacharacter (`| ' [ ] \n \r`), to prove escaping
// ROUND-TRIPS through a real service-message parse (not merely that we emitted *something*): a raw
// `'` or `]` would terminate the attribute/message early, and a raw newline would split the message
// across lines — either corrupts the whole stream.
const NASTY_REASON = `pipe | quote ' bracket [x] newline\nreturn\r end`;

/** One crafted summary exercising every branch: a PASS, an assertion-FAIL (sutOk) with the nasty
 * reason, a SUT error (!sutOk), and two identity-matrix cells sharing one case id. */
function craftSummary(): EvalSuiteSummary {
  const cases: EvalCaseResult[] = [
    {
      id: 'pass-case',
      verdict: 'PASS',
      passThreshold: 6,
      sutOk: true,
      durationMs: 100,
      reasons: [],
    },
    {
      id: 'assert-fail',
      verdict: 'FAIL',
      passThreshold: 6,
      sutOk: true,
      durationMs: 200,
      reasons: [NASTY_REASON, 'second reason [2]'],
    },
    {
      id: 'sut-error',
      verdict: 'FAIL',
      passThreshold: 6,
      sutOk: false,
      durationMs: 50,
      reasons: ["transport error: connection | reset ['auth']"],
    },
    {
      id: 'greets',
      identity: 'admin',
      verdict: 'PASS',
      passThreshold: 6,
      sutOk: true,
      durationMs: 10,
      reasons: [],
    },
    {
      id: 'greets',
      identity: 'limited',
      verdict: 'FAIL',
      passThreshold: 6,
      sutOk: true,
      durationMs: 20,
      reasons: ['forbidden "secret"'],
    },
  ];
  return { total: 5, passed: 2, failed: 3, cases };
}

const CTX: EvalRunContext = { suitePath: 'eval/authz-matrix.yaml', outputDir: '/unused' };

/** A parsed `##teamcity[...]` line: the message name + its (unescaped) attributes. */
interface ServiceMessage {
  message: string;
  attrs: Record<string, string>;
}

// Attribute-value body: any run of chars that are NOT TeamCity metachars, or a `|`-escape pair.
// Used by BOTH the whole-line shape check and the attribute extraction, so a raw `'`/`[`/`]`/`|`/
// newline leaking into a value makes the line UNPARSEABLE here — exactly like TeamCity itself.
const VALUE = String.raw`(?:[^'|\[\]\r\n]|\|.)*`;
const LINE_RE = new RegExp(String.raw`^##teamcity\[(\w+)((?: [A-Za-z]+='${VALUE}')*)\]$`);
const ATTR_RE = new RegExp(String.raw` ([A-Za-z]+)='(${VALUE})'`, 'g');

const UNESCAPE: Record<string, string> = {
  '|': '|',
  "'": "'",
  n: '\n',
  r: '\r',
  '[': '[',
  ']': ']',
  x: '\u0085',
  l: '\u2028',
  p: '\u2029',
};

function unescapeTeamCity(value: string): string {
  return value.replace(/\|(.)/g, (_, ch: string) => UNESCAPE[ch] ?? ch);
}

/** Parse the captured stream STRICTLY: every non-empty line must be a well-formed single-line
 * service message (throws otherwise — the acceptance is "no raw metachar leaks"). */
function parseServiceMessages(chunks: string[]): ServiceMessage[] {
  const lines = chunks
    .join('')
    .split('\n')
    .filter((line) => line.length > 0);
  return lines.map((line) => {
    const match = LINE_RE.exec(line);
    if (!match) throw new Error(`malformed service message line: ${JSON.stringify(line)}`);
    const attrs: Record<string, string> = {};
    for (const [, key, raw] of match[2].matchAll(ATTR_RE)) {
      attrs[key] = unescapeTeamCity(raw);
    }
    return { message: match[1], attrs };
  });
}

/** Drive the reporter over a whole crafted run with a capturing sink, in lifecycle order —
 * awaiting each hook (the contract allows `void | Promise<void>`). */
async function emitAndParse(summary: EvalSuiteSummary, ctx: EvalRunContext = CTX) {
  const { createTeamCityReporter } = await import('#src/teamcityReporter.js');
  const chunks: string[] = [];
  const reporter = createTeamCityReporter((chunk) => {
    chunks.push(chunk);
  });
  await reporter.onSuiteStart?.(ctx);
  for (const result of summary.cases) {
    await reporter.onCellResult?.(result, ctx);
  }
  await reporter.onSuiteEnd?.(summary, ctx);
  return { chunks, messages: parseServiceMessages(chunks) };
}

describe('createTeamCityReporter — live ##teamcity[...] service messages', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('emits the exact suite/test lifecycle sequence, one message per line', async () => {
    const summary = craftSummary();
    const { chunks, messages } = await emitAndParse(summary);

    // Sequence: suite start, then per cell testStarted → (testFailed?) → testFinished, suite end.
    expect(messages.map((m) => m.message)).toEqual([
      'testSuiteStarted',
      'testStarted', // pass-case
      'testFinished',
      'testStarted', // assert-fail
      'testFailed',
      'testFinished',
      'testStarted', // sut-error
      'testFailed',
      'testFinished',
      'testStarted', // greets [admin]
      'testFinished',
      'testStarted', // greets [limited]
      'testFailed',
      'testFinished',
      'testSuiteFinished',
    ]);

    // Suite name = basename minus extension, on both ends.
    expect(messages[0].attrs.name).toBe('authz-matrix');
    expect(messages.at(-1)!.attrs.name).toBe('authz-matrix');

    // Every write is one whole `##teamcity[...]` line terminated by exactly one newline.
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^##teamcity\[.*\]\n$/s);
      expect(chunk.match(/\n/g)).toHaveLength(1);
    }
  });

  it('always closes a cell with testFinished carrying duration in ms', async () => {
    const { messages } = await emitAndParse(craftSummary());
    const finished = messages.filter((m) => m.message === 'testFinished');
    expect(finished.map((m) => m.attrs.duration)).toEqual(['100', '200', '50', '10', '20']);
    // Names pair up with their testStarted counterparts.
    expect(finished.map((m) => m.attrs.name)).toEqual([
      'pass-case',
      'assert-fail',
      'sut-error',
      'greets [admin]',
      'greets [limited]',
    ]);
  });

  it('a PASS cell emits NO testFailed', async () => {
    const { messages } = await emitAndParse(craftSummary());
    const failedNames = messages.filter((m) => m.message === 'testFailed').map((m) => m.attrs.name);
    expect(failedNames).not.toContain('pass-case');
    expect(failedNames).not.toContain('greets [admin]');
  });

  it('an assertion FAIL carries the reasons on testFailed, every metachar escaped and round-tripping', async () => {
    const { chunks, messages } = await emitAndParse(craftSummary());
    const failed = messages.find(
      (m) => m.message === 'testFailed' && m.attrs.name === 'assert-fail'
    );
    expect(failed).toBeDefined();

    // message = first reason; details = all reasons — decoded back BYTE-INTACT through the
    // strict parse (proves `| ' [ ] \n \r` were each escaped, not leaked or dropped).
    expect(failed!.attrs.message).toBe(NASTY_REASON);
    expect(failed!.attrs.details).toBe(`${NASTY_REASON}\nsecond reason [2]`);

    // And the raw stream truly contains the escapes (belt-and-braces on top of the strict parse).
    const raw = chunks.join('');
    expect(raw).toContain("pipe || quote |' bracket |[x|] newline|nreturn|r end");
  });

  it('flags a SUT/harness failure (!sutOk) distinctly in testFailed details', async () => {
    const { messages } = await emitAndParse(craftSummary());
    const failed = messages.find((m) => m.message === 'testFailed' && m.attrs.name === 'sut-error');
    expect(failed).toBeDefined();
    expect(failed!.attrs.message).toBe("transport error: connection | reset ['auth']");
    expect(failed!.attrs.details).toBe(
      "SUT run failed:\ntransport error: connection | reset ['auth']"
    );
  });

  it('derives unique names for matrix cells: "<id> [<identity>]"', async () => {
    const { messages } = await emitAndParse(craftSummary());
    const startedNames = messages
      .filter((m) => m.message === 'testStarted')
      .map((m) => m.attrs.name);
    expect(startedNames).toContain('greets [admin]');
    expect(startedNames).toContain('greets [limited]');
    expect(new Set(startedNames).size).toBe(startedNames.length);
  });

  it('never throws on odd input (missing reasons/duration, absent id) and still closes the cell', async () => {
    const { createTeamCityReporter } = await import('#src/teamcityReporter.js');
    const chunks: string[] = [];
    const reporter = createTeamCityReporter((chunk) => {
      chunks.push(chunk);
    });

    // Deliberately malformed: no reasons array, no durationMs, no id — a reporter MUST NOT be able
    // to fail the run, so the hook must cope rather than throw (the driver would contain it, but
    // defensiveness is part of the contract).
    const odd = { verdict: 'FAIL', sutOk: false } as unknown as EvalCaseResult;
    await expect(
      (async () => {
        await reporter.onCellResult?.(odd, CTX);
      })()
    ).resolves.toBeUndefined();

    const messages = parseServiceMessages(chunks);
    expect(messages.map((m) => m.message)).toEqual(['testStarted', 'testFailed', 'testFinished']);
    expect(messages[1].attrs.message).toBe('SUT run failed');
    expect(messages[2].attrs.duration).toBe('0');
  });

  it('escapes the suite name too (a metachar in the file name cannot corrupt the stream)', async () => {
    const summary: EvalSuiteSummary = { total: 0, passed: 0, failed: 0, cases: [] };
    const { messages } = await emitAndParse(summary, {
      suitePath: "eval/[nasty] suite's.yaml",
      outputDir: '/unused',
    });
    expect(messages.map((m) => m.message)).toEqual(['testSuiteStarted', 'testSuiteFinished']);
    expect(messages[0].attrs.name).toBe("[nasty] suite's");
  });

  it('defaults its sink to process.stdout.write (stdout IS the TeamCity build-log channel)', async () => {
    const { createTeamCityReporter } = await import('#src/teamcityReporter.js');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const reporter = createTeamCityReporter();
      await reporter.onSuiteStart?.(CTX);
      expect(stdoutSpy).toHaveBeenCalledWith("##teamcity[testSuiteStarted name='authz-matrix']\n");
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
