import { isDeepStrictEqual } from 'node:util';

import { toolNameMatchesPattern } from '@gaunt-sloth/core/utils/toolMatching.js';

import { resolveJsonPath } from '#src/deterministicChecks.js';
import type { EvalExpectation, ToolResultJsonPathCheck } from '#src/evalTypes.js';
import type { ToolResultRecord } from '#src/types.js';

/**
 * BATCH-21 tool-RESULT assertions — grade a cell against what its called tools *returned*
 * (`toolResults`: per-call `isError` + payload), not just which names were called (BATCH-10's
 * `#src/toolChecks.js`) or what the answer said. This is the structural check the authz/data-
 * isolation suites need: "the restricted identity CALLED the tool AND the call came back denied"
 * becomes deterministic instead of judge-graded.
 *
 * Kept beside (not inside) `runToolCallChecks` on purpose — same file-per-input-kind split the
 * answer checks use: these read the tool RESULTS, that one reads the tool NAMES. Name patterns
 * reuse the same `toolNameMatchesPattern` glob/exact matcher (`@gaunt-sloth/core`), so
 * `mcp__unimarket__*` selects results exactly as it selects calls in `must_call`; payload paths
 * reuse `resolveJsonPath`, the same minimal dot/`[index]` evaluator `json_path` uses on the answer.
 *
 * - `mustError` — for **each** pattern, at least one tool result whose name matches it has
 *   `isError: true`, else `tool "<pattern>" did not return an error` (the same single message
 *   whether the tool succeeded or was never called — either way, no matching error came back).
 * - `toolResultJsonPath` — each entry passes iff **at least one** result from a tool matching its
 *   `tool` pattern satisfies it: the payload parses as JSON, the `path` resolves, and (when set)
 *   `equals` deep-equals / `contains` substring-matches the resolved value. A non-JSON (or absent)
 *   payload is a deterministic per-result FAIL, never a throw — note capture caps payloads
 *   (`TOOL_RESULT_CONTENT_CAP`), so a truncated over-cap payload also fails as non-JSON.
 *
 * The runner only ever calls this with expectation blocks a `gth-agent` suite produced — the suite
 * parser rejects tool-result assertions against `ag-ui`/`adk-agent` targets, whose wire carries no
 * result payloads (see `#src/evalSuite.js`), so an empty `toolResults` here means "no tool
 * returned anything", not "the target can't report results".
 */
export function runToolResultChecks(
  toolResults: ToolResultRecord[],
  expectation: Pick<EvalExpectation, 'mustError' | 'toolResultJsonPath'>
): string[] {
  const failures: string[] = [];

  for (const pattern of expectation.mustError) {
    const matchedAnError = toolResults.some(
      (result) => result.isError && toolNameMatchesPattern(result.name, pattern)
    );
    if (!matchedAnError) {
      failures.push(`tool "${pattern}" did not return an error`);
    }
  }

  for (const check of expectation.toolResultJsonPath) {
    const failure = checkToolResultJsonPath(toolResults, check);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }

  return failures;
}

/** Grade one {@link ToolResultJsonPathCheck}: `undefined` when at least one matching tool result
 * satisfies it, else ONE failure line (per check, not per result) naming the path + tool pattern
 * and the distinct per-result reasons. */
function checkToolResultJsonPath(
  toolResults: ToolResultRecord[],
  check: ToolResultJsonPathCheck
): string | undefined {
  const label = `tool_result_json_path "${check.path}" (tool "${check.tool}")`;
  const matching = toolResults.filter((result) => toolNameMatchesPattern(result.name, check.tool));
  if (matching.length === 0) {
    return `${label}: no result from a matching tool`;
  }

  // First-seen-order distinct reasons: with several matching results (a tool called N times), a
  // repeated reason is reported once, and ANY passing result clears the whole check.
  const reasons = new Set<string>();
  for (const result of matching) {
    const reason = evaluateResultAgainstCheck(result, check);
    if (reason === undefined) return undefined;
    reasons.add(reason);
  }
  return `${label}: ${[...reasons].join('; ')}`;
}

/** Evaluate ONE tool result against ONE check: `undefined` = satisfied, else the failure reason.
 * Deterministic and throw-free: a non-JSON/absent payload is a reason, not an exception. */
function evaluateResultAgainstCheck(
  result: ToolResultRecord,
  check: ToolResultJsonPathCheck
): string | undefined {
  let root: unknown;
  try {
    root = JSON.parse((result.content ?? '').trim());
  } catch {
    return 'result payload is not JSON';
  }

  const { found, value } = resolveJsonPath(root, check.path);
  if (!found) {
    return 'path did not resolve';
  }

  if (check.contains !== undefined) {
    if (typeof value !== 'string') {
      return `is ${JSON.stringify(value)} (contains check requires a string)`;
    }
    if (!value.includes(check.contains)) {
      return `does not contain "${check.contains}"`;
    }
    return undefined;
  }

  // `equals` may legitimately be `null`, so discriminate on KEY presence (the parser normalizes
  // the key out entirely for a pure existence check, and keeps it — possibly null-valued — when
  // the suite set it).
  if ('equals' in check) {
    if (!isDeepStrictEqual(value, check.equals)) {
      return `is ${JSON.stringify(value)}, expected ${JSON.stringify(check.equals)}`;
    }
    return undefined;
  }

  // Neither equals nor contains: a pure existence check — the resolved path is enough.
  return undefined;
}
