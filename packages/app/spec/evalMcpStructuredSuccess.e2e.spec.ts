/**
 * EXT-211 — `gth eval` grades a **successful** MCP tool result's `structuredContent` with
 * `tool_result_json_path`, through the production path: the suite parser, `runEvalSuite`, the
 * production run-cell adapter (`buildProductionRunCell` → `runSingleShot`), the production resolvers
 * dialling a real MCP server over stdio through `@langchain/mcp-adapters`, a real agent graph, and
 * `writeEvalOutput`. Only the model is a stub, so there is no key and no network.
 *
 * `@langchain/mcp-adapters` 2.x keeps a successful result's `structuredContent` in the
 * `ToolMessage` artifact rather than in the content the model sees. The capture reads it from there
 * and records it in the envelope 1.x put in the content, so a 1.x-era `path` such as
 * `structuredContent.code` keeps matching.
 *
 * The stub model also records the tool-result content it was handed, which is how these cells pin
 * that the model-facing content is the server's text and nothing was serialised into it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import { resetConsoleLevel, setConsoleLevel } from '@gaunt-sloth/core/utils/consoleLevel.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';

const FIXTURE = fileURLToPath(
  new URL('../../agent/spec/mcp/namedToolsStdioServer.mjs', import.meta.url)
);
const SERVER = 'unimarket';
const TOOL = 'mcp__unimarket_contract_search';

/** The tool-result content each model call was handed, in order. */
const modelSawToolContent: unknown[] = [];

/** Calls the one MCP tool natively, then answers in text once its result has come back. */
class McpCallingModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'mcp-calling';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const toolMessage = messages.find((m) => ToolMessage.isInstance(m));
    if (toolMessage) modelSawToolContent.push(toolMessage.content);
    const message = toolMessage
      ? new AIMessage('The contract search answered.')
      : new AIMessage({
          content: '',
          tool_calls: [{ name: TOOL, args: {}, id: 'call-1', type: 'tool_call' }],
        });
    return { generations: [{ message, text: String(message.content) }] };
  }
}

function suite(checks: string[]): string {
  return `
target: { type: gth-agent }
cases:
  - id: answered
    prompt: "fetch the supply contracts"
    must_call: ["${TOOL}"]
    tool_result_json_path:
${checks.map((check) => `      - ${check}`).join('\n')}
`;
}

const projectDir = mkdtempSync(join(tmpdir(), 'gth-eval-mcp-structured-success-spec-'));

function scriptedConfig(toolArg: string): GthConfig {
  return {
    llm: new McpCallingModel(),
    streamOutput: false,
    contentSource: 'file',
    requirementSource: 'file',
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: false,
    writeBinaryOutputsToFile: false,
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: false,
    // The documented opt-out: no session rows and an in-memory checkpointer, so the run leaves
    // the developer's own history store untouched.
    history: { enabled: false },
    mcpServers: {
      [SERVER]: { transport: 'stdio', command: process.execPath, args: [FIXTURE, toolArg] },
    },
  } as Partial<GthConfig> as GthConfig;
}

/** Run the suite through the production eval path and return the case it wrote. */
async function runSuite(toolArg: string, checks: string[]) {
  const { parseEvalSuite } = await import('@gaunt-sloth/batch/evalSuite.js');
  const { runEvalSuite } = await import('@gaunt-sloth/batch/evalRunner.js');
  const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');
  const { buildProductionRunCell } = await import('#src/commands/batchCommand.js');

  const runCell = await buildProductionRunCell(
    scriptedConfig(toolArg),
    'PREAMBLE',
    {},
    {
      command: 'ask',
      displayCommand: 'eval',
      origin: 'eval',
      sourcePrefix: 'EVAL',
      wrapBlockPrefix: 'message',
      wrapPrefix: 'user message',
      recordToolCalls: true,
    }
  );
  const summary = await runEvalSuite(parseEvalSuite(suite(checks)), { runCell });
  const outputDir = join(projectDir, `${toolArg}-${modelSawToolContent.length}`);
  writeEvalOutput(outputDir, summary);
  return JSON.parse(readFileSync(join(outputDir, 'answered.json'), 'utf8'));
}

let priorProjectDir: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  modelSawToolContent.length = 0;
  priorProjectDir = peekProjectDir();
  setProjectDir(projectDir);
  setConsoleLevel(StatusLevel.ERROR);
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  resetConsoleLevel();
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

describe('gth eval grades a successful MCP result’s structuredContent (EXT-211)', () => {
  it('grades a body that exists only in structuredContent', async () => {
    const answered = await runSuite('contract_search=structured-ok', [
      '{ tool: "' + TOOL + '", path: "structuredContent.code", equals: "STRUCTURED_OK" }',
    ]);

    expect(answered.reasons).toEqual([]);
    expect(answered.verdict).toBe('PASS');
  }, 60000);

  it('grades the structured half of a body sent as both text and structured content', async () => {
    const answered = await runSuite('contract_search=text-and-structured-ok', [
      '{ tool: "' + TOOL + '", path: "structuredContent.code", equals: "STRUCTURED_OK" }',
      '{ tool: "' + TOOL + '", path: "text", contains: "TEXT_OK" }',
    ]);

    expect(answered.reasons).toEqual([]);
    expect(answered.verdict).toBe('PASS');
    // The trace still records exactly what the model observed.
    expect(answered.toolResults[0].content).toBe('{"code":"TEXT_OK"}');
  }, 60000);
});

describe('the model-facing content of an MCP call (EXT-211)', () => {
  // These cells grade nothing, so they hold on either side of the change that added the
  // structured capture: they pin the bytes the model is handed, which that change must not touch.
  it('is the server text alone when the result also carries structuredContent and _meta', async () => {
    await runSuite('contract_search=text-and-structured-ok', [
      '{ tool: "' + TOOL + '", path: "code", contains: "" }',
    ]);

    expect(modelSawToolContent).toEqual(['{"code":"TEXT_OK"}']);
  }, 60000);

  it('carries nothing of a structured-only result', async () => {
    await runSuite('contract_search=structured-ok', [
      '{ tool: "' + TOOL + '", path: "code", contains: "" }',
    ]);

    expect(JSON.stringify(modelSawToolContent)).not.toContain('STRUCTURED_OK');
  }, 60000);

  it('is the server’s own error text, with no prefix, for an errored call', async () => {
    await runSuite('contract_search=text-error', [
      '{ tool: "' + TOOL + '", path: "code", contains: "" }',
    ]);

    expect(modelSawToolContent).toEqual(['{"code":"TEXT_DENIED"}']);
  }, 60000);

  it('control: is the plain text of a result with no structured content', async () => {
    await runSuite('contract_search', ['{ tool: "' + TOOL + '", path: "code", contains: "" }']);

    expect(modelSawToolContent).toEqual(['contract_search']);
  }, 60000);
});
