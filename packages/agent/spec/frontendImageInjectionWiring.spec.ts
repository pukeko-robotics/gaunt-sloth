/**
 * RC-22 WIRING GATE (the RC-21 lesson: a same-copy unit test can stay green while the real server
 * path is dead). This drives the REAL production agent path — `GthLangChainAgent` built with the
 * agent package's real `createResolvers()` (exactly what the AG-UI server's `getAgentForTools`
 * reqAgent uses) and `config.middleware: ['frontend-image-injection']` — against a scripted,
 * key-free chat model that CAPTURES the messages it receives. It proves, end to end and hermetically:
 *
 *   1. the middleware is REGISTERED (resolves by the bare name through resolvers → registry),
 *   2. it is ASSEMBLED into the real `createAgent` graph's beforeModel chain by init, and
 *   3. it FIRES on a `capture_image` `{mimeType,data}` ToolMessage, turning it into a vision
 *      HumanMessage that actually REACHES THE MODEL INPUT.
 *
 * The complementary getAgentForTools spread (that `config.middleware` reaches the per-toolset agent's
 * init) is asserted in apiAgUiModule.spec.ts; the cross-@langchain/core-copy safety of the guard is
 * proven by the foreign-fixture unit test in frontendImageInjectionMiddleware.spec.ts. The live
 * browser round-trip across the real file:-dep boundary remains the Andrew live-e2e.
 */
import { describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { GthLangChainAgent } from '@gaunt-sloth/core/core/GthLangChainAgent.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { createResolvers } from '#src/resolvers.js';

/**
 * A minimal chat model (no provider / API key) that records every batch of messages it is asked to
 * generate on, then returns a terminal AIMessage so the ReAct graph ends after one model call.
 */
class CapturingChatModel extends BaseChatModel {
  seenMessages: BaseMessage[][] = [];
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'capturing';
  }
  // The ReAct graph binds tools to the model; ignore them and always return the scripted answer.
  bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.seenMessages.push(messages);
    const message = new AIMessage('done');
    return { generations: [{ message, text: 'done' }] };
  }
}

const IMG = { mimeType: 'image/jpeg', data: 'QUFBQg==' };
const DATA_URL = `data:${IMG.mimeType};base64,${IMG.data}`;

/** Config as the AG-UI (`api`) reqAgent would receive it, with the opt-in middleware referenced. */
function apiConfig(model: BaseChatModel, middleware: unknown[]): GthConfig {
  return {
    llm: model,
    middleware,
    modelProviderType: 'openai',
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
    injectModelContext: false,
    noDefaultPrompts: true,
    allowedTools: [],
  } as unknown as GthConfig;
}

/** A history that ends with a capture_image tool result carrying an image — the CopilotKit shape. */
function captureHistory(): BaseMessage[] {
  return [
    new HumanMessage('Take a photo and describe it.'),
    new AIMessage({
      content: '',
      tool_calls: [{ name: 'capture_image', args: {}, id: 'call-cap-1' }],
    }),
    new ToolMessage({
      content: JSON.stringify(IMG),
      tool_call_id: 'call-cap-1',
      name: 'capture_image',
    }),
  ];
}

function findVisionHumanMessage(seen: BaseMessage[][]): any {
  return seen
    .flat()
    .find(
      (m: any) =>
        typeof m.getType === 'function' &&
        m.getType() === 'human' &&
        Array.isArray(m.content) &&
        m.content.some((b: any) => b?.type === 'image_url' && b?.image_url?.url === DATA_URL)
    );
}

const runConfig: RunnableConfig = { configurable: { thread_id: 'wire-thread-1' } };

describe('RC-22 wiring: frontend-image-injection fires on the real GthLangChainAgent graph', () => {
  it('turns a capture_image {mimeType,data} ToolMessage into a vision HumanMessage the model sees', async () => {
    const model = new CapturingChatModel();
    const agent = new GthLangChainAgent(vi.fn(), createResolvers());
    await agent.init('api', apiConfig(model, ['frontend-image-injection']));

    await agent.invoke(captureHistory(), runConfig);

    const visionMsg = findVisionHumanMessage(model.seenMessages);
    expect(visionMsg).toBeDefined();
    // The provider-native OpenAI block reached the model input.
    expect(visionMsg.content).toEqual([
      { type: 'text', text: 'Camera frame captured:' },
      { type: 'image_url', image_url: { url: DATA_URL } },
    ]);
  });

  it('NEGATIVE control: without the middleware, no vision block is injected (the ToolMessage stays plain text)', async () => {
    const model = new CapturingChatModel();
    const agent = new GthLangChainAgent(vi.fn(), createResolvers());
    await agent.init('api', apiConfig(model, []));

    await agent.invoke(captureHistory(), runConfig);

    // The model was called, but never saw an injected vision HumanMessage.
    expect(model.seenMessages.length).toBeGreaterThan(0);
    expect(findVisionHumanMessage(model.seenMessages)).toBeUndefined();
  });
});
