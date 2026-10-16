/**
 * BATCH-54 — `gth eval`'s `tool_trajectory` against the `toolCalls` the production path records,
 * driven through the suite parser, `runEvalSuite`, the production run-cell adapter
 * (`buildProductionRunCell` → `runSingleShot`), a real lean agent graph and `writeEvalOutput`. Only
 * the model and the tools are stubs, so there is no key and no network.
 *
 * The model requests three calls in ONE message (parallel calls), in an order that is neither
 * alphabetical nor the order the tools are registered in, and calls one of them twice. The spec
 * pins what the trajectory check depends on: every requested call is recorded, in the order the
 * model emitted them, not de-duplicated, on a streamed and a non-streamed run alike, and without
 * `evalToolCallArgs` the entries carry no arguments.
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

const stubTool = (name: string) =>
  tool(async () => JSON.stringify({ ok: true }), {
    name,
    description: `Stub ${name}.`,
    schema: z.object({ id: z.number() }),
  });

vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({
  createResolvers: () => ({
    resolveTools: async () => [stubTool('alpha'), stubTool('beta'), stubTool('gamma')],
  }),
}));

/** The calls the model requests in its one tool-calling message, in emission order. */
const EMITTED = [
  { id: 'call_1', name: 'gamma', args: { id: 1 } },
  { id: 'call_2', name: 'alpha', args: { id: 2 } },
  { id: 'call_3', name: 'gamma', args: { id: 3 } },
];

/** Requests {@link EMITTED} as native parallel calls, then answers once the results are back. */
class ParallelCallingModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'parallel-calling';
  }
  bindTools(): unknown {
    return this;
  }
  private answered(messages: BaseMessage[]): boolean {
    return messages.some((message) => ToolMessage.isInstance(message));
  }
  async _generate(messages: BaseMessage[]) {
    const message = this.answered(messages)
      ? new AIMessage('done')
      : new AIMessage({
          content: '',
          tool_calls: EMITTED.map((call) => ({ ...call, type: 'tool_call' as const })),
        });
    return {
      generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }],
    };
  }
  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ) {
    if (this.answered(messages)) {
      const chunk = new ChatGenerationChunk({ text: 'done', message: new AIMessageChunk('done') });
      await runManager?.handleLLMNewToken('done', undefined, undefined, undefined, undefined, {
        chunk,
      });
      yield chunk;
      return;
    }
    for (const [index, call] of EMITTED.entries()) {
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              index,
              id: call.id,
              name: call.name,
              args: JSON.stringify(call.args),
              type: 'tool_call_chunk',
            },
          ],
        }),
      });
    }
  }
}

const suite = (trajectory: string) => `
target: { type: gth-agent }
cases:
  - id: parallel
    prompt: "do the three things"
    tool_trajectory: ${trajectory}
`;

const projectDir = mkdtempSync(join(tmpdir(), 'gth-eval-tool-trajectory-spec-'));

function scriptedConfig(streamOutput: boolean): GthConfig {
  return {
    llm: new ParallelCallingModel(),
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
    // No session rows and an in-memory checkpointer, so the run leaves the developer's own history
    // store untouched.
    history: { enabled: false },
  } as Partial<GthConfig> as GthConfig;
}

/** Run a suite through the production eval path WITHOUT the args opt-in; return what it wrote. */
async function runSuite(yaml: string, streamOutput: boolean, outputDir: string) {
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
      recordToolCallArgs: false,
    }
  );
  const summary = await runEvalSuite(parseEvalSuite(yaml), { runCell });
  writeEvalOutput(outputDir, summary);
  return JSON.parse(readFileSync(join(outputDir, 'parallel.json'), 'utf8'));
}

let priorProjectDir: string | undefined;

beforeEach(() => {
  priorProjectDir = peekProjectDir();
  setProjectDir(projectDir);
  setConsoleLevel(StatusLevel.ERROR);
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  resetConsoleLevel();
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

describe('gth eval grades tool_trajectory against parallel calls in one message', () => {
  it.each([true, false])(
    'records every call in emission order, without arguments (streamOutput: %s)',
    async (streamOutput) => {
      const caseFile = await runSuite(
        suite('{ calls: [gamma, alpha, gamma], strict: true }'),
        streamOutput,
        join(projectDir, `strict-${streamOutput}`)
      );

      expect(caseFile.toolCalls).toEqual([
        { name: 'gamma', id: 'call_1' },
        { name: 'alpha', id: 'call_2' },
        { name: 'gamma', id: 'call_3' },
      ]);
      expect(caseFile.verdict).toBe('PASS');
      expect(caseFile.reasons).toEqual([]);
    },
    60000
  );

  it.each([true, false])(
    'fails a trajectory in a different order (streamOutput: %s)',
    async (streamOutput) => {
      const caseFile = await runSuite(
        suite('{ calls: [alpha, gamma, gamma] }'),
        streamOutput,
        join(projectDir, `wrong-${streamOutput}`)
      );

      expect(caseFile.verdict).toBe('FAIL');
      expect(caseFile.reasons).toEqual([
        'tool_trajectory: pattern 3 "gamma" has no matching call after call 3 ("gamma"); ' +
          'expected in order ["alpha", "gamma", "gamma"], calls were ["gamma", "alpha", "gamma"]',
      ]);
    },
    60000
  );
});
