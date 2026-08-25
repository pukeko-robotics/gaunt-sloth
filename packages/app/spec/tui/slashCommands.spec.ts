import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import type {
  SlashCommand,
  SlashCommandContext,
} from '@gaunt-sloth/agent/modules/slashCommands.js';

const ctx: SlashCommandContext = {
  mode: 'chat',
  modelDisplayName: 'claude-opus-4',
  turnCount: 3,
  toolsExpanded: false,
  debugVisible: false,
};

describe('tui/slashCommands parseSlashCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null for plain (non-slash) input', async () => {
    const { parseSlashCommand } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(parseSlashCommand('hello world')).toBeNull();
    expect(parseSlashCommand('  not a command')).toBeNull();
  });

  it('returns null for a bare slash', async () => {
    const { parseSlashCommand } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('  /   ')).toBeNull();
  });

  it('parses the command name (lower-cased) and args', async () => {
    const { parseSlashCommand } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(parseSlashCommand('/Help')).toEqual({ name: 'help', args: [] });
    expect(parseSlashCommand('  /status  foo bar ')).toEqual({
      name: 'status',
      args: ['foo', 'bar'],
    });
  });

  // GS2-8 — the `/`-vs-path heuristic (Mari's dogfood addendum): a real command has no further
  // `/` after the leading one, so a pasted filesystem path is NOT a command and falls through
  // to the model as ordinary prompt text.
  describe('the /-vs-path heuristic', () => {
    it('a plain command parses (/help)', async () => {
      const { parseSlashCommand } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
      expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: [] });
    });

    it('a pasted path is not a command (/usr/bin, /usr/home/bob/test.md)', async () => {
      const { parseSlashCommand } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
      expect(parseSlashCommand('/usr/bin')).toBeNull();
      expect(parseSlashCommand('/usr/home/bob/test.md')).toBeNull();
    });

    it('a command with args still parses (/verbose extra-arg)', async () => {
      const { parseSlashCommand } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
      expect(parseSlashCommand('/verbose extra-arg')).toEqual({
        name: 'verbose',
        args: ['extra-arg'],
      });
    });

    it('a bare / is not a command', async () => {
      const { parseSlashCommand } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
      expect(parseSlashCommand('/')).toBeNull();
    });
  });
});

describe('tui/slashCommands dispatchSlashCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('/help renders a notice listing every registered command', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    const result = dispatchSlashCommand(parseSlashCommand('/help')!, registry, ctx);
    expect(result.notice?.title).toBe('Slash commands');
    for (const c of registry) {
      expect(result.notice?.lines).toContain(`/${c.name} — ${c.description}`);
    }
  });

  it('/clear requests a transcript clear (banner is the visible feedback)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/clear')!, createCommandRegistry(), ctx);
    expect(result.clearTranscript).toBe(true);
  });

  it('/debug requests a debug-panel toggle with a state-aware notice (showing when hidden)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/debug')!, createCommandRegistry(), {
      ...ctx,
      debugVisible: false,
    });
    expect(result.toggleDebug).toBe(true);
    expect(result.notice?.title).toBe('Debug panel: shown');
    expect(result.notice?.lines[0]).toContain('subagent tree');
    expect(result.exit).toBeUndefined();
  });

  it('/debug reports the hiding notice when the panel is currently shown', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/debug')!, createCommandRegistry(), {
      ...ctx,
      debugVisible: true,
    });
    expect(result.notice?.title).toBe('Debug panel: hidden');
    expect(result.notice?.lines[0]).toContain('closed');
  });

  it('/verbose requests a toggle with the ON notice when detail is currently off (GS2-8 rename)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/verbose')!, createCommandRegistry(), {
      ...ctx,
      toolsExpanded: false,
    });
    expect(result.toggleTools).toBe(true);
    expect(result.notice?.title).toBe('Tool details: on');
    expect(result.notice?.lines[0]).toContain('full inputs and results');
    // The current command carries no deprecation pointer.
    expect(result.message).toBeUndefined();
    expect(result.exit).toBeUndefined();
  });

  it('/verbose reports the OFF notice when detail is currently on', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/verbose')!, createCommandRegistry(), {
      ...ctx,
      toolsExpanded: true,
    });
    expect(result.notice?.title).toBe('Tool details: off');
    expect(result.notice?.lines[0]).toContain('single summary line');
  });

  it('/tools is gone (2.0 hard removal, renamed /verbose) — it now reads as an unknown command (GS2-8)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    expect(registry.some((c) => c.name === 'tools')).toBe(false);
    const result = dispatchSlashCommand(parseSlashCommand('/tools')!, registry, ctx);
    expect(result.notice?.title).toBe('Unknown command: /tools');
    expect(result.toggleTools).toBeUndefined();
  });

  // CFG-26 — the `/approvals` family. The commands stay PURE: they only request a show/switch;
  // the surface applies it against the runner and commits the notice for the LANDED posture.
  it('/approvals with no arg requests the DISPLAY, not a change', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/approvals')!,
      createCommandRegistry(),
      ctx
    );
    expect(result.approvals).toEqual({ show: true });
    expect(result.notice).toBeUndefined();
  });

  it('/approvals <rung> requests each of the five rungs; an unknown arg returns a usage notice', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    for (const rung of ['manual', 'write', 'assisted', 'auto', 'bypass'] as const) {
      expect(
        dispatchSlashCommand(parseSlashCommand(`/approvals ${rung}`)!, registry, ctx).approvals
      ).toEqual({ rung });
    }
    const bad = dispatchSlashCommand(parseSlashCommand('/approvals maybe')!, registry, ctx);
    expect(bad.approvals).toBeUndefined();
    expect(bad.notice?.tone).toBe('warn');
    expect(bad.notice?.title).toContain('maybe');
  });

  /**
   * CFG-27 — the pre-2.0 approvals vocabulary is gone with NO aliases. `ask` is not accepted as a
   * mode spelling, and `/auto-approve` / `/bypass-approve` are not commands: a silent alias would
   * leave the user believing in a vocabulary the gate no longer has, and `/auto-approve off` in
   * particular had to mean one of two different rungs.
   */
  it('the retired `ask` spelling and the /auto-approve, /bypass-approve commands are gone', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    // CFG-39 — `auto` is NOT checked here because it is a LIVE mode name now; the cell below pins
    // that `/approvals auto` is accepted rather than explained away.
    const result = dispatchSlashCommand(parseSlashCommand('/approvals ask')!, registry, ctx);
    expect(result.approvals).toBeUndefined();
    expect(result.notice?.title).toContain('ask');
    for (const name of ['auto-approve', 'bypass-approve']) {
      expect(registry.some((c) => c.name === name)).toBe(false);
    }
  });

  it('/yolo is DELETED pre-beta — an unknown command, not an alias and not a deprecation warning', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/yolo')!, createCommandRegistry(), ctx);
    expect(result.notice?.title).toBe('Unknown command: /yolo');
    expect(result.approvals).toBeUndefined();
    // Not a soft-landing alias: nothing in the copy points at a replacement behaviour.
    expect(createCommandRegistry().some((c) => c.name === 'yolo')).toBe(false);
  });

  /**
   * §10 — the notice body IS the mode's own description, and §8.1 forbids any of it leaning on the
   * hardline floor. §10 rule 4 fixes the title's spelling: the display form with spaces.
   */
  it('approvalsRungNotice renders §10 copy, warn-tones bypass, and never names the floor', async () => {
    const { approvalsRungNotice } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const posture = (rung: string, rater?: string) => ({ rung, rater, allow: [], deny: [] }) as any;

    const bypass = approvalsRungNotice(posture('bypass'));
    expect(bypass.title).toBe('Approvals: Bypass');
    expect(bypass.tone).toBe('warn');
    expect(bypass.lines.join(' ')).toContain('nothing is rated and nothing is asked');
    // §8.1 — the only protection cited is one the user can inspect and extend.
    expect(bypass.lines.join(' ')).toContain('deny list');
    expect(bypass.lines.join(' ')).not.toMatch(/hardline|floor/i);

    // `assisted` must state plainly that files are STILL rewritten and deleted without asking.
    const assistedNotice = approvalsRungNotice(posture('assisted'));
    expect(assistedNotice.title).toBe('Approvals: Assisted');
    expect(assistedNotice.tone).toBe('info');
    expect(assistedNotice.lines.join(' ')).toContain(
      'rewrite and delete files in your working folder without asking'
    );

    // `auto` states the negotiation that makes it differ from Assisted on a destructive command,
    // and in the same breath that it is not safe and that the exchange still ends at the user.
    const autoNotice = approvalsRungNotice(posture('auto'));
    expect(autoNotice.title).toBe('Approvals: Auto');
    expect(autoNotice.lines.join(' ')).toContain('It is not safe');
    expect(autoNotice.lines.join(' ')).toContain('back to the agent');
    expect(autoNotice.lines.join(' ')).toContain('then asks you');

    // Every posture notice points at the page that carries what the two sentences cannot. Asserted
    // through the constant, not a literal: the URL moves to the docs site once that page is
    // deployed, and a hardcoded host would make that one-line swap a test failure.
    const { APPROVAL_PROTECTION_DOCS_URL } = await import('@gaunt-sloth/core/config.js');
    expect(autoNotice.lines).toContain(APPROVAL_PROTECTION_DOCS_URL);

    // A configured rater profile is named at the rated rungs (the spec's status requirement).
    expect(approvalsRungNotice(posture('assisted', 'safety-rater')).lines.join(' ')).toContain(
      'safety-rater'
    );
    // ...and never at an unrated one, where naming it would promise a call that never happens.
    expect(approvalsRungNotice(posture('write', 'safety-rater')).lines.join(' ')).not.toContain(
      'safety-rater'
    );
  });

  it('approvalsStatusNotice shows the rung, the rater and the allow/deny sizes (— when not loaded)', async () => {
    const { approvalsStatusNotice } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const notice = approvalsStatusNotice(
      {
        rung: 'assisted',
        rater: 'safety-rater',
        allow: [],
        deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
        escalate: [],
      } as any,
      { session: 3, always: undefined },
      ['npm publish']
    );
    expect(notice.title).toBe('Approvals: Assisted');
    const body = notice.lines.join(' ');
    expect(body).toContain('safety-rater');
    expect(body).toContain('3 this session');
    expect(body).toContain('Denied: 1');
    // Not loaded → `—`, never a misleading 0.
    expect(body).toContain('— remembered');
  });

  /**
   * [[EXT-81]] — **the abstention row is gone, and its absence is asserted rather than assumed.**
   *
   * The display used to carry a count of the commands the gate could not read, because an
   * abstention refused work back to the model and left no other trace. Nothing abstains now: an
   * unresolvable command is rated like any other and the parser's finding never reaches the user at
   * all. A line reporting a count that is always zero would be a display of a fact with no reader.
   */
  it('the /approvals display carries NO abstention row', async () => {
    const { approvalsStatusNotice } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const posture = { rung: 'auto', allow: [], deny: [], escalate: [] } as any;
    const body = approvalsStatusNotice(posture, { session: 0, always: 0 }).lines.join(' ');
    expect(body).not.toContain('could not read a command');
    // ...and the rest of the display is still there, so the assertion above is about the removed
    // row rather than about a notice that stopped rendering.
    expect(body).toContain('Allowed: 0 this session');
  });

  it('the /approvals display says the rater is unused at the three deterministic rungs', async () => {
    const { approvalsStatusNotice } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    for (const rung of ['manual', 'write', 'bypass'] as const) {
      const notice = approvalsStatusNotice(
        { rung, rater: 'safety-rater', allow: [], deny: [] } as any,
        { session: 0, always: 0 }
      );
      expect(notice.lines.join(' ')).toContain('not used in this mode');
    }
  });

  /**
   * CFG-39 — the four postures the picker offers, and the text fallback every non-TTY surface
   * prints in its place. `write` is deliberately not a row: it is a modifier of Manual, settable
   * with `/approvals write` and named by the footer hint rather than by a row of its own.
   */
  it('CFG-39: /approvals auto is accepted as a mode, not explained as retired', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/approvals auto')!,
      createCommandRegistry(),
      ctx
    );
    expect(result.approvals).toEqual({ rung: 'auto' });
  });

  it('CFG-39: the picker offers the four postures, reading their copy from the descriptions', async () => {
    const { approvalPostureChoices } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const { APPROVAL_RUNG_DESCRIPTIONS, APPROVAL_RUNG_LABELS } =
      await import('@gaunt-sloth/core/config.js');
    const choices = approvalPostureChoices('assisted');
    expect(choices.map((c) => c.rung)).toEqual(['manual', 'assisted', 'auto', 'bypass']);
    expect(choices.map((c) => c.rung)).not.toContain('write');
    // The copy is the descriptions' own, never authored by the menu.
    for (const choice of choices) {
      expect(choice.description).toBe(APPROVAL_RUNG_DESCRIPTIONS[choice.rung]);
      expect(choice.label).toBe(APPROVAL_RUNG_LABELS[choice.rung]);
    }
    expect(choices.filter((c) => c.current).map((c) => c.rung)).toEqual(['assisted']);
  });

  /**
   * The one-line forms (picker rows, the text fallback, the usage hint) all shorten through
   * `firstSentence`. A description that is already ONE sentence keeps its own terminator rather
   * than gaining a second.
   */
  it('firstSentence terminates a shortened description with exactly one period', async () => {
    const { firstSentence } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(firstSentence('No gate.')).toBe('No gate.');
    expect(firstSentence('It asks first. Then it acts.')).toBe('It asks first.');
    // An unterminated single sentence still gains its period.
    expect(firstSentence('No gate')).toBe('No gate.');
  });

  /**
   * A sentence ends at `.`, `?` or `!` — all three, because the copy this shortens is ordinary
   * prose and not every sentence in it is a statement. Splitting on the period alone renders a
   * question as `Really?.` and returns BOTH sentences of `Ready? Then go.`, which is the whole
   * description in a row sized for one line.
   *
   * These cases pin the terminator set rather than the current copy: the copy is what makes the
   * defect reachable, so a test that only asserted today's descriptions would go quiet the moment
   * someone rephrased one.
   */
  it('firstSentence ends the row at a question mark or an exclamation mark too', async () => {
    const { firstSentence } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(firstSentence('Really?')).toBe('Really?');
    expect(firstSentence('Ready? Then go.')).toBe('Ready?');
    expect(firstSentence('Stop! Then think.')).toBe('Stop!');
    // A terminator inside the sentence does not end it: an ellipsis is not three sentences.
    expect(firstSentence('Wait... then go. And then stop.')).toBe('Wait... then go.');
  });

  /**
   * The picker, the text fallback and the usage hint all show ONE sentence per mode, so that
   * sentence has to be the whole answer to "what is this mode for" and has to fit a row. Ink wraps
   * rather than truncates, so an opener written as a paragraph costs three rendered lines per row
   * and the four postures stop being scannable.
   */
  it('every mode opens with a sentence that stands alone in a picker row', async () => {
    const { firstSentence } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const { APPROVAL_RUNG_DESCRIPTIONS, APPROVAL_RUNGS } =
      await import('@gaunt-sloth/core/config.js');
    for (const rung of APPROVAL_RUNGS) {
      const description = APPROVAL_RUNG_DESCRIPTIONS[rung];
      const opener = firstSentence(description);
      // A real cut, not the whole description handed back for want of a boundary.
      expect(opener.length, `${rung} has no sentence boundary`).toBeLessThan(description.length);
      expect(
        opener.length,
        `${rung}'s opener is too long for a row: "${opener}"`
      ).toBeLessThanOrEqual(140);
      expect(opener).not.toContain('..');
    }
  });

  /**
   * **The assertion that has to be on the RENDER, not on the constant.** Auto's honest clause — that
   * the [[EXT-29]] negotiation is bounded and ends at the user — was twice written into sentence
   * two, where the picker, the text fallback and the usage hint never print it. A whole-text
   * `toContain` passes on that copy; only cutting the opener the way the surfaces cut it can fail on
   * it. Core's own §10 block cannot host this: `firstSentence` lives in the agent package, which
   * core does not depend on.
   *
   * Worded as "the opener must carry the terminus, and must sell nothing beyond it", because the
   * failure is not a missing phrase — it is a promise ("as few interruptions as possible", "judges
   * each command instead of you") landing in the one clause a user reads while choosing. Auto now
   * genuinely differs from Assisted, which makes that clause easier to overwrite, not harder: the
   * difference is a few rounds of argument, and the sentence that states it has to state where the
   * argument ends in the same breath.
   */
  it('the mode a user could most easily over-trust says where it ends, in the clause a picker RENDERS', async () => {
    const { firstSentence } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const { APPROVAL_RUNG_DESCRIPTIONS } = await import('@gaunt-sloth/core/config.js');
    const opener = firstSentence(APPROVAL_RUNG_DESCRIPTIONS['auto']);
    // The correction itself, in the rendered clause: the argument is bounded and ends at the user.
    expect(opener).toContain('then asks you');
    expect(opener).toMatch(/a few times|a few rounds/);
    // And no promise beyond it. Each of these shipped or nearly shipped.
    expect(opener).not.toMatch(/few interruptions|instead of you|unattended|without stopping/i);
    expect(opener).not.toMatch(/does not stop to ask/i);
  });

  /**
   * [[CFG-48]] — §10 constraint 6. A rated rung settles some risky commands without asking anyone,
   * so the sentence that offers it has to say what kind of work that is acceptable for. A
   * *terminus* is not that: "then asks you" and "anything riskier comes to you" say where the
   * exchange ends, not when the mode is a bad idea — and for a while those were all the two rated
   * openers carried, while all three deterministic ones carried a real limit on use.
   *
   * **Lexical on purpose, because that is the version that can actually fail.** "Carries a
   * limit-on-use clause" has no mechanical predicate: a test written to that sentence either pins
   * today's exact strings, which the next paraphrase defeats, or matches loosely enough to pass
   * anything. So the rule names its carrier token and this asserts the token — and the docblock
   * says so, so an author who moves the wording reads the failure as the rule and not as a false
   * positive.
   *
   * Two things make it track the RULE rather than these two strings: the rated set comes from
   * `isRatedRung`, the production predicate, so a sixth rated rung has to carry a clause on the day
   * it is added; and the three UNRATED rungs are asserted NOT to carry the token, so the lazy fix —
   * spreading `recoverable` across all five — destroys the distinction instead of satisfying it.
   * Matched with a boundary that "unrecoverable" and "non-recoverable" fail, since a substring test
   * would accept copy meaning the opposite of the rule.
   */
  it("every rated rung's opener says what kind of work it is for, and only the rated ones do", async () => {
    const { firstSentence } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const { APPROVAL_RUNG_DESCRIPTIONS, APPROVAL_RUNGS, isRatedRung } =
      await import('@gaunt-sloth/core/config.js');
    const carrier = /(?<![\w-])recoverable\b/;
    // The regex is the assertion, so prove it discriminates before trusting either half.
    expect(carrier.test('unrecoverable')).toBe(false);
    expect(carrier.test('non-recoverable')).toBe(false);
    expect(carrier.test('for recoverable work')).toBe(true);

    const rated = APPROVAL_RUNGS.filter((rung) => isRatedRung(rung));
    expect(rated.length).toBeGreaterThan(0);
    for (const rung of rated) {
      const opener = firstSentence(APPROVAL_RUNG_DESCRIPTIONS[rung]);
      expect(opener, `${rung}'s opener carries no limit on use: "${opener}"`).toMatch(carrier);
    }
    for (const rung of APPROVAL_RUNGS.filter((rung) => !isRatedRung(rung))) {
      expect(
        APPROVAL_RUNG_DESCRIPTIONS[rung],
        `${rung} is not rated, so "recoverable" there erases the distinction the word draws`
      ).not.toMatch(carrier);
    }
  });

  it('CFG-39: the text fallback shortens a single-sentence description without doubling the period', async () => {
    const { approvalPostureLines } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    for (const line of approvalPostureLines('assisted')) {
      expect(line).not.toContain('..');
    }
  });

  it('CFG-39: on `write` no posture row claims to be current, so the display stays honest', async () => {
    const { approvalPostureChoices } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(approvalPostureChoices('write').some((c) => c.current)).toBe(false);
  });

  it('CFG-39: the no-arg display carries the selectable list, and drops it for an interactive surface', async () => {
    const { approvalsStatusNotice } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const posture = { rung: 'assisted', allow: [], deny: [] } as any;
    const text = approvalsStatusNotice(posture, { session: 0, always: 0 }).lines.join('\n');
    // The text fallback names every posture and the Write modifier.
    for (const label of ['Manual', 'Assisted', 'Auto', 'Bypass']) expect(text).toContain(label);
    expect(text).toContain('/approvals write');
    // A surface rendering the picker itself does not also print the rows.
    const interactive = approvalsStatusNotice(
      posture,
      { session: 0, always: 0 },
      [],
      [],
      undefined,
      { interactive: true }
    );
    expect(interactive.lines.join('\n')).not.toContain('Choose a mode with');
    // …but it still answers "what am I on", which is the question /approvals has always answered.
    expect(interactive.title).toBe('Approvals: Assisted');
  });

  it('dispatch during a run refuses idle-only commands but allows availableDuringRun ones', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    // /approvals is run-safe → still requests the change mid-turn (EXT-12's reason, generalized:
    // the user must be able to change how the REST of the run is handled).
    for (const line of ['/approvals', '/approvals write', '/approvals bypass']) {
      expect(
        dispatchSlashCommand(parseSlashCommand(line)!, registry, ctx, { duringRun: true }).approvals
      ).toBeDefined();
    }
    // /clear is NOT run-safe → refused with a friendly warn notice, no clear requested.
    const refused = dispatchSlashCommand(parseSlashCommand('/clear')!, registry, ctx, {
      duringRun: true,
    });
    expect(refused.clearTranscript).toBeUndefined();
    expect(refused.notice?.tone).toBe('warn');
    expect(refused.notice?.title).toContain('not available while the agent is working');
  });

  it('/exit requests an app quit', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/exit')!, createCommandRegistry(), ctx);
    expect(result.exit).toBe(true);
  });

  it('/quit is an equal-citizen alias of /exit — quits with no deprecation notice (GS2-8)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/quit')!, createCommandRegistry(), ctx);
    expect(result.exit).toBe(true);
    expect(result.message).toBeUndefined();
    expect(result.notice).toBeUndefined();
  });

  it('/mode is gone (2.0 hard removal) — it now reads as an unknown command (GS2-8)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    expect(registry.some((c) => c.name === 'mode')).toBe(false);
    const result = dispatchSlashCommand(parseSlashCommand('/mode')!, registry, ctx);
    expect(result.notice?.title).toBe('Unknown command: /mode');
    expect(result.notice?.tone).toBe('warn');
  });

  it('/status folds in the old /mode info (mode, model, turns) as one notice (GS2-8)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/status')!,
      createCommandRegistry(),
      ctx
    );
    expect(result.notice?.title).toBe('Session status');
    const joined = result.notice?.lines.join('\n') ?? '';
    expect(joined).toContain('Mode: chat');
    expect(joined).toContain('how the agent handles your messages');
    expect(joined).toContain('Model: claude-opus-4');
    expect(joined).toContain('Turns so far: 3');
  });

  it('/model surfaces the model display name as a notice', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/model')!, createCommandRegistry(), ctx);
    expect(result.notice?.title).toBe('Model: claude-opus-4');
  });

  it('/model falls back to "unknown" when no display name is set', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/model')!, createCommandRegistry(), {
      ...ctx,
      modelDisplayName: '',
    });
    expect(result.notice?.title).toBe('Model: unknown');
  });

  it('an unknown command yields a friendly warn-tone notice, never throws', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/foo')!, createCommandRegistry(), ctx);
    expect(result.notice?.title).toBe('Unknown command: /foo');
    expect(result.notice?.tone).toBe('warn');
    expect(result.notice?.lines.join(' ')).toContain('/help');
    expect(result.exit).toBeUndefined();
  });

  it('registry is a fresh array each call so extensions can append (EXT-5)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    expect(createCommandRegistry()).not.toBe(registry);
    registry.push({
      name: 'ping',
      description: 'extension command',
      run: () => ({ message: 'pong' }),
    });
    const result = dispatchSlashCommand(parseSlashCommand('/ping')!, registry, ctx);
    expect(result.message).toBe('pong');
  });
});

/**
 * EXT-70 §4.7.1 — the `/approvals trust|untrust <server> <hint…>` half of the command: the parse,
 * the usage copy, and the notice that has to state §4.7.4's consequence at the moment trust is
 * withdrawn.
 */
describe('tui/slashCommands /approvals trust (EXT-70 §4.7.1)', () => {
  const load = () => import('@gaunt-sloth/agent/modules/slashCommands.js');

  /** A landed change, with the fail-closed defaults every field of a real one has. */
  const change = (over: Record<string, unknown> = {}) =>
    ({
      server: 'jira',
      configured: true,
      trusted: ['readOnlyHint'],
      added: ['readOnlyHint'],
      removed: [],
      weakening: [],
      invalidates: [],
      ...over,
    }) as never;

  describe('parseApprovalsArg', () => {
    it('parses trust and untrust with one or several hints', async () => {
      const { parseApprovalsArg } = await load();
      expect(parseApprovalsArg(['trust', 'jira', 'readOnlyHint'])).toEqual({
        trust: { server: 'jira', hints: ['readOnlyHint'], believe: true },
      });
      expect(parseApprovalsArg(['untrust', 'jira', 'readOnlyHint', 'openWorldHint'])).toEqual({
        trust: { server: 'jira', hints: ['readOnlyHint', 'openWorldHint'], believe: false },
      });
    });

    /**
     * A hint is matched case-insensitively and echoed in its CANONICAL spelling, because what lands
     * in the policy has to be the name the derivation reads — a lower-cased `readonlyhint` matches
     * nothing and would trust nothing while the notice reported success.
     */
    it('canonicalizes the hint spelling', async () => {
      const { parseApprovalsArg } = await load();
      expect(parseApprovalsArg(['trust', 'jira', 'readonlyhint'])).toEqual({
        trust: { server: 'jira', hints: ['readOnlyHint'], believe: true },
      });
    });

    /**
     * A server key is the user's own `mcpServers` key (§4.7.5) and is case-sensitive: folding it
     * would name a DIFFERENT server, silently. The control is the hint in the same invocation,
     * which IS folded — so this is about the server field and not about nothing being lower-cased.
     */
    it('never folds the case of the server key', async () => {
      const { parseApprovalsArg } = await load();
      expect(parseApprovalsArg(['trust', 'MyJira', 'READONLYHINT'])).toEqual({
        trust: { server: 'MyJira', hints: ['readOnlyHint'], believe: true },
      });
    });

    it('de-duplicates repeated hints', async () => {
      const { parseApprovalsArg } = await load();
      expect(parseApprovalsArg(['trust', 'jira', 'readOnlyHint', 'readOnlyHint'])).toEqual({
        trust: { server: 'jira', hints: ['readOnlyHint'], believe: true },
      });
    });

    it.each([
      [['trust'], 'trust-missing-server'],
      [['untrust', 'jira'], 'trust-missing-hints'],
      [['trust', 'jira', 'notAHint'], 'unknown-hint'],
    ])('reports %j as a usage problem rather than guessing', async (args, kind) => {
      const { parseApprovalsArg } = await load();
      const parsed = parseApprovalsArg(args as string[]);
      expect(parsed).toMatchObject({ usage: { kind } });
    });

    it('still returns null for a first argument that is neither a rung nor a trust verb', async () => {
      const { parseApprovalsArg } = await load();
      expect(parseApprovalsArg(['nonsense'])).toBeNull();
    });

    /**
     * [[EXT-107]] — the removal verb takes the number the list printed. Parsed STRICTLY: this
     * command removes a protection, so a coerced argument would lift a refusal the user did not
     * name. Every rejected spelling is a case here rather than a comment, because "it parses
     * loosely" is invisible until someone lifts the wrong one.
     */
    it('parses undeny with the number the refusal list printed', async () => {
      const { parseApprovalsArg } = await load();
      expect(parseApprovalsArg(['undeny', '2'])).toEqual({ undeny: { index: 2 } });
      expect(parseApprovalsArg(['UNDENY', '2'])).toEqual({ undeny: { index: 2 } });
    });

    it.each([
      [['undeny'], 'undeny-missing-number'],
      [['undeny', 'two'], 'undeny-bad-number'],
      [['undeny', '0'], 'undeny-bad-number'],
      [['undeny', '-1'], 'undeny-bad-number'],
      [['undeny', '1.5'], 'undeny-bad-number'],
      [['undeny', ''], 'undeny-bad-number'],
    ])('refuses to guess at %j', async (args, kind) => {
      const { parseApprovalsArg } = await load();
      expect(parseApprovalsArg(args as string[])).toMatchObject({ usage: { kind } });
    });
  });

  describe('the command itself', () => {
    const ctx = {
      mode: 'chat',
      modelDisplayName: 'test-model',
      turnCount: 0,
      toolsExpanded: false,
      debugVisible: false,
    };

    it('asks the surface to apply a well-formed trust change', async () => {
      const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } = await load();
      const result = dispatchSlashCommand(
        parseSlashCommand('/approvals untrust jira openWorldHint')!,
        createCommandRegistry(),
        ctx as never
      );
      expect(result.approvals).toEqual({
        trust: { server: 'jira', hints: ['openWorldHint'], believe: false },
      });
    });

    /**
     * A malformed invocation changes NOTHING, so it never reaches the surface — it answers on its
     * own with copy naming the vocabulary. The `approvals` assertion is the one that matters: a
     * result carrying both would have the surface apply a request the parse rejected.
     */
    it('answers a malformed invocation itself, asking the surface for nothing', async () => {
      const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } = await load();
      const result = dispatchSlashCommand(
        parseSlashCommand('/approvals trust jira nope')!,
        createCommandRegistry(),
        ctx as never
      );
      expect(result.approvals).toBeUndefined();
      expect(result.notice?.tone).toBe('warn');
      expect(result.notice?.lines.join(' ')).toContain('readOnlyHint');
    });

    /**
     * [[EXT-107]] — a well-formed `undeny` reaches the SURFACE, because only the runner knows which
     * refusal a number names. A command that answered it here would be guessing at a list it cannot
     * see.
     */
    it('hands a well-formed undeny to the surface', async () => {
      const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } = await load();
      const result = dispatchSlashCommand(
        parseSlashCommand('/approvals undeny 3')!,
        createCommandRegistry(),
        ctx as never
      );
      expect(result.approvals).toEqual({ undeny: { index: 3 } });
      expect(result.notice).toBeUndefined();
    });

    /**
     * ...and a malformed one changes nothing and never reaches the surface. The `approvals`
     * assertion is the one that matters: a result carrying both would have the surface lift
     * something off an argument the parse rejected.
     */
    it('answers a malformed undeny itself, asking the surface for nothing', async () => {
      const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } = await load();
      const result = dispatchSlashCommand(
        parseSlashCommand('/approvals undeny banana')!,
        createCommandRegistry(),
        ctx as never
      );
      expect(result.approvals).toBeUndefined();
      expect(result.notice?.tone).toBe('warn');
      expect(result.notice?.lines.join(' ')).toContain('Nothing was changed');
    });

    it('is available mid-turn, like the rest of /approvals', async () => {
      const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } = await load();
      expect(
        dispatchSlashCommand(
          parseSlashCommand('/approvals trust jira readOnlyHint')!,
          createCommandRegistry(),
          ctx as never,
          { duringRun: true }
        ).approvals
      ).toBeDefined();
    });
  });

  /**
   * [[EXT-107]] — the refusal list is the escape hatch from a refusal that now outlives the session,
   * so what it must carry is not a count but, per line, the list that HOLDS the refusal and the
   * number that lifts it.
   */
  describe('approvalsRefusalsNotice', () => {
    const refusal = (over: Record<string, unknown>) =>
      ({
        index: 1,
        description: 'npm publish',
        origin: 'persisted',
        ...over,
      }) as never;

    it('is absent when nothing is refused, so an ordinary session says nothing about refusals', async () => {
      const { approvalsRefusalsNotice } = await load();
      expect(approvalsRefusalsNotice([])).toBeNull();
    });

    /**
     * The three origins, in one assertion, because the whole point is that they read DIFFERENTLY.
     * A rendering that labelled them alike would pass any test that checked only one.
     */
    it('says which list holds each refusal, and names the command that lifts one', async () => {
      const { approvalsRefusalsNotice } = await load();
      const notice = approvalsRefusalsNotice([
        refusal({ index: 1, description: 'npm publish', origin: 'config' }),
        refusal({ index: 2, description: 'git push --force', origin: 'persisted' }),
        refusal({ index: 3, description: 'rm -rf dist', origin: 'session' }),
      ])!;
      expect(notice.title).toBe('Refused calls: 3');
      const lines = notice.lines;
      expect(lines[0]).toContain('1. npm publish — from your approvals.deny');
      expect(lines[1]).toContain('2. git push --force — saved to this project');
      expect(lines[2]).toContain('3. rm -rf dist — this session only');
      expect(lines.join(' ')).toContain('/approvals undeny <number>');
    });

    /**
     * The overflow has to stay WALKABLE. A cap that simply hid the rest would put refusals beyond
     * reach of the only control that reaches them, so the line says they come back into the list as
     * the ones above are lifted — which is true because the numbering is a deterministic order.
     */
    it('summarises the overflow as reachable rather than hidden', async () => {
      const { approvalsRefusalsNotice } = await load();
      const many = Array.from({ length: 12 }, (_, index) =>
        refusal({ index: index + 1, description: `cmd-${index + 1}` })
      );
      const notice = approvalsRefusalsNotice(many)!;
      expect(notice.title).toBe('Refused calls: 12');
      expect(
        notice.lines.filter((line) => line.startsWith('  ') && /cmd-/u.test(line))
      ).toHaveLength(10);
      expect(notice.lines.join(' ')).toContain(
        '…and 2 more, which appear here as the ones above are lifted.'
      );
    });
  });

  /**
   * [[EXT-107]] — the notice is built from what the runner RETURNS, so it can only describe the
   * refusal actually lifted.
   */
  describe('approvalsUndenyNotice', () => {
    it('reports a saved refusal as gone from the project, not merely from this session', async () => {
      const { approvalsUndenyNotice } = await load();
      const notice = approvalsUndenyNotice({
        outcome: 'lifted',
        description: 'npm publish',
        origin: 'persisted',
        stillConfigured: false,
      });
      expect(notice.title).toBe('Refusal lifted');
      expect(notice.lines.join(' ')).toContain('will not come back in a new session');
      expect(notice.tone).toBe('info');
    });

    /**
     * The case a plain "removed" would misreport: still refused, by a line in the user's own config.
     * Telling them they had opened something that is still closed is the failure the escalation
     * menu is written to avoid, one layer up — so this one is `warn`, not `info`.
     */
    it('says when the config the user wrote still refuses the lifted call', async () => {
      const { approvalsUndenyNotice } = await load();
      const notice = approvalsUndenyNotice({
        outcome: 'lifted',
        description: 'npm publish',
        origin: 'persisted',
        stillConfigured: true,
      });
      expect(notice.lines.join(' ')).toContain('still matches it');
      expect(notice.tone).toBe('warn');
    });

    it('points a configured entry at the file it lives in, and says nothing changed', async () => {
      const { approvalsUndenyNotice } = await load();
      const notice = approvalsUndenyNotice({ outcome: 'configured', description: 'npm publish' });
      expect(notice.lines.join(' ')).toContain('approvals.deny');
      expect(notice.lines.join(' ')).toContain('Nothing was changed');
      expect(notice.tone).toBe('warn');
    });

    it('explains a number that names no refusal, and the empty case separately', async () => {
      const { approvalsUndenyNotice } = await load();
      expect(
        approvalsUndenyNotice({ outcome: 'unknown', index: 7, count: 2 }).lines.join(' ')
      ).toContain('The list has 2');
      expect(
        approvalsUndenyNotice({ outcome: 'unknown', index: 1, count: 0 }).lines.join(' ')
      ).toContain('Nothing is refused right now');
    });
  });

  describe('approvalsTrustNotice', () => {
    it('names what is now believed, and stays session-scoped', async () => {
      const { approvalsTrustNotice } = await load();
      const notice = approvalsTrustNotice(change());
      expect(notice.title).toContain('jira');
      const body = notice.lines.join(' ');
      expect(body).toContain('Now believing from jira: readOnlyHint');
      expect(body).toContain('Believed from jira: readOnlyHint');
      expect(body).toContain('Session-scoped only');
      expect(notice.tone).toBe('info');
    });

    /**
     * §2(c) — **the consequence is stated where trust is withdrawn**, not only in the notice that
     * arrives at the next call. A user who withdraws belief and then finds their saved approvals
     * gone has been surprised by the correct behaviour, which is how correct behaviour gets
     * reported as a bug.
     */
    it('says the saved approvals will go, and names them where it can', async () => {
      const { approvalsTrustNotice } = await load();
      const notice = approvalsTrustNotice(
        change({
          trusted: [],
          added: [],
          removed: ['readOnlyHint'],
          weakening: ['readOnlyHint'],
          invalidates: ['mcpTool jira/search'],
        })
      );
      const body = notice.lines.join(' ');
      expect(body).toContain('withdrawn the next time that tool is called');
      expect(body).toContain('mcpTool jira/search');
      expect(notice.tone, 'a withdrawal that costs approvals is not an info notice').toBe('warn');
    });

    /**
     * Where nothing visible is weakened it states the RULE rather than naming grants — promising a
     * specific withdrawal that then does not happen teaches the user to disbelieve the notice.
     */
    it('states the rule when it can see no grant to name', async () => {
      const { approvalsTrustNotice } = await load();
      const body = approvalsTrustNotice(
        change({
          trusted: [],
          added: [],
          removed: ['openWorldHint'],
          weakening: ['openWorldHint'],
          invalidates: [],
        })
      ).lines.join(' ');
      expect(body).toContain('any saved approval for jira');
      expect(body).toContain('is withdrawn the next time that tool is called');
    });

    /**
     * The negative, with its control below: a change that weakens nothing must not warn about
     * approvals going, or the warning becomes noise on every `/approvals trust` and stops being
     * read. `idempotentHint` is the one hint whose withdrawal is not a weakening.
     */
    it('says nothing about withdrawn approvals when nothing weakened', async () => {
      const { approvalsTrustNotice } = await load();
      const notice = approvalsTrustNotice(
        change({ trusted: [], added: [], removed: ['idempotentHint'], weakening: [] })
      );
      const body = notice.lines.join(' ');
      expect(body).not.toContain('withdrawn');
      expect(notice.tone).toBe('info');
      // CONTROL: the withdrawal itself IS reported, so the absence above is about the invalidation
      // line and not about the notice having said nothing at all.
      expect(body).toContain('No longer believing from jira: idempotentHint');
    });

    it('warns when the key names no configured server, without refusing it', async () => {
      const { approvalsTrustNotice } = await load();
      const unknown = approvalsTrustNotice(change({ configured: false })).lines.join(' ');
      expect(unknown).toContain('no server is configured under the key "jira"');
      // CONTROL: a configured key gets no such line.
      expect(approvalsTrustNotice(change()).lines.join(' ')).not.toContain(
        'no server is configured'
      );
    });

    it('says so plainly when the request changed nothing', async () => {
      const { approvalsTrustNotice } = await load();
      expect(approvalsTrustNotice(change({ added: [], removed: [] })).lines.join(' ')).toContain(
        'Nothing changed'
      );
    });
  });

  describe('the /approvals display', () => {
    const posture = {
      rung: 'assisted',
      rater: undefined,
      allow: [],
      deny: [],
      escalate: [],
    } as never;

    it('lists each grant with when it was made and the annotations it was made under', async () => {
      const { approvalsStatusNotice } = await load();
      const body = approvalsStatusNotice(
        posture,
        { session: 1, always: 0 },
        [],
        [
          {
            entry: { type: 'mcpTool', server: 'jira', matcher: 'exact', pattern: 'search' },
            scope: 'session',
            grantedAt: '2026-08-02T09:16:00.000Z',
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
        ] as never,
        { defaults: [], servers: [{ server: 'jira', trusted: ['readOnlyHint'], configured: true }] }
      ).lines.join(' ');
      expect(body).toContain('mcpTool jira/search');
      expect(body).toContain('2026-08-02T09:16:00.000Z');
      expect(body).toContain('readOnlyHint=true');
      expect(body).toContain('openWorldHint=false');
      expect(body).toContain('MCP annotations believed: defaults — nothing · jira — readOnlyHint');
    });

    /**
     * A server that believes nothing is still listed: "believes nothing" and "this server is not
     * here at all" look identical when only trusted servers appear, and the second is what a typo
     * produces.
     */
    it('lists a server that believes nothing rather than omitting it', async () => {
      const { approvalsStatusNotice } = await load();
      const body = approvalsStatusNotice(posture, { session: 0, always: 0 }, [], [], {
        defaults: [],
        servers: [{ server: 'jira', trusted: [], configured: true }],
      }).lines.join(' ');
      expect(body).toContain('jira — nothing');
    });

    /**
     * §4.7.4 — **the heading may not claim a scope the list does not have.** `getGrants` reports the
     * persisted store's `always` grants next to this session's, and an `always` grant was made in
     * whatever session the user made it in, which is usually not this one. A heading that said
     * "this session" would be a plain falsehood about every persisted line under it, and the display
     * is fed pre-rendered here, so nothing else in the suite would notice.
     *
     * Asserted on the heading LINE, not on the joined body: the allow/deny line legitimately says
     * "this session" about the counts, so a body-wide search for the phrase could not tell a true
     * use from a false one.
     */
    it('does not call a remembered grant one made this session', async () => {
      const { approvalsStatusNotice } = await load();
      const lines = approvalsStatusNotice(posture, { session: 0, always: 1 }, [], [
        {
          entry: { type: 'mcpTool', server: 'jira', matcher: 'exact', pattern: 'search' },
          scope: 'always',
          grantedAt: '2026-07-14T11:02:00.000Z',
        },
      ] as never).lines;
      const heading = lines.find((line) => line.endsWith('Granted approvals:'));
      expect(heading, 'the grant block is headed').toBeDefined();
      expect(heading, 'a persisted grant was not granted this session').not.toContain(
        'this session'
      );
      // CONTROL: the line itself still says which session it belongs to and when it was made — the
      // heading drops the claim because the per-line answer is the true one, not because it is gone.
      expect(lines.join(' ')).toContain('always, granted 2026-07-14T11:02:00.000Z');
    });

    it('says nothing about grants when there are none', async () => {
      const { approvalsStatusNotice } = await load();
      const body = approvalsStatusNotice(posture, { session: 0, always: 0 }).lines.join(' ');
      expect(body).not.toContain('Granted approvals');
      // CONTROL: the display still rendered, so the absence is about the grant block.
      expect(body).toContain('Auto-rater:');
    });
  });
});

describe('tui/slashCommands /config (GS2-1 read-only)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('surfaces the pre-rendered config summary as a notice', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/config')!, createCommandRegistry(), {
      ...ctx,
      configSummary: ['Model: claude-x', 'Agent backend: lean'],
    });
    expect(result.notice?.title).toBe('Resolved configuration');
    expect(result.notice?.lines).toEqual(['Model: claude-x', 'Agent backend: lean']);
  });

  it('shows an "unavailable" line when no summary is present (e.g. fixture agent)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/config')!,
      createCommandRegistry(),
      ctx
    );
    expect(result.notice?.lines.join(' ')).toContain('not available');
  });

  it('is listed in the registry (so it appears in the /help + / menu)', async () => {
    const { createCommandRegistry } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(createCommandRegistry().some((c) => c.name === 'config')).toBe(true);
  });

  // TUI-C19 — /config renders the actual validation warnings the standing advisory line points at.
  it('renders the config-validation warnings above the summary when present (TUI-C19)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const warning =
      'Unknown top-level config key in .gsloth.config.json: pullrequest. It is kept as-is but ignored by Gaunt Sloth; check for typos.';
    const result = dispatchSlashCommand(parseSlashCommand('/config')!, createCommandRegistry(), {
      ...ctx,
      configSummary: ['Model: claude-x', 'Agent backend: lean'],
      configWarnings: [warning],
    });
    const joined = result.notice?.lines.join('\n') ?? '';
    // The actual warning text is shown (not just the resolved summary)…
    expect(joined).toContain('pullrequest');
    expect(joined).toContain('check for typos');
    expect(joined).toContain('Config warning');
    // …and the resolved summary still follows it.
    expect(joined).toContain('Model: claude-x');
    // Warnings present ⇒ caution tone.
    expect(result.notice?.tone).toBe('warn');
  });

  it('shows NO warnings and no warn tone when the config is clean (TUI-C19)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/config')!, createCommandRegistry(), {
      ...ctx,
      configSummary: ['Model: claude-x', 'Agent backend: lean'],
      configWarnings: [],
    });
    expect(result.notice?.lines).toEqual(['Model: claude-x', 'Agent backend: lean']);
    expect(result.notice?.lines.join('\n')).not.toContain('Config warning');
    expect(result.notice?.tone).toBeUndefined();
  });
});

describe('tui/slashCommands formatConfigSummary (GS2-1)', () => {
  it('summarizes the orienting resolved-config fields, secret-free', async () => {
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const lines = formatConfigSummary({
      modelDisplayName: 'gpt-5.5',
      agent: { backend: 'lean' },
      filesystem: 'all',
      streamOutput: true,
      useColour: false,
      commands: { pr: {}, review: {}, code: {} },
    });
    const joined = lines.join('\n');
    expect(joined).toContain('Model: gpt-5.5');
    expect(joined).toContain('Agent backend: lean');
    expect(joined).toContain('Filesystem: all');
    expect(joined).toContain('Commands configured: pr, review, code');
    expect(joined).toContain('gth config print');
  });

  it('defaults the agent backend to lean and the model to unknown when absent', async () => {
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const lines = formatConfigSummary({});
    expect(lines.join('\n')).toContain('Model: unknown');
    expect(lines.join('\n')).toContain('Agent backend: lean');
  });

  it('renders an array filesystem policy as JSON', async () => {
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const lines = formatConfigSummary({ filesystem: ['./src', './docs'] });
    expect(lines.join('\n')).toContain('Filesystem: ["./src","./docs"]');
  });

  // CFG-25 — the panel must print the EFFECTIVE per-command filesystem (GS2-60 bakes it into
  // config.commands[command]), never the top-level default alone: `Filesystem: none` in a default
  // `code` session understated the session's actual `all` access.
  it('shows the effective per-command filesystem (all, not none) in a default-config code session (CFG-25)', async () => {
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    // Shape of the resolved default config: top-level 'none', per-command values baked by GS2-60.
    const lines = formatConfigSummary(
      {
        filesystem: 'none',
        commands: { code: { filesystem: 'all' }, chat: { filesystem: 'read' } },
      },
      'code'
    );
    const fsLine = lines.find((l) => l.startsWith('Filesystem:'));
    expect(fsLine).toBeDefined();
    expect(fsLine).toContain('all');
    expect(fsLine).not.toMatch(/^Filesystem: none/);
  });

  it('renders both values as `effective (command; top-level: X)` when they differ (CFG-25)', async () => {
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const lines = formatConfigSummary(
      {
        filesystem: 'none',
        commands: { code: { filesystem: 'all' } },
      },
      'code'
    );
    expect(lines).toContain('Filesystem: all (code; top-level: none)');
  });

  it('renders a single plain value when the effective and top-level values agree (CFG-25)', async () => {
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const lines = formatConfigSummary(
      {
        filesystem: 'read',
        commands: { chat: { filesystem: 'read' } },
      },
      'chat'
    );
    expect(lines).toContain('Filesystem: read');
    expect(lines.join('\n')).not.toContain('top-level');
  });

  it('falls back to the top-level value when the command has no filesystem entry (CFG-25)', async () => {
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const lines = formatConfigSummary({ filesystem: 'read', commands: { chat: {} } }, 'chat');
    expect(lines).toContain('Filesystem: read');
  });

  it('compares formatted renderings, so an array command value vs a string top-level counts as differing (CFG-25)', async () => {
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const lines = formatConfigSummary(
      { filesystem: 'none', commands: { code: { filesystem: ['./src'] } } },
      'code'
    );
    expect(lines).toContain('Filesystem: ["./src"] (code; top-level: none)');
  });

  // CFG-25 fix round 1 — the live-bug regression vector, with the fixture DERIVED from the real
  // resolution instead of hand-built: run `resolveConfig({}, {})` (the exact default merge a real
  // session performs; GS2-60 bakes per-command precedence into `commands.*`) and assert the panel
  // renders code's effective `all` over the top-level `none`. If the panel ever reads the raw
  // top-level value again, THIS reproduces the shipped bug.
  it('renders `all (code; top-level: none)` from the REAL resolveConfig default output (CFG-25)', async () => {
    const { resolveConfig } = await import('@gaunt-sloth/core/config/loader.js');
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const resolved = resolveConfig({} as never, {});
    const lines = formatConfigSummary(resolved as never, 'code');
    expect(lines).toContain('Filesystem: all (code; top-level: none)');
  });
});

describe('tui/slashCommands /reasoning (TUI-C18 recall a turn’s thinking)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // Fixture where a LATER turn lacks reasoning, so "no-arg = most recent WITH reasoning" is a real
  // assertion (turn 3, not the newest turn 4). Index 0 = turn 1.
  const reasonings = ['A thought', '', 'C thought', ''];

  it('is listed in the registry (so it appears in /help + the / menu) and is run-safe', async () => {
    const { createCommandRegistry } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const cmd = createCommandRegistry().find((c) => c.name === 'reasoning');
    expect(cmd).toBeDefined();
    expect(cmd?.availableDuringRun).toBe(true);
  });

  it('no arg resolves to the most recent turn that HAS reasoning (turn 3, skipping the empty turn 4)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/reasoning')!, createCommandRegistry(), {
      ...ctx,
      turnReasonings: reasonings,
    });
    expect(result.reprintReasoning).toEqual({ reasoning: 'C thought', turnNumber: 3 });
    expect(result.notice).toBeUndefined();
  });

  it('/reasoning <n> resolves to that 1-based turn', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/reasoning 1')!,
      createCommandRegistry(),
      { ...ctx, turnReasonings: reasonings }
    );
    expect(result.reprintReasoning).toEqual({ reasoning: 'A thought', turnNumber: 1 });
  });

  it('a turn with no thinking gives a friendly info notice, not a reprint', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/reasoning 2')!,
      createCommandRegistry(),
      { ...ctx, turnReasonings: reasonings }
    );
    expect(result.reprintReasoning).toBeUndefined();
    expect(result.notice?.title).toBe('Turn 2 has no thinking');
    expect(result.notice?.tone).toBeUndefined(); // info
  });

  it('an out-of-range <n> gives a warn notice (never throws / mis-indexes)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    const withReasonings = { ...ctx, turnReasonings: reasonings };
    for (const n of ['5', '0', '-1', 'abc']) {
      const result = dispatchSlashCommand(
        parseSlashCommand(`/reasoning ${n}`)!,
        registry,
        withReasonings
      );
      expect(result.reprintReasoning).toBeUndefined();
      expect(result.notice?.tone).toBe('warn');
      expect(result.notice?.title).toContain(`No turn ${n}`);
    }
  });

  it('no committed reasoning anywhere gives the "nothing to show" notice', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    // Empty transcript.
    const none = dispatchSlashCommand(parseSlashCommand('/reasoning')!, registry, {
      ...ctx,
      turnReasonings: [],
    });
    expect(none.reprintReasoning).toBeUndefined();
    expect(none.notice?.title).toBe('No thinking to show');
    // Turns exist but none recorded thinking.
    const allEmpty = dispatchSlashCommand(parseSlashCommand('/reasoning')!, registry, {
      ...ctx,
      turnReasonings: ['', ''],
    });
    expect(allEmpty.notice?.title).toBe('No thinking to show');
  });

  it('stays run-safe: it still resolves during inference', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/reasoning')!,
      createCommandRegistry(),
      { ...ctx, turnReasonings: reasonings },
      { duringRun: true }
    );
    expect(result.reprintReasoning).toEqual({ reasoning: 'C thought', turnNumber: 3 });
  });
});

describe('tui/slashCommands /debug-dump (GS2-46)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls the injected dumpDebugSession with redact ON by default and renders the path + softened redacted note (GS2-47)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const dumpDebugSession = vi.fn().mockReturnValue({
      archiveDir: '/home/user/.gsloth/debug-dumps/2026-07-18T12-00-00-000Z',
    });
    const fakeTranscript = [{ kind: 'user', id: 1, text: 'hi' }];
    const fakeConfig = { modelDisplayName: 'claude-opus-4' };

    const result = dispatchSlashCommand(
      parseSlashCommand('/debug-dump')!,
      createCommandRegistry(),
      {
        ...ctx,
        transcript: fakeTranscript,
        resolvedConfig: fakeConfig,
        dumpDebugSession,
      }
    );

    // GS2-47 — with no `debugDump.redact` and no `--unsafe-no-redact`, redaction defaults ON.
    expect(dumpDebugSession).toHaveBeenCalledWith({
      transcript: fakeTranscript,
      config: fakeConfig,
      modelDisplayName: ctx.modelDisplayName,
      redact: true,
    });

    // The default is now REDACTED: the notice carries the path + a softened "secrets redacted"
    // note (still review-before-sharing), NOT the loud UNSANITIZED warning, and no warn tone.
    const allText = [result.notice?.title, ...(result.notice?.lines ?? [])].join('\n');
    expect(allText).toContain('/home/user/.gsloth/debug-dumps/2026-07-18T12-00-00-000Z');
    expect(allText.toLowerCase()).toContain('redacted');
    expect(allText.toLowerCase()).toContain('review before sharing');
    expect(allText.toLowerCase()).not.toContain('unsanitized');
    expect(result.notice?.tone).toBeUndefined();
  });

  it('opts OUT via config `debugDump.redact: false` — passes redact:false AND fires the loud UNSANITIZED warning', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const dumpDebugSession = vi.fn().mockReturnValue({ archiveDir: '/tmp/raw-dump' });

    const result = dispatchSlashCommand(
      parseSlashCommand('/debug-dump')!,
      createCommandRegistry(),
      {
        ...ctx,
        resolvedConfig: { debugDump: { redact: false } },
        dumpDebugSession,
      }
    );

    expect(dumpDebugSession).toHaveBeenCalledWith(
      expect.objectContaining({ config: { debugDump: { redact: false } }, redact: false })
    );
    // The loud warning fires (both the path and the "unsanitized/secrets" caution, warn tone).
    const allText = [result.notice?.title, ...(result.notice?.lines ?? [])].join('\n');
    expect(allText.toLowerCase()).toContain('unsanitized');
    expect(allText.toLowerCase()).toContain('secrets');
    expect(result.notice?.tone).toBe('warn');
  });

  it('opts OUT via the `--unsafe-no-redact` command flag — passes redact:false and the loud warning', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const dumpDebugSession = vi.fn().mockReturnValue({ archiveDir: '/tmp/raw-dump' });

    const result = dispatchSlashCommand(
      parseSlashCommand('/debug-dump --unsafe-no-redact')!,
      createCommandRegistry(),
      { ...ctx, resolvedConfig: { modelDisplayName: 'm' }, dumpDebugSession }
    );

    expect(dumpDebugSession).toHaveBeenCalledWith(expect.objectContaining({ redact: false }));
    expect(result.notice?.title.toLowerCase()).toContain('unsanitized');
    expect(result.notice?.tone).toBe('warn');
  });

  it('defaults transcript to [] and passes through an undefined resolvedConfig (redact still ON) when the context omits them', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const dumpDebugSession = vi.fn().mockReturnValue({ archiveDir: '/tmp/whatever' });

    dispatchSlashCommand(parseSlashCommand('/debug-dump')!, createCommandRegistry(), {
      ...ctx,
      dumpDebugSession,
    });

    // Any uncertainty (no resolvedConfig) defaults to redacting — fail safe.
    expect(dumpDebugSession).toHaveBeenCalledWith({
      transcript: [],
      config: undefined,
      modelDisplayName: ctx.modelDisplayName,
      redact: true,
    });
  });

  it('reports itself unavailable (never throws) when no dumpDebugSession writer is injected', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/debug-dump')!,
      createCommandRegistry(),
      ctx // fixture-style context: no dumpDebugSession
    );
    expect(result.notice?.title).toBe('Debug dump unavailable');
    expect(result.notice?.lines.join(' ')).toContain('No debug-dump writer is available');
  });

  it('stays run-safe: it is dispatchable while a turn is streaming', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const dumpDebugSession = vi.fn().mockReturnValue({ archiveDir: '/tmp/mid-turn-dump' });
    const result = dispatchSlashCommand(
      parseSlashCommand('/debug-dump')!,
      createCommandRegistry(),
      { ...ctx, dumpDebugSession },
      { duringRun: true }
    );
    expect(dumpDebugSession).toHaveBeenCalled();
    expect(result.notice?.title).toContain('Debug dump written');
  });

  it('is listed in /help', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    const result = dispatchSlashCommand(parseSlashCommand('/help')!, registry, ctx);
    expect(result.notice?.lines.some((l) => l.startsWith('/debug-dump —'))).toBe(true);
  });
});

describe('tui/slashCommands slashMenuQuery (TUI-C10 menu trigger)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the lower-cased query after the slash for a bare in-progress command', async () => {
    const { slashMenuQuery } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(slashMenuQuery('/')).toBe('');
    expect(slashMenuQuery('/mo')).toBe('mo');
    expect(slashMenuQuery('/MODE')).toBe('mode');
  });

  it('returns null for non-slash input or once a space begins the args', async () => {
    const { slashMenuQuery } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(slashMenuQuery('')).toBeNull();
    expect(slashMenuQuery('hello')).toBeNull();
    expect(slashMenuQuery(' /model')).toBeNull(); // leading space: not a trigger
    expect(slashMenuQuery('/model ')).toBeNull(); // space started args -> menu closes
    expect(slashMenuQuery('/model foo')).toBeNull();
  });

  it('a pasted path never triggers the menu — mirrors the /-vs-path heuristic (GS2-8)', async () => {
    const { slashMenuQuery } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    expect(slashMenuQuery('/usr/bin')).toBeNull();
    expect(slashMenuQuery('/usr/home/bob/test.md')).toBeNull();
  });
});

describe('tui/slashCommands filterSlashCommands (TUI-C10 menu filter)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('an empty query returns the whole registry (bare "/" lists everything)', async () => {
    const { createCommandRegistry, filterSlashCommands } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    const all = filterSlashCommands(registry, '');
    expect(all.map((c) => c.name)).toEqual(registry.map((c) => c.name));
    expect(all).not.toBe(registry); // a copy, never the live array
  });

  it('filters by prefix, case-insensitively', async () => {
    const { createCommandRegistry, filterSlashCommands } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    // `mo` is a genuine prefix of both /mouse and /model; registry order decides which comes first.
    expect(filterSlashCommands(registry, 'mo').map((c) => c.name)).toEqual(['mouse', 'model']);
    expect(filterSlashCommands(registry, 'MODEL').map((c) => c.name)).toEqual(['model']);
    expect(filterSlashCommands(registry, 'model').map((c) => c.name)).toEqual(['model']);
  });

  it('ranks prefix matches ahead of looser substring matches', async () => {
    const { filterSlashCommands } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry: SlashCommand[] = [
      { name: 'compare', description: '', run: () => ({}) },
      { name: 'clear', description: '', run: () => ({}) },
    ];
    // "c" prefixes both; "lea" only substrings inside "clear".
    expect(filterSlashCommands(registry, 'lea').map((c) => c.name)).toEqual(['clear']);
    // A query matching a prefix on one and a substring on another puts the prefix first.
    const mixed: SlashCommand[] = [
      { name: 'xray', description: '', run: () => ({}) }, // substring 'ra'
      { name: 'range', description: '', run: () => ({}) }, // prefix 'ra'
    ];
    expect(filterSlashCommands(mixed, 'ra').map((c) => c.name)).toEqual(['range', 'xray']);
  });

  it('includes extension-registered commands automatically (no hardcoded list)', async () => {
    const { createCommandRegistry, filterSlashCommands } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    registry.push({ name: 'ping', description: 'extension command', run: () => ({}) });
    expect(filterSlashCommands(registry, 'pi').map((c) => c.name)).toEqual(['ping']);
    expect(filterSlashCommands(registry, '').map((c) => c.name)).toContain('ping');
  });
});

describe('readline/TUI registry parity (GS2-8 single source of truth)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('the TUI consumes the ONE agent registry (no app-side registry can exist)', async () => {
    // Until GS2-2 (B4) the TUI reached the registry through an app-side re-export shim
    // (`src/tui/slashCommands.ts`), and this test compared the two import paths for function
    // identity. The shim is deleted, so only one import path is left; what remains to prove is
    // that no app-local slash-command module has re-grown for a TUI-side fork to hide in —
    // the agent module the readline (`--no-tui`) session dispatches through is the single
    // source of truth the TUI's `createCommandRegistry()` call resolves to.
    const appLocalModule = new URL('../../src/tui/slashCommands.ts', import.meta.url);
    expect(existsSync(appLocalModule)).toBe(false);
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    // The one registry is real and complete: the factory and dispatch/parse seam the TUI
    // imports are live functions producing a non-empty, duplicate-free command set.
    expect(typeof dispatchSlashCommand).toBe('function');
    expect(typeof parseSlashCommand).toBe('function');
    const names = createCommandRegistry().map((c) => c.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('the renamed/added commands are all present exactly once', async () => {
    const { createCommandRegistry } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const names = createCommandRegistry().map((c) => c.name);
    for (const expected of ['verbose', 'quit', 'exit', 'status', 'help']) {
      expect(names.filter((n) => n === expected)).toHaveLength(1);
    }
    expect(names).not.toContain('mode');
    expect(names).not.toContain('tools');
  });
});
