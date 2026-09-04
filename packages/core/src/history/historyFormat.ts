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
import type {
  CheckpointStoreStats,
  PrunableConversation,
  ReclaimSummary,
} from '#src/history/checkpointRetention.js';

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
      'No conversations recorded yet. Recording is on by default; `history.enabled: false` in ' +
        'your config turns it off.',
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

/**
 * GS2-107 — a byte count a person can read at a glance. Binary units, one decimal above KB, because
 * the number this renders is the answer to "how much of my disk is this", not an accounting figure.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * GS2-107 — the one line that makes the conversation store's volume visible where a person already
 * looks (`gth history list`), naming both the detail and the remedy so neither has to be discovered.
 *
 * The file size and the checkpoint share are separate numbers because the same file also holds the
 * transcripts and the search index; one figure labelled as checkpoints would overstate them.
 */
export function formatStoreSizeLine(stats: CheckpointStoreStats): string {
  const threads = `${stats.threadCount} ${stats.threadCount === 1 ? 'thread' : 'threads'}`;
  return (
    `Conversation store: ${formatBytes(stats.fileBytes)} on disk, of which ` +
    `${formatBytes(stats.checkpointBytes)} is ${stats.checkpointCount} checkpoints across ` +
    `${threads}. \`gth insights\` breaks it down; \`gth history prune\` reclaims it.`
  );
}

/**
 * GS2-107 — the readout in full, for `gth insights`: what the checkpoint tables hold, how much of it
 * is already unreachable, and which threads are the big ones.
 */
export function formatCheckpointStoreStats(stats: CheckpointStoreStats): string[] {
  if (stats.checkpointCount === 0) {
    return [
      'Conversation store: no checkpoints recorded. Interactive `chat` and `code` sessions ' +
        'write the state a resume needs; other commands do not.',
    ];
  }
  const lines: string[] = [];
  lines.push(`Database file: ${formatBytes(stats.fileBytes)} (${stats.dbPath})`);
  lines.push(
    `Checkpoints: ${stats.checkpointCount} across ${stats.threadCount} ` +
      `${stats.threadCount === 1 ? 'thread' : 'threads'}, ${formatBytes(stats.checkpointBytes)} ` +
      `including ${stats.writeCount} pending writes`
  );
  if (stats.unresumableThreadCount > 0) {
    lines.push(
      `Unresumable: ${stats.unresumableThreadCount} ` +
        `${stats.unresumableThreadCount === 1 ? 'thread' : 'threads'} no conversation names, ` +
        `${formatBytes(stats.unresumableBytes)} — reclaimed automatically a day after the ` +
        'session that wrote them ends.'
    );
  }
  if (stats.largestThreads.length > 0) {
    lines.push('Largest threads:');
    for (const t of stats.largestThreads) {
      const owner =
        t.conversationId != null
          ? `conversation #${t.conversationId}${t.command ? ` [${t.command}]` : ''}`
          : 'no conversation (not resumable)';
      lines.push(`  ${formatBytes(t.bytes)}  ${t.checkpointCount} checkpoints  ${owner}`);
    }
  }
  return lines;
}

/**
 * GS2-107 — what `gth history prune` will remove, said BEFORE it removes it. A prune costs a resume,
 * so the plan names every conversation by the id a person would have typed to resume it, and states
 * plainly that the transcript is not what is going away.
 */
export function formatPrunePlan(
  candidates: PrunableConversation[],
  unaddressableThreads: number,
  unaddressableBytes: number
): string[] {
  const lines: string[] = [];
  if (candidates.length === 0 && unaddressableThreads === 0) {
    return ['Nothing to prune: no stored conversation state matches those bounds.'];
  }
  if (candidates.length > 0) {
    const bytes = candidates.reduce((sum, c) => sum + c.bytes, 0);
    lines.push(
      `Would remove the stored state of ${candidates.length} ` +
        `${candidates.length === 1 ? 'conversation' : 'conversations'} (${formatBytes(bytes)}):`
    );
    for (const c of candidates) {
      lines.push(
        `  #${c.conversationId}  ${c.lastActivityTs}` +
          `${c.command ? `  [${c.command}]` : ''}  ${c.turnCount} ` +
          `${c.turnCount === 1 ? 'turn' : 'turns'}  ${c.checkpointCount} checkpoints  ` +
          formatBytes(c.bytes) +
          (c.recentlyActive ? '  <- active today' : '')
      );
    }
    lines.push(
      'Their transcripts stay: `gth history list` and `gth history show <id>` keep working. What ' +
        'goes is the state a resume needs, so those conversations can no longer be resumed.'
    );
    // GS2-107 — the one thing the plan cannot work out for itself. A conversation open in another
    // terminal is indistinguishable from a finished one at this distance, so the person holding
    // both windows is told which rows are recent enough to be that, and asked before anything goes.
    if (candidates.some((c) => c.recentlyActive)) {
      lines.push(
        'One or more of those were active in the last day and may be open in another window right ' +
          'now. Prune does not skip an open conversation — it removes exactly what the bounds you ' +
          'gave select — and a session whose state is removed under it loses the earlier part of ' +
          'its conversation.'
      );
    }
  }
  if (unaddressableThreads > 0) {
    lines.push(
      `Also reclaims ${unaddressableThreads} ` +
        `${unaddressableThreads === 1 ? 'thread' : 'threads'} no conversation names ` +
        `(${formatBytes(unaddressableBytes)}), which nothing could have resumed.`
    );
  }
  return lines;
}

/** GS2-107 — what a completed prune actually removed. */
export function formatPruneResult(
  removed: ReclaimSummary,
  fileBytesBefore: number,
  fileBytesAfter: number,
  vacuumed: boolean
): string[] {
  const lines = [
    `Removed ${removed.checkpointCount} checkpoints and ${removed.writeCount} pending writes ` +
      `across ${removed.threadCount} ${removed.threadCount === 1 ? 'thread' : 'threads'} ` +
      `(${formatBytes(removed.bytes)} of stored state).`,
  ];
  if (vacuumed) {
    lines.push(
      `Database file: ${formatBytes(fileBytesBefore)} → ${formatBytes(fileBytesAfter)} after VACUUM.`
    );
  } else {
    lines.push(
      'The rows are gone, but the file could not be compacted (VACUUM needs the database to ' +
        'itself). It will be reused for new checkpoints; run the prune again with no other ' +
        'session open to shrink it.'
    );
  }
  return lines;
}

/** Render the analytics summary: totals, top tools, per-command breakdown. */
export function formatInsightsSummary(insights: HistoryInsights): string[] {
  if (insights.sessionCount === 0) {
    return [
      'No sessions recorded yet. Recording is on by default; `history.enabled: false` in your ' +
        'config turns it off.',
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
