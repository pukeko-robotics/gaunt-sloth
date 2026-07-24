/**
 * GS2-75 — unit tests for the default-on binary-content-injection middleware.
 *
 * The middleware turns a `gth_read_binary` ToolMessage into a HumanMessage carrying a content block
 * the target provider can decode. These tests pin the per-provider IMAGE block shape (the GS2-75 fix:
 * route the image case through `imageBlockFor` so OpenAI reasoning models on the Responses API get a
 * valid `image_url` block instead of the standard `source_type` data block, which @langchain/openai
 * mis-serialises to an invalid Responses image part), and prove that the file/video/audio path and
 * non-OpenAI providers are untouched. The registry wiring (that the factory threads the resolved
 * provider in) is checked at the end.
 */
import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import {
  createBinaryContentInjectionMiddleware,
  type BinaryContentInjectionMiddlewareSettings,
} from '#src/middleware/binaryContentInjectionMiddleware.js';
import { imageBlockFor } from '#src/middleware/frontendImageInjectionMiddleware.js';
import { resolveMiddleware } from '#src/middleware/registry.js';

/** A tiny valid 1×1 base64 PNG-ish payload — content is opaque to the middleware. */
const B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_MIME = 'image/png';
const PNG_DATA_URL = `data:${PNG_MIME};base64,${B64}`;
const IMG_PATH = '/tmp/some;weird path/photo.png';

/**
 * Build the `gth_read_binary` ToolMessage content string exactly as `parseBinaryContent` expects:
 * `gth_read_binary;type:<type>;path:<encodeURIComponent(path)>;data:<mime>;base64,<b64>`.
 */
function binaryToolContent(type: string, mime: string, data: string, filePath: string): string {
  return `gth_read_binary;type:${type};path:${encodeURIComponent(filePath)};data:${mime};base64,${data}`;
}

/** A native read-binary round: assistant tool-call request + its gth_read_binary ToolMessage result. */
function binaryRound(
  type: string,
  mime: string,
  data: string,
  filePath: string,
  id = 'call-1'
): BaseMessage[] {
  return [
    new AIMessage({ content: '', tool_calls: [{ name: 'gth_read_binary', args: {}, id }] }),
    new ToolMessage({
      content: binaryToolContent(type, mime, data, filePath),
      tool_call_id: id,
      name: 'gth_read_binary',
    }),
  ];
}

/** Invoke the (object-form) middleware's beforeModel hook. */
async function runBeforeModel(mw: any, messages: unknown[]) {
  const hook = typeof mw.beforeModel === 'function' ? mw.beforeModel : mw.beforeModel.hook;
  return hook({ messages });
}

/** The injected HumanMessage's content block at index 1 (index 0 is the text preamble). */
function injectedBlock(result: any): any {
  const msgs = result?.messages;
  if (!Array.isArray(msgs)) return undefined;
  const last = msgs[msgs.length - 1];
  return Array.isArray(last?.content) ? last.content[1] : undefined;
}

const cfg = () => ({}) as unknown as GthConfig;

async function mwFor(provider?: string) {
  const settings = { provider } as BinaryContentInjectionMiddlewareSettings;
  return createBinaryContentInjectionMiddleware(settings, cfg());
}

describe('binary-content-injection — per-provider IMAGE block (GS2-75)', () => {
  it('openai → image_url:{url} (valid on the Responses API, unlike the standard block)', async () => {
    const mw = await mwFor('openai');
    const result = await runBeforeModel(mw, binaryRound('image', PNG_MIME, B64, IMG_PATH));
    // Literal expected block — the real anti-regression anchor for the fix.
    expect(injectedBlock(result)).toEqual({
      type: 'image_url',
      image_url: { url: PNG_DATA_URL },
    });
  });

  it('ollama → image_url as a data-URL STRING', async () => {
    const mw = await mwFor('ollama');
    const result = await runBeforeModel(mw, binaryRound('image', PNG_MIME, B64, IMG_PATH));
    expect(injectedBlock(result)).toEqual({
      type: 'image_url',
      image_url: PNG_DATA_URL,
    });
  });

  it('anthropic → the standard base64 image block (non-OpenAI unchanged)', async () => {
    const mw = await mwFor('anthropic');
    const result = await runBeforeModel(mw, binaryRound('image', PNG_MIME, B64, IMG_PATH));
    expect(injectedBlock(result)).toEqual({
      type: 'image',
      source_type: 'base64',
      mime_type: PNG_MIME,
      data: B64,
    });
  });

  it("default (provider '' / undefined) → the standard base64 image block", async () => {
    for (const mw of [await mwFor(''), await mwFor(undefined)]) {
      const result = await runBeforeModel(mw, binaryRound('image', PNG_MIME, B64, IMG_PATH));
      expect(injectedBlock(result)).toEqual({
        type: 'image',
        source_type: 'base64',
        mime_type: PNG_MIME,
        data: B64,
      });
    }
  });

  it('the injected image block tracks imageBlockFor (source of truth) across providers', async () => {
    for (const provider of ['openai', 'ollama', 'anthropic', 'google-genai', 'vertexai', '']) {
      const mw = await mwFor(provider);
      const result = await runBeforeModel(mw, binaryRound('image', PNG_MIME, B64, IMG_PATH));
      expect(injectedBlock(result)).toEqual(imageBlockFor(provider, PNG_MIME, B64));
    }
  });
});

describe('binary-content-injection — non-image binaries are untouched', () => {
  it('a file (application/pdf) keeps the standard createContentBlock data-block, regardless of provider', async () => {
    for (const provider of ['openai', 'ollama', 'anthropic', '']) {
      const mw = await mwFor(provider);
      const result = await runBeforeModel(
        mw,
        binaryRound('file', 'application/pdf', B64, '/tmp/doc.pdf')
      );
      // NOT an image_url block; the standard block WITH filename metadata (createContentBlock path).
      expect(injectedBlock(result)).toEqual({
        type: 'file',
        source_type: 'base64',
        mime_type: 'application/pdf',
        data: B64,
        metadata: { filename: 'doc.pdf' },
      });
    }
  });

  it('is a no-op when there is no gth_read_binary ToolMessage', async () => {
    const mw = await mwFor('openai');
    expect(
      await runBeforeModel(mw, [new HumanMessage('hi'), new AIMessage('hello')])
    ).toBeUndefined();
  });
});

describe('binary-content-injection — registry wiring', () => {
  it('the factory threads the resolved provider through (openai → image_url:{url})', async () => {
    const [mw] = await resolveMiddleware(['binary-content-injection'], {
      llm: {},
      modelProviderType: 'openai',
    } as unknown as GthConfig);
    expect(mw.name).toBe('binary-content-injection');
    const result = await runBeforeModel(mw, binaryRound('image', PNG_MIME, B64, IMG_PATH));
    expect(injectedBlock(result)).toEqual({ type: 'image_url', image_url: { url: PNG_DATA_URL } });
  });

  it('a non-openai resolved provider (ollama) yields the ollama string image_url', async () => {
    const [mw] = await resolveMiddleware(['binary-content-injection'], {
      llm: {},
      modelProviderType: 'ollama',
    } as unknown as GthConfig);
    const result = await runBeforeModel(mw, binaryRound('image', PNG_MIME, B64, IMG_PATH));
    expect(injectedBlock(result)).toEqual({ type: 'image_url', image_url: PNG_DATA_URL });
  });

  it('the DEFAULT-ON auto-inject path (binaryFormats, no explicit name) also threads the provider — the exact path that broke it openai', async () => {
    // Production fires this middleware via binaryFormats auto-inject, not by explicit name; this is
    // the openai Responses regression scenario end to end at the resolver level.
    const mws = await resolveMiddleware(undefined, {
      llm: {},
      modelProviderType: 'openai',
      binaryFormats: [{ type: 'image', extensions: ['png'] }],
    } as unknown as GthConfig);
    const mw = mws.find((m) => m.name === 'binary-content-injection');
    expect(mw).toBeDefined();
    const result = await runBeforeModel(mw, binaryRound('image', PNG_MIME, B64, IMG_PATH));
    expect(injectedBlock(result)).toEqual({ type: 'image_url', image_url: { url: PNG_DATA_URL } });
  });
});
