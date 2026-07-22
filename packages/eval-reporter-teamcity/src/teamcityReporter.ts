import { basename, extname } from 'node:path';
// Type-only from the package ROOT (`@gaunt-sloth/batch`): the reporter contract and the eval result
// shapes are re-exported there as ONE public plugin surface. Erased at build, so batch is only a
// peer/dev dependency (no runtime dependency on it — the seam is the shared TYPES, nothing more).
import type {
  EvalCaseResult,
  EvalReporter,
  EvalRunContext,
  EvalSuiteSummary,
} from '@gaunt-sloth/batch';

/**
 * Where the reporter writes its service messages. Defaults to `process.stdout.write` — stdout IS the
 * TeamCity build-log channel a `##teamcity[...]` line must land on — and is injectable so the unit
 * test captures the emitted stream. Deliberately NOT routed through the app's console utils: this
 * package has no core dependency, and a service message must reach the log raw (un-prefixed,
 * un-colored) or TeamCity won't parse it.
 */
export type TeamCityWrite = (chunk: string) => void;

/**
 * Escape a dynamic string for use inside a TeamCity service-message attribute value. This is the
 * crux of the reporter (the analogue of the JUnit reporter's XML escaping): attribute values are
 * delimited by `'` inside a `##teamcity[...]` line, so a raw `'` or `]` in a judge/assertion reason
 * would terminate the value (or the whole message) early and corrupt the stream, and a raw newline
 * would split the message across lines — TeamCity only parses a message that occupies a single line.
 *
 * Per the TeamCity service-message spec, the escape character is `|`, so `|` itself MUST be escaped
 * first: `|`→`||`, `'`→`|'`, `\n`→`|n`, `\r`→`|r`, `[`→`|[`, `]`→`|]`, plus the Unicode line
 * separators NEL (U+0085)→`|x`, LS (U+2028)→`|l`, PS (U+2029)→`|p` for completeness.
 */
export function escapeTeamCity(value: string): string {
  return value
    .replace(/\|/g, '||')
    .replace(/'/g, "|'")
    .replace(/\n/g, '|n')
    .replace(/\r/g, '|r')
    .replace(/\[/g, '|[')
    .replace(/\]/g, '|]')
    .replace(/\u0085/g, '|x')
    .replace(/\u2028/g, '|l')
    .replace(/\u2029/g, '|p');
}

/** Render one `##teamcity[...]` service message, escaping every attribute value, one per line. */
function serviceMessage(messageName: string, attrs: Record<string, string>): string {
  const rendered = Object.entries(attrs)
    .map(([key, value]) => `${key}='${escapeTeamCity(value)}'`)
    .join(' ');
  return `##teamcity[${messageName} ${rendered}]\n`;
}

/** `basename(suitePath)` with its extension removed, e.g. `eval/authz-matrix.yaml` → `authz-matrix`.
 * Used as the `testSuiteStarted`/`testSuiteFinished` name — the same stem the JUnit reporter uses. */
function suiteStem(suitePath: string): string {
  const base = basename(String(suitePath ?? ''));
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** The SAME label the text and JUnit reporters use: `<id> [<identity>]` for a matrix cell, else
 * `<id>` — so matrix cell names are unique per (case × identity). */
function cellLabel(result: EvalCaseResult): string {
  return result.identity ? `${result.id} [${result.identity}]` : String(result.id ?? '');
}

/**
 * Create the live TeamCity reporter: it interleaves `##teamcity[...]` service messages into the
 * build log as the run progresses, so a TeamCity build shows per-cell pass/fail LIVE with zero
 * artifact-path wiring (contrast the JUnit reporter, which writes a `results.xml` artifact at the
 * end). Message sequence:
 *
 * - `onSuiteStart`  → `testSuiteStarted name='<suite stem>'`
 * - `onCellResult`  → `testStarted name='<cell>'`, then on FAIL a `testFailed name='<cell>'
 *   message='<first reason>' details='<all reasons>'` (a SUT/harness failure — `sutOk === false`,
 *   the JUnit reporter's `<error>` category — is distinguished by a `SUT run failed:` details
 *   prefix), then ALWAYS `testFinished name='<cell>' duration='<ms>'`.
 * - `onSuiteEnd`    → `testSuiteFinished name='<suite stem>'`
 *
 * The verdict is read off `result.verdict`/`result.reasons` (already surfaced by the eval runner),
 * never re-derived. Hooks are defensive on odd input (missing reasons/duration never throw) — the
 * driver contains hook errors anyway, but a reporter must not be able to fail the run.
 */
export function createTeamCityReporter(
  write: TeamCityWrite = (chunk) => {
    process.stdout.write(chunk);
  }
): EvalReporter {
  return {
    onSuiteStart(ctx: EvalRunContext): void {
      write(serviceMessage('testSuiteStarted', { name: suiteStem(ctx.suitePath) }));
    },

    onCellResult(result: EvalCaseResult): void {
      const name = cellLabel(result);
      write(serviceMessage('testStarted', { name }));

      if (result.verdict !== 'PASS') {
        const reasons = Array.isArray(result.reasons) ? result.reasons : [];
        // Mirror the JUnit reporter's failure-vs-error split (assertion failure vs a SUT that never
        // produced a gradeable answer) — TeamCity has no per-test "error" category, so the SUT case
        // is flagged in `details` instead of a separate element.
        const sutFailed = result.sutOk === false;
        const message = reasons[0] ?? (sutFailed ? 'SUT run failed' : 'assertion failed');
        const details = sutFailed ? ['SUT run failed:', ...reasons].join('\n') : reasons.join('\n');
        write(serviceMessage('testFailed', { name, message, details }));
      }

      const durationMs = Number.isFinite(result.durationMs) ? result.durationMs : 0;
      write(serviceMessage('testFinished', { name, duration: String(durationMs) }));
    },

    onSuiteEnd(_summary: EvalSuiteSummary, ctx: EvalRunContext): void {
      write(serviceMessage('testSuiteFinished', { name: suiteStem(ctx.suitePath) }));
    },
  };
}
