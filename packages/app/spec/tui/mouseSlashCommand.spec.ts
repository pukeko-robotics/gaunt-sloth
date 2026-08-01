import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCommandRegistry,
  dispatchSlashCommand,
  parseMouseArg,
  parseSlashCommand,
  type SlashCommandContext,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import { MOUSE_SELECTION_HINT } from '@gaunt-sloth/core/config/mouse.js';

const context = (over: Partial<SlashCommandContext> = {}): SlashCommandContext => ({
  mode: 'chat',
  modelDisplayName: 'test-model',
  turnCount: 0,
  toolsExpanded: false,
  debugVisible: false,
  mouseEnabled: true,
  ...over,
});

const run = (line: string, ctx: SlashCommandContext) =>
  dispatchSlashCommand(parseSlashCommand(line)!, createCommandRegistry(), ctx, {
    duringRun: false,
  });

describe('parseMouseArg', () => {
  it('toggles when given no argument', () => {
    expect(parseMouseArg([], true)).toBe(false);
    expect(parseMouseArg([], false)).toBe(true);
  });

  it('reads on and off explicitly, case-insensitively', () => {
    expect(parseMouseArg(['on'], false)).toBe(true);
    expect(parseMouseArg(['OFF'], true)).toBe(false);
  });

  it('is idempotent — /mouse on while already on stays on', () => {
    expect(parseMouseArg(['on'], true)).toBe(true);
  });

  it('returns null for anything else, so the caller can say so instead of guessing', () => {
    expect(parseMouseArg(['maybe'], true)).toBeNull();
  });
});

describe('/mouse', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is registered and self-described in the registry', () => {
    const command = createCommandRegistry().find((c) => c.name === 'mouse');
    expect(command).toBeDefined();
    expect(command!.description).toContain('mouse');
  });

  it('turns mouse off from on', () => {
    const result = run('/mouse off', context({ mouseEnabled: true }));
    expect(result.setMouse).toBe(false);
    expect(result.notice?.title).toBe('Mouse off');
  });

  it('turns mouse on from off', () => {
    const result = run('/mouse on', context({ mouseEnabled: false }));
    expect(result.setMouse).toBe(true);
    expect(result.notice?.title).toBe('Mouse on');
  });

  it('toggles with no argument, from the CURRENT state', () => {
    expect(run('/mouse', context({ mouseEnabled: true })).setMouse).toBe(false);
    expect(run('/mouse', context({ mouseEnabled: false })).setMouse).toBe(true);
  });

  it('tells the user how to select text whenever it reports mouse on', () => {
    // The moment someone runs /mouse is the moment they are trying to copy something and finding
    // that dragging no longer selects. Answering it there is the whole point of the hint.
    const result = run('/mouse on', context({ mouseEnabled: false }));
    expect(result.notice?.lines).toContain(MOUSE_SELECTION_HINT);
  });

  it('names both the session and the permanent way to turn it off', () => {
    const lines = run('/mouse on', context({ mouseEnabled: false })).notice!.lines.join(' ');
    expect(lines).toContain('/mouse off');
    expect(lines).toContain('useMouse');
  });

  it('warns on an unrecognised argument without changing anything', () => {
    const result = run('/mouse sideways', context({ mouseEnabled: true }));
    expect(result.setMouse).toBeUndefined();
    expect(result.notice?.tone).toBe('warn');
  });

  it('reports itself unavailable on a surface with no mouse layer, rather than claiming "off"', () => {
    const result = run('/mouse', context({ mouseEnabled: undefined }));
    expect(result.setMouse).toBeUndefined();
    expect(result.notice?.title).toBe('Mouse unavailable');
    expect(result.notice?.tone).toBe('warn');
  });

  it('is available mid-turn — wanting to copy something does not wait for the run to finish', () => {
    const result = dispatchSlashCommand(
      parseSlashCommand('/mouse off')!,
      createCommandRegistry(),
      context({ mouseEnabled: true }),
      { duringRun: true }
    );
    expect(result.setMouse).toBe(false);
  });
});
