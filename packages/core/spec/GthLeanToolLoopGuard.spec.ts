/**
 * EXT-36 acceptance bar (the MECHANICAL half): prove — in a REAL langchain `createAgent` ReAct graph
 * — that the tool-loop guard behaves end-to-end. Two things, mirroring GthLeanToolErrorRecovery.spec:
 *  (a) WARN (default): when a model re-issues the SAME (tool, args) call, the control-flow-free nudge
 *      is injected into the running message list and the run CONTINUES (no abort, no reroute); and
 *  (b) HALT (opt-in): a runaway identical-call loop ends gracefully via jumpTo:'end' instead of
 *      draining calls up to the coarse recursionLimit (no GraphRecursionError).
 *
 * Unlike GthLangChainAgent.spec.ts (which mocks `createAgent` and unit-tests the hook in isolation),
 * this drives the REAL createAgent middleware/router stack with a scripted chat model (no API key)
 * and a real, ALWAYS-SUCCEEDING tool — the no-progress "success" loop GS2-36's error budget cannot
 * see, which is precisely EXT-36's remit. The guard under test is the REAL exported
 * `createToolLoopGuardMiddleware`.
 *
 * This is deliberately NOT a proof that the model CHOOSES to break the loop — the model is scripted;
 * the assertion is only "the nudge reached the graph and the run continued / ended cleanly, never
 * crashed."
 */
import { describe, expect, it } from 'vitest';
import { createAgent } from 'langchain';
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import {
  createToolLoopGuardMiddleware,
  TOOL_LOOP_GUARD_MARKER,
} from '#src/core/GthLangChainAgent.js';

/**
 * A minimal chat model that returns a scripted AIMessage per call (no provider / API key). `respond`
 * is called with the 0-based model-call index so a test can emit the SAME tool call a few times then
 * a final answer, or always emit the same tool call (to exercise HALT). `callCount` lets a test
 * assert the loop was bounded.
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
  bindTools(): unknown {
    return this;
  }
  async _generate(_messages: BaseMessage[]) {
    const message = this.respond(this.callCount++);
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

/** A read_file-shaped tool that ALWAYS succeeds with the SAME result — the no-progress success loop. */
const alwaysSameTool = tool(async () => 'file contents never change', {
  name: 'read_file',
  description: 'Read a file.',
  schema: z.object({ path: z.string() }),
});

// The same (name, args) each time → the SAME signature; the id is unique per call as real ids are.
const sameToolCall = (i: number) =>
  new AIMessage({
    content: '',
    tool_calls: [{ name: 'read_file', args: { path: 'a.txt' }, id: `call-${i}` }],
  });

describe('EXT-36 mechanical half: the loop guard fires in a real createAgent graph', () => {
  it('WARN: the nudge is injected into the running graph and the run CONTINUES to a final answer', async () => {
    // Re-issue the identical call 3 times (tripping the threshold), then — having seen the nudge —
    // produce the final answer. WARN must not abort or reroute, so the run reaches that answer.
    const model = new ScriptedChatModel((i) =>
      i < 3
        ? sameToolCall(i)
        : new AIMessage('Understood — I was repeating myself, here is the answer.')
    );
    const agent = createAgent({
      model,
      tools: [alwaysSameTool],
      middleware: [createToolLoopGuardMiddleware({ threshold: 3 })],
    });

    const result = await agent.invoke({ messages: [new HumanMessage('read a.txt for me')] });
    const messages = result.messages as BaseMessage[];

    // The control-flow-free nudge actually reached the graph (an AIMessage carrying the marker)...
    const nudge = messages.find(
      (m) =>
        AIMessage.isInstance(m) &&
        (m as AIMessage).additional_kwargs?.[TOOL_LOOP_GUARD_MARKER] !== undefined
    ) as AIMessage | undefined;
    expect(nudge).toBeDefined();
    expect(String(nudge!.content)).toContain('same arguments');

    // ...and the run CONTINUED to a later model turn that produced the final answer (no abort).
    const last = messages[messages.length - 1];
    expect(AIMessage.isInstance(last)).toBe(true);
    expect(String(last.content)).toContain('here is the answer');
    // 3 looping calls + the final answer turn.
    expect(model.callCount).toBe(4);
  });

  it('HALT (opt-in): a runaway identical-call loop ENDS gracefully (no recursion-limit crash)', async () => {
    // The model never gives up: it re-issues the identical successful call every turn. Without the
    // guard this drains calls until createAgent's recursionLimit throws; HALT must end it cleanly.
    const model = new ScriptedChatModel((i) => sameToolCall(i));
    const agent = createAgent({
      model,
      tools: [alwaysSameTool],
      middleware: [createToolLoopGuardMiddleware({ halt: true, threshold: 3 })],
    });

    // Resolves (does NOT throw a GraphRecursionError) because the guard jumps to end.
    const result = await agent.invoke({ messages: [new HumanMessage('keep reading a.txt')] });
    const messages = result.messages as BaseMessage[];

    const last = messages[messages.length - 1];
    expect(AIMessage.isInstance(last)).toBe(true);
    expect(String(last.content)).toContain('Stopped after');
    // The loop was bounded to the threshold (3 model calls), far below the coarse recursionLimit.
    expect(model.callCount).toBe(3);
  });
});
