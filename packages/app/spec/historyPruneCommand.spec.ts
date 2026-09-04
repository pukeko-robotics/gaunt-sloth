/**
 * GS2-107 — `gth history prune`, and the size readout on `gth history list`.
 *
 * A real store over a temp file; the command is driven through commander exactly as the CLI does.
 *
 * **Every invocation passes `--db <temp>`.** This command deletes rows and runs a VACUUM, so an
 * invocation without it would resolve to the developer's own `~/.gsloth/history.db` — the file the
 * root vitest global-setup guard fingerprints. The dry-run default is the second layer of that: a
 * prune removes nothing until `--yes`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Command } from 'commander';

const startSessionMock = vi.hoisted(() => vi.fn());
vi.mock('#src/modules/startSession.js', () => ({ startSession: startSessionMock }));

const initConfigMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

const consoleMock = vi.hoisted(() => ({
  display: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleMock,
}));

const DAY = 24 * 60 * 60 * 1000;

describe('gth history prune (GS2-107)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-history-prune-'));
    dbPath = resolve(dir, 'history.db');
    initConfigMock.mockResolvedValue({ history: { dbPath } });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Everything the console was told, as one string, so a sentence can be asserted whole. */
  const output = (): string =>
    [
      ...consoleMock.display.mock.calls,
      ...consoleMock.displayInfo.mock.calls,
      ...consoleMock.displayWarning.mock.calls,
      ...consoleMock.displaySuccess.mock.calls,
    ]
      .map((c) => String(c[0]))
      .join('\n');

  const run = async (...args: string[]) => {
    const { historyCommand } = await import('#src/commands/historyCommand.js');
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    historyCommand(program, {});
    await program.parseAsync(['node', 'gth', 'history', ...args]);
  };

  /**
   * A conversation with `checkpoints` checkpoints under its thread, last active `ageDays` ago.
   * Built through the real store and the real saver, so the schema is the product's.
   */
  const seed = async (options: {
    threadId: string;
    ageDays: number;
    checkpoints?: number;
    payload?: number;
    named?: boolean;
  }): Promise<number | undefined> => {
    const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
    const { openCheckpointSaver } = await import('@gaunt-sloth/core/history/checkpointSaver.js');
    const ts = new Date(Date.now() - options.ageDays * DAY).toISOString();
    const store = openHistoryStore(dbPath, { create: true })!;
    let id: number | undefined;
    if (options.named !== false) {
      id = store.openConversation({ command: 'code', ts, threadId: options.threadId })!;
      store.record({ conversationId: id, command: 'code', ts, prompt: 'p', response: 'r' });
    }
    store.close();
    const saver = openCheckpointSaver(dbPath)!;
    const payload = 'x'.repeat(options.payload ?? 2000);
    for (let i = 0; i < (options.checkpoints ?? 3); i++) {
      await saver.put(
        {
          configurable: {
            thread_id: options.threadId,
            checkpoint_ns: '',
            ...(i > 0 ? { checkpoint_id: `cp-${options.threadId}-${i - 1}` } : {}),
          },
        },
        {
          v: 4,
          id: `cp-${options.threadId}-${i}`,
          ts,
          channel_values: { messages: payload },
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: i, parents: {} },
        {}
      );
    }
    saver.close();
    return id;
  };

  const threadsInStore = (): string[] => {
    const db = new DatabaseSync(dbPath);
    const rows = db
      .prepare(`SELECT DISTINCT thread_id FROM checkpoints ORDER BY thread_id`)
      .all() as Record<string, unknown>[];
    db.close();
    return rows.map((r) => String(r.thread_id));
  };

  it('refuses to guess a bound, and removes nothing', async () => {
    await seed({ threadId: 't-old', ageDays: 400 });
    await run('prune', '--db', dbPath);
    expect(output()).toContain('needs a bound');
    expect(threadsInStore()).toEqual(['t-old']);
  });

  it('says what it will remove and removes nothing without --yes', async () => {
    const id = await seed({ threadId: 't-old', ageDays: 90 });
    await run('prune', '--older-than', '30', '--db', dbPath);
    const said = output();
    expect(said).toContain(`#${id}`);
    expect(said).toContain('Would remove the stored state of 1 conversation');
    expect(said).toContain('Their transcripts stay');
    expect(said).toContain('Re-run with `--yes`');
    expect(threadsInStore()).toEqual(['t-old']);
  });

  it('removes what it names and nothing else, and the control conversation survives', async () => {
    const oldId = await seed({ threadId: 't-old', ageDays: 90 });
    const keptId = await seed({ threadId: 't-recent', ageDays: 2 });
    await run('prune', '--older-than', '30', '--yes', '--db', dbPath);

    expect(threadsInStore()).toEqual(['t-recent']);
    // The transcript is not what went: both conversations are still listable and readable.
    const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
    const store = openHistoryStore(dbPath)!;
    expect(
      store
        .listConversations(10)
        .map((c) => c.id)
        .sort()
    ).toEqual([oldId!, keptId!].sort());
    expect(store.getConversationThread(oldId!)).toHaveLength(1);
    store.close();
    expect(output()).toContain('Removed 3 checkpoints');
  });

  it('the file gets smaller — the VACUUM is what gives the space back', async () => {
    await seed({ threadId: 't-bulk', ageDays: 90, checkpoints: 40, payload: 20_000 });
    await seed({ threadId: 't-keep', ageDays: 1, checkpoints: 1, payload: 100 });
    const before = statSync(dbPath).size;
    expect(before).toBeGreaterThan(500_000);

    await run('prune', '--older-than', '30', '--yes', '--db', dbPath);

    const after = statSync(dbPath).size;
    expect(after).toBeLessThan(before / 2);
    expect(output()).toContain('after VACUUM');
    expect(threadsInStore()).toEqual(['t-keep']);
  });

  it('a count bound keeps the N most recent conversations WHOLE', async () => {
    await seed({ threadId: 't1', ageDays: 1 });
    await seed({ threadId: 't2', ageDays: 2 });
    await seed({ threadId: 't3', ageDays: 3 });
    await run('prune', '--keep-last', '2', '--yes', '--db', dbPath);
    expect(threadsInStore()).toEqual(['t1', 't2']);
    // Whole, not truncated: the kept conversations still hold every checkpoint they had.
    const db = new DatabaseSync(dbPath);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = 't1'`).get()
    ).toMatchObject({ n: 3 });
    db.close();
  });

  it('reclaims an unaddressable thread alongside, and says so', async () => {
    await seed({ threadId: 't-named', ageDays: 1 });
    await seed({ threadId: 't-orphan', ageDays: 90, named: false });
    await run('prune', '--keep-last', '5', '--yes', '--db', dbPath);
    expect(output()).toContain('no conversation names');
    expect(threadsInStore()).toEqual(['t-named']);
  });

  it('refuses a bound that is not a whole number rather than reinterpreting it', async () => {
    await seed({ threadId: 't-old', ageDays: 400 });
    await run('prune', '--older-than', 'soon', '--yes', '--db', dbPath);
    expect(output()).toContain('is not a positive whole number');
    expect(threadsInStore()).toEqual(['t-old']);
  });

  /**
   * GS2-107 fix round, finding E — the docstring said non-positive values were refused and the code
   * accepted `0`, which is the widest delete this command can make: `--older-than 0` means "older
   * than right now", so every conversation with stored state is selected, reached by typing the
   * smallest-looking bound there is. `--keep-last 0` is the same sentence from the other end.
   *
   * The empty forms are here because `Number('')` and `Number('  ')` are both `0` rather than
   * `NaN`, so they arrive at the numeric test already looking like a valid bound.
   */
  it.each([
    ['--older-than', '0'],
    ['--keep-last', '0'],
    ['--older-than', ''],
    ['--keep-last', '   '],
  ])('refuses %s %s and removes nothing', async (flag, value) => {
    await seed({ threadId: 't-old', ageDays: 400 });
    await run('prune', flag, value, '--yes', '--db', dbPath);
    expect(output()).toContain('is not a positive whole number');
    expect(output()).not.toContain('History prune complete');
    expect(threadsInStore()).toEqual(['t-old']);
  });

  /**
   * GS2-107 fix round, finding F — the command a person types has neither of the automatic pass's
   * guards, and the plan is where it says so. The marker rides on the row, the paragraph appears
   * once, and both are absent when nothing selected is recent — so a person reading a plan full of
   * year-old conversations is not told to worry about a window that is not open.
   */
  it('marks a recently active conversation in the plan and says prune does not skip an open one', async () => {
    await seed({ threadId: 't-newest', ageDays: 0 });
    await seed({ threadId: 't-hours-ago', ageDays: 0.2 });
    await seed({ threadId: 't-ancient', ageDays: 400 });
    await run('prune', '--keep-last', '1', '--db', dbPath);
    expect(output()).toContain('active today');
    expect(output()).toContain('may be open in another window right now');
    expect(output()).toContain('does not skip an open conversation');
    expect(threadsInStore()).toEqual(['t-ancient', 't-hours-ago', 't-newest']);
  });

  it('says none of that when everything selected is old', async () => {
    await seed({ threadId: 't-newest', ageDays: 0 });
    await seed({ threadId: 't-ancient', ageDays: 400 });
    await run('prune', '--keep-last', '1', '--db', dbPath);
    expect(output()).toContain('#');
    expect(output()).not.toContain('active today');
    expect(output()).not.toContain('may be open in another window right now');
  });

  it('says there is no history rather than creating a database', async () => {
    const absent = resolve(dir, 'nothing-here.db');
    await run('prune', '--older-than', '30', '--yes', '--db', absent);
    expect(output()).toContain('No session history found');
    expect(() => statSync(absent)).toThrow();
  });

  describe('the size readout on `gth history list`', () => {
    it('reports the shape the store was built to', async () => {
      await seed({ threadId: 't-a', ageDays: 1, checkpoints: 4, payload: 3000 });
      await seed({ threadId: 't-b', ageDays: 2, checkpoints: 2, payload: 3000 });
      await run('list', '--db', dbPath);
      const said = output();
      expect(said).toContain('Conversation store:');
      expect(said).toContain('6 checkpoints across 2 threads');
      expect(said).toContain('gth history prune');
    });

    it('MUTATION CONTROL: the numbers move with the store', async () => {
      await seed({ threadId: 't-a', ageDays: 1, checkpoints: 4, payload: 3000 });
      await run('list', '--db', dbPath);
      expect(output()).toContain('4 checkpoints across 1 thread');
      vi.resetAllMocks();
      initConfigMock.mockResolvedValue({ history: { dbPath } });
      await seed({ threadId: 't-b', ageDays: 1, checkpoints: 5, payload: 3000 });
      await run('list', '--db', dbPath);
      expect(output()).toContain('9 checkpoints across 2 threads');
    });

    it('stays quiet when there are no checkpoints to report', async () => {
      const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
      const store = openHistoryStore(dbPath, { create: true })!;
      store.record({ command: 'ask', prompt: 'p', response: 'r' });
      store.close();
      await run('list', '--db', dbPath);
      expect(output()).not.toContain('Conversation store:');
    });
  });
});
