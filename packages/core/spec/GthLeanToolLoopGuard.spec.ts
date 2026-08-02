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

/**
 * OPS-34 — the signature delimiter is U+0000, and it is written in source as an escape rather than
 * a raw byte (that invariant is enforced repo-wide by `noRawControlBytes.spec.ts`). These pin the
 * BEHAVIOUR the escape must preserve, so a future "simplification" of the delimiter has to fail
 * here rather than silently changing what counts as the same call.
 */
describe('OPS-34 tool-call signature delimiter', () => {
  it('is exactly one character, U+0000', async () => {
    const { TOOL_CALL_SIGNATURE_DELIMITER } = await import('#src/core/GthLangChainAgent.js');
    expect(TOOL_CALL_SIGNATURE_DELIMITER).toHaveLength(1);
    expect(TOOL_CALL_SIGNATURE_DELIMITER.charCodeAt(0)).toBe(0);
  });

  it('separates the tool name from its serialised arguments', async () => {
    const { toolCallSignature } = await import('#src/core/GthLangChainAgent.js');
    const sig = toolCallSignature('read_file', { path: 'a.txt' });
    expect(sig.charCodeAt('read_file'.length)).toBe(0);
    expect(sig.startsWith('read_file')).toBe(true);
    expect(sig.endsWith('{"path":"a.txt"}')).toBe(true);
  });

  it('two calls differing only in arguments get distinct signatures', async () => {
    const { toolCallSignature } = await import('#src/core/GthLangChainAgent.js');
    expect(toolCallSignature('read_file', { path: 'a.txt' })).not.toBe(
      toolCallSignature('read_file', { path: 'b.txt' })
    );
  });

  it('identical name and arguments collide by design — that is the loop signal', async () => {
    const { toolCallSignature } = await import('#src/core/GthLangChainAgent.js');
    // Key order must not matter: the streak counter would miss a real loop if it did.
    expect(toolCallSignature('read_file', { a: 1, b: 2 })).toBe(
      toolCallSignature('read_file', { b: 2, a: 1 })
    );
  });

  it('splits into exactly two parts, so the name/args boundary is unambiguous', async () => {
    const { toolCallSignature } = await import('#src/core/GthLangChainAgent.js');
    // This is the property the control character actually buys: a tool name cannot contain U+0000,
    // and stableStringify never emits one, so the delimiter occurs exactly once and the boundary
    // can always be recovered. Under a printable delimiter this assertion fails.
    const parts = toolCallSignature('read_file', { path: 'a b-c.txt' }).split(
      String.fromCharCode(0)
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('read_file');
    expect(parts[1]).toBe('{"path":"a b-c.txt"}');
  });
});
