import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import type {
  AgentStreamEvent,
  ApprovalOutcome,
  PendingToolInterrupt,
  ToolApprovalDecision,
} from '@gaunt-sloth/core/core/types.js';
import { maxDisplayWidth } from '@gaunt-sloth/core/utils/displayWidth.js';
import { LiveTurn } from '#src/tui/components/LiveTurn.js';
import { App } from '#src/tui/components/App.js';
import {
  foldEventSequence,
  recordApprovalDecision,
  turnText,
  type TurnViewModel,
} from '#src/tui/viewModel.js';
import type { PendingApproval, TuiAgent } from '#src/tui/types.js';

/**
 * [[TUI-C99]] — **a decision about a call is drawn beside the call, below it, and stays there.**
 *
 * The defect these cases pin was structural rather than a layout choice. [[EXT-137]]'s scrollable
 * half was committed to the transcript the moment the question was asked, and
 * `<TranscriptViewport>` draws every committed item before its children while `<LiveTurn>` IS a
 * child — so the block could only ever paint above the whole in-flight turn, and it got worse the
 * longer the turn ran. The decision notices inverted for the same reason: `runTurn` commits the
 * finished turn in its `finally`, after every notice a keystroke pushed.
 *
 * Andrew's ruling dissolves the ordering problem rather than solving it: what remains after the
 * answer is a one-line outcome on the row of the call it concerns, and Ctrl+T opens the detail. A
 * line inside its own call's panel has no wall to sit above and cannot drift as the turn grows.
 *
 * Two shapes were tried and rejected and neither is asserted here: rendering the request as a
 * standing child after `<LiveTurn>` (which pins it last permanently, so work done AFTER the answer
 * appears above it), and recording the request in the turn's ordered segment list (correct in both
 * directions, but it reaches `onTurnComplete` and therefore the model's history).
 */

const PENDING_T2: PendingToolInterrupt = {
  name: 'run_shell_command',
  args: { command: 'rm -rf build' },
  id: 't2',
  subject: { kind: 'shell', command: 'rm -rf build' },
  safetyVerdict: {
    outcome: 'destructive',
    reason: 'Deletes a build directory; the work in it cannot be recovered from this session.',
  },
  grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "rm -rf build" }',
  grantSummary: 'rm -rf build',
  denyPreview: '{ "type": "shell", "matcher": "exact", "pattern": "rm -rf build" }',
  denySummary: 'rm -rf build',
};

/** The turn as it stands when the human is asked: one finished call, one waiting at the gate. */
const UP_TO_THE_GATE: AgentStreamEvent[] = [
  { type: 'text', delta: 'Listing the directory first.' },
  { type: 'tool_start', id: 't1', name: 'run_shell_command' },
  { type: 'tool_args', id: 't1', delta: '{"command":"ls -la"}' },
  { type: 'tool_end', id: 't1' },
  { type: 'tool_result', id: 't1', content: 'FIRST-CALL-OUTPUT' },
  // [[TUI-C100]] — a gated call is ANNOUNCED before the gate and gets no `tool_end` until its own
  // result lands, so the row is on screen, running, while the dialog is up.
  { type: 'tool_start', id: 't2', name: 'run_shell_command' },
  { type: 'tool_args', id: 't2', delta: '{"command":"rm -rf build"}' },
];

/** What the resumed run produces once the answer was `approve`: the call's own result, then more. */
const AFTER_THE_ANSWER: AgentStreamEvent[] = [
  { type: 'tool_end', id: 't2' },
  { type: 'tool_result', id: 't2', content: 'GATED-CALL-OUTPUT' },
  { type: 'tool_start', id: 't3', name: 'read_file' },
  { type: 'tool_args', id: 't3', delta: '{"path":"NOTES.md"}' },
  { type: 'tool_end', id: 't3' },
  { type: 'tool_result', id: 't3', content: 'LATER-CALL-OUTPUT' },
  { type: 'text', delta: 'All done.' },
];

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

describe('[[TUI-C99]] the outcome line sits below the call it is about', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * The discriminating case, and the one that fails against the branch point: at the moment the
   * question is answered the turn already holds a finished call, and the answer has to read as
   * having come after it.
   */
  it('paints below the gated call, which is below the call that preceded it', () => {
    const answered = recordApprovalDecision(foldEventSequence(UP_TO_THE_GATE), 't2', {
      decision: 'approved',
      request: PENDING_T2,
    });
    const rows = frameRows(<LiveTurn turn={answered} streaming columns={100} />);

    const firstCall = rowOf(rows, 'FIRST-CALL-OUTPUT');
    const gatedCall = rowOf(rows, 'rm -rf build');
    const outcome = rowOf(rows, 'approved by you');

    expect(firstCall).toBeGreaterThanOrEqual(0);
    expect(gatedCall).toBeGreaterThanOrEqual(0);
    expect(outcome).toBeGreaterThan(firstCall);
    expect(outcome).toBeGreaterThan(gatedCall);
    // …and above nothing else: it is the last drawn row of the turn at this point.
    expect(rows.slice(outcome + 1).every((row) => row.trim() === '')).toBe(true);
  });

  /**
   * The row the rejected shape failed. A block pinned after the turn stays last for the rest of the
   * turn, so the resumed run — the output of the very command that was approved, and everything
   * after it — appears ABOVE the question that gated it. An outcome line belongs to its own call,
   * so work that lands later lands below it.
   */
  it('stays attached as the turn grows: later calls appear BELOW it', () => {
    const answered = recordApprovalDecision(foldEventSequence(UP_TO_THE_GATE), 't2', {
      decision: 'approved',
      request: PENDING_T2,
    });
    const grown = foldEventSequence(AFTER_THE_ANSWER, answered);
    const rows = frameRows(<LiveTurn turn={grown} streaming columns={100} />);

    const outcome = rowOf(rows, 'approved by you');
    expect(outcome).toBeGreaterThanOrEqual(0);
    expect(rowOf(rows, 'GATED-CALL-OUTPUT')).toBeGreaterThan(outcome);
    expect(rowOf(rows, 'LATER-CALL-OUTPUT')).toBeGreaterThan(outcome);
    expect(rowOf(rows, 'All done.')).toBeGreaterThan(outcome);
  });

  /**
   * The gated call's own `tool_result`/`tool_end` patch the very segment the outcome hangs off, and
   * a patch that rebuilt the call instead of spreading it would drop the field silently — green
   * everywhere, and the line simply gone the moment the command finished.
   */
  it('survives the gated call being patched by its own result', () => {
    const answered = recordApprovalDecision(foldEventSequence(UP_TO_THE_GATE), 't2', {
      decision: 'approved',
      request: PENDING_T2,
    });
    expect(
      rowOf(frameRows(<LiveTurn turn={answered} streaming columns={100} />), 'approved by you')
    ).toBeGreaterThanOrEqual(0);
    const grown = foldEventSequence(AFTER_THE_ANSWER, answered);
    expect(
      rowOf(frameRows(<LiveTurn turn={grown} streaming columns={100} />), 'approved by you')
    ).toBeGreaterThanOrEqual(0);
  });

  it('names a refusal as a refusal', () => {
    const refused = recordApprovalDecision(foldEventSequence(UP_TO_THE_GATE), 't2', {
      decision: 'rejected',
      request: PENDING_T2,
    });
    const rows = frameRows(<LiveTurn turn={refused} streaming columns={100} />);
    expect(rowOf(rows, 'rejected by you')).toBeGreaterThan(rowOf(rows, 'rm -rf build'));
    expect(rows.join('\n')).not.toContain('approved by you');
  });

  /**
   * An answer that cannot be attributed to a call must not be pinned to one. The interrupt's `id`
   * is recovered defensively from the suspended graph and is documented as absent-able, so the
   * caller has to be able to tell — and pinning it to "the last running call" would report a
   * human's decision against a command they were never asked about.
   */
  it('attributes nothing when the interrupt carries no usable id', () => {
    const turn = foldEventSequence(UP_TO_THE_GATE);
    const request = { ...PENDING_T2 };
    delete request.id;
    expect(recordApprovalDecision(turn, undefined, { decision: 'approved', request })).toBe(turn);
    expect(recordApprovalDecision(turn, 'no-such-call', { decision: 'approved', request })).toBe(
      turn
    );
  });

  /**
   * **This node is placement only.** `turnText` concatenates `text` segments alone, so an outcome
   * hung off a tool call cannot enter `onTurnComplete` and therefore cannot enter the model's
   * conversation history. That is the property that made this shape available where recording the
   * request as a turn segment was not, so it is asserted rather than assumed.
   */
  it('changes nothing about what the model is told', () => {
    const before = foldEventSequence([...UP_TO_THE_GATE, ...AFTER_THE_ANSWER]);
    const after = foldEventSequence(
      AFTER_THE_ANSWER,
      recordApprovalDecision(foldEventSequence(UP_TO_THE_GATE), 't2', {
        decision: 'approved',
        request: PENDING_T2,
      })
    );
    expect(turnText(after)).toBe(turnText(before));
    expect(turnText(after)).toBe('Listing the directory first.All done.');
    expect(turnText(after)).not.toContain('approved by you');
  });
});

describe('[[TUI-C99]] Ctrl+T carries the request the answer was about', () => {
  const answered = (): TurnViewModel =>
    recordApprovalDecision(foldEventSequence(UP_TO_THE_GATE), 't2', {
      decision: 'approved',
      request: PENDING_T2,
    });

  /**
   * [[EXT-137]] put the untrusted halves in the conversation, scrollable and uncapped, so a reader
   * could audit what a model or a third-party server claimed about a call. The ruling preserves
   * that guarantee only if the expansion really holds it — a header naming the request would not.
   */
  it('expanded, the row carries the rating, the sticky preview and the framed command', () => {
    const rows = frameRows(<LiveTurn turn={answered()} toolsExpanded columns={100} />).join('\n');
    expect(rows).toContain('Gaunt Sloth is asking about this call');
    expect(rows).toContain("the rater's own words");
    expect(rows).toContain('Deletes a build directory');
    expect(rows).toContain('[s]/[a] will remember');
    expect(rows).toContain('[d] will refuse this exact call');
    expect(rows).toContain('rm -rf build');
  });

  it('collapsed, it says where the detail is instead of printing it', () => {
    const rows = frameRows(<LiveTurn turn={answered()} columns={100} />).join('\n');
    expect(rows).toContain('approved by you');
    expect(rows).toContain('Ctrl+T');
    expect(rows).not.toContain("the rater's own words");
    expect(rows).not.toContain('[s]/[a] will remember');
  });

  /**
   * The detail is reached the same way on a COMMITTED turn, which is where a reader auditing after
   * the fact actually is. `<LiveTurn>` draws both, so this asserts the expansion is not gated on
   * the turn still streaming.
   */
  it('is reachable on a committed turn, not only a live one', () => {
    const rows = frameRows(<LiveTurn turn={answered()} toolsExpanded columns={100} />).join('\n');
    expect(rows).toContain('Gaunt Sloth is asking about this call');
  });

  /**
   * [[TUI-C99]] — **the expansion is framed at the width it was TOLD, and this is what says so.**
   *
   * The type makes `columns` required all the way down; this holds the property the type only
   * guards against a compiler. Threading it wrongly is not an absent frame but an 80-column one:
   * `frameWidthFor(undefined)` is `DEFAULT_FRAME_WIDTH`, so every gutter row comes out ~79 wide, a
   * narrower terminal wraps them a second time, and the untrusted half of the row restarts at
   * column 0 — the [[TUI-C26]] guarantee, lost to a prop nobody passed.
   *
   * **The harness reports 100 columns on purpose, and this pins told-width rather than terminal
   * width.** At a real 60-column stdout Ink would wrap the over-wide rows down to 60 and the
   * measurement could not see the fault it exists to catch — the re-wrap IS the fault. Told 60
   * inside a 100-column frame leaves a mis-framed row visibly over-wide instead.
   *
   * Scoped to the rows carrying the frame's gutter, which is not a loosened bound: those are the
   * rows holding text the model, the rater or a hostile URL wrote, and they are the only ones core
   * wraps to the frame width at all. The block's own label sentences are ours, and a terminal
   * re-wrapping one of those puts our words at column 0, which forges nothing.
   */
  it('frames the expansion to the width it was told, not to the 80-column default', () => {
    const TOLD = 60;
    const rows = frameRows(<LiveTurn turn={answered()} toolsExpanded columns={TOLD} />);
    const framed = rows.filter((row) => row.includes('│') || row.includes('┊'));
    // The block drew, and drew the quoted material — without this the bound below could hold by
    // measuring nothing at all.
    expect(framed.length).toBeGreaterThan(0);
    expect(framed.join('\n')).toContain('Deletes a build directory');
    for (const row of framed) expect(maxDisplayWidth(row)).toBeLessThanOrEqual(TOLD);
  });
});

/* ------------------------------------------------------------------------- *
 * The App-level half: what the committed transcript holds afterwards.        *
 * ------------------------------------------------------------------------- */

const baseProps = {
  mode: 'code',
  readyMessage: '\nGaunt Sloth is ready.',
  exitMessage: "Type 'exit' or Ctrl+C to exit\n",
};

/** The production approval bridge's shape, small enough to own here. */
function createBridge() {
  const listeners = new Set<(record: PendingApproval) => void>();
  const settle = new Map<PendingToolInterrupt, (outcome: ApprovalOutcome | null) => void>();
  /** Every request handed to the surface, so a case can wait on the ASK rather than on pixels. */
  const asked: PendingToolInterrupt[] = [];
  return {
    asked,
    subscribe: (cb: (record: PendingApproval) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    /** Ask, and resolve when a key is pressed — exactly as the runner's callback awaits. */
    ask: (pending: PendingToolInterrupt): Promise<ToolApprovalDecision> =>
      new Promise<ToolApprovalDecision>((resolve) => {
        let outcomeSettled: (outcome: ApprovalOutcome | null) => void = () => {};
        const outcome = new Promise<ApprovalOutcome | null>((s) => {
          outcomeSettled = s;
        });
        settle.set(pending, outcomeSettled);
        asked.push(pending);
        const record: PendingApproval = {
          pending,
          resolve: (decision) => {
            resolve(decision);
            return outcome;
          },
        };
        for (const l of listeners) l(record);
      }),
    /** [[EXT-150]]'s return leg: what the runner says the answer LANDED as. */
    report: (pending: PendingToolInterrupt, lifetime: 'once' | 'session' | 'always') => {
      settle.get(pending)?.({ pending, decision: 'approve', lifetime });
    },
  };
}

/** A turn that runs to the gate, waits for the human, then finishes. */
function gatedAgent(bridge: ReturnType<typeof createBridge>, pendings = [PENDING_T2]): TuiAgent {
  return {
    async *runTurn(): AsyncGenerator<AgentStreamEvent> {
      yield* UP_TO_THE_GATE;
      for (const pending of pendings) {
        const decision = await bridge.ask(pending);
        if (decision.type === 'approve') {
          yield { type: 'tool_end', id: pending.id ?? 't2' };
          yield { type: 'tool_result', id: pending.id ?? 't2', content: 'GATED-CALL-OUTPUT' };
        } else {
          yield { type: 'tool_end', id: pending.id ?? 't2' };
          yield {
            type: 'tool_result',
            id: pending.id ?? 't2',
            content: 'The user rejected your call to run_shell_command.',
            isError: true,
          };
        }
      }
      yield { type: 'text', delta: 'All done.' };
    },
  } as unknown as TuiAgent;
}

/** Wait until `check` holds against the latest frame, then hand it back ANSI-stripped. */
async function frameWhere(
  lastFrame: () => string | undefined,
  check: (frame: string) => boolean
): Promise<string> {
  let out = '';
  await vi.waitFor(() => {
    out = stripAnsi(lastFrame() ?? '');
    expect(check(out)).toBe(true);
  });
  return out;
}

describe('[[TUI-C99]] the committed record reads in the order it happened', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * `runTurn` commits the finished turn in its `finally`, so this is a separate question from the
   * live render: a notice pushed the instant a key is pressed lands in the transcript BEFORE the
   * turn it was part of and stays there. Only the scrollback can answer it.
   */
  it('the approve notice lands after the turn, not above it', async () => {
    const bridge = createBridge();
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={gatedAgent(bridge)}
        subscribeApproval={bridge.subscribe}
        initialMessage="tidy the build dir"
      />
    );

    await frameWhere(lastFrame, (f) => f.includes('rm -rf build') && f.includes('[o]nce'));
    stdin.write('o');
    const frame = await frameWhere(
      lastFrame,
      (f) => f.includes('Command approved (once)') && f.includes('All done.')
    );

    const rows = frame.split('\n');
    expect(rowOf(rows, 'All done.')).toBeGreaterThanOrEqual(0);
    expect(rowOf(rows, 'Command approved (once)')).toBeGreaterThan(rowOf(rows, 'All done.'));
    // The outcome sits on the call, inside the turn, above the notice that followed the turn.
    expect(rowOf(rows, 'approved by you')).toBeLessThan(rowOf(rows, 'All done.'));
    unmount();
  });

  /**
   * The per-notice test is *does this say something the tool row cannot?* The ordinary refusal
   * notice said only that the command did not run and that the agent was told — both of which the
   * row itself now says, [[TUI-C100]] having made a refused call render as `✗ … [error]` with the
   * refusal text under it. So it goes, and the outcome line is what replaces it.
   */
  it('the ordinary refusal notice is replaced by the outcome line', async () => {
    const bridge = createBridge();
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={gatedAgent(bridge)}
        subscribeApproval={bridge.subscribe}
        initialMessage="tidy the build dir"
      />
    );

    await frameWhere(lastFrame, (f) => f.includes('rm -rf build') && f.includes('[N]o'));
    stdin.write('n');
    const frame = await frameWhere(lastFrame, (f) => f.includes('All done.'));

    expect(frame).toContain('rejected by you');
    expect(frame).not.toContain('Command rejected');
    expect(frame).not.toContain('the agent was told you declined');
    unmount();
  });

  /**
   * [[EXT-150]] — the sticky refusal notices report a persistent policy change and name the control
   * that lifts it, which is not derivable from the row and which its own comment requires be said
   * "one notice, once, when it is known". They survive; only their POSITION changes.
   */
  it('the sticky refusal notice survives, with its /approvals undeny clause, after the turn', async () => {
    const bridge = createBridge();
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={gatedAgent(bridge)}
        subscribeApproval={bridge.subscribe}
        initialMessage="tidy the build dir"
      />
    );

    await frameWhere(lastFrame, (f) => f.includes('rm -rf build') && f.includes('[d]eny always'));
    stdin.write('d');
    // The runner reports what the refusal LANDED as; the notice is written from that.
    bridge.report(PENDING_T2, 'always');
    const frame = await frameWhere(
      lastFrame,
      (f) => f.includes('/approvals undeny') && f.includes('All done.')
    );

    const rows = frame.split('\n');
    expect(rowOf(rows, 'Command refused')).toBeGreaterThan(rowOf(rows, 'All done.'));
    expect(frame).toContain('Lift it with /approvals undeny');
    expect(frame).toContain('rejected by you');
    unmount();
  });

  /**
   * Two identical calls back to back stay two questions with two answers. The old once-only guard
   * keyed a committed block on the queue RECORD's identity for this; nothing is committed on the
   * ask now, and what carries the property instead is that each answer is written onto its own
   * tool call by id.
   */
  it('two identical gated calls get two questions and two outcome lines', async () => {
    const second: PendingToolInterrupt = { ...PENDING_T2, id: 't2b' };
    const bridge = createBridge();
    const agent = {
      async *runTurn(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'tool_start', id: 't2', name: 'run_shell_command' };
        yield { type: 'tool_args', id: 't2', delta: '{"command":"rm -rf build"}' };
        const first = await bridge.ask(PENDING_T2);
        yield { type: 'tool_end', id: 't2' };
        yield {
          type: 'tool_result',
          id: 't2',
          content: first.type === 'approve' ? 'FIRST-RUN' : 'refused',
          ...(first.type === 'approve' ? {} : { isError: true }),
        };
        yield { type: 'tool_start', id: 't2b', name: 'run_shell_command' };
        yield { type: 'tool_args', id: 't2b', delta: '{"command":"rm -rf build"}' };
        const again = await bridge.ask(second);
        yield { type: 'tool_end', id: 't2b' };
        yield {
          type: 'tool_result',
          id: 't2b',
          content: again.type === 'approve' ? 'SECOND-RUN' : 'refused',
          ...(again.type === 'approve' ? {} : { isError: true }),
        };
        yield { type: 'text', delta: 'All done.' };
      },
    } as unknown as TuiAgent;

    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={agent}
        subscribeApproval={bridge.subscribe}
        initialMessage="tidy it twice"
      />
    );

    await frameWhere(lastFrame, (f) => f.includes('[o]nce'));
    stdin.write('o');
    // The second call is asked about in its own right rather than the first block being redrawn:
    // two records reach the surface, and the second prompt is up before the key is sent.
    await vi.waitFor(() => expect(bridge.asked).toHaveLength(2));
    await frameWhere(lastFrame, (f) => f.includes('[N]o'));
    stdin.write('n');
    const frame = await frameWhere(lastFrame, (f) => f.includes('All done.'));

    const rows = frame.split('\n');
    expect(rowOf(rows, 'approved by you')).toBeGreaterThanOrEqual(0);
    expect(rowOf(rows, 'rejected by you')).toBeGreaterThan(rowOf(rows, 'approved by you'));
    expect(rows.filter((r) => r.includes('approved by you'))).toHaveLength(1);
    expect(rows.filter((r) => r.includes('rejected by you'))).toHaveLength(1);
    unmount();
  });

  /**
   * A resize re-renders everything, and the shape this replaces committed its block from an effect
   * — so a redraw was one guard away from appending a second copy. Nothing is committed on the ask
   * now, and the assertion is on the transcript rather than on a set: while the question is open, a
   * resize leaves the conversation exactly as long as it was.
   */
  it('a resize while the question is open commits nothing', async () => {
    const bridge = createBridge();
    const rendered = render(
      <App
        {...baseProps}
        agent={gatedAgent(bridge)}
        subscribeApproval={bridge.subscribe}
        initialMessage="tidy the build dir"
      />
    );

    const before = await frameWhere(rendered.lastFrame, (f) => f.includes('[o]nce'));
    rendered.stdout.emit('resize');
    rendered.stdout.emit('resize');
    await vi.waitFor(() => {
      const now = stripAnsi(rendered.lastFrame() ?? '');
      expect(now.split('Gaunt Sloth is asking about this call').length).toBe(
        before.split('Gaunt Sloth is asking about this call').length
      );
    });
    rendered.unmount();
  });

  /**
   * The whole point of keeping the answer off the turn's segment list: `onTurnComplete` is what
   * feeds the model's conversation history, and it must not learn that a human was asked.
   */
  it('onTurnComplete never sees the outcome', async () => {
    const bridge = createBridge();
    const seen: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={gatedAgent(bridge)}
        subscribeApproval={bridge.subscribe}
        initialMessage="tidy the build dir"
        onTurnComplete={(_input: string, text: string) => {
          seen.push(text);
        }}
      />
    );

    await frameWhere(lastFrame, (f) => f.includes('[o]nce'));
    stdin.write('o');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe('Listing the directory first.All done.');
    expect(seen[0]).not.toContain('approved by you');
    unmount();
  });
});
