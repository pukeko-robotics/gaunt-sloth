/**
 * RC-22 — function-level tests for the frontend-image-injection middleware and its by-name registry
 * resolution. The end-to-end "it actually fires on the real agent graph and reaches the model input"
 * proof lives in frontendImageInjectionWiring.spec.ts; here we pin the transform, the RC-21
 * cross-copy guard, the per-provider block shapes, error/idempotency/opt-in behaviour, and that the
 * registry resolves the bare name (deriving the provider from config).
 */
import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import {
  createFrontendImageInjectionMiddleware,
  imageBlockFor,
  DEFAULT_CAPTURE_TOOL_NAME,
} from '#src/middleware/frontendImageInjectionMiddleware.js';
import { resolveMiddleware } from '#src/middleware/registry.js';

/** Invoke the middleware's beforeModel hook (a plain function for the object-form createMiddleware). */

async function runBeforeModel(mw: any, messages: unknown[], threadId = 'thread-1') {
  const hook = typeof mw.beforeModel === 'function' ? mw.beforeModel : mw.beforeModel.hook;
  return hook({ messages }, { configurable: { thread_id: threadId } });
}

/**
 * A `capture_image` ToolMessage as constructed by a SECOND @langchain/core copy (a `file:`-dep
 * consumer): a plain object that duck-types as a tool message (`getType() === 'tool'` → passes
 * `isToolMessage`) but is NOT an instance of the `ToolMessage` class this package imports (fails
 * `instanceof`). This is the exact RC-21 golden-bug shape.
 */
function foreignCaptureToolMessage(
  payload: Record<string, unknown>,
  id = 'call-foreign-1',
  name = 'capture_image'
): BaseMessage {
  return {
    getType: () => 'tool',
    content: JSON.stringify(payload),
    tool_call_id: id,
    name,
  } as unknown as BaseMessage;
}

/** A native capture round: assistant tool-call request + its capture ToolMessage result. */
function captureRound(payload: Record<string, unknown>, id = 'call-1', name = 'capture_image') {
  return [
    new AIMessage({ content: '', tool_calls: [{ name, args: {}, id }] }),
    new ToolMessage({ content: JSON.stringify(payload), tool_call_id: id, name }),
  ];
}

/** Extract the last message's content blocks (the injected HumanMessage), if it is a block array. */

function lastInjectedBlocks(result: any): any[] | undefined {
  const msgs = result?.messages;
  if (!Array.isArray(msgs)) return undefined;
  const last = msgs[msgs.length - 1];
  return Array.isArray(last?.content) ? last.content : undefined;
}

const IMG = { mimeType: 'image/jpeg', data: 'QUFBQg==' };
const DATA_URL = `data:${IMG.mimeType};base64,${IMG.data}`;

describe('imageBlockFor — per-provider vision block shape', () => {
  it('OpenAI-compatible providers use image_url:{url} (Completions AND Responses safe)', () => {
    for (const provider of ['openai', 'openrouter', 'deepseek', 'xai', 'groq']) {
      expect(imageBlockFor(provider, IMG.mimeType, IMG.data)).toEqual({
        type: 'image_url',
        image_url: { url: DATA_URL },
      });
    }
  });

  it('ollama uses a data-URL STRING image_url (not {url})', () => {
    expect(imageBlockFor('ollama', IMG.mimeType, IMG.data)).toEqual({
      type: 'image_url',
      image_url: DATA_URL,
    });
  });

  it('anthropic / google-genai / vertexai use the standard base64 block', () => {
    for (const provider of ['anthropic', 'google-genai', 'vertexai']) {
      expect(imageBlockFor(provider, IMG.mimeType, IMG.data)).toEqual({
        type: 'image',
        source_type: 'base64',
        mime_type: IMG.mimeType,
        data: IMG.data,
      });
    }
  });

  it('an unknown provider (huggingface / fake / "") falls back to the base64 block', () => {
    for (const provider of ['huggingface', 'fake', '']) {
      expect(imageBlockFor(provider, IMG.mimeType, IMG.data)).toEqual({
        type: 'image',
        source_type: 'base64',
        mime_type: IMG.mimeType,
        data: IMG.data,
      });
    }
  });
});

describe('createFrontendImageInjectionMiddleware — transform', () => {
  it('RC-21: injects a vision block for a FOREIGN-copy ToolMessage (passes isToolMessage, fails instanceof)', async () => {
    const foreign = foreignCaptureToolMessage(IMG);
    // Sanity: the fixture is the golden-bug shape — instanceof would have missed it.
    expect(foreign instanceof ToolMessage).toBe(false);

    const mw = createFrontendImageInjectionMiddleware({ provider: 'openai' });
    const result = await runBeforeModel(mw, [new HumanMessage('photo?'), foreign]);

    const blocks = lastInjectedBlocks(result);
    expect(blocks).toBeDefined();
    expect(blocks![0]).toEqual({ type: 'text', text: 'Camera frame captured:' });
    expect(blocks![1]).toEqual({ type: 'image_url', image_url: { url: DATA_URL } });
  });

  it('uses the resolved provider mapping for the injected block (ollama → string image_url)', async () => {
    const mw = createFrontendImageInjectionMiddleware({ provider: 'ollama' });
    const result = await runBeforeModel(mw, captureRound(IMG));
    expect(lastInjectedBlocks(result)![1]).toEqual({ type: 'image_url', image_url: DATA_URL });
  });

  it('{error} payload → "Camera unavailable" note, no image block', async () => {
    const mw = createFrontendImageInjectionMiddleware({ provider: 'anthropic' });
    const result = await runBeforeModel(mw, captureRound({ error: 'no camera device' }));
    const msgs = result.messages as BaseMessage[];
    const note = msgs[msgs.length - 1];
    expect(typeof note.content === 'string' ? note.content : '').toBe(
      'Camera unavailable: no camera device'
    );
    // No vision block was injected (content is a plain string, not a block array).
    expect(Array.isArray(note.content)).toBe(false);
  });

  it('non-JSON tool result → skipped (nothing injected)', async () => {
    const mw = createFrontendImageInjectionMiddleware({ provider: 'openai' });
    const messages = [
      new AIMessage({ content: '', tool_calls: [{ name: 'capture_image', args: {}, id: 'c1' }] }),
      new ToolMessage({ content: 'not-json at all', tool_call_id: 'c1', name: 'capture_image' }),
    ];
    expect(await runBeforeModel(mw, messages)).toBeUndefined();
  });

  it('is a no-op when no capture ToolMessage is present (default behaviour unchanged)', async () => {
    const mw = createFrontendImageInjectionMiddleware({ provider: 'openai' });
    expect(
      await runBeforeModel(mw, [new HumanMessage('hello'), new AIMessage('hi')])
    ).toBeUndefined();
  });

  it('idempotency: the same tool_call_id is not re-injected on a second beforeModel pass', async () => {
    const mw = createFrontendImageInjectionMiddleware({ provider: 'openai' });
    const round = captureRound(IMG, 'call-dupe');

    const first = await runBeforeModel(mw, round, 'thread-idem');
    expect(lastInjectedBlocks(first)).toBeDefined();

    // Second pass on the SAME thread with the retained capture ToolMessage — must not re-inject.
    const second = await runBeforeModel(mw, first.messages, 'thread-idem');
    expect(second).toBeUndefined();
  });

  it('a data-less capture result injects nothing AND leaves the guard clean (a later frame recovers)', async () => {
    const mw = createFrontendImageInjectionMiddleware({ provider: 'openai' });
    // First sighting: same tool_call_id but the base64 data was dropped upstream.
    const dataless = captureRound({ mimeType: 'image/png' }, 'call-recover');
    expect(await runBeforeModel(mw, dataless, 'thread-recover')).toBeUndefined();

    // Later, the data-bearing result for the SAME id arrives — it must still inject.
    const withData = captureRound(IMG, 'call-recover');
    const result = await runBeforeModel(mw, withData, 'thread-recover');
    expect(lastInjectedBlocks(result)).toBeDefined();
  });

  it('honours a custom toolName and ignores the default when overridden', async () => {
    const mw = createFrontendImageInjectionMiddleware({
      provider: 'openai',
      toolName: 'take_photo',
    });
    // A capture_image result is ignored now (tool name does not match)...
    expect(await runBeforeModel(mw, captureRound(IMG, 'x', 'capture_image'))).toBeUndefined();
    // ...but the configured take_photo result is injected.
    const result = await runBeforeModel(mw, captureRound(IMG, 'y', 'take_photo'));
    expect(lastInjectedBlocks(result)![1]).toEqual({
      type: 'image_url',
      image_url: { url: DATA_URL },
    });
  });

  it('default capture tool name is capture_image', () => {
    expect(DEFAULT_CAPTURE_TOOL_NAME).toBe('capture_image');
  });
});

describe('registry — by-name resolution + opt-in (no auto-inject)', () => {
  const cfg = (extra: Partial<GthConfig> = {}) =>
    ({ llm: {}, modelProviderType: 'openai', ...extra }) as unknown as GthConfig;

  it('resolves the bare name "frontend-image-injection" to a middleware', async () => {
    const result = await resolveMiddleware(['frontend-image-injection'], cfg());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('frontend-image-injection');
  });

  it('derives the provider from config.modelProviderType for the resolved middleware', async () => {
    const [mw] = await resolveMiddleware(
      ['frontend-image-injection'],
      cfg({ modelProviderType: 'ollama' })
    );
    const result = await runBeforeModel(mw, captureRound(IMG));
    // ollama mapping (string image_url) proves the registry passed modelProviderType through.
    expect(lastInjectedBlocks(result)![1]).toEqual({ type: 'image_url', image_url: DATA_URL });
  });

  it('passes the toolName setting through from the object config form', async () => {
    const [mw] = await resolveMiddleware(
      [{ name: 'frontend-image-injection', toolName: 'take_photo' }],
      cfg()
    );
    expect(await runBeforeModel(mw, captureRound(IMG, 'z', 'capture_image'))).toBeUndefined();
    const result = await runBeforeModel(mw, captureRound(IMG, 'z2', 'take_photo'));
    expect(lastInjectedBlocks(result)).toBeDefined();
  });

  it('is NOT auto-injected: binaryFormats set but the name unlisted → binary auto-injects, frontend absent', async () => {
    const result = await resolveMiddleware(
      undefined,
      cfg({ binaryFormats: [{ type: 'image', extensions: ['png'] }] })
    );
    const names = result.map((m) => m.name);
    expect(names).toContain('binary-content-injection');
    expect(names).not.toContain('frontend-image-injection');
  });
});
