/**
 * [[EXT-159]] — the two middleware termination sites, driven through a REAL `createAgent` graph.
 *
 * Both middlewares end a run deliberately with `jumpTo: 'end'`, and until now the only thing that
 * reached anyone was the notice each injects: a sentence a consumer would have to pattern-match to
 * learn what happened. These cells prove the parallel typed channel exists and that the two sites
 * are distinguishable — "the agent kept failing" and "the agent repeated one call" are different
 * facts about why a run ended, and a taxonomy that collapsed them would be no better than the
 * prose.
 *
 * Driven through a scripted model in a real graph (the shape `GthLeanToolErrorRecovery.spec.ts`
 * and `GthLeanToolLoopGuard.spec.ts` already use) rather than by calling the hook directly, so what
 * is asserted is the site firing on the path production takes to it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAgent, createMiddleware } from 'langchain';
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { ShellCommandFailedError } from '#src/core/shell/ShellCommandFailedError.js';
import {
  createToolErrorBudgetMiddleware,
  createToolLoopGuardMiddleware,
} from '#src/core/GthLangChainAgent.js';
import type { GthTerminationReason } from '#src/core/terminationReason.js';

/** A chat model that returns a scripted AIMessage per call — no provider, no API key. */
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
  bindTools(): unknown {
    return this;
  }
  async _generate(_messages: BaseMessage[]) {
    const message = this.respond(this.callCount++);
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

// The lean production copy of this softener is unit-tested in GthLangChainAgent.spec.ts;
// reproduced here so the real graph observes the same status:'error' ToolMessage the budget counts.
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

/** A run_shell_command-shaped tool that always fails, like a non-zero exit. */
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

const alwaysSameTool = tool(async () => 'file contents never change', {
  name: 'read_file',
  description: 'Read a file.',
  schema: z.object({ path: z.string() }),
});

const callFor = (i: number, path: string) =>
  new AIMessage({
    content: '',
    tool_calls: [{ name: 'read_file', args: { path }, id: `call-${i}` }],
  });

const shellCallFor = (i: number) =>
  new AIMessage({
    content: '',
    tool_calls: [{ name: 'run_shell_command', args: { command: 'boom' }, id: `call-${i}` }],
  });

describe('[[EXT-159]] the run-ending middlewares set a reason', () => {
  it('middleware.tool-error-budget — a capped error streak reports `tool_error_budget`', async () => {
    const halts = vi.fn<(_reason: GthTerminationReason) => void>();
    const model = new ScriptedChatModel((i) => shellCallFor(i));
    const agent = createAgent({
      model,
      tools: [alwaysFailingTool],
      middleware: [shellExitSoftening, createToolErrorBudgetMiddleware(3, halts)],
    });

    const result = await agent.invoke({ messages: [new HumanMessage('keep trying')] });

    // The notice the user sees is unchanged — the typed reason is a parallel channel, not a
    // replacement for it.
    const last = (result.messages as BaseMessage[]).at(-1);
    expect(String(last?.content)).toContain('Stopped after');
    expect(halts).toHaveBeenCalledTimes(1);
    expect(halts.mock.calls[0][0]).toMatchObject({
      site: 'middleware.tool-error-budget',
      category: 'tool_error_budget',
      source: 'control',
      // The guard's own notice asks the model to change its approach; the taxonomy says the same
      // thing in a form a consumer can act on without reading the sentence.
      retryableAsIs: false,
      retryableAfterRemedy: true,
      remedy: 'change-request',
    });
  });

  it('middleware.tool-loop-guard — a halted identical-call loop reports `tool_loop_guard`', async () => {
    const halts = vi.fn<(_reason: GthTerminationReason) => void>();
    const model = new ScriptedChatModel((i) => callFor(i, 'a.txt'));
    const agent = createAgent({
      model,
      tools: [alwaysSameTool],
      middleware: [createToolLoopGuardMiddleware({ halt: true, threshold: 3 }, undefined, halts)],
    });

    const result = await agent.invoke({ messages: [new HumanMessage('keep reading a.txt')] });

    const last = (result.messages as BaseMessage[]).at(-1);
    expect(String(last?.content)).toContain('Stopped after');
    expect(halts).toHaveBeenCalledTimes(1);
    expect(halts.mock.calls[0][0]).toMatchObject({
      site: 'middleware.tool-loop-guard',
      category: 'tool_loop_guard',
      source: 'control',
    });
    // A distinct member, not a shared one: the two guards stop a run for different reasons and a
    // consumer must be able to tell them apart without reading either notice.
    expect(halts.mock.calls[0][0].category).not.toBe('tool_error_budget');
  });

  /**
   * WARN does not end anything — it surfaces a notice and returns `undefined`, leaving the model's
   * input byte-for-byte unchanged. A reason set there would claim a termination that did not
   * happen, which is the same class of untruth this node removes.
   */
  it('the loop guard’s default WARN mode sets no reason, because it ends nothing', async () => {
    const halts = vi.fn<(_reason: GthTerminationReason) => void>();
    const warns = vi.fn<(_message: string) => void>();
    const guard = createToolLoopGuardMiddleware({ threshold: 2 }, warns, halts);
    const hook = (guard as unknown as { beforeModel: { hook: (_s: unknown) => unknown } })
      .beforeModel.hook;

    const messages: BaseMessage[] = [new HumanMessage('go')];
    for (let i = 0; i < 2; i++) {
      messages.push(callFor(i, 'a.txt'));
      messages.push(new ToolMessage({ content: 'same', tool_call_id: `call-${i}` }));
    }

    expect(hook({ messages })).toBeUndefined();
    expect(warns).toHaveBeenCalledTimes(1);
    expect(halts).not.toHaveBeenCalled();
  });
});
