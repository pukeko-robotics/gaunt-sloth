/**
 * GS2-20 — `/resume` in the shared slash-command registry: registered beside `/compact`, idle-only,
 * listed by `/help`, pure (a `resume` effect, nothing else), its id validated before anything is
 * looked up; and `/status` naming the conversation being recorded.
 */
import { describe, expect, it } from 'vitest';
import {
  createCommandRegistry,
  dispatchSlashCommand,
  filterSlashCommands,
  formatHelp,
  parseSlashCommand,
  type SlashCommandContext,
} from '#src/modules/slashCommands.js';

const ctx: SlashCommandContext = {
  mode: 'code',
  modelDisplayName: 'test-model',
  turnCount: 3,
  toolsExpanded: false,
  debugVisible: false,
};

const run = (line: string, over: Partial<SlashCommandContext> = {}, duringRun = false) =>
  dispatchSlashCommand(
    parseSlashCommand(line)!,
    createCommandRegistry(),
    { ...ctx, ...over },
    {
      duringRun,
    }
  );

describe('GS2-20 /resume — registry', () => {
  it('is registered, idle-only, and listed by /help', () => {
    const registry = createCommandRegistry();
    const command = registry.find((c) => c.name === 'resume');
    expect(command).toBeDefined();
    expect(command!.availableDuringRun).toBeFalsy();
    expect(formatHelp(registry).lines.some((line) => line.startsWith('/resume — '))).toBe(true);
    expect(run('/help').notice!.lines.some((line) => line.startsWith('/resume — '))).toBe(true);
    expect(filterSlashCommands(registry, 'resu').map((c) => c.name)).toEqual(['resume']);
  });

  it('bare /resume asks the surface to list; /resume <id> asks it to resume that id', () => {
    expect(run('/resume')).toEqual({ resume: {} });
    expect(run('/resume 12')).toEqual({ resume: { id: 12 } });
    expect(run('/resume #12')).toEqual({ resume: { id: 12 } });
    expect(run('/resume 12').notice).toBeUndefined();
    expect(run('/resume 12').clearTranscript).toBeUndefined();
  });

  it('names an id that is not one, and asks for nothing', () => {
    for (const line of ['/resume abc', '/resume 0', '/resume -1', '/resume 1 2', '/resume 1.5']) {
      const result = run(line);
      expect(result.resume, line).toBeUndefined();
      expect(result.notice?.title, line).toContain('Not a conversation id:');
      expect(result.notice?.lines.join(' '), line).toContain('Usage: /resume [<id>]');
      expect(result.notice?.tone, line).toBe('warn');
    }
    expect(run('/resume abc').notice?.title).toBe('Not a conversation id: abc');
  });

  it('is refused while a turn is running, like /clear and /compact', () => {
    const result = run('/resume 12', {}, true);
    expect(result.resume).toBeUndefined();
    expect(result.notice?.title).toBe('/resume is not available while the agent is working');
  });
});

describe('GS2-20 /status — names the conversation', () => {
  it('names the id being recorded, and what takes it', () => {
    const lines = run('/status', { conversationId: 42 }).notice!.lines;
    const line = lines.find((l) => l.startsWith('Conversation:'));
    expect(line).toBe(
      'Conversation: #42 — pick it up later with `gth history resume 42`, or switch with ' +
        '/resume <id>.'
    );
    // The rest of the block is untouched.
    expect(lines).toContain('Turns so far: 3');
  });

  it('says so when nothing is being recorded', () => {
    const lines = run('/status').notice!.lines;
    expect(lines.find((l) => l.startsWith('Conversation:'))).toBe(
      'Conversation: not being recorded, so this session cannot be resumed later.'
    );
  });
});
