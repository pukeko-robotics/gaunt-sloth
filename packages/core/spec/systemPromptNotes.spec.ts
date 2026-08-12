import { describe, expect, it } from 'vitest';
import {
  appendCommitCoAuthorNote,
  appendModelContextNote,
  resolveModelIdentity,
  type CommitCoAuthor,
  type ResolvedModelIdentity,
} from '#src/utils/systemPromptNotes.js';
import { DEFAULT_COMMIT_CO_AUTHOR_EMAIL, DEFAULT_COMMIT_CO_AUTHOR_NAME } from '#src/constants.js';
import type { FilesystemToolsConfig } from '#src/config/filesystem-tools.js';

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

  /** The composed `Co-Authored-By:` line, so an assertion about the trailer scans the trailer. */
  const trailerLineOf = (note: string): string | undefined =>
    note.split('\n').find((line) => line.startsWith('Co-Authored-By:'));

  /**
   * The note MINUS the trailer's angle-bracketed address — the prose the model reads as
   * instructions. Only the ADDRESS is excluded, because the RFC form of an address genuinely
   * requires angle brackets; everywhere else, the rest of the trailer line included, an angle
   * bracket is a placeholder the model may copy literally into a shell. Dropping the whole trailer
   * line instead would leave markup placed on that line outside a scan whose title claims to cover
   * the note.
   */
  const proseOf = (note: string): string =>
    note
      .split('\n')
      .map((line) => {
        if (!line.startsWith('Co-Authored-By:')) return line;
        const open = line.indexOf('<');
        const close = line.indexOf('>', open + 1);
        return open >= 0 && close > open ? line.slice(0, open) + line.slice(close + 1) : line;
      })
      .join('\n');

  /** The note alone, for a given `filesystem` config — the EXT-84 gate's only input. */
  const noteFor = (filesystem?: FilesystemToolsConfig): string =>
    appendCommitCoAuthorNote(undefined, undefined, undefined, filesystem);

  /** The clause composed when the write tool IS registered — it names the tool literally. */
  const NAMED_TOOL_CLAUSE =
    'Write the message to a file with the write_file tool (never with shell echo or a heredoc, ' +
    'which put the same text back into a shell argument), then commit it with git commit -F ' +
    'followed by that file path.';

  /**
   * EXT-97 — the staging rule's load-bearing clauses. Held as constants because each is asserted
   * both on its own and across the EXT-84 branch sweep, and a substring typed twice drifts.
   */
  const STAGING_RULE = 'Stage the files you changed by naming their paths';
  const UNSCOPED_ADD_PROHIBITION = 'Do not stage with git add -A, git add . or git commit -a';
  const UNSCOPED_ADD_MECHANISM =
    'an unscoped add stages every untracked file in the working tree, including the commit ' +
    'message file you just wrote, so it lands in the commit and on the pull request';
  const MESSAGE_FILE_NEVER_STAGED = 'Never stage the commit message file itself.';
  /**
   * EXT-97 — the last resort, and the step that stops it reintroducing the very defect the rule
   * closes: an unscoped add stages the message file, so the file must leave the tree BEFORE the
   * allowance is taken. The allowance itself stays (a change can genuinely touch too many files to
   * name); it is the remedy that has to be mandatory.
   */
  const LAST_RESORT_REMOVES_MESSAGE_FILE =
    'first move the commit message file out of the working tree or delete it';

  /** EXT-97 — the conditional scratchpad sentence, verbatim. */
  const SCRATCHPAD_SENTENCE =
    'If this session has given you a scratchpad location, write that message file there instead ' +
    'of into the project.';

  /** `filesystem` values under which the write tool IS registered. */
  const WRITE_TOOL_REGISTERED: (FilesystemToolsConfig | undefined)[] = [
    'all',
    ['all'],
    ['write_file'],
    ['read', 'write_file'],
    undefined,
  ];

  /** `filesystem` values under which it is NOT — the string modes and the array forms. */
  const WRITE_TOOL_ABSENT_STRINGS: FilesystemToolsConfig[] = ['read', 'none'];
  const WRITE_TOOL_ABSENT_ARRAYS: FilesystemToolsConfig[] = [
    ['read'],
    ['read_file'],
    ['read_file', 'list_directory'],
    [],
  ];

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
      // EXACT on the composed trailer line, not a substring of the whole note: an empty
      // parenthesis, a whitespace identity or a stand-in like "unknown" all fail here, and a
      // future note wording that happens to contain those characters elsewhere does not.
      expect(trailerLineOf(out)).toBe('Co-Authored-By: Gaunt Sloth <code@gauntsloth.app>');
      // …and the identity is not spliced into the name anywhere else in the note either.
      expect(out).not.toContain('Gaunt Sloth (');
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
  // own examples in backticks would demonstrate the exact style the rule exists to stop, and the
  // requirement is "no backticks AND no markup", both halves pinned here. The angle-bracket half
  // is not cosmetic: a model copying `-F <path to that file>` literally emits a SHELL INPUT
  // REDIRECT, which is the very class of accident this note exists to prevent. Asserted on the
  // note ALONE (with a base prompt the return value includes sibling notes that legitimately use
  // backticks), and on the PROSE (only the trailer's RFC `<email>` brackets are legitimate, and
  // only those are excluded — the rest of that line is scanned like any other).
  it('contains no backtick and no other markup in its prose', () => {
    // Placeholder/markup characters a model could copy verbatim, or that would make the note
    // demonstrate the formatting it forbids.
    const MARKUP = ['`', '<', '>', '*', '#', '[', ']'];
    // Two axes, each of which changes the scanned text: the co-author NAME (now inside the scan,
    // since only the address is excluded) and the EXT-84 filesystem branch (a different final
    // clause). A note wording that is clean on one branch and not the other fails here.
    const notes = [
      appendCommitCoAuthorNote(undefined, undefined),
      appendCommitCoAuthorNote(undefined, undefined, NEUTRAL_IDENTITY),
      appendCommitCoAuthorNote(undefined, { name: 'Acme Bot', email: 'bot@acme.test' }),
      noteFor('read'),
      noteFor(['read_file']),
    ];
    for (const note of notes) {
      // A backtick is illegitimate even on the trailer line.
      expect(note).not.toContain('`');
      const prose = proseOf(note);
      for (const char of MARKUP) expect(prose).not.toContain(char);
    }
  });

  // EXT-83 — the single-trailer instruction. With the model-name denylist retired, this sentence
  // and the supplied correct name together carry the whole "what goes in the trailer" requirement,
  // so its load went up; it is pinned here because nothing else in the suite asserts it and a
  // silent deletion would leave the model free to emit a second trailer naming itself.
  it('instructs the model to emit at most ONE Co-Authored-By trailer', () => {
    // Swept over the EXT-84 filesystem branches rather than over co-author shapes: the sentence is
    // composed identically for every identity, so those shapes could not discriminate, whereas the
    // branches build the note's tail differently and a rule dropped from one of them fails here.
    for (const filesystem of ['all', 'read', 'none', ['read_file']] as FilesystemToolsConfig[]) {
      expect(noteFor(filesystem)).toContain('Emit at most this one Co-Authored-By trailer.');
    }
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

  // EXT-84 — the clause naming the writing tool is gated on the resolved `filesystem` capability.
  // Naming a tool that is not registered, while forbidding the shell fallback AND the inline flag,
  // leaves the model no compliant path at all, and its likeliest recovery is the inline form this
  // whole note exists to prevent. `filesystem` is a UNION (string modes plus an array of tool
  // names), so the string and array forms are asserted separately: a gate that handled only the
  // two string modes would pass the block below and fail the one after it.

  it('leaves the note unchanged under filesystem all, naming the write tool literally', () => {
    const note = noteFor('all');
    expect(note).toContain(NAMED_TOOL_CLAUSE);
    // The pre-EXT-84 call shape (no filesystem argument) composes the SAME note byte for byte, so
    // the gate is additive: every caller that does not thread a capability is unaffected.
    expect(note).toBe(appendCommitCoAuthorNote(undefined, undefined));
  });

  it('names the write tool under every filesystem value that registers it', () => {
    // Includes the array forms that DO reach it, so "array means restricted" would fail here: the
    // gate resolves the union, it does not merely test for an array.
    for (const filesystem of WRITE_TOOL_REGISTERED) {
      expect(noteFor(filesystem)).toContain(NAMED_TOOL_CLAUSE);
    }
  });

  it('names no tool under the read and none string modes', () => {
    for (const filesystem of WRITE_TOOL_ABSENT_STRINGS) {
      expect(noteFor(filesystem)).not.toContain('write_file');
    }
  });

  it('names no tool under an array form that excludes the write tool', () => {
    // Asserted apart from the string modes on purpose — this is the case a two-value check misses.
    for (const filesystem of WRITE_TOOL_ABSENT_ARRAYS) {
      expect(noteFor(filesystem)).not.toContain('write_file');
    }
  });

  it('keeps both prohibitions and supplies a compliant path when no tool is named', () => {
    // The point of the gate is NOT to drop the rules — it is to stop the model being cornered. The
    // inline prohibition, its mechanism and the file form all survive, and the note ends with the
    // one course that remains available when nothing can write the file.
    for (const filesystem of [...WRITE_TOOL_ABSENT_STRINGS, ...WRITE_TOOL_ABSENT_ARRAYS]) {
      const note = noteFor(filesystem);
      expect(note).toContain('Never pass a commit message inline with the -m option');
      expect(note).toContain(
        'expands backtick and dollar-parenthesis constructs before git ever runs'
      );
      expect(note).toContain('git commit -F');
      expect(note).toContain('Do not create that file with shell echo or a heredoc');
      expect(note).toContain(
        'If nothing in this session can write that file, do not create the commit yourself'
      );
    }
  });

  it('claims nothing about which tools this session has when it names none', () => {
    // The two backends read the SAME `filesystem` value but register filesystem tools by different
    // rules, so a note asserting the session HAS no file-writing tool would be flatly false on one
    // of them. The restricted branch is conditional instead: it never states the absence.
    for (const filesystem of [...WRITE_TOOL_ABSENT_STRINGS, ...WRITE_TOOL_ABSENT_ARRAYS]) {
      const note = noteFor(filesystem);
      expect(note).toContain('If nothing in this session can write that file');
      expect(note).not.toContain('You have no');
      expect(note).not.toContain('no file-writing tool is available');
      expect(note).not.toContain('There is no tool');
    }
  });

  // EXT-97 — the staging rule. Rule 2 leaves the message file untracked in the working tree, so an
  // unscoped add sweeps it into the commit and onto the pull request. Like the -m prohibition
  // beside it, the note must carry the MECHANISM and not merely the ban, and it must offer the
  // compliant path (named paths) plus the last resort, or a model facing a hundred-file change has
  // nowhere to go but the construct this rule forbids.
  it('states the staging rule, the unscoped-add prohibition and the mechanism behind it', () => {
    const note = appendCommitCoAuthorNote(undefined, undefined);
    expect(note).toContain(STAGING_RULE);
    expect(note).toContain(UNSCOPED_ADD_PROHIBITION);
    expect(note).toContain(UNSCOPED_ADD_MECHANISM);
    // Stated separately from the prohibition: even a correctly scoped add must not name this file.
    expect(note).toContain(MESSAGE_FILE_NEVER_STAGED);
    // The last resort survives — but only with the message file removed from the tree first, or the
    // escape hatch would stage the very file the sentence above forbids staging.
    expect(note).toContain('is an unscoped add acceptable');
    expect(note).toContain(LAST_RESORT_REMOVES_MESSAGE_FILE);
    expect(note).toContain('check with git status what else the add is about to sweep in');
  });

  // EXT-97 — the PLACEMENT property, and the reason this is asserted over the branch sweep rather
  // than once: the staging rule is universal (an unscoped add sweeps the message file in however
  // that file came to be written), so composing it inside the EXT-84 write-tool ternary would leave
  // it silently missing from every configuration that does not register the write tool. Relocating
  // the rule into either branch fails here.
  it('carries the staging rule on BOTH branches of the write-tool gate', () => {
    const branches: (FilesystemToolsConfig | undefined)[] = [
      ...WRITE_TOOL_REGISTERED,
      ...WRITE_TOOL_ABSENT_STRINGS,
      ...WRITE_TOOL_ABSENT_ARRAYS,
    ];
    for (const filesystem of branches) {
      const note = noteFor(filesystem);
      expect(note).toContain(STAGING_RULE);
      expect(note).toContain(UNSCOPED_ADD_PROHIBITION);
      expect(note).toContain(UNSCOPED_ADD_MECHANISM);
      expect(note).toContain(MESSAGE_FILE_NEVER_STAGED);
      // The scratchpad sentence is universal for the same reason — it is about WHERE the file goes,
      // not about which tool writes it.
      expect(note).toContain(SCRATCHPAD_SENTENCE);
    }
  });

  // EXT-97 — the scratchpad sentence, and the two constraints that give it its shape.
  it('carries a conditional scratchpad sentence that names NO path', () => {
    const note = appendCommitCoAuthorNote(undefined, undefined);
    // Conditional on the session having HANDED the model a location — not on the model going
    // looking for one. Nothing hands it one today, so a model told nothing proceeds as before; when
    // the mechanism lands the sentence becomes live with no further prompt edit.
    expect(note).toContain(SCRATCHPAD_SENTENCE);
    // …and it names no path. The built-in write tool refuses any path outside the working folder at
    // every approval mode, so a note that named one would buy a refused call and a wasted turn.
    // Asserted over both EXT-84 branches so a path spliced into either one fails.
    for (const filesystem of ['all', 'read'] as FilesystemToolsConfig[]) {
      const branch = noteFor(filesystem);
      for (const path of ['/tmp', '~/.gsloth', '.gsloth/scratchpad']) {
        expect(branch).not.toContain(path);
      }
    }
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

  // GS2-53 — the OpenAI-compatible shims that extend ChatOpenAI (deepseek/xai) report a live
  // `_llmType()` of `openai`. The configured provider `type` (stashed by the loader as
  // `modelProviderType`) is the true provider and MUST win, or a `type: deepseek` config injects
  // the wrong `openai:<model>` identity into the prompt.
  it('prefers the configured provider type over _llmType() for OpenAI-compatible shims', () => {
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

  it('a configured type that matches _llmType() (anthropic/ollama/openrouter) is unchanged', () => {
    // The type maps 1:1 to _llmType() here, so preferring it yields the same identity as before.
    // `openrouter` belongs in THIS group: it is a native client, not a ChatOpenAI subclass, and
    // its own `_llmType()` already reports `openrouter`.
    expect(
      resolveModelIdentity({
        llm: { _llmType: () => 'openrouter', model: 'anthropic/claude-3.5-sonnet' },
        modelDisplayName: 'anthropic/claude-3.5-sonnet',
        modelProviderType: 'openrouter',
      })
    ).toEqual({ identity: 'openrouter:anthropic/claude-3.5-sonnet', hasProvider: true });
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
