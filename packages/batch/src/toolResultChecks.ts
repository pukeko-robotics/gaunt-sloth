import { isDeepStrictEqual } from 'node:util';

import { toolNameMatchesPattern } from '@gaunt-sloth/core/utils/toolMatching.js';

import { resolveJsonPath } from '#src/deterministicChecks.js';
import type {
  EvalExpectation,
  ToolCallJsonPathCheck,
  ToolResultJsonPathCheck,
} from '#src/evalTypes.js';
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
 * `mcp__unimarket_*` selects results exactly as it selects calls in `must_call`; payload paths
 * reuse `resolveJsonPath`, the same minimal dot/`[index]` evaluator `json_path` uses on the answer.
 *
 * - `mustError` — for **each** pattern, at least one tool result whose name matches it has
 *   `isError: true`, else `tool "<pattern>" did not return an error` (the same single message
 *   whether the tool succeeded or was never called — either way, no matching error came back).
 * - `toolResultJsonPath` — each entry passes iff **at least one** result from a tool matching its
 *   `tool` pattern satisfies it: the payload parses as JSON, the `path` resolves, and (when set)
 *   `equals` deep-equals / `contains` substring-matches the resolved value. A non-JSON (or absent)
 *   payload is a deterministic per-result FAIL, never a throw. A payload capture cut at
 *   `toolResultCaptureMaxBytes` fails too, with its own reason naming that key, even when the
 *   cut prefix still parses — the cut is recorded on the result at capture (`contentTruncated`),
 *   and this check reads that record rather than inferring the cut from the stored length or from
 *   a parse of the prefix.
 *   (BATCH-43) The payload it reads is the result's `errorPayload` when capture recovered one — an
 *   errored MCP tool's own error body, freed from the adapter's prose prefix — and otherwise the
 *   observed `content`, which is left exactly as the model saw it in either case.
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

/**
 * BATCH-49 — the reason a payload that capture cut gets, distinct from the one a prose payload
 * gets.
 *
 * The two used to share `result payload is not JSON`, which sent the person reading it to the
 * server when the cut had happened here. The wording names `toolResultCaptureMaxBytes` because
 * that is the key to raise, and it quotes the original size when capture recorded one, because a
 * reason that only names the key still leaves the new value to be guessed. The original size is
 * optional in the wording only: a record written before the field existed still has to produce a
 * reason that names the key.
 */
function truncatedPayloadReason(originalBytes: number | undefined): string {
  const measured =
    typeof originalBytes === 'number' ? ` (the tool returned ${originalBytes} bytes)` : '';
  return (
    'result payload was truncated at toolResultCaptureMaxBytes' +
    measured +
    ' and is no longer JSON; raise toolResultCaptureMaxBytes to capture it whole'
  );
}

/** Evaluate ONE tool result against ONE check: `undefined` = satisfied, else the failure reason.
 * Deterministic and throw-free: a non-JSON/absent payload is a reason, not an exception. */
function evaluateResultAgainstCheck(
  result: ToolResultRecord,
  check: ToolResultJsonPathCheck
): string | undefined {
  // BATCH-43 — grade the recovered MCP error body when capture produced one, else the observed
  // payload exactly as before. An errored MCP tool's `content` is the adapter's prose-prefixed
  // message and never parses; `errorPayload` is the server's own body with that prefix removed,
  // and it is only ever recorded when it parses, so this branch cannot introduce a new failure —
  // when it is absent (any non-MCP result, or an MCP error whose body is prose) the reason below
  // is the same deterministic one the check has always given.
  // The recovered body is graded when capture produced one; it is only recorded when it
  // parsed, so this branch never sees a truncated `errorPayload` — an over-cap body is dropped
  // whole rather than cut. The truncation flag is about `content`, and it is only consulted when
  // `content` is what is being graded.
  const gradingContent = result.errorPayload === undefined;
  const payload = result.errorPayload ?? result.content ?? '';
  // Consult the flag before the parse. A cut prefix can still parse — a JSON document padded with
  // trailing whitespace past the cap, or a long top-level number cut short — and grading it would
  // judge a payload the server did not send. A cut inside an object or array never parses. `errorPayload` is only recorded when it parsed whole, so a truncated observed payload
  // must not turn that recovered body into a truncation failure.
  if (gradingContent && result.contentTruncated) {
    return truncatedPayloadReason(result.contentOriginalBytes);
  }
  let root: unknown;
  try {
    root = JSON.parse(payload.trim());
  } catch {
    return 'result payload is not JSON';
  }

  return gradeJsonPathValue(root, check);
}

/**
 * Resolve `check.path` against an already-parsed payload and apply its `equals` / `contains` /
 * `matches` (or neither: existence). `undefined` = satisfied, else the reason. Shared by the
 * tool-RESULT check above and BATCH-52's tool-call ARGUMENT check, which differ only in which
 * payload they parse.
 */
export function gradeJsonPathValue(
  root: unknown,
  check: Pick<ToolResultJsonPathCheck, 'path' | 'equals' | 'contains'> &
    Pick<ToolCallJsonPathCheck, 'matches'>
): string | undefined {
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

  if (check.matches !== undefined) {
    if (typeof value !== 'string') {
      return `is ${JSON.stringify(value)} (matches check requires a string)`;
    }
    if (!check.matches.test(value)) {
      return `does not match ${check.matches}`;
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
