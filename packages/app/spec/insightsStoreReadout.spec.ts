/**
 * GS2-107 — `gth insights` reports over the conversation store as well as the session totals: how
 * many bytes, how many checkpoints, across how many threads, and which threads are the big ones.
 * That is what makes the volume visible without anyone having to decide a policy first.
 *
 * A real store over a temp file, driven through commander. `--db <temp>` on every invocation: this
 * command is read-only, but the same habit is what keeps the developer's own history out of the
 * suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Command } from 'commander';

const consoleMock = vi.hoisted(() => ({
  display: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleMock,
}));

describe('gth insights — the conversation-store readout (GS2-107)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-insights-store-'));
    dbPath = resolve(dir, 'history.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const output = (): string =>
    [
      ...consoleMock.display.mock.calls,
      ...consoleMock.displayInfo.mock.calls,
      ...consoleMock.displayWarning.mock.calls,
    ]
      .map((c) => String(c[0]))
      .join('\n');

  const run = async (...args: string[]) => {
    const { insightsCommand } = await import('#src/commands/insightsCommand.js');
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    insightsCommand(program);
    await program.parseAsync(['node', 'gth', 'insights', ...args]);
  };

  /** A conversation with `checkpoints` checkpoints under its thread; `named: false` for an orphan. */
  const seed = async (options: {
    threadId: string;
    checkpoints: number;
    payload?: number;
    named?: boolean;
  }): Promise<void> => {
    const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
    const { openCheckpointSaver } = await import('@gaunt-sloth/core/history/checkpointSaver.js');
    const store = openHistoryStore(dbPath, { create: true })!;
    if (options.named !== false) {
      const id = store.openConversation({ command: 'code', threadId: options.threadId })!;
      store.record({ conversationId: id, command: 'code', prompt: 'p', response: 'r' });
    }
    store.close();
    const saver = openCheckpointSaver(dbPath)!;
    const payload = 'x'.repeat(options.payload ?? 1000);
    for (let i = 0; i < options.checkpoints; i++) {
      await saver.put(
        { configurable: { thread_id: options.threadId, checkpoint_ns: '' } },
        {
          v: 4,
          id: `cp-${options.threadId}-${i}`,
          ts: new Date().toISOString(),
          channel_values: { messages: payload },
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: i, parents: {} },
        {}
      );
    }
    saver.close();
  };

  it('reports the shape the store was built to, file size and checkpoint share apart', async () => {
    await seed({ threadId: 't-big', checkpoints: 6, payload: 4000 });
    await seed({ threadId: 't-small', checkpoints: 2, payload: 10 });
    await seed({ threadId: 't-orphan', checkpoints: 1, payload: 10, named: false });

    await run('--db', dbPath);
    const said = output();
    expect(said).toContain('Conversation store (local only):');
    expect(said).toContain('Checkpoints: 9 across 3 threads');
    expect(said).toContain('1 thread no conversation names');
    expect(said).toContain('Largest threads:');
    expect(said).toContain('conversation #1 [code]');
    expect(said).toContain('no conversation (not resumable)');
    // The database file is bigger than the checkpoint blobs it holds — two numbers, not one.
    expect(said).toContain(`(${dbPath})`);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
  });

  it('MUTATION CONTROL: the numbers move with the store rather than being printed from a constant', async () => {
    await seed({ threadId: 't-a', checkpoints: 2 });
    await run('--db', dbPath);
    expect(output()).toContain('Checkpoints: 2 across 1 thread');

    vi.resetAllMocks();
    await seed({ threadId: 't-b', checkpoints: 5 });
    await run('--db', dbPath);
    expect(output()).toContain('Checkpoints: 7 across 2 threads');
  });

  it('says there is no history rather than creating a database', async () => {
    const absent = resolve(dir, 'absent.db');
    await run('--db', absent);
    expect(output()).toContain('No session history found');
    expect(() => statSync(absent)).toThrow();
  });
});
