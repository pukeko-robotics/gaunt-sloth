import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Box, renderToString } from 'ink';
import {
  estimateItemRows,
  transcriptWindowStart,
  TRANSCRIPT_WINDOW_SLACK_ITEMS,
} from '#src/tui/transcriptWindow.js';
import { TranscriptViewport } from '#src/tui/components/TranscriptViewport.js';
import type { TranscriptItem } from '#src/tui/types.js';
import { initialTurnViewModel, type TurnViewModel } from '#src/tui/viewModel.js';

const turn = (over: Partial<TurnViewModel> = {}): TurnViewModel => ({
  ...initialTurnViewModel(),
  ...over,
});

const toolCall = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'read_file',
  argsText: '{"path":"NOTES.md"}',
  status: 'done' as const,
  result: 'line one\nline two\nline three',
  ...over,
});

/**
 * Every item kind, in the shapes that actually reach the viewport. The estimator has to be a lower
 * bound for ALL of them, so the coverage here is the coverage of the invariant.
 */
const CASES: Array<{ name: string; item: TranscriptItem }> = [
  { name: 'user (short)', item: { kind: 'user', id: 1, text: 'hello' } },
  {
    name: 'user (long, wraps)',
    item: { kind: 'user', id: 2, text: 'the quick brown fox jumps over the lazy dog '.repeat(4) },
  },
  { name: 'user (empty)', item: { kind: 'user', id: 3, text: '' } },
  { name: 'user (multi-line paste)', item: { kind: 'user', id: 4, text: 'a\n\nb\nc' } },
  { name: 'system', item: { kind: 'system', id: 5, level: 'WARNING', text: 'careful now' } },
  {
    name: 'system (long)',
    item: { kind: 'system', id: 6, level: 'ERROR', text: 'something went wrong '.repeat(8) },
  },
  {
    name: 'notice',
    item: {
      kind: 'notice',
      id: 7,
      title: 'Tool details: on',
      lines: ['Tool calls now show their full inputs and results.', 'Run /verbose again.'],
      tone: 'info',
    },
  },
  {
    name: 'notice (empty body line)',
    item: { kind: 'notice', id: 8, title: 'Done', lines: ['first', '', 'third'], tone: 'warn' },
  },
  {
    name: 'notice (long body line)',
    item: {
      kind: 'notice',
      id: 9,
      title: 'Approved and remembered',
      lines: ['this exact command is saved to the project allow-list, '.repeat(4)],
      tone: 'info',
    },
  },
  {
    name: 'reasoning reprint',
    item: {
      kind: 'reasoning',
      id: 10,
      reasoning: 'First I weigh it.\n\nThen I choose.',
      turnNumber: 2,
    },
  },
  {
    name: 'assistant (plain text)',
    item: { kind: 'assistant', id: 11, turn: turn({ text: 'done' }) },
  },
  {
    name: 'assistant (markdown: heading, list, fence)',
    item: {
      kind: 'assistant',
      id: 12,
      turn: turn({
        text: '# Summary\n\n- first item\n- second item\n\n```js\nconst fenced = 1;\n```\n\nDone.',
      }),
    },
  },
  {
    name: 'assistant (long prose that wraps)',
    item: {
      kind: 'assistant',
      id: 13,
      turn: turn({ text: 'a fairly long sentence about nothing in particular. '.repeat(6) }),
    },
  },
  {
    name: 'assistant (reasoning + tool + text)',
    item: {
      kind: 'assistant',
      id: 14,
      turn: turn({
        reasoning: 'weigh it\nchoose',
        toolCalls: [toolCall()],
        text: 'the answer',
      }),
    },
  },
  {
    name: 'assistant (edit_file diff)',
    item: {
      kind: 'assistant',
      id: 15,
      turn: turn({
        toolCalls: [
          toolCall({
            name: 'edit_file',
            argsText: '{"path":"src/answer.ts","edits":[{"oldText":"41","newText":"42"}]}',
            result: 'ok',
          }),
        ],
      }),
    },
  },
  {
    name: 'assistant (tool with a capped preview + notice + live output)',
    item: {
      kind: 'assistant',
      id: 16,
      turn: turn({
        toolCalls: [
          toolCall({
            name: 'run_shell_command',
            argsText: '{"command":"ls -la"}',
            output: Array.from({ length: 14 }, (_, i) => `out-${i}`).join('\n'),
            notice: '🔧 Executing run_shell_command: ls -la',
            result: 'listed',
          }),
        ],
      }),
    },
  },
  {
    name: 'assistant (empty turn)',
    item: { kind: 'assistant', id: 17, turn: turn() },
  },
];

/** Rows the viewport really renders for one item, measured with Ink's own renderer. */
function actualRows(item: TranscriptItem, columns: number, toolsExpanded: boolean): number {
  // Rendered inside the same viewport component, with a budget that cannot cut the single item, so
  // this measures exactly the tree the app mounts — not a hand-rebuilt approximation of it.
  const frame = renderToString(
    <Box flexDirection="column">
      <TranscriptViewport items={[item]} budgetRows={1} toolsExpanded={toolsExpanded} />
    </Box>,
    { columns }
  );
  return frame.split('\n').length;
}

describe('transcriptWindow — the estimate is a LOWER bound on the rendered rows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // This is the invariant the whole windowing design rests on. The viewport pins its content to
  // the bottom and clips the top, so an UNDER-estimate merely mounts a component or two more than
  // needed. An OVER-estimate cuts the item list too high and leaves a blank band above the
  // conversation — a silent visual defect with nothing to report it. So the direction is asserted,
  // per item kind, at widths narrow enough to force wrapping.
  for (const columns of [24, 40, 100]) {
    for (const toolsExpanded of [false, true]) {
      describe(`at ${columns} columns, tool detail ${toolsExpanded ? 'on' : 'off'}`, () => {
        for (const { name, item } of CASES) {
          it(`never over-counts: ${name}`, () => {
            const estimate = estimateItemRows(item, { toolsExpanded, separator: false });
            const actual = actualRows(item, columns, toolsExpanded);
            expect(
              estimate,
              `${name} at ${columns} cols: estimated ${estimate} rows but Ink rendered ${actual}`
            ).toBeLessThanOrEqual(actual);
          });
        }
      });
    }
  }

  it('counts the separator rule above a non-first user line', () => {
    const item: TranscriptItem = { kind: 'user', id: 1, text: 'hi' };
    const without = estimateItemRows(item, { toolsExpanded: false, separator: false });
    const withRule = estimateItemRows(item, { toolsExpanded: false, separator: true });
    expect(withRule).toBe(without + 1);
  });

  it('charges an expanded tool panel more than a collapsed one', () => {
    // The fold state is a real input to the height, so a window computed with the wrong one would
    // be wrong by the whole body of every tool call on screen.
    const item: TranscriptItem = {
      kind: 'assistant',
      id: 1,
      turn: turn({
        toolCalls: [toolCall({ result: Array.from({ length: 30 }, (_, i) => `r${i}`).join('\n') })],
      }),
    };
    const collapsed = estimateItemRows(item, { toolsExpanded: false, separator: false });
    const expanded = estimateItemRows(item, { toolsExpanded: true, separator: false });
    expect(expanded).toBeGreaterThan(collapsed);
  });
});

describe('transcriptWindowStart', () => {
  const line = (id: number): TranscriptItem => ({
    kind: 'system',
    id,
    level: 'INFO',
    text: `line-${id}`,
  });

  it('returns 0 for an empty transcript', () => {
    expect(transcriptWindowStart([], 24, false)).toBe(0);
  });

  it('keeps everything when the whole transcript fits the budget', () => {
    const items = [1, 2, 3].map(line);
    expect(transcriptWindowStart(items, 24, false)).toBe(0);
  });

  it('cuts to the tail once the transcript exceeds the budget', () => {
    // 50 one-row items against a 10-row budget: 10 items cover it, plus the slack item.
    const items = Array.from({ length: 50 }, (_, i) => line(i));
    const start = transcriptWindowStart(items, 10, false);
    expect(start).toBe(50 - 10 - TRANSCRIPT_WINDOW_SLACK_ITEMS);
    expect(items.length - start).toBeLessThan(items.length);
  });

  it('is FLAT in transcript length — the slice size depends on the budget, not the history', () => {
    // The DL-10 defence, as a structural invariant rather than a stopwatch: growing the transcript
    // 40x must not grow what gets mounted. A stopwatch assertion would flap on a loaded CI box;
    // this cannot, and it fails for the same regression. Every size is past the budget, so the
    // comparison is between three genuinely windowed transcripts.
    const sizes = [50, 500, 2000].map((n) => {
      const items = Array.from({ length: n }, (_, i) => line(i));
      return items.length - transcriptWindowStart(items, 40, false);
    });
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeLessThanOrEqual(40 + TRANSCRIPT_WINDOW_SLACK_ITEMS);
  });

  it('never mounts fewer than the newest item, even when one item dwarfs the viewport', () => {
    // A single assistant turn is routinely taller than the viewport. The window cannot get smaller
    // than one item, and rendering nothing would be an empty screen mid-conversation.
    const tall: TranscriptItem = {
      kind: 'assistant',
      id: 1,
      turn: turn({ text: Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\n') }),
    };
    const items = [line(0), tall];
    expect(items.length - transcriptWindowStart(items, 8, false)).toBeGreaterThanOrEqual(1);
  });

  it('bounds the mounted count by the budget at every viewport size', () => {
    const items = Array.from({ length: 200 }, (_, i) => line(i));
    for (const budget of [1, 8, 40, 120]) {
      const mounted = items.length - transcriptWindowStart(items, budget, false);
      expect(mounted).toBeLessThanOrEqual(budget + TRANSCRIPT_WINDOW_SLACK_ITEMS);
      expect(mounted).toBeGreaterThanOrEqual(1);
    }
  });
});
