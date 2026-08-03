import { describe, expect, it } from 'vitest';
import {
  appendCommitCoAuthorNote,
  appendModelContextNote,
  resolveModelIdentity,
  type CommitCoAuthor,
  type ResolvedModelIdentity,
} from '#src/utils/systemPromptNotes.js';
import { DEFAULT_COMMIT_CO_AUTHOR_EMAIL, DEFAULT_COMMIT_CO_AUTHOR_NAME } from '#src/constants.js';

/**
 * GS2-35 / EXT-83 — commit guidance: WHO co-authors, and HOW the message reaches git.
 *
 * Gaunt Sloth has no dedicated commit tool; the agent commits via `run_shell_command`, so both
 * halves are prompt guidance. {@link appendCommitCoAuthorNote} composes them:
 *   - GS2-35: the exact, config-driven `Co-Authored-By` trailer to emit.
 *   - EXT-83: the model identity is SUPPLIED in the default name rather than a denylist of model
 *     names being forbidden, and the message-writing rules (plain English; written to a file and
 *     passed by file) state the SHELL-EXPANSION MECHANISM rather than merely prohibiting.
 * These assertions are the acceptance — unit tests on the assembled guidance, no live LLM needed.
 */
describe('appendCommitCoAuthorNote (GS2-35/EXT-83)', () => {
  /**
   * A resolved identity that shares no token with the retired model-name denylist, so the
   * "no model or vendor name in the note text" scan cannot be satisfied merely by the absence of
   * an injected value.
   */
  const NEUTRAL_IDENTITY: ResolvedModelIdentity = { identity: 'acme:widget-1', hasProvider: true };

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

  // EXT-83 — the trailer names the REAL model while keeping the Gaunt Sloth address. Both halves
  // are asserted in ONE string: the identity without the address would break the link to the real
  // gauntsloth account, and the address without the identity would be the old un-named trailer, so
  // a change to either half must fail visibly here.
  it('carries the resolved model identity AND the Gaunt Sloth email in one trailer line', () => {
    const out = appendCommitCoAuthorNote('BASE PROMPT', undefined, {
      identity: 'anthropic:claude-opus-5',
      hasProvider: true,
    });
    expect(out).toContain(
      'Co-Authored-By: Gaunt Sloth (anthropic:claude-opus-5) <code@gauntsloth.app>'
    );
  });

  it('emits an explicitly configured name VERBATIM, with no identity spliced into it', () => {
    // The user asked for this exact string; the identity decorates only the DEFAULT name.
    const out = appendCommitCoAuthorNote(
      'BASE',
      { name: 'Acme Bot' },
      {
        identity: 'anthropic:claude-opus-5',
        hasProvider: true,
      }
    );
    expect(out).toContain('Co-Authored-By: Acme Bot <code@gauntsloth.app>');
    expect(out).not.toContain('anthropic:claude-opus-5');
    expect(out).not.toContain('Acme Bot (');
  });

  it('falls back to the plain default name when the model is unresolvable (never a placeholder)', () => {
    // Absent identity, and a blank one (whitespace-only) — neither may yield a partial or a
    // stand-in like "unknown", and neither may leave an empty parenthesis behind.
    const unresolvable: (ResolvedModelIdentity | undefined)[] = [
      undefined,
      { identity: '   ', hasProvider: false },
    ];
    for (const identity of unresolvable) {
      const out = appendCommitCoAuthorNote('BASE', undefined, identity);
      expect(out).toContain('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
      expect(out).not.toContain('Gaunt Sloth (');
      expect(out).not.toContain('()');
      expect(out.toLowerCase()).not.toContain('unknown');
    }
  });

  // EXT-83 — the load-bearing proof that the model-name DENYLIST is gone rather than relocated or
  // reworded. A denylist is stale the day a new vendor ships, and an enumeration sitting beside a
  // catch-all teaches the model that the list is the rule; supplying the correct name replaces the
  // whole class. Scanned case-insensitively over BOTH the bare note and one composed with a
  // neutral injected identity, so absence cannot be an artifact of injecting nothing.
  it('names no model or vendor anywhere in the note text (the denylist is gone, not relocated)', () => {
    const RETIRED_DENYLIST = ['Claude', 'GPT', 'Gemini', 'Opus', 'Sonnet'];
    // The names the retired list had already gone stale against — this project drives gth with all
    // of them, and a "better list" would be the same defect again.
    const ALSO_ABSENT = [
      'Anthropic',
      'OpenAI',
      'Google',
      'DeepSeek',
      'Kimi',
      'Qwen',
      'Grok',
      'Llama',
      'Mistral',
    ];
    const notes = [
      appendCommitCoAuthorNote(undefined, undefined),
      appendCommitCoAuthorNote(undefined, undefined, NEUTRAL_IDENTITY),
    ];
    for (const note of notes) {
      for (const token of [...RETIRED_DENYLIST, ...ALSO_ABSENT]) {
        expect(note.toLowerCase()).not.toContain(token.toLowerCase());
      }
      // …and the sentence that carried them is gone in substance, not merely re-spelled.
      expect(note).not.toContain('NEVER attribute the co-author to the underlying model');
    }
  });

  // EXT-83 — this is the ONE note whose subject is how to write a commit message, so quoting its
  // own examples in backticks would demonstrate the exact style the rule exists to stop. Asserted
  // on the note ALONE (with a base prompt the return value includes sibling notes that legitimately
  // use backticks).
  it('contains no backtick character at all', () => {
    const notes = [
      appendCommitCoAuthorNote(undefined, undefined),
      appendCommitCoAuthorNote(undefined, undefined, NEUTRAL_IDENTITY),
      appendCommitCoAuthorNote(undefined, { name: 'Acme Bot', email: 'bot@acme.test' }),
    ];
    for (const note of notes) expect(note).not.toContain('`');
  });

  // EXT-83 — a prohibition the model can only obey by rote is one it drops under pressure; the
  // note must carry the MECHANISM (the shell expands the construct BEFORE git runs). Naming a
  // construct without its mechanism has been measured on this project not to work.
  it('states the shell-expansion mechanism and both message rules, not merely a prohibition', () => {
    const note = appendCommitCoAuthorNote(undefined, undefined);
    // Rule 1 — plain English.
    expect(note).toContain('plain English');
    // The mechanism itself: expansion, of the named constructs, before git runs.
    expect(note).toContain(
      'expands backtick and dollar-parenthesis constructs before git ever runs'
    );
    // Rule 2 — by file, not inline. Unconditional, not advisory.
    expect(note).toContain('Never pass a commit message inline with the -m option');
    expect(note).toContain('git commit -F');
    // …and the file must be written by the tool, not by a shell redirect that reintroduces the
    // identical hazard one layer up.
    expect(note).toContain('write_file');
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
describe('resolveModelIdentity (GS2-34/GS2-53)', () => {
  it('formats provider:model from _llmType() + modelDisplayName (modelDisplayName wins over llm.model)', () => {
    const id = resolveModelIdentity({
      llm: { _llmType: () => 'anthropic', model: 'llm-model-fallback' },
      modelDisplayName: 'claude-sonnet-5',
    });
    expect(id).toEqual({ identity: 'anthropic:claude-sonnet-5', hasProvider: true });
  });

  it('falls back to the live model.model when modelDisplayName is unset', () => {
    expect(
      resolveModelIdentity({ llm: { _llmType: () => 'ollama', model: 'gemma3:27b' } })
    ).toEqual({ identity: 'ollama:gemma3:27b', hasProvider: true });
  });

  it('returns undefined when the model is unknown (a provider alone is not a usable identity)', () => {
    // This is the load-bearing case: an `_llmType`-only config (no model) must resolve to undefined
    // so appendModelContextNote injects nothing and the prompt is unchanged.
    expect(resolveModelIdentity({ llm: { _llmType: () => 'anthropic' } })).toBeUndefined();
    expect(resolveModelIdentity({})).toBeUndefined();
    expect(resolveModelIdentity(undefined)).toBeUndefined();
  });

  it('emits the bare model with hasProvider:false when the provider is unavailable', () => {
    expect(resolveModelIdentity({ modelDisplayName: 'gpt-5.4' })).toEqual({
      identity: 'gpt-5.4',
      hasProvider: false,
    });
  });

  // GS2-53 — the AUTHORITATIVE regression: a bare model whose NAME contains a colon (an Ollama/HF
  // tag like `gemma3:27b`) with NO provider resolvable must be `hasProvider: false`, so the note
  // never re-appends the dangling `(provider:model)` label from a colon that is merely part of the
  // model name.
  it('reports hasProvider:false for a bare colon-containing model name (no provider resolvable)', () => {
    // modelDisplayName carries a colon, no modelProviderType, no llm/_llmType at all.
    expect(resolveModelIdentity({ modelDisplayName: 'gemma3:27b' })).toEqual({
      identity: 'gemma3:27b',
      hasProvider: false,
    });
    // Same, but _llmType() throws — still no provider, still hasProvider:false.
    expect(
      resolveModelIdentity({
        llm: {
          _llmType: () => {
            throw new Error('provider accessor boom');
          },
          model: 'gemma3:27b',
        },
      })
    ).toEqual({ identity: 'gemma3:27b', hasProvider: false });
  });

  it('never throws when _llmType() throws — guarded, emits the bare model (hasProvider:false)', () => {
    const id = resolveModelIdentity({
      llm: {
        _llmType: () => {
          throw new Error('provider accessor boom');
        },
        model: 'x',
      },
      modelDisplayName: 'gpt-5.4',
    });
    expect(id).toEqual({ identity: 'gpt-5.4', hasProvider: false });
  });

  it('an empty-string _llmType() is treated as no provider (hasProvider:false, bare model)', () => {
    expect(resolveModelIdentity({ llm: { _llmType: () => '', model: 'some-model' } })).toEqual({
      identity: 'some-model',
      hasProvider: false,
    });
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
    ).toEqual({ identity: 'openrouter:anthropic/claude-3.5-sonnet', hasProvider: true });
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'openai', model: 'deepseek-chat' },
        modelDisplayName: 'deepseek-chat',
        modelProviderType: 'deepseek',
      })
    ).toEqual({ identity: 'deepseek:deepseek-chat', hasProvider: true });
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'openai', model: 'grok-4' },
        modelDisplayName: 'grok-4',
        modelProviderType: 'xai',
      })
    ).toEqual({ identity: 'xai:grok-4', hasProvider: true });
  });

  it('a configured type that matches _llmType() (anthropic/ollama) is unchanged', () => {
    // The type maps 1:1 to _llmType() here, so preferring it yields the same identity as before.
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'anthropic', model: 'claude-sonnet-5' },
        modelDisplayName: 'claude-sonnet-5',
        modelProviderType: 'anthropic',
      })
    ).toEqual({ identity: 'anthropic:claude-sonnet-5', hasProvider: true });
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'ollama', model: 'gemma3:27b' },
        modelProviderType: 'ollama',
      })
    ).toEqual({ identity: 'ollama:gemma3:27b', hasProvider: true });
  });

  it('falls back to _llmType() when no configured type is threaded (e.g. module configs)', () => {
    // A module config hands us an already-built LLM with no raw `type`, so modelProviderType is
    // absent — the guarded `_llmType()` remains the provider source, exactly as before GS2-53.
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'anthropic', model: 'claude-sonnet-5' },
        modelDisplayName: 'claude-sonnet-5',
      })
    ).toEqual({ identity: 'anthropic:claude-sonnet-5', hasProvider: true });
    // A blank/whitespace-only type is treated as unset and falls back to _llmType() too.
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'anthropic', model: 'claude-sonnet-5' },
        modelDisplayName: 'claude-sonnet-5',
        modelProviderType: '   ',
      })
    ).toEqual({ identity: 'anthropic:claude-sonnet-5', hasProvider: true });
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
    ).toEqual({ identity: 'xai:grok-4', hasProvider: true });
  });
});

describe('appendModelContextNote (GS2-34/GS2-53)', () => {
  it('injects a single line naming the provider:model identity', () => {
    const out = appendModelContextNote('BASE PROMPT', {
      identity: 'anthropic:claude-sonnet-5',
      hasProvider: true,
    });
    expect(out?.startsWith('BASE PROMPT')).toBe(true);
    expect(out).toContain('`anthropic:claude-sonnet-5`');
    expect(out).toContain('which model you are');
    // GS2-53 — the `(provider:model)` format label rides along when a provider half is present.
    expect(out).toContain('`anthropic:claude-sonnet-5` (provider:model). This is your');
  });

  // GS2-53 — the `(provider:model)` label documents the identity FORMAT. On the bare-model branch
  // (hasProvider:false) it dangled and misled; it must be omitted so the sentence still reads
  // naturally.
  it('omits the dangling (provider:model) label for a bare-model identity', () => {
    const out = appendModelContextNote('BASE PROMPT', { identity: 'gpt-5.4', hasProvider: false });
    expect(out).toContain('`gpt-5.4`. This is your');
    expect(out).not.toContain('(provider:model)');
    // Still a well-formed, single first-party line naming the model.
    expect(out).toContain('which model you are');
  });

  // GS2-53 — the AUTHORITATIVE regression: a bare model whose NAME contains a colon must STILL omit
  // the label. Driven by the structured `hasProvider:false`, NOT by `identity.includes(':')` —
  // which would (wrongly) see the colon in `gemma3:27b` and re-append the dangling label.
  it('omits the label for a bare colon-containing model name (hasProvider:false)', () => {
    const out = appendModelContextNote('BASE PROMPT', {
      identity: 'gemma3:27b',
      hasProvider: false,
    });
    expect(out).toContain('`gemma3:27b`. This is your');
    expect(out).not.toContain('(provider:model)');
  });

  it('keeps the (provider:model) label for a provider-present multi-colon identity', () => {
    // `ollama:gemma3:27b` HAS a provider half (leading `ollama:`), so the label is correct even
    // though the model name itself contains a colon.
    const out = appendModelContextNote('BASE PROMPT', {
      identity: 'ollama:gemma3:27b',
      hasProvider: true,
    });
    expect(out).toContain('`ollama:gemma3:27b` (provider:model). This is your');
  });

  it('returns the note alone when there is no base prompt', () => {
    const out = appendModelContextNote(undefined, {
      identity: 'anthropic:claude-sonnet-5',
      hasProvider: true,
    });
    expect(out?.startsWith('The model currently serving this session')).toBe(true);
    expect(out).toContain('`anthropic:claude-sonnet-5`');
  });

  it('opt-out / unresolved identity leaves the prompt UNCHANGED (no line)', () => {
    // Undefined identity — the config opted out (injectModelContext: false) or no model resolved —
    // returns the base prompt byte-for-byte (additive-only guarantee).
    expect(appendModelContextNote('BASE PROMPT', undefined)).toBe('BASE PROMPT');
    expect(appendModelContextNote('BASE PROMPT', { identity: '   ', hasProvider: false })).toBe(
      'BASE PROMPT'
    );
    expect(appendModelContextNote(undefined, undefined)).toBeUndefined();
  });
});
