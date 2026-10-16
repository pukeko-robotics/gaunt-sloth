/**
 * BATCH-54 — the shape of the `toolCalls` list `gth eval` writes, shared by the in-process
 * (`batchCommand.ts`) and AG-UI (`agUiEvalRunner.ts`) runners so the two cannot drift.
 *
 * `gth eval` records `toolCalls` on every run, because `tool_trajectory` grades the order of the
 * calls and a call-order assertion that needed an opt-in would be refused for a reason that has
 * nothing to do with the order. The run-level `evalToolCallArgs` now decides only whether each entry
 * keeps its `args`: those are the model's own argument text, written to result files and handed to
 * reporters unredacted, and that is what the opt-in exists to consent to. A name and an id say
 * nothing the `tools` list does not already say.
 *
 * The capture itself is unchanged: core's run-stats accumulator and the AG-UI decoder both build
 * each record with its arguments, and this strips them before the record reaches the outcome. So
 * with the opt-in off no argument text reaches a result file, and with it on the records pass
 * through untouched, byte for byte what the opt-in produced before.
 *
 * @module
 */
import type { ToolCallRecord } from '@gaunt-sloth/batch';

/**
 * The `toolCalls` an eval outcome carries: `calls` unchanged when `withArgs`, otherwise each entry
 * reduced to its `name` and, when the provider sent one, its `id`. Order and count are kept.
 */
export function evalToolCallRecords(
  calls: readonly ToolCallRecord[],
  withArgs: boolean
): ToolCallRecord[] {
  if (withArgs) return [...calls];
  return calls.map((call) => ({ name: call.name, ...(call.id ? { id: call.id } : {}) }));
}
