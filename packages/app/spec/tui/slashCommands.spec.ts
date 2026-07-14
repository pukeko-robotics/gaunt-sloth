import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommand, SlashCommandContext } from '#src/tui/slashCommands.js';

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
    const { parseSlashCommand } = await import('#src/tui/slashCommands.js');
    expect(parseSlashCommand('hello world')).toBeNull();
    expect(parseSlashCommand('  not a command')).toBeNull();
  });

  it('returns null for a bare slash', async () => {
    const { parseSlashCommand } = await import('#src/tui/slashCommands.js');
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('  /   ')).toBeNull();
  });

  it('parses the command name (lower-cased) and args', async () => {
    const { parseSlashCommand } = await import('#src/tui/slashCommands.js');
    expect(parseSlashCommand('/Help')).toEqual({ name: 'help', args: [] });
    expect(parseSlashCommand('  /mode  foo bar ')).toEqual({ name: 'mode', args: ['foo', 'bar'] });
  });
});

describe('tui/slashCommands dispatchSlashCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('/help renders a notice listing every registered command', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const registry = createCommandRegistry();
    const result = dispatchSlashCommand(parseSlashCommand('/help')!, registry, ctx);
    expect(result.notice?.title).toBe('Slash commands');
    for (const c of registry) {
      expect(result.notice?.lines).toContain(`/${c.name} — ${c.description}`);
    }
  });

  it('/clear requests a transcript clear (banner is the visible feedback)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/clear')!, createCommandRegistry(), ctx);
    expect(result.clearTranscript).toBe(true);
  });

  it('/debug requests a debug-panel toggle with a state-aware notice (showing when hidden)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
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
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/debug')!, createCommandRegistry(), {
      ...ctx,
      debugVisible: true,
    });
    expect(result.notice?.title).toBe('Debug panel: hidden');
    expect(result.notice?.lines[0]).toContain('closed');
  });

  it('/tools requests a toggle with the ON notice when detail is currently off', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/tools')!, createCommandRegistry(), {
      ...ctx,
      toolsExpanded: false,
    });
    expect(result.toggleTools).toBe(true);
    expect(result.notice?.title).toBe('Tool details: on');
    expect(result.notice?.lines[0]).toContain('full inputs and results');
    expect(result.exit).toBeUndefined();
  });

  it('/tools reports the OFF notice when detail is currently on', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/tools')!, createCommandRegistry(), {
      ...ctx,
      toolsExpanded: true,
    });
    expect(result.notice?.title).toBe('Tool details: off');
    expect(result.notice?.lines[0]).toContain('single summary line');
  });

  it('/auto-approve with no arg requests a toggle (App owns the runner flag + state-aware notice)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/auto-approve')!,
      createCommandRegistry(),
      ctx
    );
    // The command is pure: it only requests the change; the App applies the runner flag and commits
    // the notice for the resulting state (the command can't read the flag).
    expect(result.autoApprove).toBe('toggle');
    expect(result.notice).toBeUndefined();
    expect(result.exit).toBeUndefined();
  });

  it('/auto-approve on|off request explicit states; an unknown arg returns a usage notice', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const registry = createCommandRegistry();
    expect(
      dispatchSlashCommand(parseSlashCommand('/auto-approve on')!, registry, ctx).autoApprove
    ).toBe('on');
    expect(
      dispatchSlashCommand(parseSlashCommand('/auto-approve off')!, registry, ctx).autoApprove
    ).toBe('off');
    const bad = dispatchSlashCommand(parseSlashCommand('/auto-approve maybe')!, registry, ctx);
    expect(bad.autoApprove).toBeUndefined();
    expect(bad.notice?.tone).toBe('warn');
    expect(bad.notice?.title).toContain('maybe');
  });

  it('/yolo remains a back-compat alias that requests a toggle', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/yolo')!, createCommandRegistry(), ctx);
    expect(result.autoApprove).toBe('toggle');
  });

  it('autoApproveNotice copy: ON is warn-tone and mentions the hardline floor; OFF is info', async () => {
    const { autoApproveNotice } = await import('#src/tui/slashCommands.js');
    const on = autoApproveNotice(true);
    expect(on.title).toContain('Auto-approve ON');
    expect(on.tone).toBe('warn');
    expect(on.lines.join(' ')).toContain('hardline');
    const off = autoApproveNotice(false);
    expect(off.title).toContain('Auto-approve OFF');
    expect(off.tone).toBeUndefined();
  });

  it('dispatch during a run refuses idle-only commands but allows availableDuringRun ones', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const registry = createCommandRegistry();
    // /auto-approve is run-safe → still requests the change mid-turn.
    expect(
      dispatchSlashCommand(parseSlashCommand('/auto-approve on')!, registry, ctx, {
        duringRun: true,
      }).autoApprove
    ).toBe('on');
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
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/exit')!, createCommandRegistry(), ctx);
    expect(result.exit).toBe(true);
  });

  it('/mode surfaces the current mode as a notice', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/mode')!, createCommandRegistry(), ctx);
    expect(result.notice?.title).toBe('Session mode: chat');
    expect(result.notice?.lines.length).toBeGreaterThan(0);
  });

  it('/model surfaces the model display name as a notice', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/model')!, createCommandRegistry(), ctx);
    expect(result.notice?.title).toBe('Model: claude-opus-4');
  });

  it('/model falls back to "unknown" when no display name is set', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/model')!, createCommandRegistry(), {
      ...ctx,
      modelDisplayName: '',
    });
    expect(result.notice?.title).toBe('Model: unknown');
  });

  it('an unknown command yields a friendly warn-tone notice, never throws', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/foo')!, createCommandRegistry(), ctx);
    expect(result.notice?.title).toBe('Unknown command: /foo');
    expect(result.notice?.tone).toBe('warn');
    expect(result.notice?.lines.join(' ')).toContain('/help');
    expect(result.exit).toBeUndefined();
  });

  it('registry is a fresh array each call so extensions can append (EXT-5)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
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

describe('tui/slashCommands /config (GS2-1 read-only)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('surfaces the pre-rendered config summary as a notice', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/config')!, createCommandRegistry(), {
      ...ctx,
      configSummary: ['Model: claude-x', 'Agent backend: lean'],
    });
    expect(result.notice?.title).toBe('Resolved configuration');
    expect(result.notice?.lines).toEqual(['Model: claude-x', 'Agent backend: lean']);
  });

  it('shows an "unavailable" line when no summary is present (e.g. fixture agent)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/config')!,
      createCommandRegistry(),
      ctx
    );
    expect(result.notice?.lines.join(' ')).toContain('not available');
  });

  it('is listed in the registry (so it appears in the /help + / menu)', async () => {
    const { createCommandRegistry } = await import('#src/tui/slashCommands.js');
    expect(createCommandRegistry().some((c) => c.name === 'config')).toBe(true);
  });

  // TUI-C19 — /config renders the actual validation warnings the standing advisory line points at.
  it('renders the config-validation warnings above the summary when present (TUI-C19)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
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
      await import('#src/tui/slashCommands.js');
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
    const { formatConfigSummary } = await import('#src/tui/slashCommands.js');
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
    const { formatConfigSummary } = await import('#src/tui/slashCommands.js');
    const lines = formatConfigSummary({});
    expect(lines.join('\n')).toContain('Model: unknown');
    expect(lines.join('\n')).toContain('Agent backend: lean');
  });

  it('renders an array filesystem policy as JSON', async () => {
    const { formatConfigSummary } = await import('#src/tui/slashCommands.js');
    const lines = formatConfigSummary({ filesystem: ['./src', './docs'] });
    expect(lines.join('\n')).toContain('Filesystem: ["./src","./docs"]');
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
    const { createCommandRegistry } = await import('#src/tui/slashCommands.js');
    const cmd = createCommandRegistry().find((c) => c.name === 'reasoning');
    expect(cmd).toBeDefined();
    expect(cmd?.availableDuringRun).toBe(true);
  });

  it('no arg resolves to the most recent turn that HAS reasoning (turn 3, skipping the empty turn 4)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/reasoning')!, createCommandRegistry(), {
      ...ctx,
      turnReasonings: reasonings,
    });
    expect(result.reprintReasoning).toEqual({ reasoning: 'C thought', turnNumber: 3 });
    expect(result.notice).toBeUndefined();
  });

  it('/reasoning <n> resolves to that 1-based turn', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/reasoning 1')!,
      createCommandRegistry(),
      { ...ctx, turnReasonings: reasonings }
    );
    expect(result.reprintReasoning).toEqual({ reasoning: 'A thought', turnNumber: 1 });
  });

  it('a turn with no thinking gives a friendly info notice, not a reprint', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
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
      await import('#src/tui/slashCommands.js');
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
      await import('#src/tui/slashCommands.js');
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
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(
      parseSlashCommand('/reasoning')!,
      createCommandRegistry(),
      { ...ctx, turnReasonings: reasonings },
      { duringRun: true }
    );
    expect(result.reprintReasoning).toEqual({ reasoning: 'C thought', turnNumber: 3 });
  });
});

describe('tui/slashCommands slashMenuQuery (TUI-C10 menu trigger)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the lower-cased query after the slash for a bare in-progress command', async () => {
    const { slashMenuQuery } = await import('#src/tui/slashCommands.js');
    expect(slashMenuQuery('/')).toBe('');
    expect(slashMenuQuery('/mo')).toBe('mo');
    expect(slashMenuQuery('/MODE')).toBe('mode');
  });

  it('returns null for non-slash input or once a space begins the args', async () => {
    const { slashMenuQuery } = await import('#src/tui/slashCommands.js');
    expect(slashMenuQuery('')).toBeNull();
    expect(slashMenuQuery('hello')).toBeNull();
    expect(slashMenuQuery(' /mode')).toBeNull(); // leading space: not a trigger
    expect(slashMenuQuery('/mode ')).toBeNull(); // space started args -> menu closes
    expect(slashMenuQuery('/mode foo')).toBeNull();
  });
});

describe('tui/slashCommands filterSlashCommands (TUI-C10 menu filter)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('an empty query returns the whole registry (bare "/" lists everything)', async () => {
    const { createCommandRegistry, filterSlashCommands } =
      await import('#src/tui/slashCommands.js');
    const registry = createCommandRegistry();
    const all = filterSlashCommands(registry, '');
    expect(all.map((c) => c.name)).toEqual(registry.map((c) => c.name));
    expect(all).not.toBe(registry); // a copy, never the live array
  });

  it('filters by prefix, case-insensitively', async () => {
    const { createCommandRegistry, filterSlashCommands } =
      await import('#src/tui/slashCommands.js');
    const registry = createCommandRegistry();
    expect(filterSlashCommands(registry, 'mo').map((c) => c.name)).toEqual(['mode', 'model']);
    // 'model' also starts with 'mode' (m-o-d-e-l), so both match the prefix.
    expect(filterSlashCommands(registry, 'MODE').map((c) => c.name)).toEqual(['mode', 'model']);
    expect(filterSlashCommands(registry, 'model').map((c) => c.name)).toEqual(['model']);
  });

  it('ranks prefix matches ahead of looser substring matches', async () => {
    const { filterSlashCommands } = await import('#src/tui/slashCommands.js');
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
      await import('#src/tui/slashCommands.js');
    const registry = createCommandRegistry();
    registry.push({ name: 'ping', description: 'extension command', run: () => ({}) });
    expect(filterSlashCommands(registry, 'pi').map((c) => c.name)).toEqual(['ping']);
    expect(filterSlashCommands(registry, '').map((c) => c.name)).toContain('ping');
  });
});
