import { beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box, renderToString } from 'ink';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import { LiveTurn } from '#src/tui/components/LiveTurn.js';
import { TranscriptViewport } from '#src/tui/components/TranscriptViewport.js';
import { estimateItemRows, transcriptWindowStart } from '#src/tui/transcriptWindow.js';
import {
  CHECKLIST_TOOL_NAME,
  extractActiveChecklist,
  foldEvents,
  foldEventSequence,
  initialTurnViewModel,
  turnReasoning,
  type TurnViewModel,
} from '#src/tui/viewModel.js';
import type { TranscriptItem } from '#src/tui/types.js';

/**
 * TUI-C52 — a turn paints its tool calls and its text in the order they happened.
 *
 * The defect this pins was structural rather than a race: the turn model held `text` and
 * `toolCalls` as two parallel fields, so a text run that arrived BETWEEN two tool calls had
 * nowhere to be recorded and every completed turn snapped into "all tools, then all text" — in the
 * field, forty-three tool panels above a single paragraph of explanation.
 *
 * Every fixture here is built by folding a real {@link AgentStreamEvent} sequence rather than by
 * hand-writing a view model. That is deliberate: a hand-written model asserts the shape the author
 * had in mind, while a folded one asserts what the stream actually produces — and it is the only
 * form in which these assertions can be run against the pre-fix reducer at all.
 */

const text = (delta: string): AgentStreamEvent => ({ type: 'text', delta });

/** A whole tool call as the tidy stream delivers it. */
const toolCall = (id: string, name: string, result = 'ok'): AgentStreamEvent[] => [
  { type: 'tool_start', id, name },
  { type: 'tool_end', id },
  { type: 'tool_result', id, content: result },
];

const item = (turn: TurnViewModel, id = 1): TranscriptItem => ({ kind: 'assistant', id, turn });

/** The frame's rows, ANSI-stripped, as the reader sees them top to bottom. */
const frameRows = (element: React.ReactElement): string[] => {
  const { lastFrame, unmount } = render(element);
  const rows = stripAnsi(lastFrame() ?? '').split('\n');
  unmount();
  return rows;
};

/** Index of the first row containing `needle`, or -1. */
const rowOf = (rows: string[], needle: string): number =>
  rows.findIndex((row) => row.includes(needle));

/** Rows the viewport really renders for one item, measured with Ink's own renderer. */
function actualRows(entry: TranscriptItem, columns: number, toolsExpanded: boolean): number {
  const frame = renderToString(
    <Box flexDirection="column">
      <TranscriptViewport
        items={[entry]}
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

/** A turn that genuinely ran text → tool → text → tool. */
const INTERLEAVED: AgentStreamEvent[] = [
  text('alpha-run '),
  ...toolCall('t1', 'alpha_tool'),
  text('beta-run '),
  ...toolCall('t2', 'beta_tool'),
];

/** One run of the model's thinking, as the stream delimits it. */
const think = (delta: string): AgentStreamEvent[] => [
  { type: 'reasoning_start' },
  { type: 'reasoning_delta', delta },
  { type: 'reasoning_end' },
];

/**
 * A turn that thought, spoke, acted, and thought again — the shape CFG-33 measured on a live
 * OpenRouter session, where reasoning arrives both before a call and after its result.
 */
const THINKS_TWICE: AgentStreamEvent[] = [
  ...think('THOUGHT-A: I should read alpha.'),
  text('Let me look at alpha. '),
  ...toolCall('t1', 'alpha_tool'),
  ...think('THOUGHT-B: alpha says X, so the answer is Y.'),
  text('The answer is Y.'),
];

describe('TUI-C52 — foldEvents records arrival order as an ordered segment list', () => {
  it('keeps text → tool → text → tool as FOUR segments, the two text runs distinct', async () => {
    const vm = foldEventSequence(INTERLEAVED);
    // The whole defect in one assertion: the second text run is its own segment, sitting after the
    // first tool call, instead of being concatenated onto the first run and pushed to the bottom.
    expect(
      vm.segments.map((seg) => (seg.kind === 'text' ? `text:${seg.text}` : `tool:${seg.tool.id}`))
    ).toEqual(['text:alpha-run ', 'tool:t1', 'text:beta-run ', 'tool:t2']);
  });

  it('opens a NEW text segment after a tool call rather than extending the previous one', () => {
    const vm = foldEventSequence([
      text('first '),
      text('half '),
      ...toolCall('t1', 'probe_tool'),
      text('second '),
      text('half'),
    ]);
    const runs = vm.segments.filter((seg) => seg.kind === 'text').map((seg) => seg.text);
    // Deltas within one run still concatenate — the boundary is the tool call, not the delta.
    expect(runs).toEqual(['first half ', 'second half']);
  });

  it('a late tool_args/tool_end/tool_result PATCHES its segment in place, never appends', () => {
    const vm = foldEventSequence([
      text('before '),
      { type: 'tool_start', id: 't1', name: 'slow_tool' },
      text('after '),
      // The round's later events land once the ToolMessage does — after the next text run started.
      { type: 'tool_args', id: 't1', delta: '{"q":1}' },
      { type: 'tool_end', id: 't1' },
      { type: 'tool_result', id: 't1', content: 'late result' },
    ]);
    expect(
      vm.segments.map((seg) => (seg.kind === 'text' ? `text:${seg.text}` : `tool:${seg.tool.id}`))
    ).toEqual(['text:before ', 'tool:t1', 'text:after ']);
    const tool = vm.segments.find((seg) => seg.kind === 'tool');
    expect(tool?.kind === 'tool' ? tool.tool : null).toMatchObject({
      name: 'slow_tool',
      argsText: '{"q":1}',
      status: 'done',
      result: 'late result',
    });
  });

  it('a turn with no text at all is tool segments alone — no empty text segment', () => {
    const vm = foldEventSequence([...toolCall('t1', 'alpha_tool'), ...toolCall('t2', 'beta_tool')]);
    expect(vm.segments.map((seg) => seg.kind)).toEqual(['tool', 'tool']);
  });

  it('tolerates the placeholder branch: a tool segment that never receives a name', () => {
    const vm = foldEventSequence([text('hi '), { type: 'tool_result', id: 'ghost', content: 'x' }]);
    expect(vm.segments.map((seg) => seg.kind)).toEqual(['text', 'tool']);
    const tool = vm.segments[1];
    expect(tool.kind === 'tool' ? tool.tool : null).toMatchObject({ id: 'ghost', name: '' });
    // …and it renders rather than throwing (an unnamed panel is ugly, a crash is fatal).
    expect(frameRows(<LiveTurn turn={vm} />).join('\n')).toContain('hi');
  });

  it('a tool_output-before-tool_start stream produces the SAME segment order as the tidy one', () => {
    // The agent stream only flushes tool_start when the round's ToolMessage lands, so live output
    // normally arrives first: the placeholder path is the common case, not a defensive edge.
    const live = foldEventSequence([
      text('alpha-run '),
      { type: 'tool_output', id: 't1', name: 'alpha_tool', chunk: 'streaming…\n' },
      { type: 'tool_start', id: 't1', name: 'alpha_tool' },
      { type: 'tool_end', id: 't1' },
      { type: 'tool_result', id: 't1', content: 'ok' },
      text('beta-run '),
    ]);
    const tidy = foldEventSequence([
      text('alpha-run '),
      ...toolCall('t1', 'alpha_tool'),
      text('beta-run '),
    ]);
    const shape = (vm: TurnViewModel) =>
      vm.segments.map((seg) => (seg.kind === 'text' ? `text:${seg.text}` : `tool:${seg.tool.id}`));
    expect(shape(live)).toEqual(shape(tidy));
  });

  it('turnText concatenates the runs back into exactly what streamed', async () => {
    const { turnText } = await import('#src/tui/viewModel.js');
    expect(turnText(foldEventSequence(INTERLEAVED))).toBe('alpha-run beta-run ');
  });

  it('turnToolCalls derives the tool calls in first-seen order', async () => {
    const { turnToolCalls } = await import('#src/tui/viewModel.js');
    expect(turnToolCalls(foldEventSequence(INTERLEAVED)).map((tc) => tc.id)).toEqual(['t1', 't2']);
  });
});

describe('TUI-C52 — <LiveTurn> paints the segments in the order they arrived', () => {
  beforeEach(() => {
    chalk.level = 0;
  });

  it('paints the second text run BELOW the first tool panel', () => {
    const rows = frameRows(<LiveTurn turn={foldEventSequence(INTERLEAVED)} />);
    const alpha = rowOf(rows, 'alpha-run');
    const alphaTool = rowOf(rows, 'alpha_tool');
    const beta = rowOf(rows, 'beta-run');
    const betaTool = rowOf(rows, 'beta_tool');
    expect([alpha, alphaTool, beta, betaTool].every((i) => i >= 0)).toBe(true);
    // The reported defect, as an ordering: every tool used to sit above every character of text.
    expect(alpha).toBeLessThan(alphaTool);
    expect(alphaTool).toBeLessThan(beta);
    expect(beta).toBeLessThan(betaTool);
  });

  it('keeps that order while STREAMING as well as once committed', () => {
    const vm = foldEventSequence(INTERLEAVED);
    for (const streaming of [true, false]) {
      const rows = frameRows(<LiveTurn turn={vm} streaming={streaming} />);
      expect(rowOf(rows, 'alpha-run'), `streaming=${streaming}`).toBeLessThan(
        rowOf(rows, 'alpha_tool')
      );
      expect(rowOf(rows, 'alpha_tool'), `streaming=${streaming}`).toBeLessThan(
        rowOf(rows, 'beta-run')
      );
    }
  });

  it('keeps the order after a late tool_result patches a tool that text already followed', () => {
    const vm = foldEventSequence([
      text('before-tool '),
      { type: 'tool_start', id: 't1', name: 'slow_tool' },
      text('after-tool '),
      { type: 'tool_result', id: 't1', content: 'late-result-body' },
    ]);
    const rows = frameRows(<LiveTurn turn={vm} />);
    expect(rowOf(rows, 'before-tool')).toBeLessThan(rowOf(rows, 'slow_tool'));
    expect(rowOf(rows, 'slow_tool')).toBeLessThan(rowOf(rows, 'after-tool'));
    // The patch landed on the existing panel rather than opening a second one.
    expect(rows.filter((row) => row.includes('slow_tool'))).toHaveLength(1);
    expect(rowOf(rows, 'late-result-body')).toBeLessThan(rowOf(rows, 'after-tool'));
  });

  it('renders each text segment INDEPENDENTLY: a fence split by a tool call is two blocks', () => {
    // TUI-C52's settled decision. `renderMarkdown` is stateless by design and threading fence state
    // across a tool call would be a renderer refactor; so the opening half frames what it has and
    // the closing half draws its own rule. Pinned here so the behaviour is a decision on the
    // record rather than something a later reader discovers.
    const vm = foldEventSequence([
      text('```js\nconst a = 1;'),
      ...toolCall('t1', 'alpha_tool'),
      text('\n```\nDone.'),
    ]);
    const rows = frameRows(<LiveTurn turn={vm} />);
    const code = rowOf(rows, 'const a = 1;');
    const tool = rowOf(rows, 'alpha_tool');
    const done = rowOf(rows, 'Done.');
    expect(code).toBeGreaterThanOrEqual(0);
    expect(code).toBeLessThan(tool);
    expect(tool).toBeLessThan(done);
    // The fence markers are consumed on BOTH sides — each half went through the markdown renderer.
    expect(rows.join('\n')).not.toContain('```');
    // Each half framed itself: the labelled opening rule sits above the tool panel and a closing
    // rule below it, which is what "two blocks" means on screen.
    const openRule = rowOf(rows, '── js ');
    const closeRule = rows.findIndex((row, i) => i > tool && /^─{3,}$/.test(row.trim()));
    expect(openRule).toBeGreaterThanOrEqual(0);
    expect(openRule).toBeLessThan(tool);
    expect(closeRule).toBeGreaterThan(tool);
  });

  it('TUI-C43 non-regression: a fence WITHIN one text run still renders as one block', () => {
    const vm = foldEventSequence([text('Before\n```js\nconst a = 1;\n```\nAfter')]);
    const rows = frameRows(<LiveTurn turn={vm} />);
    expect(rowOf(rows, 'Before')).toBeLessThan(rowOf(rows, 'const a = 1;'));
    expect(rowOf(rows, 'const a = 1;')).toBeLessThan(rowOf(rows, 'After'));
    expect(rows.join('\n')).not.toContain('```');
  });

  it('still skips the checklist tool inline — it is the pinned dock panel, not a turn panel', () => {
    const vm = foldEventSequence([
      text('planning-run '),
      { type: 'tool_start', id: 'c1', name: CHECKLIST_TOOL_NAME },
      {
        type: 'tool_args',
        id: 'c1',
        delta: JSON.stringify({ items: [{ content: 'step one', status: 'pending' }] }),
      },
      { type: 'tool_end', id: 'c1' },
      text('acting-run '),
    ]);
    const rows = frameRows(<LiveTurn turn={vm} />);
    const frame = rows.join('\n');
    expect(frame).not.toContain(CHECKLIST_TOOL_NAME);
    expect(frame).not.toContain('step one');
    // Both text runs still paint, in order — and on ONE row, because nothing was drawn between
    // them to justify breaking the paragraph (see the "draws nothing" group at the end of this
    // file, which owns that rule).
    expect(frame).toContain('planning-run acting-run');
    expect(rowOf(rows, 'planning-run')).toBe(rowOf(rows, 'acting-run'));
  });

  it('never FLASHES a checklist panel on the output-first ordering', () => {
    // A tool segment is created by whichever event mentions the id first, and that is normally
    // `tool_output`. If the segment reached the renderer unnamed, the checklist call would paint an
    // inline panel for a frame or two before `tool_start` named it — the one way this skip can be
    // right at rest and wrong while streaming. `tool_output` carries the name, so assert it holds
    // frame by frame rather than only at the end.
    let vm = initialTurnViewModel();
    for (const event of [
      { type: 'text', delta: 'planning ' },
      { type: 'tool_output', id: 'c1', name: CHECKLIST_TOOL_NAME, chunk: 'x' },
      { type: 'tool_start', id: 'c1', name: CHECKLIST_TOOL_NAME },
    ] satisfies AgentStreamEvent[]) {
      vm = foldEvents(vm, event);
      const frame = frameRows(<LiveTurn turn={vm} streaming />).join('\n');
      expect(frame, `after ${event.type}`).not.toContain(CHECKLIST_TOOL_NAME);
      // No panel of ANY name: an unnamed placeholder would slip past a name-only check while still
      // drawing a caret and a status word where the turn should show nothing at all.
      expect(frame, `after ${event.type}`).not.toContain('▸');
    }
  });
});

describe('TUI-C52 — extractActiveChecklist still finds the newest checklist call', () => {
  const checklistEvents = (id: string, content: string): AgentStreamEvent[] => [
    { type: 'tool_start', id, name: CHECKLIST_TOOL_NAME },
    {
      type: 'tool_args',
      id,
      delta: JSON.stringify({ items: [{ content, status: 'in_progress' }] }),
    },
  ];

  it('prefers the live turn, then walks the transcript in reverse', () => {
    const live = foldEventSequence([text('working '), ...checklistEvents('c2', 'Live item')]);
    const committed = foldEventSequence([...checklistEvents('c1', 'Old item'), text('done ')]);
    const transcript: TranscriptItem[] = [item(committed, 1)];

    expect(extractActiveChecklist(live, transcript)).toEqual([
      { content: 'Live item', status: 'in_progress' },
    ]);
    expect(extractActiveChecklist(null, transcript)).toEqual([
      { content: 'Old item', status: 'in_progress' },
    ]);
    expect(extractActiveChecklist(null, [])).toBeNull();
  });

  it('takes the LAST checklist call of a turn that made several', () => {
    const live = foldEventSequence([
      ...checklistEvents('c1', 'First plan'),
      text('mid '),
      ...checklistEvents('c2', 'Second plan'),
    ]);
    expect(extractActiveChecklist(live, [])).toEqual([
      { content: 'Second plan', status: 'in_progress' },
    ]);
  });
});

describe('TUI-C52 — the row-count oracle moves in lockstep with the renderer', () => {
  const opts = { columns: 80, toolsExpanded: false, separator: false };

  it('charges a text run that FOLLOWS a tool call its own row', () => {
    // Same characters of text, same tool call — only the POSITION of the text differs. Rendered
    // per segment the interleaved turn is one row taller, and the oracle has to say so: an oracle
    // still measuring the turn's text as a single block reports the two as equal.
    const interleaved = foldEventSequence([
      text('alpha'),
      ...toolCall('t1', 'probe_tool'),
      text('beta'),
    ]);
    const trailing = foldEventSequence([
      text('alpha'),
      text('beta'),
      ...toolCall('t1', 'probe_tool'),
    ]);
    expect(estimateItemRows(item(interleaved), opts)).toBe(
      estimateItemRows(item(trailing), opts) + 1
    );
  });

  it('charges every one of a 40-tool turn’s text runs (the measured field shape)', () => {
    // A turn with forty-plus tool calls is real — it is what the reported session contained. At a
    // width where nothing wraps, forty separate runs are forty rows where one joined run is one.
    const wide = { columns: 400, toolsExpanded: false, separator: false };
    const many: AgentStreamEvent[] = [];
    const joined: AgentStreamEvent[] = [];
    for (let i = 0; i < 40; i++) {
      many.push(text(`note-${i} `), ...toolCall(`t${i}`, `tool_${i}`));
      joined.push(text(`note-${i} `));
    }
    for (let i = 0; i < 40; i++) joined.push(...toolCall(`t${i}`, `tool_${i}`));
    expect(estimateItemRows(item(foldEventSequence(many)), wide)).toBe(
      estimateItemRows(item(foldEventSequence(joined)), wide) + 39
    );
  });

  it('skips the checklist tool exactly as the renderer does', () => {
    const withChecklist = foldEventSequence([
      text('planning '),
      { type: 'tool_start', id: 'c1', name: CHECKLIST_TOOL_NAME },
      { type: 'tool_end', id: 'c1' },
    ]);
    const withoutTool = foldEventSequence([text('planning ')]);
    expect(estimateItemRows(item(withChecklist), opts)).toBe(
      estimateItemRows(item(withoutTool), opts)
    );
  });

  /**
   * The fixture the lower-bound guard runs on.
   *
   * `t1` carries streamed args and a result that **exceeds the 10-line preview cap** on purpose.
   * Without that the collapsed and expanded bodies are the same lines, `toolCallRows`' `expanded`
   * branches are never taken, and the `detail on` half of the matrix below re-measures the
   * `detail off` half — six parameterised cases carrying three measurements. With it, the fold
   * state is a real input to both the estimate and the render.
   */
  const OVER_COUNT_TURN: AgentStreamEvent[] = [
    text('# Heading\n\nalpha-run with enough prose to wrap at a narrow width. '),
    { type: 'tool_start', id: 't1', name: 'alpha_tool' },
    { type: 'tool_args', id: 't1', delta: '{"path":"notes/example.txt","mode":"read"}' },
    { type: 'tool_end', id: 't1' },
    {
      type: 'tool_result',
      id: 't1',
      content: Array.from({ length: 14 }, (_, i) => `out-${i}`).join('\n'),
    },
    text('```js\nconst a = 1;'),
    ...toolCall('t2', 'beta_tool', 'r4'),
    text('\n```\n- closing item\n- another item'),
  ];

  it('the tool-detail axis is a real input to both the estimate and the render', () => {
    // The control that keeps the six cases below from being three: if this fails, the fold state
    // changes nothing on this fixture and the `detail on` variants are re-runs of `detail off`.
    const entry = item(foldEventSequence(OVER_COUNT_TURN));
    const base = { columns: 100, separator: false };
    expect(estimateItemRows(entry, { ...base, toolsExpanded: true })).toBeGreaterThan(
      estimateItemRows(entry, { ...base, toolsExpanded: false })
    );
    expect(actualRows(entry, 100, true)).toBeGreaterThan(actualRows(entry, 100, false));
  });

  for (const columns of [24, 40, 100]) {
    for (const toolsExpanded of [false, true]) {
      it(`never over-counts an interleaved turn at ${columns} cols, detail ${
        toolsExpanded ? 'on' : 'off'
      }`, () => {
        // The direction the whole windowing design rests on: an under-count mounts a component or
        // two too many, an OVER-count cuts the list too high and leaves a blank band on screen.
        const entry = item(foldEventSequence(OVER_COUNT_TURN));
        const estimate = estimateItemRows(entry, { columns, toolsExpanded, separator: false });
        const actual = actualRows(entry, columns, toolsExpanded);
        expect(
          estimate,
          `interleaved turn at ${columns} cols: estimated ${estimate} rows, Ink rendered ${actual}`
        ).toBeLessThanOrEqual(actual);
      });
    }
  }

  it('keeps the mounted slice flat in transcript length with 40-segment turns', () => {
    // The TUI-C48 budget as a structural property rather than a stopwatch: the window is a function
    // of the viewport, never of how much conversation sits behind it or how tall a turn is.
    const tall = (id: number): TranscriptItem => {
      const events: AgentStreamEvent[] = [];
      for (let i = 0; i < 40; i++)
        events.push(text(`note-${i} `), ...toolCall(`t${i}`, `tool_${i}`));
      return item(foldEventSequence(events), id);
    };
    const mounted = [50, 500].map((n) => {
      const items = Array.from({ length: n }, (_, i) => tall(i));
      return items.length - transcriptWindowStart(items, 40, 80, false);
    });
    expect(new Set(mounted).size).toBe(1);
    // One turn already dwarfs the budget, so the slice is that turn plus the one item of slack.
    expect(mounted[0]).toBe(2);
  });
});

/**
 * TUI-C52 — a segment that DRAWS NOTHING must not break a text run.
 *
 * Recording arrival order truthfully and drawing it are different jobs. The checklist tool is
 * recorded as a segment (`extractActiveChecklist` reads it, and the list is a record of what
 * happened) but renders as the pinned dock panel, so it paints nothing inside the turn. Left to
 * break the run around it, a sentence the model streamed as one paragraph arrives on two rows with
 * no visible cause — a new text-placement artefact in the node that exists because text landed in
 * the wrong place. The split is justified by an action the reader can SEE between the two runs; it
 * is not justified by one they cannot.
 *
 * The renderer and the row oracle therefore share one definition of what a turn draws
 * (`displaySegments`), which is what keeps them in lockstep here.
 */
describe('TUI-C52 — a segment that draws nothing does not break a text run', () => {
  beforeEach(() => {
    chalk.level = 0;
  });

  const PLAN = 'Let me plan this out. ';
  const ACT = 'Now I will start with the first step.';
  const JOINED = `${PLAN}${ACT}`;

  /** A checklist call, which is recorded in the turn and drawn nowhere in it. */
  const checklist = (id: string, content = 'step one'): AgentStreamEvent[] => [
    { type: 'tool_start', id, name: CHECKLIST_TOOL_NAME },
    {
      type: 'tool_args',
      id,
      delta: JSON.stringify({ items: [{ content, status: 'pending' }] }),
    },
    { type: 'tool_end', id },
  ];

  /**
   * A tool call that DRAWS — and nothing more. No result and no output, so its panel is exactly its
   * summary row and the prose rows below are the turn's own text rather than an output preview.
   */
  const drawnTool = (id: string, name: string): AgentStreamEvent[] => [
    { type: 'tool_start', id, name },
    { type: 'tool_end', id },
  ];

  /** The painted frame, split into the prose rows and the count of tool panels. */
  const painted = (turn: TurnViewModel): { prose: string[]; panels: number } => {
    const rows = frameRows(<LiveTurn turn={turn} />)
      .map((row) => row.trim())
      .filter((row) => row !== '');
    return {
      prose: rows.filter((row) => !row.startsWith('▸') && !row.startsWith('▾')),
      panels: rows.filter((row) => row.startsWith('▸') || row.startsWith('▾')).length,
    };
  };

  const opts = { columns: 100, toolsExpanded: false, separator: false };
  const estimate = (turn: TurnViewModel): number => estimateItemRows(item(turn), opts);

  it('re-joins the runs around a checklist call, exactly as they streamed', async () => {
    const { displaySegments } = await import('#src/tui/viewModel.js');
    const vm = foldEventSequence([text(PLAN), ...checklist('c1'), text(ACT)]);
    // The shape the reader gets: one run, and the string is the concatenation the deltas built.
    expect(displaySegments(vm)).toEqual([{ kind: 'text', text: JOINED }]);
  });

  it('paints one paragraph, not two rows with nothing between them', () => {
    const vm = foldEventSequence([text(PLAN), ...checklist('c1'), text(ACT)]);
    expect(painted(vm)).toEqual({ prose: [JOINED], panels: 0 });
  });

  it('CONTROL: a tool call that DOES draw still keeps the two runs apart', () => {
    // The over-fix this rules out is a rule that joins runs across any skipped segment, or that
    // collapses runs generally. Keeping prose with the action it is about is the whole node, and it
    // must not become a casualty of not-splitting on an action nobody can see.
    const vm = foldEventSequence([text(PLAN), ...drawnTool('t1', 'read_file'), text(ACT)]);
    const { prose, panels } = painted(vm);
    expect(prose).toEqual([PLAN.trim(), ACT]);
    expect(panels).toBe(1);
    expect(prose).not.toContain(JOINED);
  });

  it('the oracle charges the re-joined runs as ONE run', () => {
    const withChecklist = foldEventSequence([text(PLAN), ...checklist('c1'), text(ACT)]);
    const asOneRun = foldEventSequence([text(JOINED)]);
    expect(estimate(withChecklist)).toBe(estimate(asOneRun));
  });

  it('CONTROL: the oracle still charges a run split by a DRAWN tool as two', () => {
    const withTool = foldEventSequence([text(PLAN), ...drawnTool('t1', 'read_file'), text(ACT)]);
    const asOneRun = foldEventSequence([text(JOINED), ...drawnTool('t1', 'read_file')]);
    expect(estimate(withTool)).toBe(estimate(asOneRun) + 1);
  });

  it('keeps the segment list truthful — the checklist call is still recorded and findable', () => {
    const vm = foldEventSequence([text(PLAN), ...checklist('c1', 'the plan'), text(ACT)]);
    // Presentation coalesces; the record does not. Both matter, and they are different lists.
    expect(vm.segments.map((seg) => seg.kind)).toEqual(['text', 'tool', 'text']);
    expect(extractActiveChecklist(vm, [])).toEqual([{ content: 'the plan', status: 'pending' }]);
    expect(extractActiveChecklist(null, [item(vm)])).toEqual([
      { content: 'the plan', status: 'pending' },
    ]);
  });

  it('re-joins a markdown construct split by a checklist call', () => {
    // The consequence worth pinning, stated as the strongest form available: a checklist call
    // between the two halves of a fence leaves the frame byte-identical to the same text as one
    // run. That is red for a split (the second half opens with a blank row where the run was cut)
    // and stays red for any merge that inserts a separator.
    const split = foldEventSequence([
      text('```js\nconst a = 1;'),
      ...checklist('c1'),
      text('\n```\nDone.'),
    ]);
    const whole = foldEventSequence([text('```js\nconst a = 1;\n```\nDone.')]);
    expect(frameRows(<LiveTurn turn={split} />)).toEqual(frameRows(<LiveTurn turn={whole} />));
    // …and that frame is a real closed fence, not two identically-broken ones.
    const rows = frameRows(<LiveTurn turn={split} />);
    expect(rows.join('\n')).not.toContain('```');
    expect(rowOf(rows, '── js ')).toBeLessThan(rowOf(rows, 'const a = 1;'));
    expect(rowOf(rows, 'const a = 1;')).toBeLessThan(rowOf(rows, 'Done.'));
  });

  it('renderer and oracle agree while a tool is UNNAMED, and again once the name lands', () => {
    // `upsertTool`'s placeholder branch opens a segment for an id nothing has named yet, so a turn
    // can carry a nameless tool for a window. An unnamed segment DRAWS (a placeholder panel), so it
    // keeps the runs apart; if the name that eventually lands is the checklist tool it stops
    // drawing and the runs re-join. The row count therefore changes underneath the viewport — which
    // is correct, and is safe only because the renderer and the oracle re-derive it from the same
    // list. This is the one shape where they could resolve a segment differently, and nothing else
    // in this suite has a name arriving AFTER the text run that follows it.
    const unnamed = foldEventSequence([
      text(PLAN),
      { type: 'tool_args', id: 'x1', delta: '{}' }, // first mention of the id: name is ''
      text(ACT),
    ]);
    const asChecklist = foldEvents(unnamed, {
      type: 'tool_start',
      id: 'x1',
      name: CHECKLIST_TOOL_NAME,
    });
    const asTool = foldEvents(unnamed, { type: 'tool_start', id: 'x1', name: 'read_file' });

    // What the renderer paints at each of the three states.
    expect(painted(unnamed), 'unnamed').toEqual({ prose: [PLAN.trim(), ACT], panels: 1 });
    expect(painted(asChecklist), 'named as the checklist tool').toEqual({
      prose: [JOINED],
      panels: 0,
    });
    expect(painted(asTool), 'named as an ordinary tool').toEqual({
      prose: [PLAN.trim(), ACT],
      panels: 1,
    });

    // What the oracle charges for the same three states — the same conclusions, independently.
    // Naming an ordinary tool changes nothing; naming the checklist tool costs the panel's row AND
    // merges the runs, which is exactly the turn measured as one run of text.
    expect(estimate(asTool), 'an ordinary name changes no rows').toBe(estimate(unnamed));
    expect(estimate(asChecklist), 'the merged turn is one run').toBe(
      estimate(foldEventSequence([text(JOINED)]))
    );
    expect(estimate(unnamed)).toBeGreaterThan(estimate(asChecklist));

    // …and the lower-bound invariant holds at every state, including mid-transition.
    for (const [label, vm] of [
      ['unnamed', unnamed],
      ['asChecklist', asChecklist],
      ['asTool', asTool],
    ] as const) {
      expect(estimate(vm), label).toBeLessThanOrEqual(actualRows(item(vm), 100, false));
    }
  });
});

/**
 * TUI-C81 — a turn's THINKING is in the order it happened too.
 *
 * TUI-C52 gave the turn an ordered segment list and moved text and tool calls into it; reasoning
 * stayed a `reasoning: string` field beside that list, which is the same defect one field over. A
 * model that thinks, acts, then thinks again produces two thoughts at two points in the turn, and a
 * single string can only be drawn in one place — in practice above everything, so the reasoning
 * that produced the LAST tool call sat above the FIRST one, and the two thoughts were concatenated
 * into one paragraph with no separator between them.
 */
describe('TUI-C81 — reasoning is a segment, so a turn paints its thoughts where they happened', () => {
  beforeEach(() => {
    chalk.level = 0;
  });

  it('keeps reasoning → text → tool → reasoning → text as FIVE segments in that order', () => {
    const vm = foldEventSequence(THINKS_TWICE);
    expect(
      vm.segments.map((seg) =>
        seg.kind === 'tool' ? `tool:${seg.tool.id}` : `${seg.kind}:${seg.text}`
      )
    ).toEqual([
      'reasoning:THOUGHT-A: I should read alpha.',
      'text:Let me look at alpha. ',
      'tool:t1',
      'reasoning:THOUGHT-B: alpha says X, so the answer is Y.',
      'text:The answer is Y.',
    ]);
  });

  it('never runs two thoughts together: they are distinct runs, not one string', () => {
    const vm = foldEventSequence(THINKS_TWICE);
    const runs = vm.segments.filter((seg) => seg.kind === 'reasoning').map((seg) => seg.text);
    expect(runs).toHaveLength(2);
    // The pre-fix reducer produced exactly this concatenation, mid-sentence and with no separator.
    expect(runs.join('')).not.toBe(turnReasoning(vm));
    expect(turnReasoning(vm)).toBe(`${runs[0]}\n\n${runs[1]}`);
  });

  it('opens a NEW run after a tool call even though the stream never closed the block', () => {
    // GthAbstractAgent emits `reasoning_end` only when answer TEXT arrives, so a think → tool →
    // think turn never sees one. A boundary rule keyed on `reasoning_end` would merge these two
    // thoughts back into a single panel above the call that separates them; keying on what has
    // since been appended is what holds here.
    const vm = foldEventSequence([
      { type: 'reasoning_start' },
      { type: 'reasoning_delta', delta: 'before the call' },
      ...toolCall('t1', 'alpha_tool'),
      { type: 'reasoning_delta', delta: 'after the result' },
    ]);
    expect(vm.segments.map((seg) => seg.kind)).toEqual(['reasoning', 'tool', 'reasoning']);
  });

  it('still accumulates deltas WITHIN one thought — the boundary is the segment, not the delta', () => {
    const vm = foldEventSequence([
      { type: 'reasoning_start' },
      { type: 'reasoning_delta', delta: 'first ' },
      { type: 'reasoning_delta', delta: 'half' },
      { type: 'reasoning_end' },
      { type: 'reasoning_start' },
      { type: 'reasoning_delta', delta: ', still the same thought' },
    ]);
    // Nothing was drawn between them, so re-opening the block does not start a second panel.
    expect(vm.segments).toEqual([
      { kind: 'reasoning', text: 'first half, still the same thought' },
    ]);
  });

  it('a reasoning_delta with no reasoning_start still records a run', () => {
    // Defensive, mirroring upsertTool's placeholder path: a local model that streams a thought
    // without opening one must not have it silently dropped.
    const vm = foldEventSequence([{ type: 'reasoning_delta', delta: 'unopened thought' }]);
    expect(vm.segments).toEqual([{ kind: 'reasoning', text: 'unopened thought' }]);
  });

  it('paints the SECOND thinking panel below the tool call, not above the first', () => {
    const rows = frameRows(<LiveTurn turn={foldEventSequence(THINKS_TWICE)} toolsExpanded />);
    const first = rowOf(rows, 'THOUGHT-A');
    const tool = rowOf(rows, 'alpha_tool');
    const second = rowOf(rows, 'THOUGHT-B');
    const answer = rowOf(rows, 'The answer is Y.');
    expect([first, tool, second, answer].every((i) => i >= 0)).toBe(true);
    // The reported defect as an ordering: both thoughts used to sit above every panel and every
    // character of text, so `second` came before `tool`.
    expect(first).toBeLessThan(tool);
    expect(tool).toBeLessThan(second);
    expect(second).toBeLessThan(answer);
    // Two panels, because there were two thoughts.
    expect(rows.filter((row) => row.includes('💭 Thinking'))).toHaveLength(2);
  });

  it('keeps that order while STREAMING as well as once committed', () => {
    const vm = foldEventSequence(THINKS_TWICE);
    for (const streaming of [true, false]) {
      const rows = frameRows(<LiveTurn turn={vm} streaming={streaming} toolsExpanded />);
      expect(rowOf(rows, 'alpha_tool'), `streaming=${streaming}`).toBeLessThan(
        rowOf(rows, 'THOUGHT-B')
      );
    }
  });

  it('a turn that ONLY thought renders its panel and nothing else', () => {
    const vm = foldEventSequence(think('a thought and no answer yet'));
    const rows = frameRows(<LiveTurn turn={vm} streaming toolsExpanded />);
    expect(rowOf(rows, '💭 Thinking')).toBe(0);
    expect(rowOf(rows, 'a thought and no answer yet')).toBeGreaterThan(0);
  });

  it('previews the tail of the thought being WRITTEN, and only that one', () => {
    // Collapsed, streaming: the last drawn segment is the live thought and shows its newest rows;
    // a thought that text or a tool has already followed is finished and shows its header alone.
    const writing = foldEventSequence([
      ...think('older thought'),
      ...toolCall('t1', 'alpha_tool'),
      { type: 'reasoning_delta', delta: 'newer thought' },
    ]);
    const rows = frameRows(<LiveTurn turn={writing} streaming />);
    expect(rows.join('\n')).toContain('newer thought');
    expect(rows.join('\n')).not.toContain('older thought');

    // …and once the model moves on from it, the tail stops being previewed.
    const finished = foldEvents(writing, { type: 'text', delta: 'done thinking' });
    expect(frameRows(<LiveTurn turn={finished} streaming />).join('\n')).not.toContain(
      'newer thought'
    );
  });

  it('turnReasoning gives /reasoning the whole turn’s thinking, both blocks', () => {
    // TUI-C18 reprints a committed turn through this; it must not lose the second thought, and it
    // must not weld them into one paragraph either.
    expect(turnReasoning(foldEventSequence(THINKS_TWICE))).toBe(
      'THOUGHT-A: I should read alpha.\n\nTHOUGHT-B: alpha says X, so the answer is Y.'
    );
    expect(turnReasoning(foldEventSequence(INTERLEAVED))).toBe('');
  });

  it('a checklist call between two thoughts re-joins them rather than splitting the panel', async () => {
    // The TUI-C52 rule, applied to the new segment kind: a split is justified by an action the
    // reader can SEE, and the checklist tool draws nowhere in the turn.
    const { displaySegments } = await import('#src/tui/viewModel.js');
    const vm = foldEventSequence([
      { type: 'reasoning_delta', delta: 'one thought ' },
      { type: 'tool_start', id: 'c1', name: CHECKLIST_TOOL_NAME },
      { type: 'tool_end', id: 'c1' },
      { type: 'reasoning_delta', delta: 'continued' },
    ]);
    expect(displaySegments(vm)).toEqual([{ kind: 'reasoning', text: 'one thought continued' }]);
    // The record still holds both runs and the call — presentation coalesces, the record does not.
    expect(vm.segments.map((seg) => seg.kind)).toEqual(['reasoning', 'tool', 'reasoning']);
  });

  it('a text run and a reasoning run NEVER merge, even with nothing drawn between them', async () => {
    const { displaySegments } = await import('#src/tui/viewModel.js');
    const vm = foldEventSequence([
      text('the answer '),
      { type: 'tool_start', id: 'c1', name: CHECKLIST_TOOL_NAME },
      { type: 'tool_end', id: 'c1' },
      { type: 'reasoning_delta', delta: 'a private thought' },
    ]);
    // They are different layers of the turn: welding the model's thinking onto its answer is the
    // failure TUI-C15 gave the panel a border to prevent.
    expect(displaySegments(vm)).toEqual([
      { kind: 'text', text: 'the answer ' },
      { kind: 'reasoning', text: 'a private thought' },
    ]);
  });

  it('the row oracle measures each thought WHERE IT SITS', () => {
    const opts = { columns: 100, toolsExpanded: true, separator: false };
    const twice = foldEventSequence(THINKS_TWICE);
    // The control holds the same two thoughts as ONE run, one per line, so both turns draw the same
    // two gutter rows of body and the only difference left is the second panel's header. An oracle
    // still counting a turn's reasoning as a single block above everything reports the two as equal.
    const once = foldEventSequence([
      ...think('THOUGHT-A: I should read alpha.\nTHOUGHT-B: alpha says X, so the answer is Y.'),
      text('Let me look at alpha. '),
      ...toolCall('t1', 'alpha_tool'),
      text('The answer is Y.'),
    ]);
    expect(estimateItemRows(item(twice), opts)).toBe(estimateItemRows(item(once), opts) + 1);
  });

  for (const columns of [24, 40, 100]) {
    for (const toolsExpanded of [false, true]) {
      it(`never over-counts a thinking turn at ${columns} cols, detail ${
        toolsExpanded ? 'on' : 'off'
      }`, () => {
        // The invariant the whole windowing design rests on, extended to the third row source: an
        // OVER-count cuts the mounted list too high and leaves a blank band on screen.
        const entry = item(foldEventSequence(THINKS_TWICE));
        const estimate = estimateItemRows(entry, { columns, toolsExpanded, separator: false });
        const actual = actualRows(entry, columns, toolsExpanded);
        expect(
          estimate,
          `thinking turn at ${columns} cols: estimated ${estimate} rows, Ink rendered ${actual}`
        ).toBeLessThanOrEqual(actual);
      });
    }
  }
});
