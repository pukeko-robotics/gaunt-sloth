/**
 * GS2-36 acceptance bar (the MECHANICAL half): prove — in a REAL langchain `createAgent` ReAct
 * graph — that (a) a tool failure surfaced to the model as a recoverable status:'error' ToolMessage
 * does NOT abort the run: the loop CONTINUES to the next step, and (b) the retry budget ends a
 * runaway tool-error loop gracefully instead of draining tokens up to the coarse recursionLimit.
 *
 * Unlike GthLangChainAgent.spec.ts (which mocks `createAgent` and unit-tests each middleware in
 * isolation), this drives the REAL createAgent middleware/router stack with a scripted chat model
 * (no API key) and a real failing tool, mirroring GthDeepAgentPathNamespaceOrdering.spec's
 * "prove the MECHANISM end-to-end" approach. The retry budget under test is the REAL exported
 * `createToolErrorBudgetMiddleware`; the shell-exit softening is reproduced inline (its production
 * copy is unit-tested in GthLangChainAgent.spec.ts) so the graph observes the same status:'error'
 * ToolMessage the production softener would hand it.
 *
 * This is deliberately NOT a proof that the model CHOOSES to recover (the Mari addendum) — that
 * behavioural battery is BATCH-5 and does not exist yet. Here the model is scripted; the assertion
 * is only "the errored result reached the model and the run continued / ended cleanly, never crashed."
 */
import { describe, expect, it } from 'vitest';
import { createAgent, createMiddleware } from 'langchain';
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { ShellCommandFailedError } from '#src/core/shell/ShellCommandFailedError.js';
import { createToolErrorBudgetMiddleware } from '#src/core/GthLangChainAgent.js';

/**
 * A minimal chat model that returns a scripted AIMessage per call (no provider / API key). `respond`
 * is called with the 0-based model-call index so a test can emit a tool call then a final answer, or
 * always emit a tool call (to exercise the budget). `callCount` lets a test assert the loop was
 * bounded.
 */
class ScriptedChatModel extends BaseChatModel {
  callCount = 0;
  private readonly respond: (_callIndex: number) => AIMessage;
  constructor(respond: (_callIndex: number) => AIMessage) {
    super({});
    this.respond = respond;
  }
  _llmType(): string {
    return 'scripted';
  }
  // The ReAct graph binds tools to the model; we ignore them and drive responses from the script.
  bindTools(): unknown {
    return this;
  }
  async _generate(_messages: BaseMessage[]) {
    const message = this.respond(this.callCount++);
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

// The lean production copy of this softener is unit-tested in GthLangChainAgent.spec.ts; reproduced
// here so the real graph observes the same status:'error' ToolMessage.
const shellExitSoftening = createMiddleware({
  name: 'TestShellExitSoftening',
  wrapToolCall: async (request, handler) => {
    try {
      return await handler(request);
    } catch (e) {
      if (e instanceof ShellCommandFailedError) {
        return new ToolMessage({
          content: e.output,

          tool_call_id: (request.toolCall as any)?.id ?? '',
          status: 'error',
        });
      }
      throw e;
    }
  },
});

/** A run_shell_command-shaped tool that always fails (like a non-zero exit / spawn error). */
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

const toolCall = (id: string) =>
  new AIMessage({
    content: '',
    tool_calls: [{ name: 'run_shell_command', args: { command: 'boom' }, id }],
  });

describe('GS2-36 mechanical half: errored tool-result reaches the model, run does not abort', () => {
  it('CONTINUES past a softened tool error to the next step (final answer), not a crash', async () => {
    // Turn 1: call the failing tool. Turn 2: having observed the error, answer and finish.
    const model = new ScriptedChatModel((i) =>
      i === 0 ? toolCall('call-1') : new AIMessage('Understood — the command failed, moving on.')
    );
    const agent = createAgent({
      model,
      tools: [alwaysFailingTool],
      middleware: [shellExitSoftening],
    });

    const result = await agent.invoke({ messages: [new HumanMessage('run boom for me')] });
    const messages = result.messages as BaseMessage[];

    // The errored tool-result actually reached the graph as a status:'error' ToolMessage...
    const errored = messages.find(
      (m) => ToolMessage.isInstance(m) && (m as ToolMessage).status === 'error'
    ) as ToolMessage | undefined;
    expect(errored).toBeDefined();
    expect(String(errored!.content)).toContain("Command 'boom' exited with code 1");

    // ...and the run CONTINUED to a second model turn that produced the final answer (no abort).
    const last = messages[messages.length - 1];
    expect(AIMessage.isInstance(last)).toBe(true);
    expect(String(last.content)).toContain('moving on');
    expect(model.callCount).toBe(2);
  });

  it('the retry budget ENDS a runaway tool-error loop gracefully (no recursion-limit crash)', async () => {
    // The model never gives up: it re-issues the failing tool call every turn. Without the budget
    // this drains calls until createAgent's recursionLimit throws; the budget must end it cleanly.
    const model = new ScriptedChatModel((i) => toolCall(`call-${i}`));
    const agent = createAgent({
      model,
      tools: [alwaysFailingTool],
      middleware: [shellExitSoftening, createToolErrorBudgetMiddleware(3)],
    });

    // Resolves (does NOT throw a GraphRecursionError) because the budget jumps to end.
    const result = await agent.invoke({ messages: [new HumanMessage('keep trying')] });
    const messages = result.messages as BaseMessage[];

    const last = messages[messages.length - 1];
    expect(AIMessage.isInstance(last)).toBe(true);
    expect(String(last.content)).toContain('consecutive failed tool calls');
    // The loop was bounded to the cap (3 model calls), far below the coarse recursionLimit.
    expect(model.callCount).toBe(3);
  });
});
