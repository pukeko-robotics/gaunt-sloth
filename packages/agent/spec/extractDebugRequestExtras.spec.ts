import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemMessage } from '@langchain/core/messages';

describe('extractDebugRequestExtras', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('pulls system prompt, tools, model params and tool-choice from a request', async () => {
    const { extractDebugRequestExtras } = await import('#src/core/GthDeepAgent.js');
    const extras = extractDebugRequestExtras({
      systemPrompt: 'you are a sloth',
      messages: [],
      tools: [
        { name: 'read_file', description: 'reads a file', schema: { type: 'object' } },
        { name: 'no_name_skipped' === '' ? '' : 'write_file', description: 'writes' },
      ],
      model: { model: 'claude-opus-4', temperature: 0.2, apiKey: 'SECRET-KEY' },
      toolChoice: 'auto',
    });

    expect(extras).toBeDefined();
    expect(extras?.systemPrompt).toBe('you are a sloth');
    expect(extras?.tools).toHaveLength(2);
    expect(extras?.tools?.[0]).toMatchObject({ name: 'read_file', description: 'reads a file' });
    expect(extras?.toolChoice).toBe('auto');
    expect(extras?.modelParams).toMatchObject({ model: 'claude-opus-4', temperature: 0.2 });
  });

  it('NEVER includes credential-shaped fields in model params (security)', async () => {
    const { extractDebugRequestExtras } = await import('#src/core/GthDeepAgent.js');
    const extras = extractDebugRequestExtras({
      model: {
        model: 'gpt-x',
        apiKey: 'sk-SECRET',
        accessToken: 'AT-SECRET',
        clientOptions: { apiKey: 'nested-SECRET' },
      },
    });
    const dump = JSON.stringify(extras);
    expect(dump).not.toContain('SECRET');
    expect(extras?.modelParams).toEqual({ model: 'gpt-x' });
  });

  it('collapses model/modelName/modelId aliases and omits the misleading streaming flag', async () => {
    const { extractDebugRequestExtras } = await import('#src/core/GthDeepAgent.js');
    const extras = extractDebugRequestExtras({
      model: {
        model: 'claude-sonnet-4-5',
        modelName: 'claude-sonnet-4-5',
        modelId: 'claude-sonnet-4-5',
        maxTokens: 16384,
        streaming: false,
      },
    });
    // One model line, not three identical aliases; `streaming` is intentionally not surfaced
    // (it is the model's static flag, not whether the turn actually streams).
    expect(extras?.modelParams).toEqual({ model: 'claude-sonnet-4-5', maxTokens: 16384 });
  });

  it('derives `model` from `modelName` when only the alias is set', async () => {
    const { extractDebugRequestExtras } = await import('#src/core/GthDeepAgent.js');
    const extras = extractDebugRequestExtras({ model: { modelName: 'legacy-name' } });
    expect(extras?.modelParams).toEqual({ model: 'legacy-name' });
  });

  it('falls back to systemMessage.content when systemPrompt is absent', async () => {
    const { extractDebugRequestExtras } = await import('#src/core/GthDeepAgent.js');
    const extras = extractDebugRequestExtras({
      systemMessage: new SystemMessage('from system message'),
    });
    expect(extras?.systemPrompt).toBe('from system message');
  });

  it('returns undefined when nothing useful is present', async () => {
    const { extractDebugRequestExtras } = await import('#src/core/GthDeepAgent.js');
    expect(extractDebugRequestExtras({})).toBeUndefined();
    expect(extractDebugRequestExtras(null)).toBeUndefined();
    expect(extractDebugRequestExtras('nope')).toBeUndefined();
  });
});
