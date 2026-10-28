/**
 * EXT-211 — `gth eval` grades an MCP tool's **structured** error body with `tool_result_json_path`,
 * driven through the production path: the suite parser, `runEvalSuite`, the production run-cell
 * adapter (`buildProductionRunCell` → `runSingleShot`), the production resolvers dialling a real MCP
 * server over stdio through `@langchain/mcp-adapters`, a real agent graph, and `writeEvalOutput`.
 * Only the model is a stub, so there is no key and no network.
 *
 * The adapter returns an errored MCP result as a `ToolMessage` whose `artifact` keeps the result's
 * `structuredContent`. A server that puts its error detail only there sends the model a stock
 * sentence as text, so the body is gradable only if the capture reads the artifact. The cells:
 *
 * - structured-only: the body exists nowhere but the artifact;
 * - text and structured, disagreeing: shows which one the capture prefers;
 * - control, text only: grades the text body exactly as before, with no artifact involved.
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
    const message = messages.some((m) => ToolMessage.isInstance(m))
      ? new AIMessage('The contract search was refused.')
      : new AIMessage({
          content: '',
          tool_calls: [{ name: TOOL, args: {}, id: 'call-1', type: 'tool_call' }],
        });
    return { generations: [{ message, text: String(message.content) }] };
  }
}

function suite(expectedCode: string): string {
  return `
target: { type: gth-agent }
cases:
  - id: refused
    prompt: "fetch the supply contracts"
    must_error: ["${TOOL}"]
    tool_result_json_path:
      - { tool: "${TOOL}", path: "code", equals: "${expectedCode}" }
`;
}

const projectDir = mkdtempSync(join(tmpdir(), 'gth-eval-mcp-structured-error-spec-'));

function scriptedConfig(fixtureMode: string, streamOutput: boolean): GthConfig {
  return {
    llm: new McpCallingModel(),
    streamOutput,
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
      [SERVER]: {
        transport: 'stdio',
        command: process.execPath,
        args: [FIXTURE, `contract_search=${fixtureMode}`],
      },
    },
  } as Partial<GthConfig> as GthConfig;
}

/** Run the suite through the production eval path and return the case it wrote. */
async function runSuite(fixtureMode: string, expectedCode: string, streamOutput: boolean) {
  const { parseEvalSuite } = await import('@gaunt-sloth/batch/evalSuite.js');
  const { runEvalSuite } = await import('@gaunt-sloth/batch/evalRunner.js');
  const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');
  const { buildProductionRunCell } = await import('#src/commands/batchCommand.js');

  const runCell = await buildProductionRunCell(
    scriptedConfig(fixtureMode, streamOutput),
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
  const summary = await runEvalSuite(parseEvalSuite(suite(expectedCode)), { runCell });
  const outputDir = join(projectDir, `${fixtureMode}-${expectedCode}-${streamOutput}`);
  writeEvalOutput(outputDir, summary);
  return JSON.parse(readFileSync(join(outputDir, 'refused.json'), 'utf8'));
}

let priorProjectDir: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  priorProjectDir = peekProjectDir();
  setProjectDir(projectDir);
  setConsoleLevel(StatusLevel.ERROR);
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  resetConsoleLevel();
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

describe('gth eval grades an MCP structured error body (EXT-211)', () => {
  it.each([true, false])(
    'grades a body that exists only in structuredContent (streamOutput: %s)',
    async (streamOutput) => {
      const refused = await runSuite('structured-error', 'STRUCTURED_DENIED', streamOutput);

      expect(refused.reasons).toEqual([]);
      expect(refused.verdict).toBe('PASS');
      const [result] = refused.toolResults;
      expect(result).toMatchObject({ name: TOOL, isError: true });
      // The model observed the adapter's stock sentence, and the trace still says so.
      expect(result.content).toBe('The MCP tool returned an error without text content.');
    },
    60000
  );

  it('prefers the structured body over a text body that disagrees with it', async () => {
    const refused = await runSuite('text-and-structured-error', 'STRUCTURED_DENIED', false);

    expect(refused.reasons).toEqual([]);
    expect(refused.verdict).toBe('PASS');
    expect(refused.toolResults[0].content).toBe('{"code":"TEXT_DENIED"}');
  }, 60000);

  it('control: grades a text-only JSON body from the observed content, as before', async () => {
    const refused = await runSuite('text-error', 'TEXT_DENIED', false);

    expect(refused.reasons).toEqual([]);
    expect(refused.verdict).toBe('PASS');
    expect(refused.toolResults[0]).not.toHaveProperty('errorPayload');
  }, 60000);
});
