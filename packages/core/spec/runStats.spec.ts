import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  accumulateMessage,
  capToolResultText,
  createRunStatsAccumulator,
  extractRunStats,
  finalizeRunStats,
  TOOL_RESULT_CONTENT_CAP,
} from '#src/core/runStats.js';
import {
  bindMcpToolsets,
  mcpToolRegisteredName,
  NO_MCP_TOOL_BINDINGS,
  type McpToolBindings,
} from '#src/core/approvals/mcpSubjects.js';

/** Bindings for `(server, tool)` pairs, recorded by the production builder. */
const bound = (...pairs: [server: string, tool: string][]): McpToolBindings =>
  bindMcpToolsets(
    pairs.map(([server, tool]) => [server, [{ name: mcpToolRegisteredName(server, tool) }]])
  );

const UNIMARKET_SEARCH = mcpToolRegisteredName('unimarket', 'contract_search');
const UNIMARKET_BOUND = bound(['unimarket', 'contract_search']);

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

  // BATCH-21 — the tool-RESULT capture rides the SAME ToolMessage loop as name capture: one
  // record per executed tool result (isError from `.status`, capped `content`), with the existing
  // name/token capture unchanged.
  it('captures per-tool-result records (isError + content) while name capture stays unchanged', () => {
    const messages = [
      new HumanMessage('call two tools'),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'mcp__authz_get_data', args: {} },
          { id: 'c2', name: 'read_file', args: { path: 'a.txt' } },
        ],
      }),
      new ToolMessage({
        content: '{"error":{"code":"MODULE_DISABLED"}}',
        tool_call_id: 'c1',
        name: 'mcp__authz_get_data',
        status: 'error',
      }),
      new ToolMessage({ content: 'file body', tool_call_id: 'c2', name: 'read_file' }),
      new AIMessage({ content: 'done' }),
    ];

    const stats = extractRunStats(messages);
    // Existing name capture: unchanged (deduped across request + execution, same as before).
    expect(stats.tools.sort()).toEqual(['mcp__authz_get_data', 'read_file']);
    // New result capture: one record per ToolMessage, in arrival order.
    expect(stats.toolResults).toEqual([
      {
        name: 'mcp__authz_get_data',
        isError: true,
        content: '{"error":{"code":"MODULE_DISABLED"}}',
      },
      { name: 'read_file', isError: false, content: 'file body' },
    ]);
  });

  it('does NOT dedupe toolResults: a tool called twice yields two records (names stay deduped)', () => {
    const acc = createRunStatsAccumulator();
    accumulateMessage(acc, new ToolMessage({ content: 'a', tool_call_id: '1', name: 'read_file' }));
    accumulateMessage(
      acc,
      new ToolMessage({ content: 'b', tool_call_id: '2', name: 'read_file', status: 'error' })
    );
    const stats = finalizeRunStats(acc);
    expect(stats.tools).toEqual(['read_file']);
    expect(stats.toolResults).toEqual([
      { name: 'read_file', isError: false, content: 'a' },
      { name: 'read_file', isError: true, content: 'b' },
    ]);
  });

  it('JSON-stringifies a non-string tool payload (complex content blocks) into content', () => {
    const acc = createRunStatsAccumulator();
    accumulateMessage(
      acc,
      new ToolMessage({
        content: [{ type: 'text', text: 'denied' }],
        tool_call_id: 'c1',
        name: 'mcp__x_y',
      })
    );
    const stats = finalizeRunStats(acc);
    expect(stats.toolResults).toEqual([
      { name: 'mcp__x_y', isError: false, content: '[{"type":"text","text":"denied"}]' },
    ]);
  });

  it(`caps a giant ASCII tool payload at TOOL_RESULT_CONTENT_CAP (${TOOL_RESULT_CONTENT_CAP}) bytes`, () => {
    // ASCII, so a byte and a character are the same size and the cut lands exactly on the cap —
    // the behaviour this capture had before the unit changed, pinned so the change cannot move it.
    const acc = createRunStatsAccumulator();
    const giant = 'x'.repeat(TOOL_RESULT_CONTENT_CAP + 1000);
    accumulateMessage(
      acc,
      new ToolMessage({ content: giant, tool_call_id: 'c1', name: 'read_file' })
    );
    const stats = finalizeRunStats(acc);
    expect(stats.toolResults).toHaveLength(1);
    const record = stats.toolResults![0];
    expect(Buffer.byteLength(record.content!)).toBe(TOOL_RESULT_CONTENT_CAP);
    expect(record.content).toBe(giant.slice(0, TOOL_RESULT_CONTENT_CAP));
    // The cut is recorded AT capture, with the size the tool actually returned.
    expect(record.contentTruncated).toBe(true);
    expect(record.contentOriginalBytes).toBe(Buffer.byteLength(giant));
  });

  it('records no truncation fields when the payload fits the cap', () => {
    const acc = createRunStatsAccumulator();
    accumulateMessage(
      acc,
      new ToolMessage({ content: 'short', tool_call_id: 'c1', name: 'read_file' })
    );
    expect(finalizeRunStats(acc).toolResults).toEqual([
      { name: 'read_file', isError: false, content: 'short' },
    ]);
  });

  // BATCH-49 — the configured cap, not the constant, is what the capture applies. A cell that only
  // asserted against the default could not tell a wired key from a hardcoded one.
  it('truncates at the configured capture cap rather than at 8192', () => {
    const acc = createRunStatsAccumulator();
    const payload = 'y'.repeat(100);
    accumulateMessage(
      acc,
      new ToolMessage({ content: payload, tool_call_id: 'c1', name: 'read_file' }),
      NO_MCP_TOOL_BINDINGS,
      40
    );
    const record = finalizeRunStats(acc).toolResults![0];
    expect(Buffer.byteLength(record.content!)).toBe(40);
    expect(record.content).toBe(payload.slice(0, 40));
    expect(record.contentTruncated).toBe(true);
    expect(record.contentOriginalBytes).toBe(100);
    // And the default is untouched: the same payload under no configured cap is stored whole.
    const uncapped = createRunStatsAccumulator();
    accumulateMessage(
      uncapped,
      new ToolMessage({ content: payload, tool_call_id: 'c1', name: 'read_file' })
    );
    expect(finalizeRunStats(uncapped).toolResults![0].content).toBe(payload);
  });

  it('cuts on a character boundary, so a budget landing mid-character still decodes', () => {
    // U+1F426 (a bird) encodes as four UTF-8 bytes, F0 9F 90 A6. A cap of 2 would land two bytes
    // inside it; the cut must end before the character, not inside it. `codePointAt` is the pin a
    // U+FFFD check is not: a truncated lead byte decodes as U+FFFD, and so does a genuine U+FFFD a
    // payload was allowed to contain, whereas a kept code point that is not in the original is a
    // split whatever the replacement character is.
    const bird = '\u{1F426}';
    expect(Buffer.byteLength(bird)).toBe(4);
    const text = `ok${bird}tail`;
    const capped = capToolResultText(text, 4);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe('ok');
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(4);
    expect(text.startsWith(capped.text)).toBe(true);
    expect(Buffer.from(capped.text).toString('utf8')).toBe(capped.text);
    for (let i = 0; i < capped.text.length;) {
      const point = capped.text.codePointAt(i)!;
      expect(text.codePointAt(i)).toBe(point);
      i += point > 0xffff ? 2 : 1;
    }
    expect(capped.originalBytes).toBe(Buffer.byteLength(text));

    // The boundary case the walk exists for: the budget ends ON the lead byte of a 2-byte
    // character (U+00E9 is C3 A9). A cut that includes that lead emits a code point the original
    // does not contain at that index.
    const accented = 'caf\u00e9';
    expect(Buffer.from(accented)).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xc3, 0xa9]));
    const onLead = capToolResultText(accented, 4);
    expect(onLead.text).toBe('caf');
    expect(accented.startsWith(onLead.text)).toBe(true);
    expect(onLead.text.codePointAt(onLead.text.length - 1)).toBe(accented.codePointAt(2));

    // The same cut through the capture, at a configured cap, lands on the record.
    const acc = createRunStatsAccumulator();
    accumulateMessage(
      acc,
      new ToolMessage({ content: text, tool_call_id: 'c1', name: 'read_file' }),
      NO_MCP_TOOL_BINDINGS,
      4
    );
    const record = finalizeRunStats(acc).toolResults![0];
    expect(record.content).toBe('ok');
    expect(record.contentTruncated).toBe(true);
    expect(Buffer.from(record.content!).toString('utf8')).toBe(record.content);
  });

  it('applies the configured cap to the recovered MCP error body too', () => {
    // A body the default cap would recover, and a small configured cap must drop — the two capture
    // sites share one budget, so raising or lowering the key moves both.
    const body = `{"reason":"${'z'.repeat(60)}"}`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(40);
    expect(Buffer.byteLength(body)).toBeLessThan(TOOL_RESULT_CONTENT_CAP);
    const observed = `MCP tool 'contract_search' on server 'unimarket' returned an error: ${body}`;

    const atDefault = createRunStatsAccumulator();
    accumulateMessage(
      atDefault,
      new ToolMessage({
        content: observed,
        tool_call_id: 'c1',
        name: UNIMARKET_SEARCH,
        status: 'error',
      }),
      UNIMARKET_BOUND
    );
    expect(finalizeRunStats(atDefault).toolResults![0].errorPayload).toBe(body);

    const atSmallCap = createRunStatsAccumulator();
    accumulateMessage(
      atSmallCap,
      new ToolMessage({
        content: observed,
        tool_call_id: 'c1',
        name: UNIMARKET_SEARCH,
        status: 'error',
      }),
      UNIMARKET_BOUND,
      40
    );
    const record = finalizeRunStats(atSmallCap).toolResults![0];
    expect(record.errorPayload).toBeUndefined();
    expect(record.contentTruncated).toBe(true);
    expect(Buffer.byteLength(record.content!)).toBeLessThanOrEqual(40);
  });

  it('records no toolResult for a ToolMessage without a usable name (matches name capture)', () => {
    const acc = createRunStatsAccumulator();
    accumulateMessage(acc, new ToolMessage({ content: 'x', tool_call_id: 'c1', name: '' }));
    const stats = finalizeRunStats(acc);
    expect(stats.tools).toEqual([]);
    expect(stats.toolResults).toEqual([]);
  });

  // BATCH-43 — the recovered MCP error body is captured BESIDE the observed payload. Both halves
  // are asserted on the SAME record on purpose: satisfying one by tidying up the other is the exact
  // failure this feature must not have, and split across two records neither assertion sees it.
  it('captures the recovered MCP error body while leaving the observed payload byte-identical', () => {
    const observed =
      "MCP tool 'contract_search' on server 'unimarket' returned an error: " +
      '{"code":"forbidden","reason":"identity lacks scope contracts:read"}';
    const acc = createRunStatsAccumulator();
    accumulateMessage(
      acc,
      new ToolMessage({
        content: observed,
        tool_call_id: 'c1',
        name: UNIMARKET_SEARCH,
        status: 'error',
      }),
      UNIMARKET_BOUND
    );

    const stats = finalizeRunStats(acc);
    expect(stats.toolResults).toEqual([
      {
        name: UNIMARKET_SEARCH,
        isError: true,
        // What the model saw — prose prefix and all, unchanged.
        content: observed,
        // What a tool_result_json_path assertion can grade.
        errorPayload: '{"code":"forbidden","reason":"identity lacks scope contracts:read"}',
      },
    ]);
  });

  it('threads the MCP tool bindings through, so a key containing the separator still resolves', () => {
    const observed =
      "MCP tool 'contract__search' on server 'uni__market' returned an error: " +
      '{"code":"forbidden"}';
    const acc = createRunStatsAccumulator();
    accumulateMessage(
      acc,
      new ToolMessage({
        content: observed,
        tool_call_id: 'c1',
        name: mcpToolRegisteredName('uni__market', 'contract__search'),
        status: 'error',
      }),
      bound(['uni__market', 'contract__search'])
    );
    expect(finalizeRunStats(acc).toolResults![0]).toEqual({
      name: mcpToolRegisteredName('uni__market', 'contract__search'),
      isError: true,
      content: observed,
      errorPayload: '{"code":"forbidden"}',
    });
  });

  it('records no errorPayload when the caller supplies no MCP tool bindings', () => {
    // The default: nothing names the server, so nothing is recovered and the record is exactly the
    // shape it had before BATCH-43.
    const observed =
      'MCP tool \'contract_search\' on server \'unimarket\' returned an error: {"code":"forbidden"}';
    const acc = createRunStatsAccumulator();
    accumulateMessage(
      acc,
      new ToolMessage({
        content: observed,
        tool_call_id: 'c1',
        name: UNIMARKET_SEARCH,
        status: 'error',
      })
    );
    expect(finalizeRunStats(acc).toolResults).toEqual([
      { name: UNIMARKET_SEARCH, isError: true, content: observed },
    ]);
  });

  it('caps the observed payload and records NO errorPayload when the body exceeds the cap', () => {
    const huge = `{"reason":"${'x'.repeat(TOOL_RESULT_CONTENT_CAP)}"}`;
    const observed = `MCP tool 'contract_search' on server 'unimarket' returned an error: ${huge}`;
    const acc = createRunStatsAccumulator();
    accumulateMessage(
      acc,
      new ToolMessage({
        content: observed,
        tool_call_id: 'c1',
        name: UNIMARKET_SEARCH,
        status: 'error',
      }),
      UNIMARKET_BOUND
    );
    const record = finalizeRunStats(acc).toolResults![0];
    // ASCII, so the byte cap and the old character cap land on the same character — pinned in
    // bytes now, because that is the unit the cap counts.
    expect(Buffer.byteLength(record.content!)).toBe(TOOL_RESULT_CONTENT_CAP);
    expect(record.contentTruncated).toBe(true);
    expect(record.errorPayload).toBeUndefined();
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
