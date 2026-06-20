import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectedProvider, ModelInfo } from '@gaunt-sloth/core/providers/modelDiscovery.js';

// Silence the menu output during tests.
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayError: vi.fn(),
  displayDebug: vi.fn(),
  display: vi.fn(),
}));

import {
  buildConfigContent,
  defaultModelIndex,
  orderProviders,
  parseMenuSelection,
  providerReadinessLabel,
  runFirstRunDialog,
  type FirstRunDialogDeps,
  type SelectFn,
} from '#src/commands/firstRunDialog.js';

function provider(
  over: Partial<DetectedProvider> & Pick<DetectedProvider, 'id'>
): DetectedProvider {
  return {
    label: over.id,
    available: false,
    requiresExternalAuth: false,
    models: [],
    ...over,
  } as DetectedProvider;
}

function model(id: string, preferred = false): ModelInfo {
  return { id, preferred };
}

/** Returns an `ask` that yields the queued answers in order. */
function scriptedAsk(answers: string[]): (_q: string) => Promise<string> {
  let i = 0;
  return () => Promise.resolve(answers[i++] ?? '');
}

/**
 * Returns a deterministic `select` that yields the queued 0-based indices in order. An empty
 * queue entry (undefined) resolves to the provided default index, mirroring the real UI's
 * "Enter accepts the default" behaviour.
 */
function scriptedSelect(indices: (number | undefined)[]): SelectFn {
  let i = 0;
  return (_title: string, _options: string[], defaultIndex: number) => {
    const choice = indices[i++];
    return Promise.resolve(choice ?? defaultIndex);
  };
}

describe('firstRunDialog pure helpers', () => {
  it('orderProviders puts available providers first, preserving order within groups', () => {
    const input = [
      provider({ id: 'openai', available: false }),
      provider({ id: 'anthropic', available: true }),
      provider({ id: 'groq', available: false }),
      provider({ id: 'xai', available: true }),
    ];
    expect(orderProviders(input).map((p) => p.id)).toEqual(['anthropic', 'xai', 'openai', 'groq']);
  });

  it('parseMenuSelection accepts valid 1-based numbers and rejects the rest', () => {
    expect(parseMenuSelection('1', 3)).toBe(0);
    expect(parseMenuSelection(' 3 ', 3)).toBe(2);
    expect(parseMenuSelection('0', 3)).toBeNull();
    expect(parseMenuSelection('4', 3)).toBeNull();
    expect(parseMenuSelection('-1', 3)).toBeNull();
    expect(parseMenuSelection('x', 3)).toBeNull();
    expect(parseMenuSelection('', 3)).toBeNull();
  });

  it('defaultModelIndex returns the first preferred model, else 0', () => {
    expect(defaultModelIndex([model('a'), model('b', true), model('c', true)])).toBe(1);
    expect(defaultModelIndex([model('a'), model('b')])).toBe(0);
    expect(defaultModelIndex([])).toBe(0);
  });

  it('providerReadinessLabel spells out an explicit readiness state (CFG-9)', () => {
    expect(
      providerReadinessLabel(
        provider({
          id: 'anthropic',
          available: true,
          apiKeyEnvironmentVariable: 'ANTHROPIC_API_KEY',
        })
      )
    ).toBe('API Key Available');
    expect(providerReadinessLabel(provider({ id: 'ollama', available: true }))).toBe('Ready');
    expect(
      providerReadinessLabel(
        provider({ id: 'vertexai', available: false, requiresExternalAuth: true })
      )
    ).toBe('Needs External Auth');
    expect(providerReadinessLabel(provider({ id: 'openai', available: false }))).toBe('No API Key');
  });

  it('buildConfigContent emits the minimal llm config with a trailing newline', () => {
    const content = buildConfigContent('anthropic', 'claude-sonnet-4-5');
    expect(JSON.parse(content)).toEqual({ llm: { type: 'anthropic', model: 'claude-sonnet-4-5' } });
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('runFirstRunDialog', () => {
  let deps: FirstRunDialogDeps;
  let writeConfig: ReturnType<typeof vi.fn>;
  let ensureGslothDir: ReturnType<typeof vi.fn>;
  let writeProjectReviewPreamble: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeConfig = vi.fn((_scope: string, _content: string) => '/written/path');
    ensureGslothDir = vi.fn();
    writeProjectReviewPreamble = vi.fn();
    deps = {
      detectProviders: vi.fn(),
      listModels: vi.fn(),
      ensureGslothDir,
      writeProjectReviewPreamble,
      writeConfig,
      ask: scriptedAsk([]),
      select: scriptedSelect([]),
    } as unknown as FirstRunDialogDeps;
  });

  it('writes project config with the default (preferred) model and scaffolds the preamble', async () => {
    deps.detectProviders = vi.fn().mockResolvedValue([
      provider({
        id: 'anthropic',
        available: true,
        apiKeyEnvironmentVariable: 'ANTHROPIC_API_KEY',
      }),
    ]);
    deps.listModels = vi
      .fn()
      .mockResolvedValue([model('claude-haiku-4-5'), model('claude-sonnet-4-5', true)]);
    // provider 0, model: default (preferred), scope: default (project)
    deps.select = scriptedSelect([0, undefined, undefined]);

    await runFirstRunDialog(deps);

    expect(ensureGslothDir).toHaveBeenCalledTimes(1);
    expect(writeProjectReviewPreamble).toHaveBeenCalledTimes(1);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    const [scope, content] = writeConfig.mock.calls[0];
    expect(scope).toBe('project');
    expect(JSON.parse(content)).toEqual({
      llm: { type: 'anthropic', model: 'claude-sonnet-4-5' },
    });
  });

  it('writes global config without scaffolding when global scope is chosen', async () => {
    deps.detectProviders = vi
      .fn()
      .mockResolvedValue([
        provider({ id: 'openai', available: true, apiKeyEnvironmentVariable: 'OPENAI_API_KEY' }),
      ]);
    deps.listModels = vi.fn().mockResolvedValue([model('gpt-4o', true), model('gpt-4o-mini')]);
    // provider 0, model index 1 (gpt-4o-mini), scope index 1 (global)
    deps.select = scriptedSelect([0, 1, 1]);

    await runFirstRunDialog(deps);

    expect(ensureGslothDir).not.toHaveBeenCalled();
    expect(writeProjectReviewPreamble).not.toHaveBeenCalled();
    const [scope, content] = writeConfig.mock.calls[0];
    expect(scope).toBe('global');
    expect(JSON.parse(content)).toEqual({ llm: { type: 'openai', model: 'gpt-4o-mini' } });
  });

  it('still writes config for an unavailable provider so the user can fill in the key', async () => {
    deps.detectProviders = vi
      .fn()
      .mockResolvedValue([provider({ id: 'deepseek', available: false })]);
    deps.listModels = vi.fn().mockResolvedValue([model('deepseek-chat', true)]);
    deps.select = scriptedSelect([0, undefined, undefined]);

    await runFirstRunDialog(deps);

    expect(writeConfig).toHaveBeenCalledTimes(1);
    expect(writeConfig.mock.calls[0][0]).toBe('project');
  });

  it('falls back to a free-text model id when none are discovered (e.g. empty Ollama)', async () => {
    deps.detectProviders = vi
      .fn()
      .mockResolvedValue([provider({ id: 'ollama', available: true, requiresExternalAuth: true })]);
    deps.listModels = vi.fn().mockResolvedValue([]);
    // provider 0 (select); empty model list -> free-text via ask; scope 0 project (select)
    deps.select = scriptedSelect([0, 0]);
    deps.ask = scriptedAsk(['qwen3-coder']);

    await runFirstRunDialog(deps);

    const [, content] = writeConfig.mock.calls[0];
    expect(JSON.parse(content)).toEqual({ llm: { type: 'ollama', model: 'qwen3-coder' } });
  });

  it('aborts without writing when no model is entered for an empty list', async () => {
    deps.detectProviders = vi.fn().mockResolvedValue([provider({ id: 'ollama', available: true })]);
    deps.listModels = vi.fn().mockResolvedValue([]);
    deps.select = scriptedSelect([0]); // provider 0
    deps.ask = scriptedAsk(['   ']); // blank model id

    await runFirstRunDialog(deps);

    expect(writeConfig).not.toHaveBeenCalled();
  });
});
