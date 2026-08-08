import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGoogle } from '@langchain/google/node';

/**
 * CFG-33 — proof that the google presets ASK Gemini to return the thinking it is already doing.
 *
 * Gemini thinks by default and bills for it, but returns a thought summary only when
 * `generationConfig.thinkingConfig.includeThoughts` is set. Without it the `/reasoning` panel is
 * empty on `google-genai` and `vertexai` and the reasoning tokens are paid for and discarded.
 *
 * These assertions run the REAL `@langchain/google` `invocationParams()` — the same code that builds
 * the request body — so they read what would actually go on the wire rather than a mocked
 * constructor argument. `invocationParams` performs no network call and needs no valid credentials.
 */

const consoleUtilsMock = {
  displayWarning: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  env: {} as Record<string, string | undefined>,
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const fileUtilsMock = {
  writeConfigFileWithMessages: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

type WireParams = { generationConfig?: { thinkingConfig?: Record<string, unknown> } };

/** The thinking config the model would put in the request body for a plain (tool-less) call. */
function thinkingConfigOf(model: unknown): Record<string, unknown> | undefined {
  return (
    (model as { invocationParams: (options: unknown) => WireParams }).invocationParams(
      {}
    ) as WireParams
  ).generationConfig?.thinkingConfig;
}

describe('google presets ask for thought summaries (CFG-33)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { GOOGLE_API_KEY: 'test-key' };
  });

  it('baseline: @langchain/google sends NO thinking config when nothing is configured (the bug)', () => {
    // The unwrapped model is what the preset used to return. Gemini then defaults includeThoughts
    // to off, so no thought part is ever returned — a completely empty /reasoning panel.
    const bare = new ChatGoogle({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      platformType: 'gai',
    });
    expect(thinkingConfigOf(bare)).toBeUndefined();
  });

  it('google-genai sets includeThoughts and pins NO budget', async () => {
    const { processJsonConfig } = await import('#src/providers/google-genai.js');

    const model = await processJsonConfig({
      type: 'google-genai',
      model: 'gemini-3.6-flash',
    } as never);

    // includeThoughts asks for what is already being paid for...
    expect(thinkingConfigOf(model)).toEqual({ includeThoughts: true });
    // ...and nothing else: no thinkingBudget / thinkingLevel, so the API's own default budget
    // still applies. Showing reasoning must never change what reasoning COSTS.
    expect(thinkingConfigOf(model)).not.toHaveProperty('thinkingBudget');
    expect(thinkingConfigOf(model)).not.toHaveProperty('thinkingLevel');
  });

  it('vertexai sets includeThoughts too — the same ChatGoogle, the same gap', async () => {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const model = await processJsonConfig({ type: 'vertexai', model: 'gemini-3.6-flash' } as never);

    expect(thinkingConfigOf(model)).toEqual({ includeThoughts: true });
  });

  it('a configured thinking level is honoured and still returns thoughts', async () => {
    const { processJsonConfig } = await import('#src/providers/google-genai.js');

    const model = await processJsonConfig({
      type: 'google-genai',
      model: 'gemini-3.6-flash',
      thinkingLevel: 'low',
    } as never);

    // The user's own budget decision reaches the wire untouched, WITH thought summaries.
    expect(thinkingConfigOf(model)).toMatchObject({ includeThoughts: true, thinkingLevel: 'LOW' });
  });

  it('turning thinking OFF still turns thoughts off — the knob is the budget, not the display', async () => {
    const { processJsonConfig } = await import('#src/providers/google-genai.js');

    const model = await processJsonConfig({
      type: 'google-genai',
      model: 'gemini-3.6-flash',
      thinkingBudget: 0,
    } as never);

    // Nothing is being paid for, so there is nothing to show: the library's own `false` must win.
    expect(thinkingConfigOf(model)).toMatchObject({ includeThoughts: false });
  });

  it('leaves image models alone — @langchain/google withholds their thinking config on purpose', async () => {
    const { processJsonConfig } = await import('#src/providers/google-genai.js');

    const model = await processJsonConfig({
      type: 'google-genai',
      model: 'gemini-2.5-flash-preview-image',
    } as never);

    expect(thinkingConfigOf(model)).toBeUndefined();
  });

  it('survives bindTools — the agent never calls the bare model', async () => {
    const { processJsonConfig } = await import('#src/providers/google-genai.js');

    const model = await processJsonConfig({
      type: 'google-genai',
      model: 'gemini-3.6-flash',
    } as never);
    // createAgent/createDeepAgent both bind tools, which returns a RunnableBinding rather than the
    // model. The override lives on the instance the binding wraps, so the built params still carry
    // it — a fix that only worked on the bare model would do nothing in a real run.
    const bound = model.bindTools!([
      {
        name: 'get_weather',
        description: 'Get the weather.',
        schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]) as unknown as { bound: unknown };

    const wire = (
      (bound.bound as { invocationParams: (o: unknown) => WireParams }).invocationParams(
        {}
      ) as WireParams
    ).generationConfig?.thinkingConfig;
    expect(wire).toEqual({ includeThoughts: true });
  });
});
