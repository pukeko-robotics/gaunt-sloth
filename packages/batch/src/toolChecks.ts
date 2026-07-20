import { toolNameMatchesPattern } from '@gaunt-sloth/core/utils/toolMatching.js';

import type { EvalExpectation } from '#src/evalTypes.js';

/**
 * BATCH-10 tool-trace assertions — grade a case against the tool *names* it actually invoked
 * (`cellResult.tools`), rather than grepping the answer text. This "kills the false-positive class
 * structurally": an MCP-only case can prove the server was called instead of a substring that a
 * hallucinated answer could also contain.
 *
 * Kept separate from `runDeterministicChecks` (which reads the *answer*) on purpose — these read the
 * tool trace — so neither signature is muddied. Patterns reuse GS2-61's `toolNameMatchesPattern`
 * (`@gaunt-sloth/core`), the same glob/exact matcher `allowedTools` uses, so `mcp__unimarket__*`
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
