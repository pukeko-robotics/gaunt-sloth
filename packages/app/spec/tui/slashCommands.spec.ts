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
    for (const rung of ['read-only', 'write', 'auto-safe', 'full-auto', 'bypass'] as const) {
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
   * CFG-27 — the retired three-mode vocabulary is gone with NO aliases. `auto` and `ask` are not
   * accepted as rung spellings, and `/auto-approve` / `/bypass-approve` are not commands: still
   * alpha, and a silent alias would leave the user believing in a vocabulary the gate no longer
   * has. `/auto-approve off` in particular had to mean one of two different rungs.
   */
  it('the retired `auto`/`ask` spellings and the /auto-approve, /bypass-approve commands are gone', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const registry = createCommandRegistry();
    for (const retired of ['auto', 'ask']) {
      const result = dispatchSlashCommand(
        parseSlashCommand(`/approvals ${retired}`)!,
        registry,
        ctx
      );
      expect(result.approvals).toBeUndefined();
      expect(result.notice?.title).toContain(retired);
    }
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
   * §10 — the notice body IS the spec's description, verbatim, and §8.1 forbids any of it leaning
   * on the hardline floor. §10 rule 4 fixes the title's spelling: the display form with spaces.
   */
  it('approvalsRungNotice renders §10 copy, warn-tones bypass, and never names the floor', async () => {
    const { approvalsRungNotice } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const posture = (rung: string, rater?: string) => ({ rung, rater, allow: [], deny: [] }) as any;

    const bypass = approvalsRungNotice(posture('bypass'));
    expect(bypass.title).toBe('Approvals: Bypass');
    expect(bypass.tone).toBe('warn');
    expect(bypass.lines.join(' ')).toContain('without asking and without rating');
    // §8.1 — the only protection cited is one the user can inspect and extend.
    expect(bypass.lines.join(' ')).toContain('deny list');
    expect(bypass.lines.join(' ')).not.toMatch(/hardline|floor/i);

    // `auto-safe` must state plainly that files are STILL rewritten and deleted without asking.
    const autoSafe = approvalsRungNotice(posture('auto-safe'));
    expect(autoSafe.title).toBe('Approvals: Auto safe');
    expect(autoSafe.tone).toBe('info');
    expect(autoSafe.lines.join(' ')).toContain(
      'rewrite and delete files in your working folder without asking'
    );

    // `full-auto` is described as safer than bypass and explicitly not safe.
    const fullAuto = approvalsRungNotice(posture('full-auto'));
    expect(fullAuto.title).toBe('Approvals: Full auto');
    expect(fullAuto.lines.join(' ')).toContain('safer than bypass');
    expect(fullAuto.lines.join(' ')).toContain('it is not safe');

    // A configured rater profile is named at the rated rungs (the spec's status requirement).
    expect(approvalsRungNotice(posture('auto-safe', 'safety-rater')).lines.join(' ')).toContain(
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
        rung: 'auto-safe',
        rater: 'safety-rater',
        allow: [],
        deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
        escalate: [],
      } as any,
      { session: 3, always: undefined },
      ['npm publish']
    );
    expect(notice.title).toBe('Approvals: Auto safe');
    const body = notice.lines.join(' ');
    expect(body).toContain('safety-rater');
    expect(body).toContain('3 this session');
    expect(body).toContain('Denied: 1');
    // Not loaded → `—`, never a misleading 0.
    expect(body).toContain('— remembered');
  });

  it('the /approvals display says the rater is unused at the three deterministic rungs', async () => {
    const { approvalsStatusNotice } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    for (const rung of ['read-only', 'write', 'bypass'] as const) {
      const notice = approvalsStatusNotice(
        { rung, rater: 'safety-rater', allow: [], deny: [] } as any,
        { session: 0, always: 0 }
      );
      expect(notice.lines.join(' ')).toContain('not used at this rung');
    }
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
    expect(filterSlashCommands(registry, 'mo').map((c) => c.name)).toEqual(['model']);
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
