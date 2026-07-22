import { Command } from 'commander';
import { openHistoryStore, resolveHistoryDbPath } from '@gaunt-sloth/core/history/historyStore.js';
import { formatInsightsSummary } from '@gaunt-sloth/core/history/historyFormat.js';
import { display, displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';

/**
 * GS2-7 (B20) — `gth insights`: lightweight, LOCAL analytics over the opt-in session store
 * (token/cost totals, a top-tool tally, and a per-command breakdown). Read-only and fail-soft:
 * opens with `create: false`, so a missing DB just prints "no history yet" rather than creating
 * one. Nothing leaves the machine. `--db <path>` overrides the default `~/.gsloth/history.db`.
 */
export function insightsCommand(program: Command): void {
  program
    .command('insights')
    .description('Show local analytics over recorded session history (opt-in; local only)')
    .option('--db <path>', 'path to the history DB (defaults to ~/.gsloth/history.db)')
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gsloth insights\n' +
        '  $ gsloth insights --db ./project-history.db\n'
    )
    .action((options: { db?: string }) => {
      const store = openHistoryStore(resolveHistoryDbPath(options.db), { create: false });
      if (!store) {
        displayWarning(
          'No session history found. Enable it with `history.enabled: true` in your config.'
        );
        return;
      }
      try {
        const insights = store.insights();
        displayInfo('Session insights (local only):');
        for (const line of formatInsightsSummary(insights)) display(line);
      } finally {
        store.close();
      }
    });
}
