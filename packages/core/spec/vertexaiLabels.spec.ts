import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `vertexai` preset puts `llm.labels` into the generateContent request body. The assertions run
 * the real `@langchain/google` `invocationParams()`, which builds that body without a network call.
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

type WireParams = Record<string, unknown> & { labels?: Record<string, string> };

function wireParamsOf(model: unknown): WireParams {
  return (model as { invocationParams: (options: unknown) => WireParams }).invocationParams({});
}

describe('vertexai labels', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {};
  });

  it('sends the configured labels in the request body', async () => {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const model = await processJsonConfig({
      type: 'vertexai',
      model: 'gemini-3.6-flash',
      labels: { service: 'gsloth', task: 'review' },
    } as never);

    expect(wireParamsOf(model).labels).toEqual({ service: 'gsloth', task: 'review' });
  });

  it('keeps the other request fields', async () => {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const model = await processJsonConfig({
      type: 'vertexai',
      model: 'gemini-3.6-flash',
      labels: { service: 'gsloth' },
    } as never);

    expect(wireParamsOf(model).generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true },
    });
  });

  it('sends no labels field when none are configured', async () => {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const model = await processJsonConfig({ type: 'vertexai', model: 'gemini-3.6-flash' } as never);

    expect(wireParamsOf(model)).not.toHaveProperty('labels');
  });

  it('keeps the labels on a model with tools bound', async () => {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const model = await processJsonConfig({
      type: 'vertexai',
      model: 'gemini-3.6-flash',
      labels: { service: 'gsloth' },
    } as never);
    const tool = {
      name: 'noop',
      description: 'Does nothing.',
      schema: { type: 'object', properties: {} },
    };
    model.bindTools!([tool]);

    const params = (
      model as unknown as { invocationParams: (options: unknown) => WireParams }
    ).invocationParams({ tools: [tool] });
    expect(params.labels).toEqual({ service: 'gsloth' });
    expect(params).toHaveProperty('tools');
  });

  it('rejects labels that are not an object of strings', async () => {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    await expect(
      processJsonConfig({ type: 'vertexai', model: 'gemini-3.6-flash', labels: ['x'] } as never)
    ).rejects.toThrow('"llm.labels" must be an object');
    await expect(
      processJsonConfig({
        type: 'vertexai',
        model: 'gemini-3.6-flash',
        labels: { service: 'gsloth', run: 42 },
      } as never)
    ).rejects.toThrow('check: run');
  });
});
