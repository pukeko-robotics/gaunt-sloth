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

  it("hands back the library's own params object when there is nothing to add", async () => {
    const { applyGeminiThoughtSummaries } = await import('#src/providers/geminiThinking.js');
    // Identity, not just equality (the same standard `stripReasoningBlocks` is held to): a
    // configured budget/level means the library already decided, so the built params must come back
    // as-is rather than rebuilt — nothing downstream should see a different object for a call this
    // override had no opinion about.
    const params = {
      generationConfig: { thinkingConfig: { includeThoughts: true }, temperature: 0 },
    };
    const fake = { model: 'gemini-3.6-flash', invocationParams: () => params };
    applyGeminiThoughtSummaries(fake as never);
    expect(fake.invocationParams()).toBe(params);
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

/**
 * The inverse knob, for a surface that renders content blocks by `type` and therefore cannot tell a
 * Gemini thought summary from an answer (the ACP front door — see the agent package's ACP spec).
 *
 * The one thing that must not slip: it withholds the SUMMARY, it does not stop the model THINKING.
 * A zero/minimal budget would do the latter, and the coercion differs by model family — a pro model
 * floors it (thinking survives), a flash model honours it (thinking stops) — so the same "off" input
 * means two different things. Hence an explicit `includeThoughts: false`, asserted on both a 2.5 and
 * a 3.x preset because those two carry the budget to the wire in different shapes.
 */
describe('withholding thought summaries on a surface that cannot route them (CFG-33)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { GOOGLE_API_KEY: 'test-key' };
  });

  async function acpModel(llm: Record<string, unknown>): Promise<unknown> {
    const { processJsonConfig } = await import('#src/providers/google-genai.js');
    const { disableGeminiThoughtSummaries } = await import('#src/providers/geminiThinking.js');
    return disableGeminiThoughtSummaries(
      await processJsonConfig({ type: 'google-genai', ...llm } as never)
    );
  }

  it('2.5 preset: summaries off, thinking left at the API default budget', async () => {
    expect(thinkingConfigOf(await acpModel({ model: 'gemini-2.5-pro' }))).toEqual({
      includeThoughts: false,
    });
    // No budget is pinned, so the model still thinks exactly as much as it otherwise would.
    expect(thinkingConfigOf(await acpModel({ model: 'gemini-2.5-pro' }))).not.toHaveProperty(
      'thinkingBudget'
    );
  });

  it('3.x preset: summaries off, thinking left at the API default level', async () => {
    expect(thinkingConfigOf(await acpModel({ model: 'gemini-3.6-flash' }))).toEqual({
      includeThoughts: false,
    });
    expect(thinkingConfigOf(await acpModel({ model: 'gemini-3.6-flash' }))).not.toHaveProperty(
      'thinkingLevel'
    );
  });

  it('keeps a configured budget on 2.5 and the level it coarsens to on 3.x', async () => {
    // 2.5 carries an explicit token budget verbatim...
    expect(
      thinkingConfigOf(await acpModel({ model: 'gemini-2.5-pro', thinkingBudget: 8192 }))
    ).toEqual({ includeThoughts: false, thinkingBudget: 8192 });
    // ...while 3.x coarsens the same budget to a level. Either way the user's spend decision stands
    // and only the summary is withheld.
    expect(
      thinkingConfigOf(await acpModel({ model: 'gemini-3.6-flash', thinkingBudget: 8192 }))
    ).toEqual({ includeThoughts: false, thinkingLevel: 'MEDIUM' });
  });

  it('does not switch thinking back on when the user turned it off', async () => {
    expect(
      thinkingConfigOf(await acpModel({ model: 'gemini-2.5-flash', thinkingBudget: 0 }))
    ).toEqual({ includeThoughts: false, thinkingBudget: 0 });
    expect(
      thinkingConfigOf(await acpModel({ model: 'gemini-3.6-flash', thinkingLevel: 'minimal' }))
    ).toEqual({ includeThoughts: false, thinkingLevel: 'MINIMAL' });
  });

  it('leaves a non-Google model completely alone', async () => {
    const { disableGeminiThoughtSummaries } = await import('#src/providers/geminiThinking.js');
    // Every other provider builds no `generationConfig`, so there is nothing to withhold and the
    // built params must come back byte-identical — this runs on EVERY model the ACP entry is given.
    const params = { model: 'claude-x', max_tokens: 64 };
    const fake = { model: 'claude-x', invocationParams: () => params };
    disableGeminiThoughtSummaries(fake as never);
    expect(fake.invocationParams()).toBe(params);
  });
});
