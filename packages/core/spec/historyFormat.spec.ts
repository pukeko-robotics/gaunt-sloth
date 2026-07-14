import { describe, expect, it } from 'vitest';
import {
  formatConversationList,
  formatConversationThread,
  formatInsightsSummary,
  formatSearchResults,
} from '#src/history/historyFormat.js';
import type {
  ConversationSummary,
  HistoryInsights,
  SessionRecord,
  SessionSearchResult,
} from '#src/history/historyStore.js';

const hit = (over: Partial<SessionSearchResult> = {}): SessionSearchResult => ({
  id: 1,
  ts: '2026-07-03T10:00:00.000Z',
  command: 'ask',
  model: 'gpt-5',
  prompt: 'How do I do the thing?',
  response: 'Like this.',
  snippet: 'do the [thing]',
  ...over,
});

describe('history/historyFormat', () => {
  describe('formatSearchResults', () => {
    it('renders a header + snippet per hit', () => {
      const lines = formatSearchResults([hit()]);
      expect(lines[0]).toContain('#1');
      expect(lines[0]).toContain('[ask]');
      expect(lines[0]).toContain('gpt-5');
      expect(lines[1].trim()).toBe('do the [thing]');
    });
    it('falls back to a prompt preview when the snippet is empty', () => {
      const lines = formatSearchResults([hit({ snippet: '' })]);
      expect(lines[1].trim()).toBe('How do I do the thing?');
    });
    it('reports a friendly line when there are no hits', () => {
      expect(formatSearchResults([])).toEqual(['No matching sessions found.']);
    });
  });

  describe('formatConversationList (GS2-19)', () => {
    const conv = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
      id: 5,
      startedTs: '2026-07-03T10:00:00.000Z',
      command: 'chat',
      model: 'gpt-5',
      turnCount: 3,
      firstTs: '2026-07-03T10:00:00.000Z',
      lastTs: '2026-07-03T10:05:00.000Z',
      lastPrompt: 'the last thing I asked',
      lastResponse: 'the last answer',
      ...over,
    });

    it('renders a conversation-grained header: id, timespan, command, model, turn count', () => {
      const lines = formatConversationList([conv()]);
      expect(lines[0]).toContain('#5');
      expect(lines[0]).toContain('[chat]');
      expect(lines[0]).toContain('gpt-5');
      expect(lines[0]).toContain('→'); // timespan first → last
      expect(lines[0]).toContain('(3 turns)');
      expect(lines[1].trim()).toBe('the last thing I asked'); // last-message preview
    });

    it('singularises one turn and collapses a same-instant timespan to a single timestamp', () => {
      const lines = formatConversationList([
        conv({ turnCount: 1, firstTs: 'T', lastTs: 'T', lastPrompt: 'only' }),
      ]);
      expect(lines[0]).toContain('(1 turn)');
      expect(lines[0]).not.toContain('→');
    });

    it('reports an enable hint when there are no conversations', () => {
      expect(formatConversationList([])[0]).toContain('history.enabled');
    });
  });

  describe('formatConversationThread (GS2-19)', () => {
    it('renders every turn in order with prompt + response previews', () => {
      const turns: SessionRecord[] = [
        { ts: '2026-07-03T10:00:00.000Z', prompt: 'first q', response: 'first a' },
        { ts: '2026-07-03T10:01:00.000Z', prompt: 'second q', response: 'second a' },
      ];
      const lines = formatConversationThread(turns);
      expect(lines.some((l) => l.startsWith('Turn 1'))).toBe(true);
      expect(lines.some((l) => l.startsWith('Turn 2'))).toBe(true);
      expect(lines.some((l) => l.includes('first q'))).toBe(true);
      expect(lines.some((l) => l.includes('second a'))).toBe(true);
      // Order preserved: Turn 1 appears before Turn 2.
      expect(lines.findIndex((l) => l.startsWith('Turn 1'))).toBeLessThan(
        lines.findIndex((l) => l.startsWith('Turn 2'))
      );
    });

    it('reports a friendly line for an unknown / empty conversation', () => {
      expect(formatConversationThread([])).toEqual(['No turns found for that conversation.']);
    });
  });

  describe('formatInsightsSummary', () => {
    const insights: HistoryInsights = {
      sessionCount: 3,
      totalTokensInput: 300,
      totalTokensOutput: 130,
      totalTokens: 430,
      totalCostUsd: 0.03,
      topTools: [{ tool: 'read_file', count: 3 }],
      perCommand: [{ command: 'ask', count: 2 }],
      firstTs: '2026-07-01T00:00:00.000Z',
      lastTs: '2026-07-03T00:00:00.000Z',
    };
    it('renders totals, per-command and top tools', () => {
      const lines = formatInsightsSummary(insights);
      expect(lines.some((l) => l.includes('Sessions: 3'))).toBe(true);
      expect(lines.some((l) => l.includes('430 total'))).toBe(true);
      expect(lines.some((l) => l.includes('$0.0300'))).toBe(true);
      expect(lines.some((l) => l.includes('read_file: 3'))).toBe(true);
      expect(lines.some((l) => l.includes('ask: 2'))).toBe(true);
    });
    it('OMITS token, cost and top-tool lines when there is no such data (GS2-16)', () => {
      // Sessions were recorded (older records / providers that report no usage), but no tokens,
      // no cost and no tools — the misleading `0`/`$0.0000`/`(none recorded)` lines must not show.
      const noAnalytics: HistoryInsights = {
        sessionCount: 4,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        topTools: [],
        perCommand: [{ command: 'ask', count: 4 }],
        firstTs: '2026-07-01T00:00:00.000Z',
        lastTs: '2026-07-03T00:00:00.000Z',
      };
      const lines = formatInsightsSummary(noAnalytics);
      expect(lines.some((l) => l.includes('Sessions: 4'))).toBe(true); // always shown
      expect(lines.some((l) => l.includes('By command'))).toBe(true); // always shown
      expect(lines.some((l) => l.includes('Tokens'))).toBe(false);
      expect(lines.some((l) => l.toLowerCase().includes('cost'))).toBe(false);
      expect(lines.some((l) => l.includes('$'))).toBe(false);
      expect(lines.some((l) => l.toLowerCase().includes('tools'))).toBe(false);
    });

    it('SHOWS the token line when tokens exist but still omits cost when zero (GS2-16)', () => {
      const tokensNoCost: HistoryInsights = {
        sessionCount: 1,
        totalTokensInput: 100,
        totalTokensOutput: 30,
        totalTokens: 130,
        totalCostUsd: 0, // no reliable price → recorder never set costUsd
        topTools: [],
        perCommand: [],
      };
      const lines = formatInsightsSummary(tokensNoCost);
      expect(lines.some((l) => l.includes('130 total'))).toBe(true);
      expect(lines.some((l) => l.includes('$'))).toBe(false); // cost still suppressed
    });

    it('reports an enable hint for an empty store', () => {
      const empty: HistoryInsights = {
        sessionCount: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        topTools: [],
        perCommand: [],
      };
      expect(formatInsightsSummary(empty)[0]).toContain('history.enabled');
    });
  });
});
