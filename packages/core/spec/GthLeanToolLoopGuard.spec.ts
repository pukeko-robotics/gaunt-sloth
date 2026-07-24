/**
 * EXT-36 acceptance bar (the MECHANICAL half): prove — in a REAL langchain `createAgent` ReAct graph
 * — that the opt-in HALT mode ends a runaway identical-call loop gracefully via `jumpTo:'end'`
 * instead of draining calls up to the coarse recursionLimit (no GraphRecursionError), mirroring
 * GthLeanToolErrorRecovery.spec's "prove the MECHANISM end-to-end" approach.
 *
 * The DEFAULT WARN mode has no end-to-end assertion here BY DESIGN: it surfaces a user-visible notice
 * and returns `undefined` (zero `state.messages` mutation), so there is nothing in the graph's
 * message stream to assert — and appending-then-generating is exactly the provider-unsafe behaviour
 * WARN must avoid, so it must not be exercised against a live/scripted generate loop. WARN's
 * surface-and-don't-mutate contract is unit-tested in GthLangChainAgent.spec.ts by mocking the notice
 * sink and asserting the hook returns `undefined`.
 *
 * The tool ALWAYS SUCCEEDS with the same result — the no-progress "success" loop GS2-36's error
 * budget cannot see, which is precisely EXT-36's remit. The guard under test is the REAL exported
 * `createToolLoopGuardMiddleware`; the model is scripted (no API key), so the assertion is only "the
 * loop ended cleanly via the guard, never crashed."
 */
import { describe, expect, it } from 'vitest';
import { createAgent } from 'langchain';
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { createToolLoopGuardMiddleware } from '#src/core/GthLangChainAgent.js';

/**
 * A minimal chat model that returns a scripted AIMessage per call (no provider / API key). Here it
 * always re-issues the same tool call to exercise HALT; `callCount` lets the test assert the loop was
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

describe('EXT-36 mechanical half: HALT ends a real createAgent loop cleanly', () => {
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
