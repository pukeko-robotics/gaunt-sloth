/**
 * GS2-72 regression pin. GS2-72 was filed on the premise that the GS2-36 tool-error retry budget's
 * terminal notice — injected via a `jumpTo:'end'` STATE update — is invisible to the interactive
 * `streamMode:'messages'` path, so the run would drain empty and force GthAgentRunner's wasteful
 * empty-stream fallback `invoke` to re-surface it.
 *
 * On the installed deps (langchain 1.5.x) that premise does NOT hold: the budget middleware is
 * wired only into the lean `createAgent` graph, and that graph streams the injected notice as an
 * `AIMessage` chunk under `streamMode:'messages'` — so `GthAbstractAgent.stream()` enqueues it and
 * the notice reaches the caller as a non-empty result, WITHOUT the fallback invoke. No source change
 * was needed (see the GS2-72 report); this test PINS that behaviour end-to-end so a future langchain
 * bump that stops streaming jumpTo-injected messages is caught (it would then need the surfacing fix
 * GS2-72 originally contemplated).
 *
 * Mirrors GthLeanToolErrorRecovery.spec's fixtures: a scripted model that never gives up (always
 * re-issues the failing tool call) + an always-failing run_shell_command softened to a
 * status:'error' ToolMessage, driven through the REAL budget middleware in a REAL createAgent graph
 * (with a MemorySaver) and the REAL GthAbstractAgent string-stream path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createAgent, createMiddleware } from 'langchain';
import { tool } from '@langchain/core/tools';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
// NOTE: `#src` modules (which pull in the mocked systemUtils/consoleUtils) are imported
// DYNAMICALLY inside the test — a top-level `#src` import would eagerly evaluate the vi.mock
// factories before their mock consts initialize (AGENTS.md: import tested files dynamically).

const consoleUtilsMock = {
  displayInfo: vi.fn(),
  displayToolIndication: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  waitForEscape: vi.fn(),
  stopWaitingForEscape: vi.fn(),
  getUseColour: vi.fn(() => false),
  stdout: { isTTY: false, write: vi.fn() },
  env: {},
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const runConfig: RunnableConfig = { configurable: { thread_id: 'gs2-72' } };

describe('GS2-72 — retry-budget terminal notice reaches the caller via the interactive stream (no fallback invoke)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.getUseColour.mockReturnValue(false);
  });

  it('surfaces the budget notice through streamMode:messages and stays bounded to the cap', async () => {
    const { ShellCommandFailedError } = await import('#src/core/shell/ShellCommandFailedError.js');
    const { createToolErrorBudgetMiddleware } = await import('#src/core/GthLangChainAgent.js');

    class ScriptedChatModel extends BaseChatModel {
      callCount = 0;
      constructor() {
        super({});
      }
      _llmType(): string {
        return 'scripted';
      }
      bindTools(): unknown {
        return this;
      }
      async _generate() {
        const message = new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'run_shell_command',
              args: { command: 'boom' },
              id: `call-${this.callCount++}`,
            },
          ],
        });
        return { generations: [{ message, text: '' }] };
      }
    }

    const shellExitSoftening = createMiddleware({
      name: 'TestShellExitSoftening',
      wrapToolCall: async (request, handler) => {
        try {
          return await handler(request);
        } catch (e) {
          if (e instanceof ShellCommandFailedError) {
            return new ToolMessage({
              content: e.output,
              tool_call_id: (request.toolCall as { id?: string })?.id ?? '',
              status: 'error',
            });
          }
          throw e;
        }
      },
    });

    const alwaysFailingTool = tool(
      async () => {
        throw new ShellCommandFailedError({
          output: "Executing 'boom'...\n\nCommand 'boom' exited with code 1",
          exitCode: 1,
          command: 'boom',
          toolName: 'run_shell_command',
        });
      },
      {
        name: 'run_shell_command',
        description: 'Run a shell command.',
        schema: z.object({ command: z.string() }),
      }
    );

    const CAP = 3;
    const model = new ScriptedChatModel();
    const graph = createAgent({
      model,
      tools: [alwaysFailingTool],
      middleware: [shellExitSoftening, createToolErrorBudgetMiddleware(CAP)],
      checkpointer: new MemorySaver(),
    });

    const { GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js');
    class TestAgent extends GthAbstractAgent {
      async init(): Promise<void> {
        /* graph injected directly below */
      }
    }
    const agent = new TestAgent(() => {});

    (agent as any).config = { writeBinaryOutputsToFile: false };

    (agent as any).agent = graph;

    const stream = await agent.stream([new HumanMessage('keep trying')], runConfig);
    let text = '';
    for await (const chunk of stream) text += chunk;

    // The budget's terminal notice rode out through the interactive string stream as a non-empty
    // result — so GthAgentRunner's empty-stream fallback invoke would NOT fire...
    expect(text).toContain('consecutive failed tool calls');
    // ...and the loop stayed bounded to the cap (no runaway, no extra model call).
    expect(model.callCount).toBe(CAP);
  });
});
