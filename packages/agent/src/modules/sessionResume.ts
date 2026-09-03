/**
 * @packageDocumentation
 * GS2-20 — **the one seam through which a session re-enters a stored conversation.**
 *
 * Three spellings reach it — `--resume <id>` on `gth chat` / `gth code` / bare `gth`, `/resume <id>`
 * inside a running session, and `gth history resume <id>` — and every one of them is exactly two
 * calls: {@link resolveResumeTarget} decides whether the conversation CAN be resumed and gathers what
 * a resume needs, and {@link applyResumeTarget} makes the session be in it. Neither surface (the
 * readline loop, the Ink TUI) knows anything a resume requires beyond those two calls, so a check
 * added here is applied to every spelling, and a spelling cannot drift into meaning something else.
 *
 * The seam sits here, in the agent package, rather than wholly on `GthAgentRunner`, because half of
 * what a resume does is not the runner's: reading the history store, comparing workspaces and
 * re-binding the recorder are session concerns the runner deliberately does not have. The runner
 * owns the half that touches the graph — `GthAgentRunner.resumeConversation` rotates onto the
 * stored thread and installs the conversation's grants — and this module owns the checks and the
 * recorder. Both halves are exercised by both spellings, so breaking either breaks both.
 *
 * **The checks run in a fixed order, and each refusal has its own sentence**, because the person
 * typing an id needs to know which of five different things is wrong, and "cannot resume" tells
 * them none of it:
 *
 * 1. history is off — the one switch that governs recording, checkpointing and resuming alike;
 * 2. the store did not open — asked for and not available, which is a different fact from off;
 * 3. no such conversation;
 * 4. the conversation exists and is not resumable — never had a thread, lost it, or its thread was
 *    never checkpointed — with the reason class where it is known;
 * 5. it was recorded in another directory — the same comparison ACP's `session/new` makes.
 */
import { resolve } from 'node:path';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { isHistoryEnabled, type HistoryConfigView } from '@gaunt-sloth/core/history/historyEnabled.js';
import {
  listResumableConversationsSafe,
  lookupConversationSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import type { ConversationSummary, SessionRecord } from '@gaunt-sloth/core/history/historyStore.js';
import { formatConversationList } from '@gaunt-sloth/core/history/historyFormat.js';
import {
  loadConversationGrantsSafe,
  type ConversationGrants,
} from '@gaunt-sloth/core/core/approvals/conversationGrants.js';
import { isSameWorkspace } from '#src/modules/workspace.js';
import type { SlashCommandNotice } from '#src/modules/slashCommands.js';

/** Everything a resume needs, gathered by {@link resolveResumeTarget} once the checks have passed. */
export interface ResumeTarget {
  conversationId: number;
  /** The LangGraph thread whose checkpoint holds the conversation's state. */
  threadId: string;
  summary: ConversationSummary;
  /** The recorded turns, oldest first — what the surfaces replay as restored turns. */
  turns: SessionRecord[];
  /** The approvals granted in the conversation, to install again (Ruling 3). */
  grants: ConversationGrants;
}

/** Why a resume was refused — one variant per check, each with what its sentence needs. */
export type ResumeRefusal =
  | { kind: 'history-off' }
  | { kind: 'store-unavailable' }
  | { kind: 'unknown'; id: number }
  | {
      kind: 'not-resumable';
      id: number;
      /**
       * The reason class, where it is known:
       * - `single-shot` — recorded by a command that keeps no conversation state (`ask`, `exec`, …);
       * - `no-thread` — an interactive conversation whose thread link is null: a checkpoint write
       *   failed while it ran and it was marked unresumable, or it predates conversation state;
       * - `no-checkpoint` — the thread is on record but nothing was ever checkpointed under it;
       * - `unreadable` — the checkpoint could not be read from the store.
       */
      reason: 'single-shot' | 'no-thread' | 'no-checkpoint' | 'unreadable';
      command?: string;
    }
  | { kind: 'workspace-mismatch'; id: number; stored: string; current: string };

export type ResumeResolution =
  | { ok: true; target: ResumeTarget }
  | { ok: false; refusal: ResumeRefusal };

/** What {@link resolveResumeTarget} needs from the session asking. */
export interface ResumeSessionContext {
  config: HistoryConfigView;
  /** The session's checkpointer — the saver the thread is looked up in, and whether it is durable. */
  checkpointer: { saver: BaseCheckpointSaver; durable: boolean };
  /** The directory this session works in, compared with the conversation's stored `project`. */
  workspace: string;
}

/** The commands whose sessions checkpoint a thread; every other command's rows are single-shot. */
const INTERACTIVE_COMMANDS = new Set(['chat', 'code']);

/**
 * Decide whether conversation `id` can be resumed by this session, and gather what the resume
 * needs. Never throws: a failure to read is a refusal with a reason, never a crash.
 */
export async function resolveResumeTarget(
  session: ResumeSessionContext,
  id: number
): Promise<ResumeResolution> {
  if (!isHistoryEnabled(session.config)) return refuse({ kind: 'history-off' });
  // Asked for and not available: the store did not open, so nothing below could be read anyway,
  // and calling the id "unknown" would blame the person for the disk.
  if (!session.checkpointer.durable) return refuse({ kind: 'store-unavailable' });

  const stored = lookupConversationSafe(session.config, id);
  if (!stored) return refuse({ kind: 'unknown', id });
  const { summary, turns } = stored;

  if (!summary.threadId) {
    const reason = INTERACTIVE_COMMANDS.has(summary.command ?? '') ? 'no-thread' : 'single-shot';
    return refuse({ kind: 'not-resumable', id, reason, command: summary.command });
  }
  // A thread with no checkpoint is refused exactly like a null thread: there is no state to
  // re-enter, and driving the graph on it would silently start a fresh conversation under an old
  // id — which is the one thing a resume must never do.
  let checkpointed: boolean;
  try {
    const tuple = await session.checkpointer.saver.getTuple({
      configurable: { thread_id: summary.threadId },
    });
    checkpointed = tuple !== undefined;
  } catch {
    return refuse({ kind: 'not-resumable', id, reason: 'unreadable', command: summary.command });
  }
  if (!checkpointed) {
    return refuse({ kind: 'not-resumable', id, reason: 'no-checkpoint', command: summary.command });
  }

  // The same comparison ACP's `session/new` makes, on resolved paths. A row with no project on
  // record has nothing to compare and proceeds: the check refuses a KNOWN mismatch, and a datum
  // that was never written is not one.
  if (summary.project) {
    const stored = resolve(summary.project);
    const current = resolve(session.workspace);
    if (!isSameWorkspace(stored, current)) {
      return refuse({ kind: 'workspace-mismatch', id, stored, current });
    }
  }

  return {
    ok: true,
    target: {
      conversationId: id,
      threadId: summary.threadId,
      summary,
      turns,
      grants: loadConversationGrantsSafe(session.config, id),
    },
  };
}

const refuse = (refusal: ResumeRefusal): ResumeResolution => ({ ok: false, refusal });

/** The half of the runner a resume drives — `GthAgentRunner` satisfies it; specs pass a fake. */
export interface ResumableRunner {
  resumeConversation(target: { threadId: string; grants: ConversationGrants }): void;
}

/**
 * Make the session BE in the resolved conversation: the runner rotates onto the stored thread and
 * installs the conversation's grants, and the checkpointer is told which row to mark if a write
 * fails from here on. The caller switches its own recorder id to `target.conversationId`, because
 * that id is the caller's variable; nothing else is needed.
 */
export function applyResumeTarget(
  session: {
    runner: ResumableRunner;
    checkpointer: { bindConversation?(conversationId: number | undefined): void };
  },
  target: ResumeTarget
): void {
  session.runner.resumeConversation({ threadId: target.threadId, grants: target.grants });
  session.checkpointer.bindConversation?.(target.conversationId);
}

/**
 * The conversations a bare `/resume` offers: every resumable one except the conversation the
 * session is already in. Fail-soft and empty when history is off or the store is absent.
 */
export function listResumeCandidates(
  config: HistoryConfigView,
  currentConversationId: number | undefined,
  limit = 20
): ConversationSummary[] {
  return listResumableConversationsSafe(config, { limit, exclude: currentConversationId });
}

/**
 * Parse the id a person typed after `--resume`, `/resume` or `history resume`. A positive integer
 * in decimal, or `null` — the ids `gth history list` prints are exactly that, and anything else is
 * a typo worth naming rather than a lookup worth making.
 */
export function parseResumeId(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/^#/, '');
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ── Notices — shared by both surfaces so one refusal has one sentence. ────────────────────────────

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The banner a resumed session shows first: which conversation, when it started, how much of it is
 * on record, and under which command and model — the facts a person needs to confirm they picked
 * the right id. It also states the one thing a resume changes that nothing on screen shows: the
 * approvals granted in that conversation are in force again.
 */
export function resumedConversationNotice(target: ResumeTarget): SlashCommandNotice {
  const { summary } = target;
  const recorded = `${plural(summary.turnCount, 'turn')} recorded under gth ${summary.command ?? 'chat'}`;
  const model = summary.model ? `, with ${summary.model}` : '';
  return {
    title: `Resumed conversation #${target.conversationId}`,
    lines: [
      `Started ${summary.startedTs}${summary.project ? ` in ${summary.project}` : ''}.`,
      `${recorded}${model}.`,
      target.turns.length > 0
        ? 'The recorded turns are shown below; the model continues from where it left off.'
        : 'No turns were recorded yet; the model continues from where it left off.',
      'Approvals you granted in it are in force again, and new ones will be kept with it.',
    ],
  };
}

/**
 * The sentence for each refusal. One title states what did not happen and why; the body says what
 * to do instead. `inSession` picks the pointer: the slash commands a running session has, or the
 * CLI commands a shell has.
 */
export function resumeRefusalNotice(
  refusal: ResumeRefusal,
  options: { inSession?: boolean } = {}
): SlashCommandNotice {
  const list = options.inSession ? '/resume with no id' : '`gth history list`';
  switch (refusal.kind) {
    case 'history-off':
      return {
        title: 'Cannot resume: history is off',
        lines: [
          'Recording is on by default; `history.enabled: false` in your config turns it off, and ' +
            'this session has it off. Only a recorded conversation can be resumed.',
          'Remove that key, or set it to true, and start again.',
        ],
        tone: 'warn',
      };
    case 'store-unavailable':
      return {
        title: 'Cannot resume: the conversation store did not open',
        lines: [
          'The history database could not be opened, so nothing can be read from it; the notice ' +
            'about the store says why.',
          'Nothing was changed.',
        ],
        tone: 'warn',
      };
    case 'unknown':
      return {
        title: `No conversation #${refusal.id}`,
        lines: [
          'There is no conversation with that id in the history store.',
          `Run ${list} to see the ones that can be resumed.`,
        ],
        tone: 'warn',
      };
    case 'not-resumable': {
      const why =
        refusal.reason === 'single-shot'
          ? `It was recorded by \`gth ${refusal.command ?? 'ask'}\`, a single-shot run, which keeps ` +
            'no conversation state to pick up.'
          : refusal.reason === 'no-thread'
            ? 'Its conversation state is not on record: either a checkpoint write failed while it ' +
              'was running and it was marked unresumable, or it was recorded before conversation ' +
              'state was kept.'
            : refusal.reason === 'no-checkpoint'
              ? 'Its conversation state was never written — the session ended before its first ' +
                'turn completed.'
              : 'Its conversation state could not be read from the store.';
      return {
        title: `Conversation #${refusal.id} cannot be resumed`,
        lines: [why, `You can still read it with \`gth history show ${refusal.id}\`.`],
        tone: 'warn',
      };
    }
    case 'workspace-mismatch':
      return {
        title: `Conversation #${refusal.id} belongs to another project`,
        lines: [
          `It was recorded in ${refusal.stored}, and this session is in ${refusal.current}.`,
          'A conversation is resumed from the directory it was recorded in, because its tools and ' +
            'file paths point there. Change to that directory and run it again.',
          'Nothing was changed.',
        ],
        tone: 'warn',
      };
  }
}

/** A bare `/resume`: the conversations this session could move to, and how. */
export function resumePickerNotice(candidates: ConversationSummary[]): SlashCommandNotice {
  if (candidates.length === 0) {
    return {
      title: 'No other conversation can be resumed',
      lines: [
        'Only a conversation recorded by an interactive `chat` or `code` session that completed ' +
          'at least one turn can be resumed, and this session is not offered to itself.',
        'Nothing was changed.',
      ],
    };
  }
  return {
    title: 'Conversations you can resume',
    lines: [
      ...formatConversationList(candidates),
      'Resume one with /resume <id>. Later, from a shell, `gth history resume <id>` does the same.',
    ],
  };
}

/** `/resume <id>` naming the conversation the session is already in: nothing to do, and said so. */
export function resumeSameConversationNotice(id: number): SlashCommandNotice {
  return {
    title: `Already in conversation #${id}`,
    lines: ['This session is recording under that conversation now.', 'Nothing was changed.'],
  };
}

/** `/resume` on a surface with no conversation store behind it (the fixture agent). */
export function resumeUnavailableNotice(): SlashCommandNotice {
  return {
    title: 'Resume unavailable',
    lines: ['This session has no conversation store to resume from.', 'Nothing was changed.'],
    tone: 'warn',
  };
}

/** A resume whose apply step threw. The session is left in the conversation it was in. */
export function resumeFailedNotice(reason: string): SlashCommandNotice {
  return {
    title: 'Resume did not happen',
    lines: [`The session was left where it was: ${reason}`],
    tone: 'warn',
  };
}
