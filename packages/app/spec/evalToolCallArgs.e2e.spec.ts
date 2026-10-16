/**
 * `gth eval`'s tool-call argument capture for a call the model wrote as plain text, driven through
 * the production path: the suite parser, `runEvalSuite`, the production run-cell adapter
 * (`buildProductionRunCell` → `runSingleShot`), a real lean agent graph with its tool-call repair
 * middleware, and `writeEvalOutput`. Only the model and the tool are stubs, so there is no key and
 * no network.
 *
 * The repair promotes the text to a native call under the id of the text message it replaces. A
 * streamed run has already seen that id as text, so the promoted message never reaches the run
 * stats by the stream; the spec runs both a streamed and a non-streamed run and asserts the call is
 * recorded once, with its exact arguments, in both.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import { resetConsoleLevel, setConsoleLevel } from '@gaunt-sloth/core/utils/consoleLevel.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';

/** Every tool invocation the stub tool received, in order. */
const toolInvocations: unknown[] = [];

const lookupCustomer = tool(
  async (input) => {
    toolInvocations.push(input);
    return JSON.stringify({ customer: input.query, found: true });
  },
  {
    name: 'lookup_customer',
    description: 'Look up a customer by name.',
    schema: z.object({ query: z.string() }),
  }
);

// The production resolvers would load the whole app toolset and dial MCP servers from a unit spec;
// these hand the agent the one stub tool instead.
vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({
  createResolvers: () => ({ resolveTools: async () => [lookupCustomer] }),
}));

/**
 * Writes its tool call as assistant text rather than as a native tool call, and answers in text
 * once a tool result has come back.
 */
class TextEmittingModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'text-emitting';
  }
  bindTools(): unknown {
    return this;
  }
  private textFor(messages: BaseMessage[]): string[] {
    return messages.some((message) => ToolMessage.isInstance(message))
      ? ['Acme is ', 'an EU customer.']
      : ['[tool:lookup_customer]', '{"query":"acme"}'];
  }
  async _generate(messages: BaseMessage[]) {
    const text = this.textFor(messages).join('');
    return { generations: [{ message: new AIMessage(text), text }] };
  }
  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ) {
    for (const text of this.textFor(messages)) {
      const chunk = new ChatGenerationChunk({ text, message: new AIMessageChunk(text) });
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
        chunk,
      });
      yield chunk;
    }
  }
}

const SUITE = `
target: { type: gth-agent }
cases:
  - id: text-emitted
    prompt: "look up acme"
    must_call: ["lookup_customer"]
    tool_call_json_path:
      - { tool: "lookup_customer", path: "query", equals: "acme" }
`;

const projectDir = mkdtempSync(join(tmpdir(), 'gth-eval-tool-call-args-spec-'));

function scriptedConfig(streamOutput: boolean): GthConfig {
  return {
    llm: new TextEmittingModel(),
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
  } as Partial<GthConfig> as GthConfig;
}

/** Run the suite through the production eval path and return what it wrote. */
async function runSuite(streamOutput: boolean, outputDir: string) {
  const { parseEvalSuite } = await import('@gaunt-sloth/batch/evalSuite.js');
  const { runEvalSuite } = await import('@gaunt-sloth/batch/evalRunner.js');
  const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');
  const { buildProductionRunCell } = await import('#src/commands/batchCommand.js');

  const runCell = await buildProductionRunCell(
    scriptedConfig(streamOutput),
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
      recordToolCallArgs: true,
    }
  );
  const summary = await runEvalSuite(parseEvalSuite(SUITE), { runCell });
  writeEvalOutput(outputDir, summary);

  const read = (file: string) => JSON.parse(readFileSync(join(outputDir, file), 'utf8'));
  return { results: read('results.json'), caseFile: read('text-emitted.json') };
}

let priorProjectDir: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  toolInvocations.length = 0;
  priorProjectDir = peekProjectDir();
  setProjectDir(projectDir);
  setConsoleLevel(StatusLevel.ERROR);
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  resetConsoleLevel();
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

describe('gth eval records the arguments of a call the model wrote as text', () => {
  it.each([true, false])(
    'records the promoted call once and grades it (streamOutput: %s)',
    async (streamOutput) => {
      const run = await runSuite(streamOutput, join(projectDir, `stream-${streamOutput}`));

      expect(toolInvocations).toEqual([{ query: 'acme' }]);
      const [textEmitted] = run.results.cases;
      expect(textEmitted.toolCalls).toEqual([
        { name: 'lookup_customer', id: expect.any(String), args: '{"query":"acme"}' },
      ]);
      expect(textEmitted.verdict).toBe('PASS');
      expect(textEmitted.reasons).toEqual([]);
      expect(run.caseFile).toEqual(textEmitted);
    },
    60000
  );
});
