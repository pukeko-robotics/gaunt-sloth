import { describe, expect, it } from 'vitest';
import {
  parseChecklistArgs,
  extractActiveChecklist,
  CHECKLIST_TOOL_NAME,
  type TurnViewModel,
} from '#src/tui/viewModel.js';
import type { TranscriptItem } from '#src/tui/types.js';

describe('viewModel — checklist parsing', () => {
  it('exposes the checklist tool name', () => {
    expect(CHECKLIST_TOOL_NAME).toBe('gth_checklist');
  });

  it('parses a complete args buffer into typed rows', () => {
    const args = JSON.stringify({
      items: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
    });
    expect(parseChecklistArgs(args)).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]);
  });

  it('returns null for an empty or half-streamed buffer (never throws)', () => {
    expect(parseChecklistArgs('')).toBeNull();
    expect(parseChecklistArgs('   ')).toBeNull();
    expect(parseChecklistArgs('{"items":[{"content":"a","stat')).toBeNull();
  });

  it('drops malformed rows but keeps valid ones', () => {
    const args = JSON.stringify({
      items: [
        { content: 'ok', status: 'pending' },
        { content: 'bad-status', status: 'nope' },
        { status: 'pending' },
        { content: 'also-ok', status: 'completed' },
      ],
    });
    expect(parseChecklistArgs(args)).toEqual([
      { content: 'ok', status: 'pending' },
      { content: 'also-ok', status: 'completed' },
    ]);
  });

  /**
   * REL-18 — the row text is neutralised by the PARSER, so every consumer of a
   * `ChecklistItemViewModel` inherits it and no renderer has to remember. The dock-level proof that
   * this reaches the screen is `checklistDockNeutralisation.spec.tsx`; this pins the function the
   * guard actually sits on, which is the thing a rewrite of the panel would leave standing.
   */
  it('neutralises the model-written row text', () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const args = JSON.stringify({
      items: [{ content: `a${ESC}[31mb${ESC}]0;t${BEL}c${ESC}[2Ad`, status: 'pending' }],
    });
    expect(parseChecklistArgs(args)).toEqual([
      { content: 'a\\x1b[31mb\\x1b]0;t\\x07c\\x1b[2Ad', status: 'pending' },
    ]);
  });

  it('returns null when items is missing or not an array', () => {
    expect(parseChecklistArgs('{"items":"x"}')).toBeNull();
    expect(parseChecklistArgs('{}')).toBeNull();
    expect(parseChecklistArgs('{"items":[]}')).toBeNull();
  });

  it('extractActiveChecklist prefers live turn and falls back to transcript in reverse order', () => {
    const live: TurnViewModel = {
      isReasoning: false,
      segments: [
        {
          kind: 'tool',
          tool: {
            id: '1',
            name: CHECKLIST_TOOL_NAME,
            argsText: JSON.stringify({ items: [{ content: 'Live item', status: 'in_progress' }] }),
            status: 'running',
          },
        },
      ],
    };

    const transcript: TranscriptItem[] = [
      {
        kind: 'assistant',
        id: 1,
        turn: {
          isReasoning: false,
          segments: [
            {
              kind: 'tool',
              tool: {
                id: '0',
                name: CHECKLIST_TOOL_NAME,
                argsText: JSON.stringify({
                  items: [{ content: 'Old item', status: 'completed' }],
                }),
                status: 'done',
              },
            },
          ],
        },
      },
    ];

    expect(extractActiveChecklist(live, transcript)).toEqual([
      { content: 'Live item', status: 'in_progress' },
    ]);

    expect(extractActiveChecklist(null, transcript)).toEqual([
      { content: 'Old item', status: 'completed' },
    ]);

    expect(extractActiveChecklist(null, [])).toBeNull();
  });
});
