import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { EvalCaseResult, EvalRunContext, EvalSuiteSummary } from '@gaunt-sloth/batch';

// A reason string carrying every XML-special character, to prove escaping ROUND-TRIPS through a real
// JUnit reader (not merely that we emitted *something*): a raw `<` or `&` would make the file
// unparseable, and a wrong escape would corrupt the text on the way back.
const NASTY_REASON = `missing <tag> & "quote" 'apos'`;

/** One crafted summary exercising every branch: a PASS, an assertion-FAIL (sutOk), a SUT error
 * (!sutOk), a judged cell with a tool trace, and an identity-matrix cell. */
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
      reasons: [NASTY_REASON, 'second reason > here'],
    },
    {
      id: 'sut-error',
      verdict: 'FAIL',
      passThreshold: 6,
      sutOk: false,
      durationMs: 50,
      reasons: ['transport error: connection & reset'],
    },
    {
      id: 'judged',
      verdict: 'PASS',
      passThreshold: 6,
      sutOk: true,
      durationMs: 300,
      reasons: [],
      tools: ['read_file', 'run_tests'],
      judge: { attempted: true, ok: true, verdict: { rate: 8, reason: 'clear answer' } },
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
  ];
  return { total: 5, passed: 3, failed: 2, cases };
}

describe('createJUnitReporter — results.xml parsed by a real JUnit reader', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'gth-junit-reporter-'));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  async function emitAndParse(summary: EvalSuiteSummary, suitePath = 'eval/authz-matrix.yaml') {
    const { createJUnitReporter } = await import('#src/junitReporter.js');
    const ctx: EvalRunContext = { suitePath, outputDir };
    await createJUnitReporter().onSuiteEnd?.(summary, ctx);

    const xml = readFileSync(join(outputDir, 'results.xml'), 'utf8');
    // Acceptance: well-formed by a real validator, not just "looks like XML".
    expect(XMLValidator.validate(xml)).toBe(true);

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: true,
      isArray: (name) => name === 'testcase',
    });
    const parsed = parser.parse(xml);
    return { xml, parsed };
  }

  function testcaseByName(parsed: Record<string, any>, name: string): Record<string, any> {
    const cases = parsed.testsuites.testsuite.testcase as Record<string, any>[];
    const found = cases.find((t) => t['@_name'] === name);
    if (!found) throw new Error(`no <testcase name="${name}">`);
    return found;
  }

  it('emits one <testcase> per cell with correct suite counts', async () => {
    const summary = craftSummary();
    const { parsed } = await emitAndParse(summary);

    const cases = parsed.testsuites.testsuite.testcase as unknown[];
    expect(cases).toHaveLength(summary.total);

    // failures = FAIL && sutOk (1: assert-fail); errors = !sutOk (1: sut-error); sum === failed.
    for (const node of [parsed.testsuites, parsed.testsuites.testsuite]) {
      expect(Number(node['@_tests'])).toBe(5);
      expect(Number(node['@_failures'])).toBe(1);
      expect(Number(node['@_errors'])).toBe(1);
    }
    // suiteStem = basename minus extension.
    expect(parsed.testsuites['@_name']).toBe('authz-matrix');
    expect(parsed.testsuites.testsuite['@_name']).toBe('authz-matrix');
  });

  it('maps an assertion FAIL (sutOk) to <failure> with NO <error>, escaping round-tripping intact', async () => {
    const { parsed } = await emitAndParse(craftSummary());
    const tc = testcaseByName(parsed, 'assert-fail');

    expect(tc.failure).toBeDefined();
    expect(tc.error).toBeUndefined();

    // message === the (decoded) first reason; the special characters come back BYTE-INTACT.
    expect(tc.failure['@_message']).toBe(NASTY_REASON);
    const body = String(tc.failure['#text']);
    expect(body).toContain(NASTY_REASON);
    expect(body).toContain('second reason > here');
    // Every XML-special char survived the escape→parse round-trip (proves escaping, not corruption).
    for (const ch of ['<tag>', '&', '"quote"', "'apos'"]) {
      expect(body).toContain(ch);
    }
    expect(tc.classname).toBeUndefined(); // sanity: classname is an attribute, not a child
    expect(tc['@_classname']).toBe('authz-matrix');
  });

  it('maps a SUT run failure (!sutOk) to <error> with NO <failure>', async () => {
    const { parsed } = await emitAndParse(craftSummary());
    const tc = testcaseByName(parsed, 'sut-error');

    expect(tc.error).toBeDefined();
    expect(tc.failure).toBeUndefined();
    expect(tc.error['@_message']).toBe('transport error: connection & reset');
    expect(String(tc.error['#text'])).toContain('connection & reset');
  });

  it('leaves a PASS cell with neither <failure> nor <error> nor <system-out>', async () => {
    const { parsed } = await emitAndParse(craftSummary());
    const tc = testcaseByName(parsed, 'pass-case');

    expect(tc.failure).toBeUndefined();
    expect(tc.error).toBeUndefined();
    expect(tc['system-out']).toBeUndefined();
  });

  it('carries judge rate + tools in <system-out> for a graded cell', async () => {
    const { parsed } = await emitAndParse(craftSummary());
    const tc = testcaseByName(parsed, 'judged');

    expect(tc.failure).toBeUndefined();
    expect(tc.error).toBeUndefined();
    const sysOut = String(tc['system-out']);
    expect(sysOut).toContain('judge: 8/10');
    expect(sysOut).toContain('tools: read_file, run_tests');
  });

  it('labels an identity-matrix cell "<id> [<identity>]"', async () => {
    const { parsed } = await emitAndParse(craftSummary());
    // testcaseByName throws if not present.
    const tc = testcaseByName(parsed, 'greets [admin]');
    expect(tc['@_classname']).toBe('authz-matrix');
  });

  it('does not emit a timestamp attribute (deterministic output)', async () => {
    const { xml } = await emitAndParse(craftSummary());
    expect(xml).not.toContain('timestamp=');
  });

  it('strips XML-1.0-invalid control characters so a conforming reader accepts the file', async () => {
    // Realistic input for this feature: ANSI colour codes (ESC = \x1b) in captured tool output and a
    // stray NUL in a transport-error string. These are FORBIDDEN in XML 1.0 (no valid escape), so a
    // raw one makes a strict reader reject the file — and fast-xml-parser's validator is too lenient
    // to catch it, so assert their ABSENCE from the emitted document directly.
    const summary: EvalSuiteSummary = {
      total: 1,
      passed: 0,
      failed: 1,
      cases: [
        {
          id: 'ansi-reason',
          verdict: 'FAIL',
          passThreshold: 6,
          sutOk: true,
          durationMs: 5,
          reasons: ['expected \x1b[31mred\x1b[0m but got \x00 raw'],
        },
      ],
    };
    const { xml, parsed } = await emitAndParse(summary);
    // No XML-1.0-forbidden control char (tab/LF/CR excepted) may remain anywhere in the document.
    expect(xml).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    // The readable text around the stripped controls survives.
    const tc = testcaseByName(parsed, 'ansi-reason');
    const body = String(tc.failure['#text']);
    for (const chunk of ['expected', 'red', 'but got', 'raw']) {
      expect(body).toContain(chunk);
    }
  });
});
