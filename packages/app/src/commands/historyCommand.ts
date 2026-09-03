import { Command } from 'commander';
import { initConfig, type CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import { openHistoryStore, resolveHistoryDbPath } from '@gaunt-sloth/core/history/historyStore.js';
import { isHistoryEnabled } from '@gaunt-sloth/core/history/historyEnabled.js';
import { lookupConversationSafe } from '@gaunt-sloth/core/history/recordSession.js';
import {
  formatConversationList,
  formatConversationThread,
  formatSearchResults,
} from '@gaunt-sloth/core/history/historyFormat.js';
import { display, displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { parseResumeId } from '@gaunt-sloth/agent/modules/sessionResume.js';
import { startSession } from '#src/modules/startSession.js';
import { sessionConfigFor } from '#src/modules/sessionConfigs.js';

/**
 * GS2-7 (B20) / GS2-19 — the `gth history` command group over the local session store.
 *
 * - `gth history search <query...>` — FTS5 full-text search across past turns; each hit shows the
 *   parent conversation it belongs to (GS2-19).
 * - `gth history list` — the most recent conversations (grouped, with turn count + timespan), the
 *   top-level unit since GS2-19 (was a flat per-turn list).
 * - `gth history show <id>` — print a whole conversation thread, all turns in order (GS2-19).
 * - `gth history resume <id>` — GS2-20: start an interactive session inside a recorded
 *   conversation, in the mode (`chat` / `code`) it was recorded under.
 *
 * The first three are READ-ONLY and fail-soft: they open the store with `create: false`, so a
 * missing DB (nothing recorded yet, or history turned off) simply reports "no history yet" instead
 * of materialising an empty file.
 * (Opening still migrates a pre-GS2-19 DB in place — see {@link HistoryStore} migrate.) The DB
 * defaults to the global `~/.gsloth/history.db`; `--db <path>` overrides it. Local only — nothing
 * here touches the network.
 *
 * `resume` is the exception on both counts: it starts a session, so it loads the config the
 * session will run under (which is also where `history.dbPath` and `history.enabled` come from —
 * hence no `--db`: a resumed session must read the store the session itself records to) and takes
 * the same command-line overrides the session commands take.
 */
export function historyCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides = {}
): void {
  const history = program
    .command('history')
    .description('Search and list locally-recorded session history (local only)')
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gth history list\n' +
        '  $ gth history search vertexai timeout\n' +
        '  $ gth history show 42\n' +
        '  $ gth history resume 42\n'
    );

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
          'No session history found. Recording is on by default; `history.enabled: false` in your ' +
            'config turns it off.'
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
    .description('List the most recent recorded conversations')
    .option('--db <path>', 'path to the history DB (defaults to ~/.gsloth/history.db)')
    .option('--limit <n>', 'maximum results', '20')
    .action((options: { db?: string; limit?: string }) => {
      const store = openHistoryStore(resolveHistoryDbPath(options.db), { create: false });
      if (!store) {
        displayWarning(
          'No session history found. Recording is on by default; `history.enabled: false` in your ' +
            'config turns it off.'
        );
        return;
      }
      try {
        const limit = clampLimit(options.limit);
        const conversations = store.listConversations(limit);
        displayInfo('Recent conversations:');
        for (const line of formatConversationList(conversations)) display(line);
      } finally {
        store.close();
      }
    });

  history
    .command('show')
    .description('Print a whole conversation thread (all turns in order)')
    .argument('<id>', 'conversation id (from `history list` / `history search`)')
    .option('--db <path>', 'path to the history DB (defaults to ~/.gsloth/history.db)')
    .action((idArg: string, options: { db?: string }) => {
      const store = openHistoryStore(resolveHistoryDbPath(options.db), { create: false });
      if (!store) {
        displayWarning(
          'No session history found. Recording is on by default; `history.enabled: false` in your ' +
            'config turns it off.'
        );
        return;
      }
      try {
        const id = Number.parseInt(idArg, 10);
        if (!Number.isFinite(id) || id <= 0) {
          displayWarning(`Invalid conversation id "${idArg}".`);
          return;
        }
        const turns = store.getConversationThread(id);
        displayInfo(`Conversation #${id}:`);
        for (const line of formatConversationThread(turns)) display(line);
      } finally {
        store.close();
      }
    });

  // GS2-20 — the third spelling of a resume. The mode comes from the ROW, not from the person: a
  // conversation recorded by `gth chat` resumes as a chat session and one recorded by `gth code`
  // as a code session, because the other mode's tools and prompt would make it a different
  // conversation. Everything past picking the mode is `startSession` with `--resume`, so the
  // five checks and their sentences are the seam's, made once. What is decided HERE is only what
  // has to be decided before a session can start: is there such a row, and was it interactive.
  history
    .command('resume')
    .description(
      'Pick up a recorded conversation where it left off, in the mode it was recorded under'
    )
    .argument('<id>', 'conversation id (from `history list`)')
    .action(async (idArg: string) => {
      const id = parseResumeId(idArg);
      if (id === null) {
        displayWarning(`Invalid conversation id "${idArg}".`);
        return;
      }
      const config = await initConfig(commandLineConfigOverrides);
      if (!isHistoryEnabled(config)) {
        displayWarning(
          'History is off: `history.enabled: false` in your config turns recording off, and only ' +
            'a recorded conversation can be resumed.'
        );
        return;
      }
      const stored = lookupConversationSafe(config, id);
      if (!stored) {
        displayWarning(
          `No conversation #${id} in the history store. Run \`gth history list\` to see the ids.`
        );
        return;
      }
      const command = stored.summary.command;
      const sessionConfig = sessionConfigFor(command);
      if (!sessionConfig) {
        displayWarning(
          `Conversation #${id} was recorded by \`gth ${command ?? 'ask'}\`, a single-shot run ` +
            'that keeps no conversation state, so there is nothing to resume it into. ' +
            `\`gth history show ${id}\` prints it.`
        );
        return;
      }
      await startSession(sessionConfig, commandLineConfigOverrides, undefined, {
        resumeConversationId: id,
      });
    });
}

/** Parse and bound a `--limit` option (1..500); falls back to 20 on a bad value. */
function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(n, 500);
}
