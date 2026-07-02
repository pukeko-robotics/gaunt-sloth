import { Command } from 'commander';
import { openHistoryStore, resolveHistoryDbPath } from '@gaunt-sloth/core/history/historyStore.js';
import { formatHistoryList, formatSearchResults } from '@gaunt-sloth/core/history/historyFormat.js';
import { display, displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';

/**
 * GS2-7 (B20) — the `gth history` command group over the local, opt-in session store.
 *
 * - `gth history search <query...>` — FTS5 full-text search across past sessions.
 * - `gth history list` — the most recent sessions.
 *
 * Both are READ-ONLY and fail-soft: they open the store with `create: false`, so a missing DB
 * (history never enabled) simply reports "no history yet" instead of materialising an empty file.
 * The DB defaults to the global `~/.gsloth/history.db`; `--db <path>` overrides it. Local only —
 * nothing here touches the network.
 */
export function historyCommand(program: Command): void {
  const history = program
    .command('history')
    .description('Search and list locally-recorded session history (opt-in; local only)');

  history
    .command('search')
    .description('Full-text search past sessions (SQLite FTS5)')
    .argument('<query...>', 'search terms')
    .option('--db <path>', 'path to the history DB (defaults to ~/.gsloth/history.db)')
    .option('--limit <n>', 'maximum results', '20')
    .action((queryParts: string[], options: { db?: string; limit?: string }) => {
      const store = openHistoryStore(resolveHistoryDbPath(options.db), { create: false });
      if (!store) {
        displayWarning(
          'No session history found. Enable it with `history.enabled: true` in your config.'
        );
        return;
      }
      try {
        const limit = clampLimit(options.limit);
        const results = store.search(queryParts.join(' '), limit);
        displayInfo(`History search: "${queryParts.join(' ')}"`);
        for (const line of formatSearchResults(results)) display(line);
      } finally {
        store.close();
      }
    });

  history
    .command('list')
    .description('List the most recent recorded sessions')
    .option('--db <path>', 'path to the history DB (defaults to ~/.gsloth/history.db)')
    .option('--limit <n>', 'maximum results', '20')
    .action((options: { db?: string; limit?: string }) => {
      const store = openHistoryStore(resolveHistoryDbPath(options.db), { create: false });
      if (!store) {
        displayWarning(
          'No session history found. Enable it with `history.enabled: true` in your config.'
        );
        return;
      }
      try {
        const limit = clampLimit(options.limit);
        const results = store.listRecent(limit);
        displayInfo('Recent sessions:');
        for (const line of formatHistoryList(results)) display(line);
      } finally {
        store.close();
      }
    });
}

/** Parse and bound a `--limit` option (1..500); falls back to 20 on a bad value. */
function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(n, 500);
}
