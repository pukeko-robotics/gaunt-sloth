import { describe, expect, it } from 'vitest';
import {
  createCommandRegistry,
  dispatchSlashCommand,
  filterSlashCommands,
  formatHelp,
  parseSlashCommand,
  type SlashCommandContext,
} from '#src/tui/slashCommands.js';

/**
 * GS2-7 (B20) — the `/history` `/search` `/insights` slash commands live in the pure registry, so
 * they auto-appear in `/help` and the TUI-C10 `/` menu, and each renders a notice from the App's
 * fail-soft, pre-built context (mirroring `/config`). Tested purely — no DB, no React.
 */
const baseCtx: SlashCommandContext = {
  mode: 'chat',
  modelDisplayName: 'gpt-5',
  turnCount: 0,
  toolsExpanded: false,
  debugVisible: false,
};

const run = (input: string, ctx: SlashCommandContext) => {
  const parsed = parseSlashCommand(input)!;
  return dispatchSlashCommand(parsed, createCommandRegistry(), ctx);
};

describe('tui/slashCommands — history/search/insights (GS2-7)', () => {
  it('registers the three commands so they surface in /help and the menu', () => {
    const registry = createCommandRegistry();
    const names = registry.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['history', 'search', 'insights']));
    // /config (GS2-1) is still present and undisturbed.
    expect(names).toContain('config');

    const help = formatHelp(registry);
    expect(help.lines.some((l) => l.startsWith('/history'))).toBe(true);
    expect(help.lines.some((l) => l.startsWith('/search'))).toBe(true);
    expect(help.lines.some((l) => l.startsWith('/insights'))).toBe(true);

    // The `/` menu prefix filter finds them.
    expect(filterSlashCommands(registry, 'his').map((c) => c.name)).toContain('history');
    expect(filterSlashCommands(registry, 'ins').map((c) => c.name)).toContain('insights');
  });

  describe('/history', () => {
    it('renders the pre-built recent-session summary', () => {
      const result = run('/history', { ...baseCtx, historySummary: ['#2  ts  [chat]', '  hello'] });
      expect(result.notice?.title).toBe('Recent sessions');
      expect(result.notice?.lines).toEqual(['#2  ts  [chat]', '  hello']);
    });
    it('falls back to an "unavailable" notice when no store is present', () => {
      const result = run('/history', baseCtx);
      expect(result.notice?.lines.join(' ')).toContain('history.enabled');
    });
  });

  describe('/insights', () => {
    it('renders the pre-built insights summary', () => {
      const result = run('/insights', { ...baseCtx, insightsSummary: ['Sessions: 5'] });
      expect(result.notice?.title).toContain('Session insights');
      expect(result.notice?.lines).toEqual(['Sessions: 5']);
    });
    it('falls back to unavailable when no store is present', () => {
      expect(run('/insights', baseCtx).notice?.lines.join(' ')).toContain('history.enabled');
    });
  });

  describe('/search', () => {
    it('shows usage when called with no query', () => {
      const result = run('/search', { ...baseCtx, historySearch: () => ['should not be called'] });
      expect(result.notice?.lines.join(' ')).toContain('Usage: /search');
    });
    it('runs the injected search provider and renders its result lines', () => {
      const calls: string[] = [];
      const provider = (q: string) => {
        calls.push(q);
        return ['#1  ts  [ask]', '  matched line'];
      };
      const result = run('/search widget factory', { ...baseCtx, historySearch: provider });
      expect(calls).toEqual(['widget factory']);
      expect(result.notice?.title).toContain('widget factory');
      expect(result.notice?.lines).toEqual(['#1  ts  [ask]', '  matched line']);
    });
    it('reports unavailable when no search provider is bound', () => {
      const result = run('/search anything', baseCtx);
      expect(result.notice?.lines.join(' ')).toContain('history.enabled');
    });
  });
});
