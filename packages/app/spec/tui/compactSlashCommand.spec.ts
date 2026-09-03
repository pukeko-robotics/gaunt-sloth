/**
 * GS2-23 — `/compact` in the shared slash-command registry: registered, idle-only, listed by
 * `/help`, pure (it returns a `compact` effect and touches nothing), and its notices built from
 * what the runner returns.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationCompaction } from '@gaunt-sloth/core/core/compaction.js';
import {
  COMPACTING_LINE,
  compactionFailedNotice,
  compactionNotice,
  compactionUnavailableNotice,
  createCommandRegistry,
  dispatchSlashCommand,
  filterSlashCommands,
  formatHelp,
  parseSlashCommand,
  type SlashCommandContext,
} from '@gaunt-sloth/agent/modules/slashCommands.js';

const ctx: SlashCommandContext = {
  mode: 'chat',
  modelDisplayName: 'test-model',
  turnCount: 3,
  toolsExpanded: false,
  debugVisible: false,
};

const outcome = (over: Partial<ConversationCompaction> = {}): ConversationCompaction => ({
  changed: true,
  removedCount: 4,
  keptCount: 6,
  keepRecent: 6,
  summaryText: 'SUMMARY',
  before: { messages: 10, characters: 12345 },
  after: { messages: 7, characters: 2100 },
  ...over,
});

describe('GS2-23 /compact — registry', () => {
  it('is registered, idle-only, and listed by /help', () => {
    const registry = createCommandRegistry();
    const command = registry.find((c) => c.name === 'compact');
    expect(command).toBeDefined();
    expect(command!.availableDuringRun).toBeFalsy();
    const help = formatHelp(registry);
    expect(help.lines.some((line) => line.startsWith('/compact — '))).toBe(true);
    // The dispatcher's own /help path lists it too.
    const viaDispatch = dispatchSlashCommand(parseSlashCommand('/help')!, registry, ctx);
    expect(viaDispatch.notice!.lines.some((line) => line.startsWith('/compact — '))).toBe(true);
  });

  it('returns a compact effect and nothing else; free text after it is the focus', () => {
    const registry = createCommandRegistry();
    const bare = dispatchSlashCommand(parseSlashCommand('/compact')!, registry, ctx);
    expect(bare).toEqual({ compact: {} });
    const focused = dispatchSlashCommand(
      parseSlashCommand('/compact keep the   file names')!,
      registry,
      ctx
    );
    expect(focused).toEqual({ compact: { focus: 'keep the file names' } });
    expect(focused.notice).toBeUndefined();
    expect(focused.clearTranscript).toBeUndefined();
  });

  it('is refused while a turn is running, like /clear', () => {
    const result = dispatchSlashCommand(
      parseSlashCommand('/compact')!,
      createCommandRegistry(),
      ctx,
      {
        duringRun: true,
      }
    );
    expect(result.compact).toBeUndefined();
    expect(result.notice?.title).toBe('/compact is not available while the agent is working');
  });

  it('is reachable from the slash menu by prefix', () => {
    expect(filterSlashCommands(createCommandRegistry(), 'comp').map((c) => c.name)).toEqual([
      'compact',
    ]);
  });
});

describe('GS2-23 /compact — notices', () => {
  it('a landed compaction says what was folded, what was kept, the size change, and what did not change', () => {
    const notice = compactionNotice(outcome(), 'the migration plan');
    expect(notice.title).toBe('Conversation compacted');
    expect(notice.tone).toBeUndefined();
    expect(notice.lines[0]).toBe(
      'Folded 4 older messages into a summary and kept the last 6 word for word.'
    );
    expect(notice.lines[1]).toBe(
      'Model context: 10 messages (~12,345 characters) → 7 messages (~2,100 characters).'
    );
    expect(notice.lines[2]).toBe('Summary focus: the migration plan');
    expect(notice.lines[3]).toContain('The transcript on screen is unchanged');
    expect(notice.lines[3]).toContain('a resumed session stays compacted');
    // No focus, no focus line.
    expect(compactionNotice(outcome()).lines).toHaveLength(3);
  });

  it('says when the kept tail is wider than asked, and why', () => {
    const notice = compactionNotice(outcome({ keptCount: 7, keepRecent: 6 }));
    expect(notice.lines[0]).toBe(
      'Folded 4 older messages into a summary and kept the last 7 word for word (6 were asked for; ' +
        'a tool call and its result stay together).'
    );
  });

  it('a no-op compaction reports nothing to compact and that nothing was changed', () => {
    const notice = compactionNotice(
      outcome({
        changed: false,
        removedCount: 0,
        keptCount: 2,
        before: { messages: 2, characters: 40 },
        after: { messages: 2, characters: 40 },
      })
    );
    expect(notice.title).toBe('Nothing to compact');
    expect(notice.lines[0]).toBe(
      'The conversation holds 2 messages, and the last 6 are always kept word for word, so there ' +
        'is nothing older to fold.'
    );
    expect(notice.lines[1]).toBe('Nothing was changed.');
  });

  it('unavailable and failed are warn-toned and both say the conversation was not changed', () => {
    const unavailable = compactionUnavailableNotice();
    expect(unavailable.tone).toBe('warn');
    expect(unavailable.lines).toContain('Nothing was changed.');
    const failed = compactionFailedNotice('provider down');
    expect(failed.tone).toBe('warn');
    expect(failed.title).toBe('Compaction did not happen');
    expect(failed.lines[0]).toBe('The conversation was left unchanged: provider down');
    expect(COMPACTING_LINE).toContain('Compacting the conversation');
  });
});
