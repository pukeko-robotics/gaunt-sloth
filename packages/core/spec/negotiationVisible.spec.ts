import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { PendingToolInterrupt, StatusUpdateCallback } from '#src/core/types.js';
import {
  NEGOTIATED_APPROVAL_COOLDOWN_MS,
  renderNegotiationRows,
  type LiveNegotiationRound,
  type NegotiationDisplay,
} from '#src/core/shell/negotiation.js';
import { setProjectDir } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';

/**
 * [[TUI-C69]] §5.4/§5.5 — **the negotiation as something a person can watch, and the hold before a
 * negotiated approval acts.**
 *
 * What is asserted here is what reaches a SURFACE, driven through the real `GthAgentRunner` with a
 * scripted rater, because the defects this node exists to fix were entirely in what reached the
 * screen: an exchange visible only at an escalation (that is, only in the runs where the argument
 * FAILED), and a working negotiation round drawn in the vocabulary of a broken tool.
 *
 * The renderer's own live/escalation split is pinned in `shellNegotiation.spec.ts`'s company below;
 * these cases are about the gate emitting at all, to whom, and when.
 */

const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  cleanup: vi.fn(),
  getPendingToolInterrupts: vi.fn(),
  streamResume: vi.fn(),
  noteRaterClarification: vi.fn(),
};

vi.mock('#src/core/shell/raterModel.js', () => ({ resolveRaterModel: vi.fn() }));
vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class {
    constructor() {
      return mockAgent;
    }
  },
  StatusUpdateCallback: vi.fn(),
}));

/** EXT-71 — clamp the persisted-grant anchor, or this suite reads the real project's allow-list. */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-negotiation-visible-'));

function streamOf(...chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** One outcome the scripted rater will return, in order. */
type ScriptedOutcome = 'safe' | 'destructive';

interface DriveOptions {
  calls: { command: string; justification?: string; id?: string }[];
  script: ScriptedOutcome[];
  /** Wire a live display (a surface that is showing the exchange). Default: yes. */
  display?: boolean;
  /** What the human answers at an escalation. Absent → no human at all (§6.2). */
  human?: 'approve' | 'reject';
}

interface DriveHandle {
  /** Resolves when the run has finished; rejects nothing (the error is captured). */
  run: Promise<unknown>;
  /** Every round the surface was handed, in order. */
  rounds: LiveNegotiationRound[];
  /** The pending interrupts the human was shown. */
  prompts: PendingToolInterrupt[];
}

describe('[[TUI-C69]] §5.4/§5.5 — the visible negotiation and the cooldown', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdate: StatusUpdateCallback;
  /** Set by {@link driveWithDisplay} so a case can watch the display's own call order. */
  let suppliedDisplay: NegotiationDisplay | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    setProjectDir(projectDir);
    rmSync(join(projectDir, SHELL_ALLOWLIST_FILE), { force: true });
    mockAgent.init.mockResolvedValue(undefined);
    mockAgent.cleanup.mockResolvedValue(undefined);
    statusUpdate = vi.fn();
    suppliedDisplay = undefined;
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  /**
   * Start a run of gated shell calls through the real runner, with a rater scripted to answer each
   * RATING CALL in turn. Returns without awaiting, so a test can inspect the world while the run is
   * suspended inside the §5.5 hold.
   */
  function drive(options: DriveOptions): DriveHandle {
    const queue = [...options.script];
    const invoke = vi.fn().mockImplementation(() => {
      const outcome = queue.shift();
      if (!outcome) throw new Error('the scripted rater ran out of answers');
      return Promise.resolve({ outcome, reason: `${outcome} because the script says so` });
    });
    const config = {
      llm: { withStructuredOutput: vi.fn().mockReturnValue({ invoke }) },
      streamOutput: true as const,
      approvals: { mode: 'auto' },
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
    } as unknown as GthConfig;

    let pending = mockAgent.getPendingToolInterrupts.mockReset();
    for (const call of options.calls) {
      pending = pending.mockResolvedValueOnce([
        {
          name: 'run_shell_command',
          args: {
            command: call.command,
            ...(call.justification ? { justification: call.justification } : {}),
          },
          ...(call.id ? { id: call.id } : {}),
        },
      ]);
    }
    pending.mockResolvedValue([]);
    mockAgent.streamResume.mockReset().mockResolvedValue(streamOf(''));
    mockAgent.stream.mockReset().mockResolvedValue(streamOf('x'));

    const runner = new GthAgentRunner(statusUpdate);
    const rounds: LiveNegotiationRound[] = [];
    const prompts: PendingToolInterrupt[] = [];
    const run = (async () => {
      await runner.init('code', config);
      if (options.display !== false) {
        runner.setNegotiationDisplay(suppliedDisplay ?? { round: (event) => rounds.push(event) });
      }
      if (options.human) {
        const answer = options.human;
        runner.setToolApprovalCallback((p) => {
          prompts.push(p);
          return answer === 'approve' ? { type: 'approve', scope: 'once' } : { type: 'reject' };
        });
      }
      return runner
        .processMessages([new HumanMessage('wipe today’s commits')])
        .then(() => undefined)
        .catch((e: unknown) => e);
    })();
    return { run, rounds, prompts };
  }

  /**
   * {@link drive} with a display the caller supplies, so a case can observe the ORDER of `round`
   * and `end` rather than only what each one carried. Awaits the run.
   */
  async function driveWithDisplay(
    display: NegotiationDisplay,
    options: Omit<DriveOptions, 'display'>
  ): Promise<{ prompts: PendingToolInterrupt[] }> {
    suppliedDisplay = display;
    try {
      const handle = drive(options);
      await handle.run;
      return { prompts: handle.prompts };
    } finally {
      suppliedDisplay = undefined;
    }
  }

  describe('§5.4 — the rounds render AS THEY HAPPEN, not only at an escalation', () => {
    /**
     * **The case the node is about.** Two rejections and then the rater agreeing: a negotiation
     * that CONVERGES, so no escalation prompt ever opens. Before this, the whole exchange was
     * invisible in exactly this run — the transcript reached a person only at an escalation, which
     * is to say only when the argument failed.
     */
    it('hands the surface every round of a negotiation that never reaches a person', async () => {
      const handle = drive({
        calls: [
          { command: 'git reset --hard origin/main' },
          { command: 'git reset --hard HEAD~5', justification: 'narrowed to today' },
          { command: 'git reset --soft HEAD~2', justification: 'keeps the tree' },
        ],
        script: ['destructive', 'destructive', 'safe'],
      });
      await handle.run;

      // Nobody was ever asked: no approval callback was wired, and §6.2's non-interactive
      // escalation never fired, because the argument converged.
      expect(handle.prompts).toEqual([]);
      expect(handle.rounds.map((r) => r.round.command)).toEqual([
        'git reset --hard origin/main',
        'git reset --hard HEAD~5',
        'git reset --soft HEAD~2',
      ]);
      // The rater's outcome and explanation ride each round, which is what §5.4 asks the surface
      // to show alongside the command and the agent's justification.
      expect(handle.rounds.map((r) => r.round.outcome)).toEqual([
        'destructive',
        'destructive',
        'safe',
      ]);
      expect(handle.rounds[1].round.justification).toBe('narrowed to today');
      expect(handle.rounds[1].round.reason).toContain('destructive');
    });

    /**
     * The position is the fact the surface cannot derive: it is handed one round at a time, so
     * `Round N` and §5.1's *rated on the command alone* marker have no array length to come from.
     * The approving round sits AFTER every rejection, which is the off-by-one worth pinning.
     */
    it('numbers each round by its place in the exchange, the approving one last', async () => {
      const handle = drive({
        calls: [{ command: 'a' }, { command: 'b' }, { command: 'c' }],
        script: ['destructive', 'destructive', 'safe'],
      });
      await handle.run;
      expect(handle.rounds.map((r) => r.position)).toEqual([0, 1, 2]);
    });

    /** The rounds a person is later shown are the rounds they watched — one renderer, one account. */
    it('renders the agent’s and the rater’s turns as separate, named, voiced rows', async () => {
      const handle = drive({
        calls: [{ command: 'rm -rf build' }, { command: 'rm -rf build/tmp' }],
        script: ['destructive', 'safe'],
      });
      await handle.run;

      const rows = renderNegotiationRows([handle.rounds[0].round], {
        width: 80,
        mode: 'live',
        from: handle.rounds[0].position,
      });
      const agent = rows.find((row) => row.text.includes('Round 1:'));
      const rater = rows.find((row) => row.text.includes('rater answered'));
      expect(agent?.voice).toBe('agent');
      expect(agent?.text).toContain('rm -rf build');
      // §5.4 — the rater's turns are the ones a surface paints yellow, and the row NAMES the
      // speaker as well, so the distinction survives a terminal with no colour.
      expect(rater?.voice).toBe('rater');
      expect(rater?.text).toContain('destructive');
    });
  });

  /**
   * §5.4 — the ONE renderer, asked for a live round instead of an escalation transcript.
   *
   * Every marker it draws is a property of a POSITION IN THE TRANSCRIPT, and a caller handing over
   * one round at a time has taken the array's length away as a source for them. These pin what
   * changes in `live` mode and — just as importantly — what does not.
   */
  describe('§5.4 — renderNegotiationRows in live mode', () => {
    const round = (
      over: Partial<{ command: string; justification: string; reason: string }> = {}
    ) =>
      ({
        command: over.command ?? 'git reset --hard origin/main',
        justification: over.justification ?? 'the user asked to wipe today’s commits',
        outcome: 'destructive' as const,
        reason: over.reason ?? 'discards every unpushed commit',
      }) as const;

    it('numbers a round from its position, not from the array it arrived in', () => {
      const text = renderNegotiationRows([round()], { width: 100, mode: 'live', from: 2 })
        .map((r) => r.text)
        .join('\n');
      expect(text).toContain('Round 3: git reset --hard origin/main');
      expect(text).not.toContain('Round 1');
    });

    /**
     * §5.1's *rated on the command alone* is true of the FIRST round of an exchange and of no
     * other. Derived from the array, a one-round slice would claim it every time — which would tell
     * the reader the rater never saw a justification it had in fact just been given.
     */
    it('marks the opening round as rated on the command alone, and no later one', () => {
      const first = renderNegotiationRows([round()], { width: 100, mode: 'live', from: 0 })
        .map((r) => r.text)
        .join('\n');
      expect(first).toContain('agent justified (not shown to the rater):');
      expect(first).toContain('rater answered (on the command alone):');

      const later = renderNegotiationRows([round()], { width: 100, mode: 'live', from: 1 })
        .map((r) => r.text)
        .join('\n');
      expect(later).toContain('agent justified: the user asked');
      expect(later).toContain('rater answered: destructive');
      expect(later).not.toContain('on the command alone');
    });

    /**
     * **A live round is never "(this request)".** Nothing is being ruled on: that marker means
     * *this is the call you are being asked about*, and drawing it here would announce a prompt
     * that has not opened.
     */
    it('never marks a live round as the pending request', () => {
      for (const from of [0, 1, 2]) {
        const text = renderNegotiationRows([round()], { width: 100, mode: 'live', from })
          .map((r) => r.text)
          .join('\n');
        expect(text).not.toContain('(this request)');
      }
    });

    /**
     * One context sentence per exchange, over the round that opens it. Repeated per round it would
     * spend a row apiece saying the same thing; omitted entirely, the readline surface would print
     * a bare `Round 1:` with no account of what is arguing with what.
     */
    it('draws its context sentence once, over the opening round only', () => {
      const opening = renderNegotiationRows([round()], { width: 100, mode: 'live', from: 0 });
      expect(opening[0]).toEqual({
        voice: 'chrome',
        text: 'The agent is negotiating with the auto-rater:',
      });
      const later = renderNegotiationRows([round()], { width: 100, mode: 'live', from: 1 });
      expect(later.some((r) => r.voice === 'chrome')).toBe(false);
      // ...and it is NOT the escalation heading, which counts an argument a person is ruling on.
      expect(opening.map((r) => r.text).join('\n')).not.toContain('argued with the auto-rater');
    });

    /**
     * The escalation block is what every caller that predates §5.4's live render draws, and this
     * change must leave it alone: its heading counts the argument, and its last round IS the
     * request being ruled on.
     */
    it('leaves the escalation block exactly as it was', () => {
      const rows = renderNegotiationRows([round(), round({ command: 'git reset --soft' })], {
        width: 100,
        attempts: 2,
      });
      const text = rows.map((r) => r.text).join('\n');
      expect(rows[0].text).toBe('The agent argued with the auto-rater 2 times:');
      expect(text).toContain('Round 1: git reset --hard origin/main');
      expect(text).toContain('Round 2 (this request): git reset --soft');
    });
  });

  /**
   * §5.3 — *"three rejections end the negotiation"* means the exchange is OVER, not paused, and the
   * surface holding it has to hear that on the same event the gate spends its transcript on.
   *
   * **Measured on a real terminal**: without this the escalation prompt — which renders the whole
   * argument itself — was drawn beneath a live copy of the same rounds, putting one exchange on an
   * unscrollable screen twice. The PTY suite caught it as six `rater answered` rows where three
   * were expected.
   */
  describe('§5.4 — reaching a person ends the exchange on screen too', () => {
    it('tells the surface the exchange ended, before the prompt renders it in full', async () => {
      const ended: string[] = [];
      const rounds: LiveNegotiationRound[] = [];
      const runner = await driveWithDisplay(
        {
          round: (event) => {
            rounds.push(event);
            ended.push('round');
          },
          end: () => ended.push('end'),
        },
        {
          calls: [{ command: 'x' }, { command: 'x' }, { command: 'x' }],
          script: ['destructive', 'destructive', 'destructive'],
          human: 'reject',
        }
      );
      expect(runner.prompts).toHaveLength(1);
      // The turn OPENS with an end — a new user turn is a person being reached, so any argument
      // standing from the previous turn is over before this one starts. Then three rounds, then the
      // exchange declared over, which happens BEFORE the human is asked: the prompt is what renders
      // the whole argument next, and a live copy above it would draw the same exchange twice.
      expect(ended).toEqual(['end', 'round', 'round', 'round', 'end']);
      expect(rounds).toHaveLength(3);
    });

    /** A new user turn is a person being reached too, so a stale argument cannot outlive its turn. */
    it('tells the surface the exchange ended when a new turn begins', async () => {
      const ended: string[] = [];
      await driveWithDisplay(
        { round: () => undefined, end: () => ended.push('end') },
        { calls: [{ command: 'ls' }], script: ['safe'] }
      );
      expect(ended.length).toBeGreaterThan(0);
    });
  });

  describe('§5.4 — a rejection is a clarification request, not a failed tool', () => {
    /**
     * The signal is threaded on the call's own id, from the gate's decision — never sniffed from
     * the result text, and never by clearing LangChain's error status, which the model, `gth
     * eval`'s tool-result assertions and the ACP bridge all read.
     */
    it('names the refused call so its result row can be toned as a round of the argument', async () => {
      const handle = drive({
        calls: [
          { command: 'git push --force', id: 'call_1' },
          { command: 'git push', id: 'call_2' },
        ],
        script: ['destructive', 'safe'],
      });
      await handle.run;
      expect(mockAgent.noteRaterClarification.mock.calls).toEqual([['call_1']]);
    });

    /**
     * **An ESCALATION is not a clarification request**, and the difference is the whole point: the
     * agent is not being asked to narrow anything, the argument is over and a person is being
     * asked. A row toned as an ongoing negotiation there would say the opposite of what happened.
     */
    it('does NOT name a call whose rejection spent a bound and went to a human', async () => {
      const handle = drive({
        calls: [
          { command: 'x', id: 'c1' },
          { command: 'x', id: 'c2' },
          { command: 'x', id: 'c3' },
        ],
        script: ['destructive', 'destructive', 'destructive'],
        human: 'reject',
      });
      await handle.run;
      // Three consecutive rejections escalate (§5.3), so the third call reached the human.
      expect(handle.prompts).toHaveLength(1);
      expect(mockAgent.noteRaterClarification.mock.calls).toEqual([['c1'], ['c2']]);
    });
  });

  describe('§5.5 — a negotiated approval is HELD before it takes effect', () => {
    /**
     * **Pinned at the interval, not merely observed to be positive.** A test that waits and then
     * asserts that some time passed passes on an implementation with no hold at all, so this
     * advances a fake clock to one millisecond SHORT of the minimum and requires the decision to be
     * unresolved there — the assertion that fails the moment the interval is reduced.
     *
     * The hold sits between the decision and the resume, which is what makes it an abort window
     * rather than a pause: the runner has not yet called `streamResume`, and the resume carries the
     * run's abort signal. It is NOT a reading window and must never be relied on as one.
     */
    /**
     * **The numbers below are LITERALS on purpose.** Advancing by
     * `NEGOTIATED_APPROVAL_COOLDOWN_MS - 1` would move the assertion with the value it is meant to
     * pin, so a hold cut to 100 ms would still pass — the assertion-that-cannot-fail shape. Written
     * as 799 and 800, cutting the constant makes the run finish before the first checkpoint and
     * this goes red there.
     */
    it('holds the approval for 800 ms, to the millisecond', async () => {
      expect(NEGOTIATED_APPROVAL_COOLDOWN_MS).toBe(800);
      vi.useFakeTimers();
      try {
        const handle = drive({
          calls: [{ command: 'git reset --hard' }, { command: 'git reset --soft HEAD~2' }],
          script: ['destructive', 'safe'],
        });
        let finished = false;
        void handle.run.then(() => {
          finished = true;
        });

        // Let every microtask (the scripted rater, the mocked streams) settle, so what remains
        // outstanding is the timer and nothing else.
        await vi.advanceTimersByTimeAsync(0);
        expect(handle.rounds).toHaveLength(2);
        expect(finished).toBe(false);
        expect(mockAgent.streamResume).toHaveBeenCalledTimes(1); // the REJECTED round only

        await vi.advanceTimersByTimeAsync(799);
        expect(finished).toBe(false);
        // The approved call has NOT been resumed: the tool has not started, so an abort landing
        // here still stops it.
        expect(mockAgent.streamResume).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await handle.run;
        expect(finished).toBe(true);
        expect(mockAgent.streamResume).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * **A surface with no live display must not sleep.** An `exec` or CI run has nobody to show an
     * approval to, so a hold there would tax every headless run and every gate for a display that
     * does not exist. Real timers, deliberately: under fake ones an implementation that DID sleep
     * would simply hang, which is a less legible failure than a test that finishes.
     */
    it('does not hold when no surface is showing the negotiation', async () => {
      const handle = drive({
        calls: [{ command: 'git reset --hard' }, { command: 'git reset --soft HEAD~2' }],
        script: ['destructive', 'safe'],
        display: false,
      });
      const started = Date.now();
      await handle.run;
      expect(handle.rounds).toEqual([]);
      // A literal, not the constant: the mutation this catches is the DISPLAY GATE being dropped,
      // and a bound that moved with the constant would still pass on a shortened hold.
      expect(Date.now() - started).toBeLessThan(800);
      expect(mockAgent.streamResume).toHaveBeenCalledTimes(2);
    });

    /**
     * A first attempt rated `safe` is not a NEGOTIATED approval: nothing was refused, no argument
     * happened, and there is nothing a person could have watched. Holding there would put an 800 ms
     * tax on the ordinary case.
     */
    it('does not hold an approval that ended no argument', async () => {
      const handle = drive({ calls: [{ command: 'ls' }], script: ['safe'] });
      const started = Date.now();
      await handle.run;
      expect(handle.rounds).toEqual([]);
      expect(Date.now() - started).toBeLessThan(800);
    });
  });
});
