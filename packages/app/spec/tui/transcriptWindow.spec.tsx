import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Box, renderToString } from 'ink';
import {
  estimateItemRows,
  transcriptWindowEnd,
  transcriptWindowStart,
} from '#src/tui/transcriptWindow.js';
import { TranscriptViewport } from '#src/tui/components/TranscriptViewport.js';
import type { TranscriptItem } from '#src/tui/types.js';
import {
  initialTurnViewModel,
  type ToolCallViewModel,
  type TurnViewModel,
} from '#src/tui/viewModel.js';

/**
 * A turn in the tools-then-text layout these cases were written for. The turn model records
 * arrival order as a segment list (TUI-C52); the interleaved shapes that ordering made
 * expressible are estimated in `turnSegments.spec.tsx`, against the same Ink measurement.
 */
const turn = (
  over: {
    text?: string;
    reasoning?: string;
    isReasoning?: boolean;
    toolCalls?: ToolCallViewModel[];
  } = {}
): TurnViewModel => ({
  ...initialTurnViewModel(),
  reasoning: over.reasoning ?? '',
  isReasoning: over.isReasoning ?? false,
  segments: [
    ...(over.toolCalls ?? []).map((tool) => ({ kind: 'tool' as const, tool })),
    ...(over.text ? [{ kind: 'text' as const, text: over.text }] : []),
  ],
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
      {/* No `scroll`, so nothing clips: zero states that, rather than leaving it to a default. */}
      <TranscriptViewport
        items={[item]}
        budgetRows={1}
        columns={columns}
        toolsExpanded={toolsExpanded}
        regionRows={0}
      />
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
            const estimate = estimateItemRows(item, { columns, toolsExpanded, separator: false });
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
    const without = estimateItemRows(item, { columns: 80, toolsExpanded: false, separator: false });
    const withRule = estimateItemRows(item, { columns: 80, toolsExpanded: false, separator: true });
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
    const collapsed = estimateItemRows(item, {
      columns: 80,
      toolsExpanded: false,
      separator: false,
    });
    const expanded = estimateItemRows(item, { columns: 80, toolsExpanded: true, separator: false });
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
    expect(transcriptWindowStart([], 24, 80, false)).toBe(0);
  });

  it('keeps everything when the whole transcript fits the budget', () => {
    const items = [1, 2, 3].map(line);
    expect(transcriptWindowStart(items, 24, 80, false)).toBe(0);
  });

  it('cuts to the tail once the transcript exceeds the budget', () => {
    // 50 one-row items against a 10-row budget: 10 items cover it, plus one item of slack, so the
    // window opens at index 39. The 39 is written out rather than derived from the slack constant
    // on purpose — an assertion that names a constant on both sides cannot fail when it changes,
    // which is the whole reason this number is worth asserting.
    const items = Array.from({ length: 50 }, (_, i) => line(i));
    const start = transcriptWindowStart(items, 10, 80, false);
    expect(start).toBe(39);
    expect(items.length - start).toBeLessThan(items.length);
  });

  it('is FLAT in transcript length — the slice size depends on the budget, not the history', () => {
    // The DL-10 defence, as a structural invariant rather than a stopwatch: growing the transcript
    // 40x must not grow what gets mounted. A stopwatch assertion would flap on a loaded CI box;
    // this cannot, and it fails for the same regression. Every size is past the budget, so the
    // comparison is between three genuinely windowed transcripts.
    const sizes = [50, 500, 2000].map((n) => {
      const items = Array.from({ length: n }, (_, i) => line(i));
      return items.length - transcriptWindowStart(items, 40, 80, false);
    });
    expect(new Set(sizes).size).toBe(1);
    // 40 one-row items cover the 40-row budget, plus one of slack. Exact, and stated as a number:
    // written as `40 + TRANSCRIPT_WINDOW_SLACK_ITEMS` it would follow the constant anywhere.
    expect(sizes[0]).toBe(41);
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
    expect(items.length - transcriptWindowStart(items, 8, 80, false)).toBeGreaterThanOrEqual(1);
  });

  it('bounds the mounted count by the budget at every viewport size', () => {
    // One-row items, so the count is the budget plus a single item of slack at every size. The
    // `+ 1` is that slack written as a number: with the constant on both sides this assertion
    // would hold for any value it took, which is exactly what it exists to rule out.
    const items = Array.from({ length: 200 }, (_, i) => line(i));
    for (const budget of [1, 8, 40, 120]) {
      const mounted = items.length - transcriptWindowStart(items, budget, 80, false);
      expect(mounted).toBe(budget + 1);
    }
  });
});

describe('transcriptWindowStart accounts for WRAPPING, not just logical lines', () => {
  // The defect a width-blind estimate produces, and the reason `columns` is a required argument.
  // A wall of unbroken prose — the single commonest shape a model emits — is ONE logical line and
  // a couple of dozen rendered rows. Counted as one row, the walk keeps taking items long after
  // the screen is full: measured at 80 columns on a 40-row viewport, it mounted 28 items and ~210
  // rows of content where 4 items cover the region. It is invisible on screen (the extra items are
  // simply clipped) and shows up only as several times the render work per frame.
  const PARA =
    'This is a long unbroken paragraph of prose of the kind a model produces whenever it is ' +
    'explaining something at any length, and it contains no newline characters at all. ';

  const wrapHeavy = (n: number): TranscriptItem[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'system' as const,
      id: i,
      level: 'INFO',
      text: PARA.repeat(3),
    }));

  it('mounts far fewer items for wrap-heavy prose than a logical-line count would', () => {
    const items = wrapHeavy(200);
    const mounted = items.length - transcriptWindowStart(items, 40, 80, false);
    // ~510 characters over 80 columns is ~7 rows per item, so a 40-row budget needs ~6 of them.
    expect(mounted).toBeLessThanOrEqual(8);
    // The control that makes the number mean something: the same items counted at a width where
    // they do NOT wrap need many more items to cover the same budget.
    const unwrapped = items.length - transcriptWindowStart(items, 40, 4000, false);
    expect(unwrapped).toBeGreaterThan(mounted * 3);
  });

  it('mounts MORE items as the terminal gets wider, because each one wraps less', () => {
    const items = wrapHeavy(200);
    const at40 = items.length - transcriptWindowStart(items, 40, 40, false);
    const at80 = items.length - transcriptWindowStart(items, 40, 80, false);
    const at200 = items.length - transcriptWindowStart(items, 40, 200, false);
    expect(at40).toBeLessThan(at80);
    expect(at80).toBeLessThan(at200);
  });
});

/**
 * TUI-C48 — the window when the reader has scrolled back.
 *
 * A scrolled viewport cuts the list around the EDGE rather than around the end of the conversation,
 * and it mounts a budget's worth on both sides of it. The half below the edge is drawn nowhere; it
 * exists so that scrolling back down can measure real heights instead of estimating them, which is
 * what keeps a scroll position from drifting.
 */
describe('the window around a scrolled edge', () => {
  const line = (id: number): TranscriptItem => ({
    kind: 'system',
    id,
    level: 'INFO',
    text: `line-${id}`,
  });

  it('walks back from the edge, not from the end of the conversation', () => {
    const items = Array.from({ length: 50 }, (_, i) => line(i));
    // Fifty one-row items, a ten-row budget, edge at item 20: ten items cover the budget and one
    // more is slack, so the window opens at index 10 — not at 39, which is where a walk from the
    // end would put it. Written as literals; deriving them from the slack constant would make the
    // assertion unable to fail when that constant changes.
    expect(transcriptWindowStart(items, 10, 80, false, 20)).toBe(10);
    expect(transcriptWindowStart(items, 10, 80, false)).toBe(39);
  });

  it('is unchanged from the walk it has always done when the edge is the newest item', () => {
    const items = Array.from({ length: 50 }, (_, i) => line(i));
    expect(transcriptWindowStart(items, 10, 80, false, items.length - 1)).toBe(
      transcriptWindowStart(items, 10, 80, false)
    );
  });

  it('mounts a budget of conversation below the edge as well', () => {
    const items = Array.from({ length: 50 }, (_, i) => line(i));
    // Ten one-row items cover a ten-row budget, plus one of slack: 20 + 11 = 31.
    expect(transcriptWindowEnd(items, 10, 80, false, 20)).toBe(31);
  });

  it('stops at the newest item rather than running past it', () => {
    const items = Array.from({ length: 50 }, (_, i) => line(i));
    expect(transcriptWindowEnd(items, 10, 80, false, 46)).toBe(49);
    expect(transcriptWindowEnd(items, 10, 80, false, 49)).toBe(49);
    // The edge may name the tail block, which is one past the newest item and not an item at all.
    expect(transcriptWindowEnd(items, 10, 80, false, 50)).toBe(49);
  });

  it('has nothing to mount for an empty transcript', () => {
    expect(transcriptWindowEnd([], 10, 80, false, 0)).toBe(-1);
  });

  it('mounts a set whose size tracks the budget, not the distance scrolled back', () => {
    // The DL-10 property in the estimator's own terms: the same budget mounts the same number of
    // items whether the edge is near the end of a long conversation or near its beginning.
    const items = Array.from({ length: 400 }, (_, i) => line(i));
    const spanAt = (edge: number) =>
      transcriptWindowEnd(items, 24, 80, false, edge) -
      transcriptWindowStart(items, 24, 80, false, edge);
    expect(spanAt(350)).toBe(spanAt(100));
    expect(spanAt(100)).toBe(spanAt(50));
  });
});
