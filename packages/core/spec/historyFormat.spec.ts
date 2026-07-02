import { describe, expect, it } from 'vitest';
import {
  formatHistoryList,
  formatInsightsSummary,
  formatSearchResults,
} from '#src/history/historyFormat.js';
import type { HistoryInsights, SessionSearchResult } from '#src/history/historyStore.js';

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

  describe('formatHistoryList', () => {
    it('lists sessions newest-first with previews', () => {
      const lines = formatHistoryList([
        hit({ id: 2, prompt: 'second' }),
        hit({ id: 1, prompt: 'first' }),
      ]);
      expect(lines[0]).toContain('#2');
      expect(lines.some((l) => l.includes('second'))).toBe(true);
    });
    it('reports an enable hint when empty', () => {
      expect(formatHistoryList([])[0]).toContain('history.enabled');
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
