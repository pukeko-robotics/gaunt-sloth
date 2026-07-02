import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  accumulateMessage,
  createRunStatsAccumulator,
  extractRunStats,
  finalizeRunStats,
} from '#src/core/runStats.js';

/**
 * GS2-16 — the run-stats harvester. These lock in that token usage + invoked tool names are read
 * from a finished run's messages (the "mocked agent result carrying usage_metadata + tool_calls"),
 * that tokens are OMITTED (not zeroed) when no provider usage was reported, and that the whole
 * thing is fail-soft.
 */
describe('core/runStats', () => {
  it('sums usage_metadata and collects requested + executed tool names', () => {
    // A realistic finished-run message list: an AIMessage that requested a tool (with usage), the
    // ToolMessage result, then the final AIMessage (with usage). Human input carries no analytics.
    const messages = [
      new HumanMessage('read the file'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
        usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }),
      new ToolMessage({ content: 'file body', tool_call_id: 'c1', name: 'read_file' }),
      new AIMessage({
        content: 'done',
        usage_metadata: { input_tokens: 130, output_tokens: 10, total_tokens: 140 },
      }),
    ];

    const stats = extractRunStats(messages);
    expect(stats.tokensInput).toBe(230); // 100 + 130
    expect(stats.tokensOutput).toBe(30); // 20 + 10
    expect(stats.tools).toEqual(['read_file']); // deduped across request + execution
  });

  it('OMITS token fields (leaves them undefined) when no message reported usage_metadata', () => {
    const messages = [
      new HumanMessage('hi'),
      new AIMessage({ content: 'hello' }), // no usage_metadata
    ];
    const stats = extractRunStats(messages);
    expect(stats.tokensInput).toBeUndefined();
    expect(stats.tokensOutput).toBeUndefined();
    expect(stats.tools).toEqual([]);
  });

  it('records tokens (even if zero) once usage IS present, and dedupes multiple tools', () => {
    const acc = createRunStatsAccumulator();
    accumulateMessage(
      acc,
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'a', name: 'run_shell_command', args: {} },
          { id: 'b', name: 'read_file', args: {} },
        ],
        usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      })
    );
    accumulateMessage(
      acc,
      new ToolMessage({ content: 'x', tool_call_id: 'a', name: 'run_shell_command' })
    );
    const stats = finalizeRunStats(acc);
    expect(stats.tokensInput).toBe(0);
    expect(stats.tokensOutput).toBe(0);
    expect(stats.tools.sort()).toEqual(['read_file', 'run_shell_command']);
  });

  it('is fail-soft on malformed / non-message input (never throws)', () => {
    const acc = createRunStatsAccumulator();
    expect(() => accumulateMessage(acc, null)).not.toThrow();
    expect(() => accumulateMessage(acc, 42)).not.toThrow();
    expect(() =>
      accumulateMessage(acc, { usage_metadata: 'nope', tool_calls: 'nope' })
    ).not.toThrow();
    expect(() => extractRunStats('not an array' as unknown)).not.toThrow();
    const stats = finalizeRunStats(acc);
    expect(stats.tokensInput).toBeUndefined();
    expect(stats.tools).toEqual([]);
  });
});
