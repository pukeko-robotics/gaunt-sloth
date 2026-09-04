/**
 * EXT-161 — `/autocompact` in the shared slash-command registry: registered beside `/compact`,
 * pure (it returns an effect and touches nothing), and reading the SAME parser the `autocompact`
 * config key validates with.
 *
 * The parser-sharing cell is the reason this command was specified in this node rather than in the
 * TUI cluster: the suffix grammar, the decimal K/M convention and the malformed-input rejection all
 * belong to one implementation, and two that merely agree on the day they are written drift
 * afterwards. It is therefore written to fail if either call site forks — see its docblock.
 */
import { describe, expect, it } from 'vitest';
import {
  autocompactLines,
  autocompactNotice,
  autocompactRejectedNotice,
  autocompactUnavailableNotice,
  createCommandRegistry,
  dispatchSlashCommand,
  parseSlashCommand,
  type SlashCommandContext,
} from '#src/modules/slashCommands.js';
import { parseTokenBudget, resolveAutocompactConfig, TokenBudgetError } from '@gaunt-sloth/core';
import type { AutocompactStatus } from '@gaunt-sloth/core/core/compactionThreshold.js';

const ctx = (over: Partial<SlashCommandContext> = {}): SlashCommandContext => ({
  mode: 'chat',
  modelDisplayName: 'claude-sonnet-4-5',
  turnCount: 0,
  toolsExpanded: false,
  debugVisible: false,
  ...over,
});

const status = (over: Partial<AutocompactStatus> = {}): AutocompactStatus => ({
  enabled: true,
  thresholdTokens: 160_000,
  thresholdOrigin: 'config',
  window: 200_000,
  windowOrigin: 'models.dev',
  budget: { kind: 'tokens', tokens: 160_000 },
  ...over,
});

const run = (line: string, context = ctx()) => {
  const parsed = parseSlashCommand(line);
  expect(parsed).not.toBeNull();
  return dispatchSlashCommand(parsed!, createCommandRegistry(), context, { duringRun: false });
};

describe('EXT-161 — /autocompact is registered and pure', () => {
  it('is in the shared registry, so both surfaces get it from one place', () => {
    const names = createCommandRegistry().map((c) => c.name);
    expect(names).toContain('autocompact');
    // Registered BESIDE /compact through the same surface, per the node — not in a second registry.
    expect(names.indexOf('autocompact')).toBe(names.indexOf('compact') + 1);
  });

  it('reports rather than erroring when given no argument', () => {
    const result = run('/autocompact');
    expect(result.autocompact).toEqual({ show: true });
    expect(result.notice).toBeUndefined();
  });

  it.each([
    ['/autocompact 300000', 300000],
    ['/autocompact 300K', 300000],
    ['/autocompact 0.9M', 900000],
    ['/autocompact 1.5k', 1500],
    ['/autocompact   300k  ', 300000],
    ['/autocompact 300 K', 300000],
  ])('%s asks for a %s-token threshold', (line, tokens) => {
    expect(run(line).autocompact).toEqual({ budget: { kind: 'tokens', tokens } });
  });

  it('accepts the percentage form, unresolved until the surface knows the window', () => {
    expect(run('/autocompact 80%').autocompact).toEqual({
      budget: { kind: 'fraction', fraction: 0.8 },
    });
  });

  it('is available mid-turn: it moves a number read before the NEXT call, not this one', () => {
    const parsed = parseSlashCommand('/autocompact 300K');
    const result = dispatchSlashCommand(parsed!, createCommandRegistry(), ctx(), {
      duringRun: true,
    });
    expect(result.autocompact).toEqual({ budget: { kind: 'tokens', tokens: 300000 } });
  });
});

describe('EXT-161 — a malformed argument leaves the threshold in force', () => {
  it.each(['/autocompact nonsense', '/autocompact 300G', '/autocompact -5', '/autocompact 0.8'])(
    '%s changes nothing and explains itself',
    (line) => {
      const result = run(line);
      // **No effect at all.** A typo must not switch a protection off: the user asked to change a
      // number, and a silent disable would only be discovered by an overflow much later.
      expect(result.autocompact).toBeUndefined();
      expect(result.notice?.title).toBe('Not a token budget');
      expect(result.notice?.tone).toBe('warn');
      expect(result.notice?.lines.join(' ')).toContain('unchanged');
    }
  );

  it('names the offending text back to the user', () => {
    expect(run('/autocompact 300G').notice?.lines.join(' ')).toContain('300G');
  });
});

/**
 * **The shared-parser cell.**
 *
 * Not "two parsers asserted to agree" — the command and the config key are driven over ONE input
 * table and their outcomes compared, acceptance for acceptance, rejection for rejection, and
 * resolved number for resolved number. A fork would have to reproduce the whole table, including
 * the exact rejection messages, to keep this green.
 */
describe('EXT-161 — the command and the config key share one parser', () => {
  const inputs = [
    '300000',
    '300K',
    '300k',
    '0.9M',
    '1.5k',
    '  300K  ',
    '80%',
    '12.5%',
    'nonsense',
    '300G',
    '0.8',
    '-5K',
    '0',
    '150%',
    '1e5',
  ];
  // The empty string is deliberately NOT in this table. It is a malformed value in a config file
  // and it is "no argument" on a command line, so the two call sites correctly differ there — the
  // one asymmetry the shared parser does not, and should not, remove. It is covered as its own
  // case below.

  it.each(inputs)('reads %j identically on both call sites', (input) => {
    // The config side, exactly as `resolveAutocompactConfig` reads the key.
    let configBudget: unknown;
    let configError: string | undefined;
    try {
      configBudget = resolveAutocompactConfig(input).budget;
    } catch (error) {
      configError = (error as TokenBudgetError).message;
    }

    // The command side, exactly as a user types it.
    const result = run(`/autocompact ${input}`.trimEnd());
    const commandBudget =
      result.autocompact && 'budget' in result.autocompact ? result.autocompact.budget : undefined;
    const commandError = result.notice?.lines[0];

    if (configError === undefined) {
      // Accepted on both sides, and to the same value.
      expect(commandBudget).toEqual(configBudget);
      expect(commandError).toBeUndefined();
    } else {
      // Rejected on both sides, with the SAME message — which is what a forked parser would have
      // to reproduce verbatim, rather than merely also failing.
      expect(commandBudget).toBeUndefined();
      expect(commandError).toBe(configError);
    }
  });

  it('a bare `/autocompact` reports, where an empty CONFIG value is malformed', () => {
    // The command's read half has no config counterpart, and an argument-less command line is not
    // an empty value — so this asymmetry is deliberate rather than a gap in the sharing.
    expect(run('/autocompact').autocompact).toEqual({ show: true });
    expect(run('/autocompact   ').autocompact).toEqual({ show: true });
    expect(resolveAutocompactConfig(undefined)).toEqual({ enabled: true, budget: null });
    expect(() => resolveAutocompactConfig('')).toThrow(TokenBudgetError);
  });

  it('rejects on the command side everything the parser itself rejects', () => {
    for (const bad of ['nonsense', '300G', '0.8', '-5K', '150%']) {
      expect(() => parseTokenBudget(bad)).toThrow(TokenBudgetError);
      expect(run(`/autocompact ${bad}`).autocompact).toBeUndefined();
    }
  });
});

describe('EXT-161 — what the notices say', () => {
  it('names the threshold, its provenance and the window it came from', () => {
    const lines = autocompactLines(status()).join(' ');
    expect(lines).toContain('160,000');
    expect(lines).toContain('200,000');
    expect(lines).toContain('models.dev');
  });

  it('says a session override came from the session, not from the config it replaced', () => {
    // A `/status` still calling a hand-typed number models.dev-derived would send the next
    // diagnosis to the wrong place entirely.
    const lines = autocompactLines(
      status({ thresholdOrigin: 'session', thresholdTokens: 300_000 })
    ).join(' ');
    expect(lines).toContain('/autocompact');
    expect(lines).toContain('overridden');
    expect(lines).not.toMatch(/from the `autocompact` key/);
  });

  it('says nothing will fire when the window is unknown, and offers the fix', () => {
    const lines = autocompactLines(
      status({
        thresholdTokens: null,
        thresholdOrigin: 'none',
        window: null,
        windowOrigin: 'unknown',
        budget: null,
      })
    ).join(' ');
    expect(lines).toContain('nothing will trigger it');
    expect(lines).toContain('/autocompact 300K');
    // Never the guess.
    expect(lines).not.toContain('4097');
  });

  it('says compaction is off when the off switch is set', () => {
    const lines = autocompactLines(
      status({ enabled: false, thresholdTokens: null, thresholdOrigin: 'none' })
    ).join(' ');
    expect(lines).toContain('OFF');
    expect(lines).toContain('autocompact: false');
  });

  it('a changed threshold says it is session-only and where to make it permanent', () => {
    const notice = autocompactNotice(status({ thresholdOrigin: 'session' }), true);
    expect(notice.title).toBe('Automatic compaction threshold set');
    expect(notice.lines.join(' ')).toContain('rest of this session only');
    // A bare report must NOT claim anything was changed.
    expect(autocompactNotice(status(), false).lines.join(' ')).not.toContain(
      'rest of this session only'
    );
  });

  it('reports unavailability rather than inventing a number', () => {
    const notice = autocompactUnavailableNotice();
    expect(notice.tone).toBe('warn');
    expect(notice.lines.join(' ')).toContain('Nothing was changed');
  });

  it('the rejection notice shows the usage line', () => {
    expect(autocompactRejectedNotice('bad').lines.join(' ')).toContain('/autocompact [<tokens>]');
  });
});

describe('EXT-161 — /status carries the threshold and its provenance', () => {
  it('includes the compaction lines when a threshold is resolved', () => {
    const result = run('/status', ctx({ autocompact: status() }));
    const lines = result.notice!.lines.join(' ');
    expect(result.notice!.title).toBe('Session status');
    expect(lines).toContain('160,000');
    expect(lines).toContain('models.dev');
  });

  it('reflects a SESSION override rather than the value it replaced', () => {
    const result = run(
      '/status',
      ctx({ autocompact: status({ thresholdOrigin: 'session', thresholdTokens: 300_000 }) })
    );
    const lines = result.notice!.lines.join(' ');
    expect(lines).toContain('300,000');
    expect(lines).toContain('/autocompact');
  });

  it('says nothing about compaction on a surface with no resolved model', () => {
    // The fixture agent: no window, so no claim. The rest of the status block is unaffected.
    const result = run('/status', ctx({ autocompact: undefined }));
    const lines = result.notice!.lines.join(' ');
    expect(lines).not.toContain('Automatic compaction');
    expect(lines).toContain('Mode: chat');
  });
});
