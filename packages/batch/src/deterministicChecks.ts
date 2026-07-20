import { isDeepStrictEqual } from 'node:util';

import type { DeterministicCheckResult, EvalCase, JsonPathCheck } from '#src/evalTypes.js';

/** Render a compiled pattern back as `/source/flags` for failure messages. */
function formatRegex(re: RegExp): string {
  return `/${re.source}/${re.flags}`;
}

/**
 * Resolve a **minimal** JSON path (BATCH-10) against an already-parsed JSON value.
 *
 * Supported subset (deliberately tiny, dependency-free — NOT full JSONPath):
 * - an optional leading `$` and/or leading `.` (`$.items[0]`, `.items[0]`, and `items[0]` are
 *   equivalent);
 * - dot-separated object keys (`data.rows`);
 * - `[<int>]` array indexing (`items[0]`, `rows[2].id`).
 *
 * No wildcards, filters, slices, quoted keys, or negative indices. A segment made only of digits
 * is treated as an array index; any other segment is an object key. Returns `{ found: false }` for
 * any missing key, out-of-range index, or type mismatch (indexing a non-array, keying a non-object)
 * rather than throwing.
 */
export function resolveJsonPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  let p = path.trim();
  if (p.startsWith('$')) p = p.slice(1);
  if (p.startsWith('.')) p = p.slice(1);
  // Normalize `[n]` index syntax into dot segments so a single split handles both forms.
  p = p.replace(/\[(\d+)\]/g, '.$1');
  const segments = p.split('.').filter((segment) => segment.length > 0);

  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return { found: false };
    }
    if (/^\d+$/.test(segment)) {
      const index = Number(segment);
      if (!Array.isArray(current) || index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else {
      if (Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
        return { found: false };
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: current };
}

/** Run the `json_path` assertions over the answer parsed as JSON. If the answer is not valid JSON,
 * the whole group fails with a single reason (not one per entry) and no entry is evaluated. */
function runJsonPathChecks(answer: string, checks: JsonPathCheck[]): string[] {
  if (checks.length === 0) return [];

  let root: unknown;
  try {
    root = JSON.parse(answer.trim());
  } catch {
    return ['answer is not JSON (json_path checks require a JSON answer)'];
  }

  const failures: string[] = [];
  for (const check of checks) {
    const { found, value } = resolveJsonPath(root, check.path);
    if (!found) {
      failures.push(`json_path "${check.path}" did not resolve (no such path in answer)`);
      continue;
    }
    if (check.contains !== undefined) {
      if (typeof value !== 'string') {
        failures.push(
          `json_path "${check.path}" is ${JSON.stringify(value)} (contains check requires a string)`
        );
      } else if (!value.includes(check.contains)) {
        failures.push(`json_path "${check.path}" does not contain "${check.contains}"`);
      }
    } else if (!isDeepStrictEqual(value, check.equals)) {
      failures.push(
        `json_path "${check.path}" is ${JSON.stringify(value)}, expected ${JSON.stringify(check.equals)}`
      );
    }
  }
  return failures;
}

/**
 * Deterministic, answer-based checks over an SUT answer. The substring family is ported, not
 * reinvented, from the field user's proven `deterministic()` function
 * (`docs/batch-eval-user-requirements.md` Appendix A); BATCH-10 adds regex and minimal JSON-path
 * assertions alongside them (all over the *answer* — tool-trace assertions live in
 * `#src/toolChecks.js`, since they read the tool names, not the answer):
 *
 * - `mustContain` — every entry must appear (case-insensitive substring); each miss is reported.
 * - `mustNotContain` — no entry may appear; each hit is reported.
 * - `shouldContainAny` — at least one entry must appear; reported as a single combined failure
 *   (not one per missing option — the check is "at least one", so there is only one way to fail
 *   it) when none do.
 * - `mustMatch` — every regex must match the raw answer (no case-folding: the pattern owns its
 *   flags); each miss is reported as `answer did not match /…/`.
 * - `mustNotMatch` — no regex may match; each hit is reported as `answer matched forbidden /…/`.
 * - `jsonPath` — the answer is parsed as JSON and each path assertion (`equals`/`contains`) is
 *   checked; a non-JSON answer fails the whole group once.
 *
 * Failures are ordered substring → regex → json_path, so a substring-only case produces exactly the
 * same output it did before BATCH-10. A case with every array empty trivially passes (no checks to
 * fail) — the suite parser (`#src/evalSuite.js`) is what enforces that a case has *some* check or a
 * judge rubric; this function itself has no opinion on that.
 */
export function runDeterministicChecks(
  answer: string,
  evalCase: Pick<EvalCase, 'mustContain' | 'mustNotContain' | 'shouldContainAny'> &
    Partial<Pick<EvalCase, 'mustMatch' | 'mustNotMatch' | 'jsonPath'>>
): DeterministicCheckResult {
  const text = answer.toLowerCase();
  const failures: string[] = [];

  for (const needle of evalCase.mustContain) {
    if (!text.includes(needle.toLowerCase())) {
      failures.push(`missing "${needle}"`);
    }
  }

  for (const needle of evalCase.mustNotContain) {
    if (text.includes(needle.toLowerCase())) {
      failures.push(`forbidden "${needle}"`);
    }
  }

  if (
    evalCase.shouldContainAny.length > 0 &&
    !evalCase.shouldContainAny.some((needle) => text.includes(needle.toLowerCase()))
  ) {
    failures.push(`none of [${evalCase.shouldContainAny.join(' | ')}]`);
  }

  // Use `answer.search(re)` rather than `re.test(answer)`: a stored `RegExp` carrying the `g` flag
  // is stateful via `lastIndex` under `.test()`, whereas `String.prototype.search` ignores it.
  for (const re of evalCase.mustMatch ?? []) {
    if (answer.search(re) === -1) {
      failures.push(`answer did not match ${formatRegex(re)}`);
    }
  }

  for (const re of evalCase.mustNotMatch ?? []) {
    if (answer.search(re) !== -1) {
      failures.push(`answer matched forbidden ${formatRegex(re)}`);
    }
  }

  failures.push(...runJsonPathChecks(answer, evalCase.jsonPath ?? []));

  return { passed: failures.length === 0, failures };
}
