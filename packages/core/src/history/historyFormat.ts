/**
 * @packageDocumentation
 * GS2-7 (B20) — pure, presentation-only formatters for the history surfaces.
 *
 * Shared by the `gth history` / `gth insights` CLI commands AND the `/history` `/search`
 * `/insights` TUI slash commands so both render identically and both are unit-testable without a
 * DB or a terminal. Every function is a pure `data -> string[]` transform (one display line per
 * element); no I/O, no colour codes.
 */
import type { HistoryInsights, SessionSearchResult } from '#src/history/historyStore.js';

/** Collapse whitespace and clip to `max` chars with an ellipsis, for one-line previews. */
function oneLine(text: string | undefined, max = 80): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A compact `#id  <ts>  [command] model` header line for one session. */
function headerLine(r: SessionSearchResult): string {
  const parts = [`#${r.id}`, r.ts];
  if (r.command) parts.push(`[${r.command}]`);
  if (r.model) parts.push(r.model);
  return parts.join('  ');
}

/**
 * Render FTS search hits: a header line per hit plus its snippet (or a prompt preview when the
 * snippet is empty). Returns a friendly single line when there are none.
 */
export function formatSearchResults(results: SessionSearchResult[]): string[] {
  if (results.length === 0) return ['No matching sessions found.'];
  const lines: string[] = [];
  for (const r of results) {
    lines.push(headerLine(r));
    const detail = r.snippet && r.snippet.trim().length > 0 ? r.snippet : r.prompt;
    const preview = oneLine(detail, 100);
    if (preview) lines.push(`    ${preview}`);
  }
  return lines;
}

/** Render a recent-sessions listing: one header + prompt-preview pair per session. */
export function formatHistoryList(results: SessionSearchResult[]): string[] {
  if (results.length === 0) {
    return [
      'No sessions recorded yet. Enable history with `history.enabled: true` in your config.',
    ];
  }
  const lines: string[] = [];
  for (const r of results) {
    lines.push(headerLine(r));
    const preview = oneLine(r.prompt, 100);
    if (preview) lines.push(`    ${preview}`);
  }
  return lines;
}

/** Render the analytics summary: totals, top tools, per-command breakdown. */
export function formatInsightsSummary(insights: HistoryInsights): string[] {
  if (insights.sessionCount === 0) {
    return [
      'No sessions recorded yet. Enable history with `history.enabled: true` in your config.',
    ];
  }
  const lines: string[] = [];
  lines.push(`Sessions: ${insights.sessionCount}`);
  if (insights.firstTs && insights.lastTs) {
    lines.push(`Span: ${insights.firstTs} → ${insights.lastTs}`);
  }
  // GS2-16: only surface the token/cost/top-tool lines when there is real data behind them.
  // Older records (and providers that report no usage) leave these zero/empty; printing
  // `Tokens: 0` / `$0.0000` / `(none recorded)` reads as "the run used nothing", which is
  // misleading, so omit the line entirely instead. Sessions / Span / By-command always show.
  if (insights.totalTokens > 0) {
    lines.push(
      `Tokens: ${insights.totalTokens} total ` +
        `(${insights.totalTokensInput} in / ${insights.totalTokensOutput} out)`
    );
  }
  // Cost is only ever recorded when a reliable price was available (the recorder never invents
  // one), so a positive total is the signal that a cost line is meaningful.
  if (insights.totalCostUsd > 0) {
    lines.push(`Estimated cost: $${insights.totalCostUsd.toFixed(4)}`);
  }

  if (insights.perCommand.length > 0) {
    lines.push('By command:');
    for (const c of insights.perCommand) lines.push(`  ${c.command}: ${c.count}`);
  }
  if (insights.topTools.length > 0) {
    lines.push('Top tools:');
    for (const t of insights.topTools) lines.push(`  ${t.tool}: ${t.count}`);
  }
  return lines;
}
