import { describe, expect, it } from 'vitest';
import {
  appendCommitCoAuthorNote,
  appendModelContextNote,
  resolveModelIdentity,
  type CommitCoAuthor,
} from '#src/utils/systemPromptNotes.js';
import { DEFAULT_COMMIT_CO_AUTHOR_EMAIL, DEFAULT_COMMIT_CO_AUTHOR_NAME } from '#src/constants.js';

/**
 * GS2-35 — commit co-authoring guidance.
 *
 * Gaunt Sloth has no dedicated commit tool; the agent commits via `run_shell_command` and, left
 * unguided, mis-attributes the co-author to the underlying MODEL name. {@link appendCommitCoAuthorNote}
 * is the fix: it composes first-party prompt guidance that (a) states the exact, config-driven
 * `Co-Authored-By` trailer to emit and (b) forbids a model-name co-author. These assertions are the
 * acceptance for GS2-35(b) — a unit test on the assembled guidance, no live LLM needed.
 */
describe('appendCommitCoAuthorNote (GS2-35)', () => {
  it('defaults to the Gaunt Sloth account when no co-author is configured', () => {
    const out = appendCommitCoAuthorNote('BASE PROMPT', undefined);
    expect(DEFAULT_COMMIT_CO_AUTHOR_NAME).toBe('Gaunt Sloth');
    expect(DEFAULT_COMMIT_CO_AUTHOR_EMAIL).toBe('code@gauntsloth.app');
    expect(out).toContain('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
  });

  it('injects a configured co-author identity (override changes the trailer)', () => {
    const coAuthor: CommitCoAuthor = { name: 'Acme Bot', email: 'bot@acme.test' };
    const out = appendCommitCoAuthorNote('BASE PROMPT', coAuthor);
    expect(out).toContain('Co-Authored-By: Acme Bot <bot@acme.test>');
    // The overridden identity fully replaces the default — the gauntsloth account is not present.
    expect(out).not.toContain('code@gauntsloth.app');
    expect(out).not.toContain('Co-Authored-By: Gaunt Sloth');
    // Regression guard: the instruction must not hardcode a credit target that fights the override
    // (the trailer says "Acme Bot", so the prose must not tell the model to "credit Gaunt Sloth").
    expect(out).not.toContain('Gaunt Sloth as the co-author');
  });

  it('falls back per-field: a name-only override keeps the default email (and vice versa)', () => {
    expect(appendCommitCoAuthorNote('BASE', { name: 'Only Name' })).toContain(
      'Co-Authored-By: Only Name <code@gauntsloth.app>'
    );
    expect(appendCommitCoAuthorNote('BASE', { email: 'only@email.test' })).toContain(
      'Co-Authored-By: Gaunt Sloth <only@email.test>'
    );
  });

  it('treats blank/whitespace-only fields as unset (uses the default)', () => {
    const out = appendCommitCoAuthorNote('BASE', { name: '   ', email: '' });
    expect(out).toContain('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
  });

  it('forbids attributing the co-author to the underlying model name', () => {
    const out = appendCommitCoAuthorNote('BASE PROMPT', undefined);
    // The prohibition is explicit and names concrete model/vendor tokens so the model cannot fall
    // back to its trained `Co-Authored-By: <model>` habit.
    expect(out).toContain('NEVER attribute the co-author to the underlying model');
    expect(out).toContain('not the model');
    expect(out).toContain('Claude');
    expect(out).toContain('GPT');
    expect(out).toContain('Gemini');
  });

  it('appends to a base prompt (keeps it) and returns the note alone when there is no base', () => {
    const withBase = appendCommitCoAuthorNote('BASE PROMPT', undefined);
    expect(withBase.startsWith('BASE PROMPT')).toBe(true);
    expect(withBase).toContain('Co-Authored-By:');

    const noBase = appendCommitCoAuthorNote(undefined, undefined);
    expect(noBase.startsWith('When you create a git commit')).toBe(true);
    expect(noBase).toContain('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
  });
});

/**
 * GS2-34 — active model-identity injection.
 *
 * The agent has no reliable knowledge of its own active `provider:model`, so it cannot answer "what
 * model are you?" or reason about its own capabilities. {@link resolveModelIdentity} formats the
 * identity from the same sources gsloth already surfaces (status-line `modelDisplayName`, AG-UI
 * `/info` `_llmType()`), and {@link appendModelContextNote} injects a single first-party line naming
 * it. These are the acceptance for GS2-34 — unit tests on the resolver + assembled note, no live LLM.
 */
describe('resolveModelIdentity (GS2-34)', () => {
  it('formats provider:model from _llmType() + modelDisplayName (modelDisplayName wins over llm.model)', () => {
    const id = resolveModelIdentity({
      llm: { _llmType: () => 'anthropic', model: 'llm-model-fallback' },
      modelDisplayName: 'claude-sonnet-5',
    });
    expect(id).toBe('anthropic:claude-sonnet-5');
  });

  it('falls back to the live model.model when modelDisplayName is unset', () => {
    expect(resolveModelIdentity({ llm: { _llmType: () => 'ollama', model: 'gemma3:27b' } })).toBe(
      'ollama:gemma3:27b'
    );
  });

  it('returns undefined when the model is unknown (a provider alone is not a usable identity)', () => {
    // This is the load-bearing case: an `_llmType`-only config (no model) must resolve to undefined
    // so appendModelContextNote injects nothing and the prompt is unchanged.
    expect(resolveModelIdentity({ llm: { _llmType: () => 'anthropic' } })).toBeUndefined();
    expect(resolveModelIdentity({})).toBeUndefined();
    expect(resolveModelIdentity(undefined)).toBeUndefined();
  });

  it('emits the bare model when the provider is unavailable', () => {
    expect(resolveModelIdentity({ modelDisplayName: 'gpt-5.4' })).toBe('gpt-5.4');
  });

  it('never throws when _llmType() throws — guarded, emits the bare model', () => {
    const id = resolveModelIdentity({
      llm: {
        _llmType: () => {
          throw new Error('provider accessor boom');
        },
        model: 'x',
      },
      modelDisplayName: 'gpt-5.4',
    });
    expect(id).toBe('gpt-5.4');
  });

  // GS2-53 — OpenAI-compatible shims (openrouter/deepseek/xai) extend ChatOpenAI, so their live
  // `_llmType()` reports `openai`. The configured provider `type` (stashed by the loader as
  // `modelProviderType`) is the true provider and MUST win, or a `type: openrouter` config injects
  // the wrong `openai:<model>` identity into the prompt.
  it('prefers the configured provider type over _llmType() for OpenAI-compatible shims', () => {
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'openai', model: 'anthropic/claude-3.5-sonnet' },
        modelDisplayName: 'anthropic/claude-3.5-sonnet',
        modelProviderType: 'openrouter',
      })
    ).toBe('openrouter:anthropic/claude-3.5-sonnet');
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'openai', model: 'deepseek-chat' },
        modelDisplayName: 'deepseek-chat',
        modelProviderType: 'deepseek',
      })
    ).toBe('deepseek:deepseek-chat');
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'openai', model: 'grok-4' },
        modelDisplayName: 'grok-4',
        modelProviderType: 'xai',
      })
    ).toBe('xai:grok-4');
  });

  it('a configured type that matches _llmType() (anthropic/ollama) is unchanged', () => {
    // The type maps 1:1 to _llmType() here, so preferring it yields the same identity as before.
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'anthropic', model: 'claude-sonnet-5' },
        modelDisplayName: 'claude-sonnet-5',
        modelProviderType: 'anthropic',
      })
    ).toBe('anthropic:claude-sonnet-5');
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'ollama', model: 'gemma3:27b' },
        modelProviderType: 'ollama',
      })
    ).toBe('ollama:gemma3:27b');
  });

  it('falls back to _llmType() when no configured type is threaded (e.g. module configs)', () => {
    // A module config hands us an already-built LLM with no raw `type`, so modelProviderType is
    // absent — the guarded `_llmType()` remains the provider source, exactly as before GS2-53.
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'anthropic', model: 'claude-sonnet-5' },
        modelDisplayName: 'claude-sonnet-5',
      })
    ).toBe('anthropic:claude-sonnet-5');
    // A blank/whitespace-only type is treated as unset and falls back to _llmType() too.
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'anthropic', model: 'claude-sonnet-5' },
        modelDisplayName: 'claude-sonnet-5',
        modelProviderType: '   ',
      })
    ).toBe('anthropic:claude-sonnet-5');
  });

  it('a configured type never triggers the _llmType() throw path (short-circuited)', () => {
    // With a configured type present, `_llmType()` is not called at all, so even a throwing
    // accessor cannot break resolution.
    expect(
      resolveModelIdentity({
        llm: {
          _llmType: () => {
            throw new Error('should never be called');
          },
          model: 'grok-4',
        },
        modelDisplayName: 'grok-4',
        modelProviderType: 'xai',
      })
    ).toBe('xai:grok-4');
  });
});

describe('appendModelContextNote (GS2-34)', () => {
  it('injects a single line naming the provider:model identity', () => {
    const out = appendModelContextNote('BASE PROMPT', 'anthropic:claude-sonnet-5');
    expect(out?.startsWith('BASE PROMPT')).toBe(true);
    expect(out).toContain('`anthropic:claude-sonnet-5`');
    expect(out).toContain('which model you are');
    // GS2-53 — the `(provider:model)` format label rides along when a provider half is present.
    expect(out).toContain('`anthropic:claude-sonnet-5` (provider:model). This is your');
  });

  // GS2-53 — the `(provider:model)` label documents the identity FORMAT. On the bare-model branch
  // (resolveModelIdentity returned just `<model>`, no colon), it dangled and misled; it must be
  // omitted so the sentence still reads naturally.
  it('omits the dangling (provider:model) label for a bare-model identity', () => {
    const out = appendModelContextNote('BASE PROMPT', 'gpt-5.4');
    expect(out).toContain('`gpt-5.4`. This is your');
    expect(out).not.toContain('(provider:model)');
    // Still a well-formed, single first-party line naming the model.
    expect(out).toContain('which model you are');
  });

  it('keeps the (provider:model) label for a provider-present multi-colon identity', () => {
    // `ollama:gemma3:27b` HAS a provider half (leading `ollama:`), so the label is correct even
    // though the model name itself contains a colon.
    const out = appendModelContextNote('BASE PROMPT', 'ollama:gemma3:27b');
    expect(out).toContain('`ollama:gemma3:27b` (provider:model). This is your');
  });

  it('returns the note alone when there is no base prompt', () => {
    const out = appendModelContextNote(undefined, 'anthropic:claude-sonnet-5');
    expect(out?.startsWith('The model currently serving this session')).toBe(true);
    expect(out).toContain('`anthropic:claude-sonnet-5`');
  });

  it('opt-out / unresolved identity leaves the prompt UNCHANGED (no line)', () => {
    // Empty/undefined identity — the config opted out (injectModelContext: false) or no model
    // resolved — returns the base prompt byte-for-byte (additive-only guarantee).
    expect(appendModelContextNote('BASE PROMPT', undefined)).toBe('BASE PROMPT');
    expect(appendModelContextNote('BASE PROMPT', '   ')).toBe('BASE PROMPT');
    expect(appendModelContextNote(undefined, undefined)).toBeUndefined();
  });
});
