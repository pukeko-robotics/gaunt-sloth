/**
 * GS2-20 — `gth history resume <id>`: starts the session in the mode the conversation was recorded
 * under, with the resume id, and fails soft — a warning, no session — for a single-shot row, an
 * unknown id, a bad id, or history turned off. Takes no `--db`. Real store over a temp file; the
 * session itself is mocked at `startSession`, which is where the seam takes over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleMock,
}));

describe('gth history resume <id> (GS2-20)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-history-resume-'));
    dbPath = resolve(dir, 'history.db');
    initConfigMock.mockResolvedValue({ history: { dbPath } });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = async () => {
    const { openConversationSafe, recordSessionSafe } =
      await import('@gaunt-sloth/core/history/recordSession.js');
    const config = { history: { dbPath } };
    const codeId = openConversationSafe(config, { command: 'code', threadId: 'thread-code' })!;
    recordSessionSafe(config, {
      conversationId: codeId,
      command: 'code',
      prompt: 'p',
      response: 'r',
    });
    const chatId = openConversationSafe(config, { command: 'chat', threadId: 'thread-chat' })!;
    recordSessionSafe(config, {
      conversationId: chatId,
      command: 'chat',
      prompt: 'p',
      response: 'r',
    });
    const askId = recordSessionSafe(config, { command: 'ask', prompt: 'p', response: 'r' })!;
    return { codeId, chatId, askId };
  };

  /** A fresh program per invocation — commander refuses to register `history` twice. */
  const run = async (...args: string[]) => {
    const { historyCommand } = await import('#src/commands/historyCommand.js');
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    historyCommand(program, { global: true });
    await program.parseAsync(['node', 'gth', 'history', 'resume', ...args]);
  };

  it('starts a code session inside a conversation recorded by gth code, passing the overrides through', async () => {
    const { codeId } = await seed();
    await run(String(codeId));
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    const [sessionConfig, overrides, message, options] = startSessionMock.mock.calls[0];
    expect(sessionConfig).toEqual(expect.objectContaining({ mode: 'code' }));
    expect(overrides).toEqual({ global: true });
    expect(message).toBeUndefined();
    expect(options).toEqual({ resumeConversationId: codeId });
    // The config it looked the row up in is the one the session will run under.
    expect(initConfigMock).toHaveBeenCalledWith({ global: true });
    expect(consoleMock.displayWarning).not.toHaveBeenCalled();
  });

  it('starts a chat session inside a conversation recorded by gth chat', async () => {
    const { chatId } = await seed();
    await run(String(chatId));
    expect(startSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'chat' }),
      { global: true },
      undefined,
      { resumeConversationId: chatId }
    );
  });

  it('fails soft for a single-shot run: a warning naming the command, and no session', async () => {
    const { askId } = await seed();
    await run(String(askId));
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledTimes(1);
    const [warning] = consoleMock.displayWarning.mock.calls[0];
    expect(warning).toContain(`Conversation #${askId}`);
    expect(warning).toContain('`gth ask`');
    expect(warning).toContain('single-shot');
    expect(warning).toContain(`gth history show ${askId}`);
  });

  it('fails soft for an unknown id and for an id that is not one', async () => {
    await seed();
    await run('9999');
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('No conversation #9999')
    );
    consoleMock.displayWarning.mockClear();
    await run('abc');
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledWith('Invalid conversation id "abc".');
    // No config was loaded for a bad id — nothing to load it for.
    expect(initConfigMock).toHaveBeenCalledTimes(1);
  });

  it('fails soft when history is off, naming the switch', async () => {
    const { codeId } = await seed();
    initConfigMock.mockResolvedValue({ history: { dbPath, enabled: false } });
    await run(String(codeId));
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('`history.enabled: false`')
    );
  });

  it('with no store at all says there is no history yet — the sentence history list uses — not that the id is unknown', async () => {
    // Nothing seeded: the database file does not exist.
    const { NO_HISTORY_MESSAGE } = await import('#src/commands/historyCommand.js');
    await run('1');
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledTimes(1);
    const [warning] = consoleMock.displayWarning.mock.calls[0];
    expect(warning).toBe(NO_HISTORY_MESSAGE);
    expect(warning).toContain('No session history found');
    expect(warning).not.toContain('No conversation #1');
  });

  it('takes no --db: the store is the one the session config names', async () => {
    const { codeId } = await seed();
    await expect(run(String(codeId), '--db', '/tmp/other.db')).rejects.toMatchObject({
      code: 'commander.unknownOption',
    });
    expect(startSessionMock).not.toHaveBeenCalled();
  });
});
