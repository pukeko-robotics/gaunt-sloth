import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { PendingToolInterrupt, StatusUpdateCallback } from '#src/core/types.js';
import {
  NEGOTIATED_APPROVAL_COOLDOWN_MS,
  NEGOTIATION_MAX_ROUNDS_SHOWN,
  renderLiveNegotiationRows,
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
  streamWithEventsResume: vi.fn(),
  noteRaterClarification: vi.fn(),
  clearRaterClarifications: vi.fn(),
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
  /**
   * Drive `processMessagesWithEvents` instead of `processMessages`.
   *
   * **The event path is the Ink TUI's**, which is the surface the pinned panel lives on, so a
   * lifecycle guarantee asserted only against the string path would leave the one that matters
   * untested — and the two methods have separate bodies.
   */
  events?: boolean;
}

/**
 * Every `Round N` a rendered block draws, as `[number, command]`.
 *
 * The round number is read back OUT of the rendered text rather than off the event, because the
 * question these cases ask is what the two views TELL A PERSON — and the defect this pins was
 * invisible to every assertion phrased over positions, which were correct and agreed with each
 * other all along.
 */
const numbered = (rows: readonly { text: string }[]): [number, string][] =>
  rows
    .map((row) => /^\s*Round (\d+)(?: \(this request\))?: (.+)$/.exec(row.text))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), match[2]] as [number, string]);

interface DriveHandle {
  /** Resolves when the run has finished; rejects nothing (the error is captured). */
  run: Promise<unknown>;
  /** Every round the surface was handed, in order. */
  rounds: LiveNegotiationRound[];
  /** The pending interrupts the human was shown. */
  prompts: PendingToolInterrupt[];
  /** The runner itself, for cases that drive a lifecycle call (`/clear`) after the turn. */
  runner: InstanceType<typeof import('#src/core/GthAgentRunner.js').GthAgentRunner>;
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
    mockAgent.streamWithEvents.mockReset().mockImplementation(async function* () {});
    mockAgent.streamWithEventsResume.mockReset().mockImplementation(async function* () {});

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
      const messages = [new HumanMessage('wipe today’s commits')];
      if (options.events) {
        return (async () => {
          // Drained rather than inspected: these cases are about what reaches the DISPLAY, and the
          // generator has to run to completion for its `finally` to be part of what is asserted.
          for await (const _event of runner.processMessagesWithEvents(messages)) {
            /* drain */
          }
        })()
          .then(() => undefined)
          .catch((e: unknown) => e);
      }
      return runner
        .processMessages(messages)
        .then(() => undefined)
        .catch((e: unknown) => e);
    })();
    return { run, rounds, prompts, runner };
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
     * The approving round sits AFTER every rejection, which is the off-by-one worth pinning — and
     * it is marked as the one the rater AGREED to, which is what stops it being numbered from a
     * position the next rejection also occupies.
     */
    it('places each round in the exchange, and marks the one the rater agreed to', async () => {
      const handle = drive({
        calls: [{ command: 'a' }, { command: 'b' }, { command: 'c' }],
        script: ['destructive', 'destructive', 'safe'],
      });
      await handle.run;
      expect(handle.rounds.map((r) => r.position)).toEqual([0, 1, 2]);
      expect(handle.rounds.map((r) => r.agreed ?? false)).toEqual([false, false, true]);
    });

    /**
     * **The case the two views can disagree about, driven end to end.**
     *
     * *reject → the agent complies → the approved call → the agent proposes again → reject* is the
     * interleaving [[EXT-108]] exists to support: it stopped an approved call from emptying the
     * transcript precisely so this history survives. The transcript still holds REJECTIONS alone,
     * so an approved call numbered from its position takes the number the next rejection then takes
     * — the live panel showing two `Round 2` rows, and the escalation prompt, which renders that
     * same transcript, giving `Round 2` to a third command while never showing the second at all.
     *
     * **The assertion is duplicate-shaped, not label-shaped.** Every other case here is phrased over
     * positions or over one round's text, and the positions were correct: an off-by-one is caught
     * by the case above and a DUPLICATE is not. So this reads the numbers back out of the rendered
     * text and requires that no number names two commands, then requires the prompt's own numbering
     * to agree with the panel's command for command.
     */
    it('gives one round number to one command, in the live view and at the prompt alike', async () => {
      const handle = drive({
        calls: [
          { command: 'git reset --hard origin/main' },
          { command: 'git stash' },
          { command: 'git reset --hard HEAD~5' },
          { command: 'git reset --hard HEAD~2' },
          { command: 'git reset --hard HEAD~1' },
        ],
        script: ['destructive', 'safe', 'destructive', 'destructive', 'destructive'],
        human: 'reject',
      });
      await handle.run;

      // The exchange as a surface lays it out — the same call both surfaces make, per round.
      const liveRows = handle.rounds.flatMap((event) =>
        renderNegotiationRows([event.round], {
          width: 100,
          mode: 'live',
          from: event.position,
          ...(event.agreed ? { agreed: true } : {}),
        })
      );
      const live = numbered(liveRows);
      expect(live.map(([n]) => n)).toEqual([...new Set(live.map(([n]) => n))]);

      // The approved call is labelled rather than counted: the number it would have taken is the
      // one the rejection after it takes.
      expect(liveRows.map((row) => row.text)).toContain('  Agreed: git stash');
      expect(live.map(([, command]) => command)).not.toContain('git stash');

      // ...and the argument a person is asked to rule on numbers the same commands the same way.
      // Rendered with no width, which is the path that returns the whole transcript unsliced.
      expect(handle.prompts).toHaveLength(1);
      const prompt = handle.prompts[0];
      expect(
        numbered(
          renderNegotiationRows(prompt.negotiationRounds ?? [], {
            attempts: prompt.negotiationAttempts,
          })
        )
      ).toEqual(live);

      // On a real screen the prompt shows the newest rounds only, still numbered by their true
      // attempt number — so the command the panel called `Round 2` is the one the prompt does.
      expect(
        numbered(
          renderNegotiationRows(prompt.negotiationRounds ?? [], {
            width: 100,
            attempts: prompt.negotiationAttempts,
          })
        )
      ).toEqual(live.filter(([n]) => n >= 2));
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
     * §5.4 — **the round that ENDS the argument is labelled, never numbered.** The transcript holds
     * rejections alone, so any number given here is the number the next rejection takes, and the
     * escalation prompt — which renders that same transcript — would hand it to a third command.
     * Everything else about the round is unchanged: it is still the agent's proposal, with the
     * rater's answer beneath it in the rater's own voice.
     */
    it('labels the round the rater agreed to instead of numbering it', () => {
      const rows = renderNegotiationRows([round({ command: 'git stash' })], {
        width: 100,
        mode: 'live',
        from: 1,
        agreed: true,
      });
      const text = rows.map((r) => r.text).join('\n');
      expect(text).toContain('Agreed: git stash');
      expect(text).not.toContain('Round');
      expect(rows.find((r) => r.text.includes('Agreed:'))?.voice).toBe('agent');
      expect(text).toContain('agent justified: the user asked');
      expect(rows.find((r) => r.text.includes('rater answered'))?.voice).toBe('rater');
    });

    /**
     * The escalation block renders the transcript, and the transcript holds no approved round to
     * label — so the flag is a live-mode fact and cannot reach the prompt's numbering.
     */
    it('leaves the escalation block numbered even if told a round was agreed', () => {
      const text = renderNegotiationRows([round()], { width: 100, attempts: 1, agreed: true })
        .map((r) => r.text)
        .join('\n');
      expect(text).toContain('Round 1 (this request): git reset --hard origin/main');
      expect(text).not.toContain('Agreed:');
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
      expect(ended.slice(0, 5)).toEqual(['end', 'round', 'round', 'round', 'end']);
      // ...and the turn's own end clears the panel again on the way out. Asserted separately from
      // the sequence above so the escalation property — end BEFORE the prompt — keeps failing on
      // its own terms if it breaks, rather than being absorbed into one longer literal that a
      // future reader can only check by counting.
      expect(ended.at(-1)).toBe('end');
      expect(ended).toHaveLength(6);
      expect(rounds).toHaveLength(3);
    });

    /**
     * **The case an escalation cannot cover.** A negotiation that CONVERGES reaches nobody, so
     * nothing spends `humanReached()` and nothing told the surface the argument was over: the rounds
     * stayed pinned in the non-scrolling dock until the user's NEXT message — across exactly the
     * idle period in which they are reading the result and typing that message into a prompt those
     * rows have pushed toward the bottom of the screen.
     *
     * The turn ending is what clears it, which is why this asserts the LAST event rather than any
     * end at all: the turn opens with one too, and a cell satisfied by that would pass on the
     * unfixed code.
     */
    it('takes a CONVERGED exchange off the screen when the turn ends', async () => {
      const events: string[] = [];
      const runner = await driveWithDisplay(
        { round: () => events.push('round'), end: () => events.push('end') },
        {
          calls: [
            { command: 'git reset --hard origin/main' },
            { command: 'git reset --soft HEAD~2', justification: 'keeps the tree' },
          ],
          script: ['destructive', 'safe'],
        }
      );
      // Nobody was reached: the argument converged, so no escalation cleared the panel for us.
      expect(runner.prompts).toEqual([]);
      expect(events.filter((event) => event === 'round')).toHaveLength(2);
      expect(events.at(-1)).toBe('end');
    });

    /**
     * **And on the EVENT path**, which is the Ink TUI's — the surface the pinned panel actually
     * lives on, and therefore the one the unbounded-panel finding is about. The two turn methods
     * have separate bodies, so a `finally` added to one of them leaves the other exactly as it was;
     * asserting only against the string path would have pinned the half that does not matter here.
     */
    it('takes a CONVERGED exchange off the screen on the event path too', async () => {
      const events: string[] = [];
      suppliedDisplay = {
        round: () => events.push('round'),
        end: () => events.push('end'),
      };
      try {
        const handle = drive({
          events: true,
          calls: [
            { command: 'git reset --hard origin/main' },
            { command: 'git reset --soft HEAD~2', justification: 'keeps the tree' },
          ],
          script: ['destructive', 'safe'],
        });
        await handle.run;
        expect(events.filter((event) => event === 'round')).toHaveLength(2);
        expect(events.at(-1)).toBe('end');
      } finally {
        suppliedDisplay = undefined;
      }
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

  describe('§5.4 — the live panel is BOUNDED, like the prompt it shares a renderer with', () => {
    /**
     * A nine-round argument — {@link MAX_REJECTIONS_BEFORE_HUMAN}, the most the gate lets happen
     * before a person is reached — with prose long enough to wrap at a real width.
     */
    const nineRounds = (): LiveNegotiationRound[] =>
      Array.from({ length: 9 }, (_unused, index) => ({
        round: {
          command: `git reset --hard origin/main --quiet --attempt-number-${index + 1}`,
          justification: `the user asked me to wipe today's commits, attempt ${index + 1}, and I still believe this is the command they meant`,
          outcome: 'destructive' as const,
          reason: `refused because it discards committed work irreversibly (attempt ${index + 1})`,
        },
        position: index,
      }));

    /**
     * **The defect this pins was a cap that applied to nothing.** `renderNegotiationRows` slices to
     * {@link NEGOTIATION_MAX_ROUNDS_SHOWN}, but the live path handed it ONE round at a time — where
     * `slice(-3)` is an identity operation — and the panel accumulated the results. Measured at 46
     * rows for this argument at 80 columns, against 16 for the same argument in the escalation
     * prompt, inside a dock that is explicitly told not to shrink.
     *
     * Asserted as a comparison with the prompt rather than as a bare number, because "is it too
     * many rows" has no answer in the abstract: the prompt renders the SAME argument under the same
     * constraint, so it is the honest yardstick. The absolute bound is asserted too, since a
     * regression that inflated both would slip past a purely relative test.
     */
    it('draws a nine-round argument in a screenful, not in a screenful per round', () => {
      const rounds = nineRounds();
      const live = renderLiveNegotiationRows(rounds, { width: 80 });
      const prompt = renderNegotiationRows(
        rounds.map((entry) => entry.round),
        { width: 80, attempts: 9 }
      );

      // One context row, then at most three rounds of at most three elements, each element bound to
      // NEGOTIATION_MAX_ROWS_PER_ELEMENT = 2 terminal rows: 1 + 3 * 3 * 2 = 19.
      expect(live.length).toBeLessThanOrEqual(19);
      // The prompt shows a heading where the panel shows a context sentence, and both show three
      // rounds, so neither may cost meaningfully more than the other for one argument.
      expect(live.length).toBeLessThanOrEqual(prompt.length + 1);
      // Not vacuous: this fixture really does have nine rounds to drop, so an unsliced render is
      // far larger than the bound above and this cell fails when the slice goes.
      expect(rounds).toHaveLength(9);
      expect(live.length).toBeLessThan(rounds.length * 3);
    });

    /**
     * The rounds a watcher keeps are the NEWEST ones, numbered by their true position — the same
     * numbers the escalation prompt will give those same rounds. A panel that showed the first
     * three would freeze on the opening of an argument and never show the state it is in.
     */
    it('keeps the newest rounds, still numbered by their place in the argument', () => {
      const live = renderLiveNegotiationRows(nineRounds(), { width: 80 });
      expect(numbered(live).map(([number]) => number)).toEqual([7, 8, 9]);
      expect(live.some((row) => row.text.includes('Round 1:'))).toBe(false);
    });

    /**
     * The context sentence is drawn on every render rather than only over round one, because once
     * the window has slid past the opening round the alternative is a bare `Round 7:` heading
     * nothing — an unattributed command in the chrome of a tool asking the user to trust it.
     */
    it('still says whose argument this is after the opening round scrolls out', () => {
      const live = renderLiveNegotiationRows(nineRounds(), { width: 80 });
      expect(live[0]?.text).toBe('The agent is negotiating with the auto-rater:');
      expect(live[0]?.voice).toBe('chrome');
      expect(
        live.filter((row) => row.text.includes('negotiating with the auto-rater'))
      ).toHaveLength(1);
    });

    /** Below the cap nothing is dropped, so a short argument is shown whole. */
    it('shows a short argument in full', () => {
      const live = renderLiveNegotiationRows(nineRounds().slice(0, NEGOTIATION_MAX_ROUNDS_SHOWN), {
        width: 80,
      });
      expect(numbered(live).map(([number]) => number)).toEqual([1, 2, 3]);
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

  describe('§5.4 — the noted tool-call ids do not outlive their turn', () => {
    /**
     * **The ids are a per-turn tone hint, and nothing was emptying them.** The set had one writer
     * and no `clear` anywhere, so it grew for the life of the process — one string per rater
     * rejection, which is small — and, less small, a later call that reused a noted id would render
     * as a clarification request whatever it actually was. That reuse is unreachable with today's
     * providers because they all mint unique ids, which makes it a property of the PROVIDERS rather
     * than of this code: nothing here held it, and no dependency bump has to keep it.
     */
    it('drops them when a new turn begins', async () => {
      const handle = drive({ calls: [{ command: 'ls' }], script: ['safe'] });
      await handle.run;
      expect(mockAgent.clearRaterClarifications).toHaveBeenCalled();
    });

    /**
     * `/clear` too, and for the reason `resetThread` already gives about the negotiation itself:
     * state from before the user asked for the conversation to be forgotten must not decide how the
     * conversation after it is drawn.
     */
    it('drops them on a thread reset', async () => {
      const handle = drive({ calls: [{ command: 'ls' }], script: ['safe'] });
      await handle.run;
      mockAgent.clearRaterClarifications.mockClear();
      handle.runner.resetThread();
      expect(mockAgent.clearRaterClarifications).toHaveBeenCalledTimes(1);
    });

    /** An agent that renders nothing simply omits the method; a turn must not fail on its absence. */
    it('does not require the agent to implement it', async () => {
      const clear = mockAgent.clearRaterClarifications;
      // @ts-expect-error — deliberately modelling an agent that predates the method.
      mockAgent.clearRaterClarifications = undefined;
      try {
        const handle = drive({ calls: [{ command: 'ls' }], script: ['safe'] });
        await expect(handle.run).resolves.not.toBeInstanceOf(Error);
      } finally {
        mockAgent.clearRaterClarifications = clear;
      }
    });
  });

  describe('§5.5 — a negotiated approval is HELD before it takes effect', () => {
    /**
     * **Pinned at the interval, not merely observed to be positive.** A test that waits and then
     * asserts that some time passed passes on an implementation with no hold at all, so this
     * advances a fake clock to one millisecond SHORT of the minimum and requires the decision to be
     * unresolved there — the assertion that fails the moment the interval is reduced.
     *
     * The hold sits between the decision and the resume: when the interval elapses the runner has
     * not yet called `streamResume`. What that ordering buys is DISPLAY — the approving round
     * reaches the surface as its own event before the tool emits anything, so the exchange reads as
     * a sequence instead of collapsing into the tool's first line of output.
     *
     * **It is not an abort window, and this spec is not evidence of one.** Nothing on this path
     * re-checks the run's abort signal: the cases below drive `processMessages`, whose
     * `resolveToolInterrupts` threads no signal at all. See the note on `showNegotiatedApproval`
     * before restoring any stronger reading of the interval. This holds for every case in this
     * block: none of them passes `events: true`.
     *
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
        // The approved call has NOT been resumed yet: the tool has not started. That is a claim
        // about ORDER, not about cancellation — nothing here re-checks the abort signal.
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
      //
      // **Half the interval, and the margin that buys is on the DETECTION side.** This path does
      // not sleep at all — measured at 2–6 ms — so a bound of 800 was never close to failing here.
      // It was close to failing the other way: an implementation that DID sleep the interval came
      // in at 801, so the bound caught it by a single millisecond. Timer coalescing, a `setTimeout`
      // that fires a tick early, or a coarser clock on the Windows cell puts that at 799 and the
      // regression passes silently, which is the direction that costs something. A bound strictly
      // below the interval it exists to catch has ~400 ms of room in both directions instead of
      // 1 ms in the one that matters.
      expect(Date.now() - started).toBeLessThan(400);
      expect(mockAgent.streamResume).toHaveBeenCalledTimes(2);
    });

    /**
     * **The approval that ANSWERS the refusal is held; the calls that merely follow it are not.**
     *
     * The condition used to be *"is the transcript non-empty"* — a fact about the TURN, not about
     * the command in front of the gate. Since [[EXT-108]] an approved call deliberately leaves the
     * rounds standing, so that stayed true for the whole rest of the turn: one refusal followed by
     * six ordinary read-only commands was measured at **4817 ms of holds in a single turn**, each
     * one drawing a row that said the auto-rater had agreed to a command it had never seen.
     *
     * It also inverted the requirement. §5.5 exists to give the approval an argument produced its
     * own salience; spent on `ls src` the window marks nothing, and the genuinely negotiated
     * approval — when it comes — is the seventh identical pause rather than the only one.
     *
     * `consecutiveRejections` is the question actually being asked: is a refusal standing
     * unanswered right now. `noteProgress()` zeroes it the moment any call gets through, so the
     * first approval after a refusal ends the argument and the rest of the turn is ordinary.
     *
     * **The timing is pinned with a fake clock and one interval's worth of advance**, which is what
     * makes this fail on the old behaviour: three holds need 2400 ms, so the run is still
     * outstanding at 800 and `finished` is false.
     */
    it('holds the approval that answers the refusal, and no later call in the turn', async () => {
      vi.useFakeTimers();
      const handle = drive({
        calls: [
          { command: 'git reset --hard origin/main' },
          { command: 'ls src' },
          { command: 'cat package.json' },
          { command: 'ls docs' },
        ],
        script: ['destructive', 'safe', 'safe', 'safe'],
      });
      try {
        let finished = false;
        void handle.run.then(() => {
          finished = true;
        });

        // Everything except the timer has settled: one hold is outstanding.
        await vi.advanceTimersByTimeAsync(0);
        expect(finished).toBe(false);

        // Exactly ONE interval finishes the whole turn. Three holds would not.
        //
        // Asserted BEFORE awaiting the run, deliberately: awaiting first would make the old
        // behaviour hang until vitest's timeout, and a timeout is a failure whose message names the
        // clock rather than the defect. This way the regression reads `expected false to be true`.
        await vi.advanceTimersByTimeAsync(NEGOTIATED_APPROVAL_COOLDOWN_MS);
        expect(finished).toBe(true);

        // And the screen says so: the refusal, then the one call that ended the argument. The two
        // ordinary commands after it are not rounds of anything.
        expect(handle.rounds.map((r) => [r.round.command, r.agreed === true])).toEqual([
          ['git reset --hard origin/main', false],
          ['ls src', true],
        ]);
      } finally {
        // Drain whatever is still outstanding before handing the mocks to the next case. Without
        // this a FAILING run stays in flight, and the next test's `mockReset` pulls the rug out
        // from under it — which is how one real failure turns into two confusing ones.
        await vi.advanceTimersByTimeAsync(NEGOTIATED_APPROVAL_COOLDOWN_MS * 5);
        await handle.run;
        vi.useRealTimers();
      }
    });

    /**
     * **`Agreed` is a claim about the rater's opinion of THIS command; `Accepted` is a claim only
     * about what it let through.** Both end an argument and both are held — §5.3 counts either as
     * progress — but only one of them can truthfully be said about a given command, and the wrong
     * one prints a false statement about the auto-rater in the chrome of the thing asking the user
     * to trust it.
     *
     * Read out of the RENDERED TEXT of both surfaces, because the flag being right on the event and
     * wrong on the screen is the failure this is for.
     */
    it('says AGREED only of a command the rater refused, and ACCEPTED of a revision', async () => {
      const rendered = async (calls: { command: string }[]): Promise<string[]> => {
        const handle = drive({ calls, script: ['destructive', 'safe'] });
        await handle.run;
        const ending = handle.rounds.filter((round) => round.agreed === true);
        expect(ending).toHaveLength(1);
        return [
          ...renderLiveNegotiationRows(handle.rounds, { width: 80 }),
          // The readline surface renders the same ending round on its own, one at a time.
          ...renderNegotiationRows([ending[0]!.round], {
            width: 80,
            mode: 'live',
            from: ending[0]!.position,
            agreed: true,
            ...(ending[0]!.revised ? { revised: true } : {}),
          }),
        ].map((row) => row.text);
      };

      // The agent narrowed the command until the rater passed it: the rater never argued about
      // `git reset --soft HEAD~2`, so it did not agree to it.
      const revised = await rendered([
        { command: 'git reset --hard origin/main' },
        { command: 'git reset --soft HEAD~2' },
      ]);
      expect(
        revised.filter((text) => text.includes('Accepted: git reset --soft HEAD~2'))
      ).toHaveLength(2);
      expect(revised.some((text) => text.includes('Agreed:'))).toBe(false);

      // The agent re-proposed the very command that was refused, with a justification, and the
      // rater changed its mind. That, and only that, is the rater agreeing.
      const same = await rendered([
        { command: 'git reset --hard origin/main' },
        { command: 'git reset --hard origin/main' },
      ]);
      expect(
        same.filter((text) => text.includes('Agreed: git reset --hard origin/main'))
      ).toHaveLength(2);
      expect(same.some((text) => text.includes('Accepted:'))).toBe(false);
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
      // Half the interval, for the same reason as the cell above: a bound set AT the value a
      // sleeping implementation produces catches it by a millisecond, and misses it entirely if
      // the timer lands a tick early.
      expect(Date.now() - started).toBeLessThan(400);
    });
  });
});
