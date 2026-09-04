import { Command } from 'commander';
import { initConfig, type CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import { openHistoryStore, resolveHistoryDbPath } from '@gaunt-sloth/core/history/historyStore.js';
import { isHistoryEnabled } from '@gaunt-sloth/core/history/historyEnabled.js';
import { lookupConversationSafe } from '@gaunt-sloth/core/history/recordSession.js';
import {
  formatConversationList,
  formatConversationThread,
  formatPrunePlan,
  formatPruneResult,
  formatSearchResults,
  formatStoreSizeLine,
} from '@gaunt-sloth/core/history/historyFormat.js';
import {
  openCheckpointMaintenance,
  type PruneBounds,
} from '@gaunt-sloth/core/history/checkpointRetention.js';
import {
  display,
  displayInfo,
  displaySuccess,
  displayWarning,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { statSync } from 'node:fs';
import { parseResumeId } from '@gaunt-sloth/agent/modules/sessionResume.js';

/**
 * The one sentence for "there is no store": `list`, `search`, `show` and `resume` all say it, so a
 * person with nothing recorded yet hears the same thing whichever they typed — and is not told a
 * conversation id is unknown when the file it would be in does not exist.
 */
export const NO_HISTORY_MESSAGE =
  'No session history found. Recording is on by default; `history.enabled: false` in your ' +
  'config turns it off.';
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
        displayWarning(NO_HISTORY_MESSAGE);
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
      const dbPath = resolveHistoryDbPath(options.db);
      const store = openHistoryStore(dbPath, { create: false });
      if (!store) {
        displayWarning(NO_HISTORY_MESSAGE);
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
      // GS2-107 — the size readout goes HERE, under the listing, because this is the screen a
      // person is already on when they wonder what the store holds. One line: the volume, where
      // the breakdown is, and what reclaims it.
      const maintenance = openCheckpointMaintenance(dbPath);
      if (!maintenance) return;
      try {
        const stats = maintenance.stats(dbPath);
        if (stats.checkpointCount > 0) display(formatStoreSizeLine(stats));
      } finally {
        maintenance.close();
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
        displayWarning(NO_HISTORY_MESSAGE);
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

  // GS2-107 — the half of the retention policy that can cost a resume, and therefore the half a
  // person has to type. Automatic reclamation removes only threads no conversation names; this
  // removes stored state someone could still have resumed, so:
  //
  // - it takes an explicit bound and refuses to guess one. A default here would be an age-based
  //   retention policy applied to everybody without being asked, which is exactly what the ruling
  //   GS2-20 was built to ("resume sheds nothing") forbids;
  // - it prints the plan and removes nothing until `--yes`. The dry run is the default because the
  //   second layer of it matters more than the keystroke: an invocation that forgets `--db` resolves
  //   to the developer's own `~/.gsloth/history.db`;
  // - it prunes WHOLE conversations. A count bound here means "keep the N most recent
  //   conversations", never "keep the last N super-steps of a thread" — a checkpoint chain is not
  //   safe to truncate in the middle as a policy, whatever one graph's channel schema allows today.
  history
    .command('prune')
    .description('Remove stored conversation state (transcripts stay) and reclaim the file')
    .option('--older-than <days>', 'prune conversations with no activity for this many days')
    .option('--keep-last <n>', 'keep the N most recently active conversations, prune the rest')
    .option('--yes', 'actually remove; without it this prints the plan and changes nothing')
    .option('--db <path>', 'path to the history DB (defaults to ~/.gsloth/history.db)')
    .addHelpText(
      'after',
      '\n' +
        'A pruned conversation keeps its transcript — `gth history show <id>` still prints it —\n' +
        'and loses only the state a resume needs. Threads no conversation names are reclaimed\n' +
        'automatically a day after the session ends; this is for the rest.\n' +
        '\n' +
        'Examples:\n' +
        '  $ gth history prune --older-than 30\n' +
        '  $ gth history prune --keep-last 20 --yes\n'
    )
    .action((options: { olderThan?: string; keepLast?: string; yes?: boolean; db?: string }) => {
      const olderThanDays = parseBound(options.olderThan, 'older-than');
      const keepLast = parseBound(options.keepLast, 'keep-last');
      if (olderThanDays === 'invalid' || keepLast === 'invalid') return;
      if (olderThanDays === undefined && keepLast === undefined) {
        displayWarning(
          'Nothing was removed: `gth history prune` needs a bound. Use `--older-than <days>`, ' +
            '`--keep-last <n>`, or both — this command can make a conversation unresumable, so it ' +
            'never picks one for you.'
        );
        return;
      }
      const dbPath = resolveHistoryDbPath(options.db);
      const maintenance = openCheckpointMaintenance(dbPath);
      if (!maintenance) {
        displayWarning(NO_HISTORY_MESSAGE);
        return;
      }
      try {
        const bounds: PruneBounds = { olderThanDays, keepLast };
        const candidates = maintenance.prunable(bounds);
        // The automatic set rides along: it is free, it cannot cost a resume, and reporting it here
        // is how a person finds out how much of the store was never reachable in the first place.
        const unaddressable = maintenance.unaddressable();
        const unaddressableBytes = maintenance.bytesOf(unaddressable);
        displayInfo('History prune:');
        for (const line of formatPrunePlan(candidates, unaddressable.length, unaddressableBytes)) {
          display(line);
        }
        if (candidates.length === 0 && unaddressable.length === 0) return;
        if (!options.yes) {
          displayWarning('Nothing was removed. Re-run with `--yes` to remove it.');
          return;
        }
        const before = fileBytes(dbPath);
        const removed = maintenance.remove([
          ...candidates.map((c) => c.threadId),
          ...unaddressable,
        ]);
        const vacuumed = maintenance.vacuum();
        const after = fileBytes(dbPath);
        for (const line of formatPruneResult(removed, before, after, vacuumed)) display(line);
        displaySuccess('History prune complete.');
      } finally {
        maintenance.close();
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
      // No store at all is "no history yet", the same answer `history list` gives in that state —
      // not an unknown id, which would send the person looking for a typo in a number.
      const store = openHistoryStore(resolveHistoryDbPath(config.history?.dbPath), {
        create: false,
      });
      if (!store) {
        displayWarning(NO_HISTORY_MESSAGE);
        return;
      }
      store.close();
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

/**
 * GS2-107 — parse a prune bound. `undefined` when the flag was not given, `'invalid'` (having said
 * so) when it was given as something that is not a positive whole number.
 *
 * A bad bound is refused rather than clamped, unlike `--limit` below: clamping a listing to 20 rows
 * costs a reader nothing, and quietly reinterpreting the bound on a command that deletes state would
 * remove a different set from the one the person asked for.
 */
function parseBound(raw: string | undefined, flag: string): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    displayWarning(
      `Nothing was removed: \`--${flag} ${raw}\` is not a whole number of ` +
        `${flag === 'older-than' ? 'days' : 'conversations'}.`
    );
    return 'invalid';
  }
  return n;
}

/** The database file's size on disk, or 0 when it cannot be read. */
function fileBytes(dbPath: string): number {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

/** Parse and bound a `--limit` option (1..500); falls back to 20 on a bad value. */
function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(n, 500);
}
