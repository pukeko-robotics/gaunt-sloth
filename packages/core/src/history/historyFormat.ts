/**
 * @packageDocumentation
 * GS2-7 (B20) — pure, presentation-only formatters for the history surfaces.
 *
 * Shared by the `gth history` / `gth insights` CLI commands AND the `/history` `/search`
 * `/insights` TUI slash commands so both render identically and both are unit-testable without a
 * DB or a terminal. Every function is a pure `data -> string[]` transform (one display line per
 * element); no I/O, no colour codes.
 */
import type {
  ConversationSummary,
  HistoryInsights,
  SessionRecord,
  SessionSearchResult,
} from '#src/history/historyStore.js';

/** Collapse whitespace and clip to `max` chars with an ellipsis, for one-line previews. */
function oneLine(text: string | undefined, max = 80): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A compact `#id  <ts>  [command] model  (conversation #cid)` header line for one turn. */
function headerLine(r: SessionSearchResult): string {
  const parts = [`#${r.id}`, r.ts];
  if (r.command) parts.push(`[${r.command}]`);
  if (r.model) parts.push(r.model);
  // GS2-19: a search hit resolves to the conversation it belongs to, so the reader can pull up the
  // whole thread (`gth history show <cid>`). Older rows migrated from GS2-7 always have one now.
  if (r.conversationId != null) parts.push(`(conversation #${r.conversationId})`);
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

/**
 * GS2-19 — render a conversation-grained listing: one header + last-turn preview per conversation.
 * The header carries the count / timespan / last message that make the conversation the top-level
 * unit (`gth history list`), replacing the old flat per-turn list.
 */
export function formatConversationList(conversations: ConversationSummary[]): string[] {
  if (conversations.length === 0) {
    return [
      'No conversations recorded yet. Enable history with `history.enabled: true` in your config.',
    ];
  }
  const lines: string[] = [];
  for (const c of conversations) {
    const parts = [`#${c.id}`];
    // Timespan across the conversation's turns; a 1-turn (or not-yet-started) conversation collapses
    // to a single instant, so show one timestamp rather than an `a → a` range.
    if (c.firstTs && c.lastTs && c.firstTs !== c.lastTs) {
      parts.push(`${c.firstTs} → ${c.lastTs}`);
    } else {
      parts.push(c.lastTs ?? c.firstTs ?? c.startedTs);
    }
    if (c.command) parts.push(`[${c.command}]`);
    if (c.model) parts.push(c.model);
    parts.push(`(${c.turnCount} ${c.turnCount === 1 ? 'turn' : 'turns'})`);
    lines.push(parts.join('  '));
    const preview = oneLine(c.lastPrompt, 100);
    if (preview) lines.push(`    ${preview}`);
  }
  return lines;
}

/**
 * GS2-19 — render one conversation's full thread (all turns in order) for `gth history show <id>`.
 * Each turn shows its prompt and response preview so a search hit can be expanded into context.
 */
export function formatConversationThread(turns: SessionRecord[]): string[] {
  if (turns.length === 0) return ['No turns found for that conversation.'];
  const lines: string[] = [];
  turns.forEach((t, i) => {
    const header = t.ts ? `Turn ${i + 1}  ${t.ts}` : `Turn ${i + 1}`;
    lines.push(header);
    const prompt = oneLine(t.prompt, 200);
    if (prompt) lines.push(`  > ${prompt}`);
    const response = oneLine(t.response, 200);
    if (response) lines.push(`    ${response}`);
  });
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
