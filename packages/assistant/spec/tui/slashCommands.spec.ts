import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '#src/tui/slashCommands.js';

const ctx: SlashCommandContext = {
  mode: 'chat',
  modelDisplayName: 'claude-opus-4',
  turnCount: 3,
};

describe('tui/slashCommands parseSlashCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null for plain (non-slash) input', async () => {
    const { parseSlashCommand } = await import('#src/tui/slashCommands.js');
    expect(parseSlashCommand('hello world')).toBeNull();
    expect(parseSlashCommand('  not a command')).toBeNull();
  });

  it('returns null for a bare slash', async () => {
    const { parseSlashCommand } = await import('#src/tui/slashCommands.js');
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('  /   ')).toBeNull();
  });

  it('parses the command name (lower-cased) and args', async () => {
    const { parseSlashCommand } = await import('#src/tui/slashCommands.js');
    expect(parseSlashCommand('/Help')).toEqual({ name: 'help', args: [] });
    expect(parseSlashCommand('  /mode  foo bar ')).toEqual({ name: 'mode', args: ['foo', 'bar'] });
  });
});

describe('tui/slashCommands dispatchSlashCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('/help lists every registered command', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const registry = createCommandRegistry();
    const result = dispatchSlashCommand(parseSlashCommand('/help')!, registry, ctx);
    expect(result.message).toContain('Available commands');
    for (const c of registry) {
      expect(result.message).toContain(`/${c.name}`);
      expect(result.message).toContain(c.description);
    }
  });

  it('/clear requests a transcript clear', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/clear')!, createCommandRegistry(), ctx);
    expect(result.clearTranscript).toBe(true);
  });

  it('/debug requests a debug-panel toggle', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/debug')!, createCommandRegistry(), ctx);
    expect(result.toggleDebug).toBe(true);
    expect(result.exit).toBeUndefined();
  });

  it('/exit requests an app quit', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/exit')!, createCommandRegistry(), ctx);
    expect(result.exit).toBe(true);
  });

  it('/mode surfaces the current mode', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/mode')!, createCommandRegistry(), ctx);
    expect(result.message).toBe('mode: chat');
  });

  it('/model surfaces the model display name', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/model')!, createCommandRegistry(), ctx);
    expect(result.message).toBe('model: claude-opus-4');
  });

  it('/model falls back to "unknown" when no display name is set', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/model')!, createCommandRegistry(), {
      ...ctx,
      modelDisplayName: '',
    });
    expect(result.message).toBe('model: unknown');
  });

  it('an unknown command yields a friendly hint at warn level, never throws', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const result = dispatchSlashCommand(parseSlashCommand('/foo')!, createCommandRegistry(), ctx);
    expect(result.message).toContain('Unknown command: /foo');
    expect(result.message).toContain('/help');
    expect(result.level).toBe('warn');
    expect(result.exit).toBeUndefined();
  });

  it('registry is a fresh array each call so extensions can append (EXT-5)', async () => {
    const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
      await import('#src/tui/slashCommands.js');
    const registry = createCommandRegistry();
    expect(createCommandRegistry()).not.toBe(registry);
    registry.push({
      name: 'ping',
      description: 'extension command',
      run: () => ({ message: 'pong' }),
    });
    const result = dispatchSlashCommand(parseSlashCommand('/ping')!, registry, ctx);
    expect(result.message).toBe('pong');
  });
});
