import { describe, expect, it } from 'vitest';
import { ToolMessage } from '@langchain/core/messages';
import { mcpToolErrorMessagePrefix } from '@gaunt-sloth/core/core/mcpErrorPayload.js';
import { extractRunStats } from '@gaunt-sloth/core/core/runStats.js';
import {
  bindMcpToolsets,
  mcpToolRegisteredName,
} from '@gaunt-sloth/core/core/approvals/mcpSubjects.js';
import type { GthToolResult } from '@gaunt-sloth/core/core/types.js';
import type { EvalCase, EvalExpectation, EvalSuite } from '#src/evalTypes.js';
import type { MatrixCell, RunCellFn, ToolResultRecord } from '#src/types.js';

/**
 * BATCH-43 acceptance — a **judge-free** eval case asserting on the CONTENT of an MCP tool's error
 * payload, graded end to end.
 *
 * The record it grades is not hand-written: it is produced by core's real capture
 * (`extractRunStats`) from a real `ToolMessage` carrying the message the MCP adapter throws for an
 * errored tool result — the message the softening middleware turns into the model's observation.
 * A fixture record typed out here would prove the check reads a field and would prove nothing about
 * whether anything ever writes it, which is the half that actually failed before this node.
 *
 * Both halves of the acceptance are asserted against that one captured record: the case PASSes on
 * the recovered error body, **and** the payload the trace reports is still byte-for-byte the
 * adapter's message including its prose prefix. Satisfying either by breaking the other reds here.
 */

const SERVER = 'unimarket';
const BARE_TOOL = 'contract_search';
const REGISTERED_TOOL = mcpToolRegisteredName(SERVER, BARE_TOOL);
/** Every tool of the server, as a `must_error` / `tool_result_json_path` glob. */
const SERVER_GLOB = mcpToolRegisteredName(SERVER, '*');
/** The bindings the session recorded when the server's tool loaded. */
const BINDINGS = bindMcpToolsets([[SERVER, [{ name: REGISTERED_TOOL }]]]);
const SERVER_ERROR_BODY = '{"code":"forbidden","reason":"identity lacks scope contracts:read"}';

/** Exactly what `@langchain/mcp-adapters` throws for an `isError: true` result from this tool. */
const ADAPTER_MESSAGE = `${mcpToolErrorMessagePrefix(SERVER, BARE_TOOL)}${SERVER_ERROR_BODY}`;

/** Run the real core capture over a softened MCP tool error, as a turn's messages would. */
function captureDeniedMcpCall(): GthToolResult[] {
  const stats = extractRunStats(
    [
      new ToolMessage({
        content: ADAPTER_MESSAGE,
        tool_call_id: 'call-1',
        name: REGISTERED_TOOL,
        status: 'error',
      }),
    ],
    BINDINGS
  );
  return stats.toolResults ?? [];
}

function makeExpectation(overrides: Partial<EvalExpectation> = {}): EvalExpectation {
  return {
    mustContain: [],
    mustNotContain: [],
    shouldContainAny: [],
    mustCall: [],
    mustNotCall: [],
    mustMatch: [],
    mustNotMatch: [],
    jsonPath: [],
    mustError: [],
    toolResultJsonPath: [],
    toolCallJsonPath: [],
    judgeRubric: undefined,
    ...overrides,
  };
}

function makeSuite(expectation: Partial<EvalExpectation>): EvalSuite {
  const evalCase: EvalCase = {
    id: 'denied-call-says-why',
    passThreshold: 6,
    turns: [{ user: 'fetch the supply contracts', expectations: [makeExpectation(expectation)] }],
  };
  return { target: { type: 'gth-agent' }, cases: [evalCase] };
}

function runCellWith(toolResults: ToolResultRecord[]): RunCellFn {
  return async (_cell: MatrixCell) => ({
    ok: true,
    answer: 'That account is not allowed to read contracts.',
    tools: [REGISTERED_TOOL],
    toolResults,
  });
}

describe('BATCH-43 — grading an MCP tool error payload end to end', () => {
  it('PASSes a judge-free case asserting the denial error code and reason', async () => {
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');
    const toolResults = captureDeniedMcpCall();

    const summary = await runEvalSuite(
      makeSuite({
        mustCall: [SERVER_GLOB],
        mustError: [SERVER_GLOB],
        toolResultJsonPath: [
          { tool: SERVER_GLOB, path: 'code', equals: 'forbidden' },
          { tool: SERVER_GLOB, path: 'reason', contains: 'contracts:read' },
        ],
      }),
      { runCell: runCellWith(toolResults) }
    );

    expect(summary.cases[0]).toMatchObject({ verdict: 'PASS', reasons: [] });
    expect(classifyEvalExit(summary)).toBe(0);

    // The other half of the acceptance, on the SAME record the case just passed on: the trace still
    // reports the payload exactly as the model observed it, prose prefix included.
    expect(summary.cases[0].toolResults).toEqual([
      {
        name: REGISTERED_TOOL,
        isError: true,
        content: ADAPTER_MESSAGE,
        errorPayload: SERVER_ERROR_BODY,
      },
    ]);
    expect(summary.cases[0].toolResults![0].content).toBe(ADAPTER_MESSAGE);
  });

  it('FAILs when the denial says something other than what the suite pinned', async () => {
    // The check is graded, not merely present: the same trace against a different expected code
    // must fail with the value it actually found, so a suite cannot pass by asserting anything.
    const { runEvalSuite, classifyEvalExit } = await import('#src/evalRunner.js');

    const summary = await runEvalSuite(
      makeSuite({
        mustError: [SERVER_GLOB],
        toolResultJsonPath: [{ tool: SERVER_GLOB, path: 'code', equals: 'rate_limited' }],
      }),
      { runCell: runCellWith(captureDeniedMcpCall()) }
    );

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual([
      `tool_result_json_path "code" (tool "${SERVER_GLOB}"): ` +
        'is "forbidden", expected "rate_limited"',
    ]);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('FAILs as before when the server formatted its denial as prose rather than JSON', async () => {
    // Nothing is recovered from a non-JSON body, so the check falls back to the observed payload
    // and gives its existing reason — the honest answer, not a heuristic parse of the prose.
    const { runEvalSuite } = await import('#src/evalRunner.js');
    const prose = `${mcpToolErrorMessagePrefix(SERVER, BARE_TOOL)}you are not allowed to do that`;
    const toolResults =
      extractRunStats(
        [
          new ToolMessage({
            content: prose,
            tool_call_id: 'call-1',
            name: REGISTERED_TOOL,
            status: 'error',
          }),
        ],
        BINDINGS
      ).toolResults ?? [];

    const summary = await runEvalSuite(
      makeSuite({
        toolResultJsonPath: [{ tool: SERVER_GLOB, path: 'code', equals: 'forbidden' }],
      }),
      { runCell: runCellWith(toolResults) }
    );

    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual([
      `tool_result_json_path "code" (tool "${SERVER_GLOB}"): result payload is not JSON`,
    ]);
    expect(summary.cases[0].toolResults).toEqual([
      { name: REGISTERED_TOOL, isError: true, content: prose },
    ]);
  });
});
