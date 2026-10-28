import { toolNameMatchesPattern } from '@gaunt-sloth/core/utils/toolMatching.js';

import type {
  EvalExpectation,
  ToolCallJsonPathCheck,
  ToolTrajectoryCheck,
} from '#src/evalTypes.js';
import { resolveJsonPath } from '#src/deterministicChecks.js';
import { gradeJsonPathValue } from '#src/toolResultChecks.js';
import type { ToolCallRecord } from '#src/types.js';

/**
 * BATCH-10 tool-trace assertions — grade a case against the tool *names* it actually invoked
 * (`cellResult.tools`), rather than grepping the answer text. This "kills the false-positive class
 * structurally": an MCP-only case can prove the server was called instead of a substring that a
 * hallucinated answer could also contain.
 *
 * Kept separate from `runDeterministicChecks` (which reads the *answer*) on purpose — these read the
 * tool trace — so neither signature is muddied. Patterns reuse GS2-61's `toolNameMatchesPattern`
 * (`@gaunt-sloth/core`), the same glob/exact matcher `allowedTools` uses, so `mcp__unimarket_*`
 * behaves identically here.
 *
 * - `mustCall` — for **each** pattern, at least one called tool must match it, else
 *   `did not call "<pattern>"`.
 * - `mustNotCall` — **no** called tool may match any forbidden pattern; each offending tool is
 *   reported once as `called forbidden tool "<tool>" (matched "<pattern>")`.
 *
 * BATCH-12: grades one {@link EvalExpectation} block's tool-trace assertions (a flat case's single
 * block or a matrix case's identity-scoped block) — same field names, same behavior as before.
 */
export function runToolCallChecks(
  tools: string[],
  expectation: Pick<EvalExpectation, 'mustCall' | 'mustNotCall'>
): string[] {
  const failures: string[] = [];

  for (const pattern of expectation.mustCall) {
    if (!tools.some((tool) => toolNameMatchesPattern(tool, pattern))) {
      failures.push(`did not call "${pattern}"`);
    }
  }

  // De-duplicate: a tool called N times (traces realistically repeat names) is one violation, not
  // N identical failure lines. `Set` preserves first-seen order.
  for (const tool of new Set(tools)) {
    const matched = expectation.mustNotCall.find((pattern) =>
      toolNameMatchesPattern(tool, pattern)
    );
    if (matched !== undefined) {
      failures.push(`called forbidden tool "${tool}" (matched "${matched}")`);
    }
  }

  return failures;
}

/**
 * BATCH-52 tool-call ARGUMENT assertions — grade a cell against the arguments its tools were
 * called WITH (the arguments on `toolCalls`, recorded only when the run sets `evalToolCallArgs`), for a suite where
 * the fact of the call is not enough.
 *
 * Each `tool_call_json_path` entry selects the calls whose name matches its `tool` pattern (the
 * `must_call` matcher), parses each call's arguments as JSON and applies `path` with `equals` /
 * `contains` / `matches` / existence — the same evaluator `tool_result_json_path` uses on a result.
 * `present: false` inverts the existence check: the call satisfies the entry when the path does not
 * resolve. The entry passes iff **at least one** matching call satisfies it, or with `allCalls`
 * iff **every** matching call does; otherwise ONE failure line names the path, the pattern and the
 * distinct per-call reasons. No matching call at all always fails. Arguments cut at the capture
 * cap fail with a reason naming `toolResultCaptureMaxBytes` rather than being graded as a prefix.
 */
export function runToolCallArgChecks(
  toolCalls: ToolCallRecord[],
  expectation: Pick<EvalExpectation, 'toolCallJsonPath'>
): string[] {
  const failures: string[] = [];
  for (const check of expectation.toolCallJsonPath) {
    const failure = checkToolCallJsonPath(toolCalls, check);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}

function checkToolCallJsonPath(
  toolCalls: ToolCallRecord[],
  check: ToolCallJsonPathCheck
): string | undefined {
  const label = `tool_call_json_path "${check.path}" (tool "${check.tool}")`;
  const matching = toolCalls.filter((call) => toolNameMatchesPattern(call.name, check.tool));
  if (matching.length === 0) {
    return `${label}: no call to a matching tool`;
  }
  const reasons = new Set<string>();
  for (const call of matching) {
    const reason = evaluateCallAgainstCheck(call, check);
    if (reason === undefined) {
      if (!check.allCalls) return undefined;
    } else {
      reasons.add(reason);
    }
  }
  return reasons.size === 0 ? undefined : `${label}: ${[...reasons].join('; ')}`;
}

function evaluateCallAgainstCheck(
  call: ToolCallRecord,
  check: ToolCallJsonPathCheck
): string | undefined {
  if (call.argsTruncated) {
    const measured =
      typeof call.argsOriginalBytes === 'number'
        ? ` (the call sent ${call.argsOriginalBytes} bytes)`
        : '';
    return (
      'arguments were truncated at toolResultCaptureMaxBytes' +
      measured +
      '; raise toolResultCaptureMaxBytes to capture them whole'
    );
  }
  // A call with no arguments at all is graded as an empty object, so its reason is the path
  // that did not resolve rather than a parse failure the model never caused.
  const text = (call.args ?? '').trim() || '{}';
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return 'arguments are not JSON';
  }
  if (check.present === false) {
    const { found, value } = resolveJsonPath(root, check.path);
    return found ? `path is present with ${JSON.stringify(value)}` : undefined;
  }
  return gradeJsonPathValue(root, check);
}

/**
 * BATCH-54 call-ORDER assertion — grade a cell (or one turn) against the order its tools were
 * called in. Returns at most one failure line; `[]` when the block declares no `tool_trajectory`.
 *
 * - **Not strict (the default):** the patterns must match an ordered subsequence of the calls.
 *   Other calls may come before, between and after. Each pattern consumes one call, so a pattern
 *   listed twice needs two matching calls.
 * - **Strict:** the number of calls equals the number of patterns, and pattern i matches call i.
 *
 * **Why a greedy left-to-right match is enough.** Each pattern is tested against a single call, and
 * a call either matches it or not; nothing a pattern consumes affects what a later pattern can
 * match except through position. So taking, for pattern i, the EARLIEST matching call after the one
 * pattern i-1 took never hurts: by induction, if any ordered embedding of the patterns exists, the
 * greedy choice for pattern i sits at or before that embedding's choice for pattern i, which leaves
 * at least as many calls for the rest. Overlapping globs (`mcp__*` before `mcp__shop_get`) change
 * nothing, since the argument never looks at which patterns a call could also have matched. No
 * backtracking is needed, and the scan is linear in the number of calls.
 *
 * **Why it grades `toolCalls`, not `tools`.** On the in-process target `tools` is a first-seen
 * name set that also takes names from tool RESULTS, so it cannot express a repeat and can hold a
 * name the model never requested; on the AG-UI target it is a plain list of `TOOL_CALL_START`
 * names. The two targets disagree, so `tools` cannot carry one meaning for this check. `toolCalls` holds
 * one entry per REQUESTED call in the order the model emitted them, parallel calls in one message
 * included, not de-duplicated, so a call counts whether or not it errored or returned a result.
 *
 * **Why `toolCalls` is recorded on every run.** A call-order assertion that only worked with
 * `evalToolCallArgs` set would be refused, or fail, for a reason unrelated to the order. The opt-in
 * now governs only whether each entry keeps its `args` (the model's argument text, the part that
 * needs consent to be written out); the names and ids are what this check reads.
 *
 * The failure line shows the expected patterns against the actual call-name sequence. Strict, it
 * names the first position (1-based) where they differ; not strict, the first pattern that could not
 * be matched in order.
 */
export function runToolTrajectoryChecks(
  toolCalls: ToolCallRecord[],
  expectation: Pick<EvalExpectation, 'toolTrajectory'>
): string[] {
  const check = expectation.toolTrajectory;
  if (check === undefined) return [];
  const failure = check.strict
    ? checkStrictTrajectory(toolCalls, check)
    : checkOrderedTrajectory(toolCalls, check);
  return failure === undefined ? [] : [failure];
}

function quoteList(items: readonly string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
}

function trajectorySummary(qualifier: string, check: ToolTrajectoryCheck, names: string[]): string {
  return (
    `expected ${qualifier} ${quoteList(check.calls)}, calls were ${quoteList(names)}` +
    (names.length === 0 ? ' (no tool was called)' : '')
  );
}

function checkOrderedTrajectory(
  toolCalls: ToolCallRecord[],
  check: ToolTrajectoryCheck
): string | undefined {
  const names = toolCalls.map((call) => call.name);
  // `next` is the index of the first call not yet consumed; `lastMatched` the call the previous
  // pattern took, for the failure line.
  let next = 0;
  let lastMatched: number | undefined;
  for (let p = 0; p < check.calls.length; p++) {
    const pattern = check.calls[p];
    let found = -1;
    for (let c = next; c < names.length; c++) {
      if (toolNameMatchesPattern(names[c], pattern)) {
        found = c;
        break;
      }
    }
    if (found === -1) {
      const after =
        lastMatched === undefined
          ? ''
          : ` after call ${lastMatched + 1} (${JSON.stringify(names[lastMatched])})`;
      return (
        `tool_trajectory: pattern ${p + 1} ${JSON.stringify(pattern)} has no matching call` +
        `${after}; ${trajectorySummary('in order', check, names)}`
      );
    }
    lastMatched = found;
    next = found + 1;
  }
  return undefined;
}

function checkStrictTrajectory(
  toolCalls: ToolCallRecord[],
  check: ToolTrajectoryCheck
): string | undefined {
  const names = toolCalls.map((call) => call.name);
  const length = Math.max(names.length, check.calls.length);
  for (let i = 0; i < length; i++) {
    const pattern = check.calls[i];
    const name = names[i];
    if (pattern !== undefined && name !== undefined && toolNameMatchesPattern(name, pattern)) {
      continue;
    }
    const expected = pattern === undefined ? 'no further call' : JSON.stringify(pattern);
    const actual = name === undefined ? 'no call' : `called ${JSON.stringify(name)}`;
    return (
      `tool_trajectory (strict): differs at position ${i + 1}: expected ${expected}, ${actual}; ` +
      trajectorySummary('exactly', check, names)
    );
  }
  return undefined;
}
