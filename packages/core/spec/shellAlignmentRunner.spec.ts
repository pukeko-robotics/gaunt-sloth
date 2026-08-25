import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { GthCommand } from '#src/config/types.js';
import { StatusLevel } from '#src/core/types.js';
import type { PendingToolInterrupt, StatusUpdateCallback } from '#src/core/types.js';
import type { ApprovalDecisionCapture } from '#src/core/shell/approvalCapture.js';
import type { LiveNegotiationRound } from '#src/core/shell/negotiation.js';
import {
  ALIGNMENT_TOOL_APPROVE,
  ALIGNMENT_TOOL_ESCALATE,
  ALIGNMENT_TOOL_SUGGEST,
  ALIGNMENT_TOOL_VIEW,
} from '#src/core/shell/alignment.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';

/**
 * [[EXT-127]] — **the WIRE from the approvals gate to the alignment checker**, driven through the
 * real `GthAgentRunner`.
 *
 * `shellAlignmentChecker.spec.ts` covers the checker as a component: the four roles, the fencing,
 * the tool contract, the fail-closed loop. Everything there is reachable by calling the module
 * directly, and none of it says whether the runner ever calls it, with what, or what it does with
 * the answer. **That gap was measured, not assumed**: setting `alignmentReachable = false && …` in
 * the runner left the entire 6810-test suite green, and repointing the checker's `user` role at the
 * ungated raw store — the one thing this node's whole design forbids — left it green as well.
 *
 * **Why the feature was invisible to every existing runner-level spec**, so nobody rebuilds one
 * that cannot see it: they give `config.llm` a `withStructuredOutput` and nothing else, and
 * `runAlignmentCheck` refuses a model without `bindTools` and fails closed before it does anything.
 * A fail-closed check leaves the classifier's own action standing — by design — so the suite sees
 * exactly what it saw before the feature existed. The harness below gives the model BOTH seams,
 * which is the whole of what makes any of this observable.
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
const projectDir = mkdtempSync(join(tmpdir(), 'gth-alignment-runner-spec-'));

function streamOf(...chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** One outcome the scripted CLASSIFIER will return, in order. */
type ScriptedOutcome = 'safe' | 'destructive' | 'catastrophic' | 'attack';

/** One tool call the scripted CHECKER makes on one of its turns. */
interface CheckerCall {
  name: string;
  args: Record<string, unknown>;
}

/** One scripted check: the tool calls it makes, turn by turn. */
type CheckerScript = CheckerCall[][];

/**
 * The intended two-turn path — view, then decide — which is what a check that answers looks like.
 * Written as a helper because every case below wants it and a hand-rolled copy per case is how one
 * of them ends up scripting a decision without the view the tools require first.
 */
function decides(
  tool: string,
  args: Record<string, unknown> = { reason: 'aligned' }
): CheckerScript {
  return [[{ name: ALIGNMENT_TOOL_VIEW, args: {} }], [{ name: tool, args }]];
}

interface DriveResult {
  /** What each gated call was decided as, in order. */
  decisions: { type: string; message?: string }[];
  /** Whether a human was asked, per gated call index. */
  escalatedAt: number[];
  /** The pending interrupt the human was shown, per escalation — the transcript they ruled on. */
  prompts: PendingToolInterrupt[];
  /** Every round the gate handed to a watching surface, as it happened. */
  liveRounds: LiveNegotiationRound[];
  /** The gate's own record of each gated call, including its alignment check. */
  records: readonly ApprovalDecisionCapture[];
  /** WARNING-level status lines the gate emitted. */
  warnings: string[];
  /** How many alignment checks were started — i.e. how many times a checker model was bound. */
  checksStarted: number;
  /** The conversation handed to the checker on each of its turns, across all checks. */
  checkerConversations: BaseMessage[][];
}

describe('[[EXT-127]] the runner-side wiring of the alignment check', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdate: Mock<StatusUpdateCallback>;
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    rmSync(join(projectDir, SHELL_ALLOWLIST_FILE), { force: true });
    mockAgent.init.mockResolvedValue(undefined);
    mockAgent.cleanup.mockResolvedValue(undefined);
    statusUpdate = vi.fn();
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    if (priorProjectDir !== undefined) setProjectDir(priorProjectDir);
  });

  /**
   * Drive gated shell calls through the real runner, with BOTH gate models scripted: the classifier
   * through `withStructuredOutput`, the checker through `bindTools`.
   *
   * Both are seams on the SAME `config.llm`, which is what production does when neither
   * `approvals.rater` nor `approvals.alignmentChecker` names a profile — so no `resolveRaterModel`
   * scripting is needed and the models used here are reached exactly as they are in a default
   * session.
   */
  async function drive(options: {
    calls: { command: string; justification?: string }[];
    /** The classifier's answers, one per RATING call, consumed lazily. */
    ratings: ScriptedOutcome[];
    /** The checker's answers, one script per CHECK, consumed in order. */
    checks?: CheckerScript[];
    mode?: 'assisted' | 'auto';
    /** The CLI verb. Only `code`, `exec` and `ask --write` bind a shell tool at all. */
    verb?: GthCommand;
    /**
     * Override [[EXT-106]] §4.6's provenance gate AFTER `init` has set it from the verb.
     *
     * **Why an override exists rather than a second verb.** The gate is decided once, at `init`,
     * from `commandCarriesUserProvenance(command)` — and no shipping verb both binds a shell tool
     * and withholds provenance: dev tools resolve only for `code`, `exec` and `ask --write`, and
     * all three are admitted, while `review`, `pr` and `api` are withheld and bind no shell at all.
     * So the non-admitting half of the pair below has **no end-to-end route today** and would be
     * unconstructible if this harness insisted on one.
     *
     * The VERB→gate wiring is pinned elsewhere and does not need re-testing here
     * (`shellUserProvenance.spec.ts` cell 11 drives `review`, `pr` and the verb-less discovery
     * runner and asserts the window is empty for each). What this override buys is the OTHER half,
     * which nothing pinned: that the runner hands the checker THAT window rather than the raw store
     * beside it. Setting it through the same public method `init` uses keeps the state reachable
     * only the way production reaches it.
     */
    admitProvenance?: boolean;
    /** What the human answers at an escalation. Absent → no human at all (§6.2). */
    human?: 'approve' | 'reject';
    userMessages?: string[];
  }): Promise<DriveResult> {
    const verb = options.verb ?? 'code';
    const ratingQueue = [...options.ratings];
    const checkerScripts = [...(options.checks ?? [])];
    const checkerConversations: BaseMessage[][] = [];
    let checksStarted = 0;

    const classifierInvoke = vi.fn().mockImplementation(() => {
      const outcome = ratingQueue.shift();
      if (!outcome) throw new Error('the scripted classifier ran out of answers');
      return Promise.resolve({ outcome, reason: `${outcome} because the script says so` });
    });

    // One `bindTools` call per check (`runAlignmentCheck` binds once, then loops), so the call
    // count IS the number of checks that were started — including the ones that then fail closed.
    const bindTools = vi.fn(() => {
      const index = checksStarted;
      checksStarted += 1;
      const script = checkerScripts[index] ?? [];
      let turn = 0;
      return {
        invoke: vi.fn(async (conversation: BaseMessage[]) => {
          checkerConversations.push(conversation);
          const calls = script[turn] ?? [];
          turn += 1;
          return new AIMessage({
            content: '',
            tool_calls: calls.map((call, i) => ({ ...call, id: `check-${index}-${turn}-${i}` })),
          });
        }),
      };
    });

    const config = {
      llm: {
        withStructuredOutput: vi.fn().mockReturnValue({ invoke: classifierInvoke }),
        bindTools,
      },
      streamOutput: true as const,
      approvals: { mode: options.mode ?? 'auto' },
      commands: { [verb]: { builtInTools: { run_shell_command: { enabled: true } } } },
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
        },
      ]);
    }
    pending.mockResolvedValue([]);
    const streamResume = mockAgent.streamResume.mockReset().mockResolvedValue(streamOf(''));
    mockAgent.stream.mockReset().mockResolvedValue(streamOf('x'));

    const runner = new GthAgentRunner(statusUpdate);
    await runner.init(verb, config);
    if (options.admitProvenance !== undefined) {
      // Reached through the private field for the same reason the negotiation specs read
      // `sinceHuman` that way: `init` is production's only caller, and widening the runner's public
      // surface so a spec can reach it would put a setter in the product for nobody.
      (
        runner as unknown as { negotiation: { admitUserProvenance(admitted: boolean): void } }
      ).negotiation.admitUserProvenance(options.admitProvenance);
    }
    const escalatedAt: number[] = [];
    const prompts: PendingToolInterrupt[] = [];
    // A watching surface, so `showNegotiationRound` is observable: the live panel is the OTHER
    // place a recorded round reaches a person, and a fix that only filled the escalation prompt
    // would leave the argument on screen missing its last turn.
    const liveRounds: LiveNegotiationRound[] = [];
    runner.setNegotiationDisplay({ round: (event) => liveRounds.push(event) });
    if (options.human) {
      const answer = options.human;
      runner.setToolApprovalCallback((pending) => {
        prompts.push(pending);
        escalatedAt.push(streamResume.mock.calls.length);
        return answer === 'approve' ? { type: 'approve', scope: 'once' } : { type: 'reject' };
      });
    }
    const input = (options.userMessages ?? ['go']).map((text) => new HumanMessage(text));
    await runner.processMessages(input).catch(() => undefined);

    return {
      decisions: streamResume.mock.calls.map(
        (call) => call[0].decisions[0] as { type: string; message?: string }
      ),
      escalatedAt,
      prompts,
      liveRounds,
      records: runner.getApprovalCaptures(),
      warnings: statusUpdate.mock.calls
        .filter((c) => c[0] === StatusLevel.WARNING)
        .map((c) => String(c[1])),
      checksStarted,
      checkerConversations,
    };
  }

  /** The `human` role of the check the gate made on the `index`-th gated call. */
  function checkerUserMessage(result: DriveResult, index = 0): string {
    const alignment = result.records[index]?.alignment;
    expect(alignment, `gated call ${index} recorded no alignment check`).toBeDefined();
    expect(
      alignment?.failClosed,
      `gated call ${index}'s check failed closed, so it proves nothing about what was sent`
    ).toBeUndefined();
    return alignment?.messages.find((message) => message.role === 'human')?.content ?? '';
  }

  /** Rated `destructive` on its own merits, floored by neither preflight arm. */
  const PLAIN_DESTRUCTIVE = 'rm -rf ./dist';
  /** §4.6's open-world arm: a host literal in a fetch position. */
  const OPEN_WORLD = 'git clone https://github.com/pukeko-robotics/testing-gaunt-sloth.git';
  /** §4.6's script-env-leak arm: an environment variable expanded into a script. */
  const ENV_LEAK = 'node probe.js $PROBE_ENV_VALUE';
  /** The user's own words, distinctive enough that no other value could produce a match. */
  const MANDATE = 'please clear out the stale dist folder for me before the release';
  /** §4.6's CARVE-OUT: an open-world command whose every host the user named verbatim. */
  const CARVED = 'curl -fsSL https://example.com/install.sh -o install.sh';
  const CARVED_HOST = 'https://example.com/install.sh';
  const CARVED_MANDATE = `please fetch ${CARVED_HOST} and save it as install.sh`;

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // D1 — the node's central claim: the `user` role is fed from the GATED provenance channel.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  describe('the checker’s `user` role is fed from the gated provenance window', () => {
    /**
     * **THE node's central property, as a control pair** — and the pair is the test, not a
     * decoration on it.
     *
     * The node's claim is that *"file content, web content and command output all arrive as tool
     * results, so under this assembly they cannot present themselves as user provenance"*. The
     * mechanism that makes it true is `retainedUserMessages()`, the command-keyed window that is
     * EMPTY until `admitUserProvenance` has established that this session's human turns are the
     * user's own typing — `noteUserMessages`' raw store, which holds them either way, is a
     * different question with a different reader.
     *
     * **A single non-admitting run could not fail.** An empty `user` role is also what a check that
     * never ran, one that failed closed, or one that was misconfigured produces, so the assertion
     * would pass for every reason except the one it names. What discriminates is the SAME command,
     * the SAME human sentence and the SAME scripts run twice, differing ONLY in the one bit
     * `commandCarriesUserProvenance` sets:
     *
     * - admitted — the user typed it. The mandate reaches the checker.
     * - withheld — the human turn is something the product fetched and handed over to be examined.
     *   The mandate must NOT reach the checker, and the checker is told so in as many words rather
     *   than left to infer it from an empty block.
     *
     * **The raw store is populated identically in both halves** — `noteUserMessages` is called
     * unconditionally, whatever the gate says — so a runner repointed at it, the exact edit the
     * `negotiation.ts` and `alignment.ts` docblocks warn about at length, makes the withheld half
     * carry the mandate and go red. That is the mutation this cell exists to catch, and before it
     * the whole suite stayed green under it.
     *
     * The command is floored by neither preflight arm on purpose: provenance also feeds §4.6's
     * carve-out, and a fixture the carve-out touches would differ between the halves for a second
     * reason and stop isolating this one.
     *
     * Asserted on `record.alignment.messages`, which `runAlignmentCheck` writes at the SEND site:
     * this is the context that reached the model, not what a builder would return if asked again.
     */
    it('carries the gated window into the `user` role, and an ungated session produces no mandate', async () => {
      const admitting = await drive({
        admitProvenance: true,
        calls: [{ command: PLAIN_DESTRUCTIVE }],
        ratings: ['destructive'],
        checks: [decides(ALIGNMENT_TOOL_ESCALATE, { reason: 'not sure' })],
        userMessages: [MANDATE],
        human: 'reject',
      });
      const notAdmitting = await drive({
        admitProvenance: false,
        calls: [{ command: PLAIN_DESTRUCTIVE }],
        ratings: ['destructive'],
        checks: [decides(ALIGNMENT_TOOL_ESCALATE, { reason: 'not sure' })],
        userMessages: [MANDATE],
        human: 'reject',
      });

      // Both runs actually made a check — without this the pair below is two silences.
      expect(admitting.checksStarted).toBe(1);
      expect(notAdmitting.checksStarted).toBe(1);

      expect(checkerUserMessage(admitting)).toContain(MANDATE);
      expect(checkerUserMessage(admitting)).toContain('<user_messages>');

      expect(checkerUserMessage(notAdmitting)).not.toContain(MANDATE);
      expect(checkerUserMessage(notAdmitting)).not.toContain('<user_messages>');
      // Not merely absent: the checker is TOLD the channel is empty, because "no mandate in view"
      // and "the user asked for nothing in particular" are different facts to a model.
      expect(checkerUserMessage(notAdmitting)).toContain('I HAVE SAID NOTHING THAT WAS ADMITTED');
    });

    /**
     * The same property one layer down: the mandate the checker is shown is what the PROVENANCE
     * WINDOW holds, not whatever the last human turn happened to say. A second turn's words join it
     * (the window is cumulative across a thread), and the classifier still sees neither.
     */
    it('the classifier sees none of it, on the very prompt the checker’s mandate came from', async () => {
      const result = await drive({
        verb: 'code',
        calls: [{ command: PLAIN_DESTRUCTIVE, justification: 'the build is stale' }],
        ratings: ['destructive'],
        checks: [decides(ALIGNMENT_TOOL_ESCALATE, { reason: 'not sure' })],
        userMessages: [MANDATE],
        human: 'reject',
      });
      expect(checkerUserMessage(result)).toContain(MANDATE);
      const ratingPrompt = result.records[0]?.rating?.prompt;
      expect(ratingPrompt?.user).toBeDefined();
      expect(ratingPrompt?.user).not.toContain(MANDATE);
      expect(ratingPrompt?.user).not.toContain('the build is stale');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // D2 — the reachability rule, one cell per conjunct, plus the arm that is excluded.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  describe('when the check is reached, clause by clause', () => {
    /**
     * The `reject` arm — a plain `destructive` at `auto`, which is the common case and the whole
     * reason the feature exists. The checker approves, and the classifier's rejection is REPLACED:
     * the command runs.
     *
     * Reds when `decision.action === 'reject'` is dropped from `alignmentReachable`.
     */
    it('a `destructive` rejection at `auto` reaches the check, and an approval replaces it', async () => {
      const result = await drive({
        calls: [{ command: PLAIN_DESTRUCTIVE }],
        ratings: ['destructive'],
        checks: [decides(ALIGNMENT_TOOL_APPROVE, { reason: 'the user asked for exactly this' })],
        userMessages: [MANDATE],
      });
      expect(result.checksStarted).toBe(1);
      expect(result.decisions.map((d) => d.type)).toEqual(['approve']);
      expect(result.records[0].alignment?.decision).toEqual({
        kind: 'approve',
        reason: 'the user asked for exactly this',
      });
    });

    /**
     * The floored arm — §4.6's open-world preflight, which an aligned approval MAY lift. It reaches
     * the gate as an `escalate` rather than a `reject`, so a rule keyed on `reject` alone would make
     * the single largest piece of authority this feature has unreachable.
     *
     * Rated `safe` deliberately: the FLOOR is what makes it `destructive`, which is what puts the
     * command on the arm this cell is named for.
     *
     * Reds when the `escalate`/`open-world` arm is dropped from `alignmentReachable`.
     */
    it('an open-world FLOORED escalation reaches the check, and an approval lifts the floor', async () => {
      const result = await drive({
        calls: [{ command: OPEN_WORLD }],
        ratings: ['safe'],
        checks: [decides(ALIGNMENT_TOOL_APPROVE, { reason: 'the user named this repository' })],
        userMessages: ['please clone the testing-gaunt-sloth repo'],
        human: 'reject',
      });
      expect(result.checksStarted).toBe(1);
      expect(result.decisions.map((d) => d.type)).toEqual(['approve']);
      expect(result.escalatedAt).toEqual([]);
    });

    /**
     * The rung clause. At `assisted` the same floored command escalates, and **no check is made** —
     * the node grants this authority at `auto` only, and `assisted` is the rung whose whole promise
     * is that a person sees anything the rater did not clear.
     *
     * The fixture is the FLOORED command on purpose. A plain `destructive` at `assisted` escalates
     * with no floor, so the last conjunct is false as well and the cell would stay green with the
     * rung test deleted — it would assert nothing. Reds when `isNegotiatingRung(approvals.rung)` is
     * replaced by `true`.
     */
    it('makes no check at `assisted`, even on a command whose floor an approval could lift', async () => {
      const result = await drive({
        mode: 'assisted',
        calls: [{ command: OPEN_WORLD }],
        ratings: ['safe'],
        checks: [decides(ALIGNMENT_TOOL_APPROVE, { reason: 'the user named this repository' })],
        userMessages: ['please clone the testing-gaunt-sloth repo'],
        human: 'reject',
      });
      expect(result.checksStarted).toBe(0);
      expect(result.records[0].alignment).toBeUndefined();
      expect(result.escalatedAt).toEqual([0]);
    });

    /**
     * The outcome clause. `catastrophic` is never offered to the checker — §4.2 gives it no rounds
     * and this node's own limits make it unliftable — and the tool contract refuses it a second
     * time, so this cell pins the CALL SITE half rather than re-testing the contract.
     *
     * The fixture names a host as well, so the command's floored `escalate` satisfies the last
     * conjunct: with the outcome test deleted the check would be made, which is what this cell
     * catches. A `catastrophic` command with no host would leave two conjuncts false and prove
     * nothing.
     *
     * Reds when `decision.verdict?.outcome === 'destructive'` is dropped.
     */
    it('makes no check for a `catastrophic` verdict, even on a floored open-world command', async () => {
      const result = await drive({
        calls: [{ command: OPEN_WORLD }],
        ratings: ['catastrophic'],
        checks: [decides(ALIGNMENT_TOOL_APPROVE, { reason: 'the user named this repository' })],
        userMessages: ['please clone the testing-gaunt-sloth repo'],
        human: 'reject',
      });
      expect(result.checksStarted).toBe(0);
      expect(result.records[0].alignment).toBeUndefined();
      expect(result.escalatedAt).toEqual([0]);
    });

    /**
     * **The script-env-leak arm is EXCLUDED, and that is a decision rather than an oversight.** It
     * is a fact about the command's own text — an interpreter expanding a secret into a script —
     * and nothing about who asked for the command speaks to it, so the node grants the checker no
     * authority over it. Including it would let a model's opinion about a request lift a floor that
     * was never about the request.
     *
     * Reds when `effectiveFloor?.kind === 'open-world'` is widened to `effectiveFloor !== null`.
     */
    it('makes no check for a script-env-leak floored command — that arm is not the checker’s', async () => {
      const result = await drive({
        calls: [{ command: ENV_LEAK }],
        ratings: ['safe'],
        checks: [decides(ALIGNMENT_TOOL_APPROVE, { reason: 'the user asked me to probe' })],
        userMessages: ['run the probe script for me'],
        human: 'reject',
      });
      expect(result.checksStarted).toBe(0);
      expect(result.records[0].alignment).toBeUndefined();
      expect(result.records[0].preflight?.kind).toBe('script-env-leak');
      expect(result.escalatedAt).toEqual([0]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // The three answers, as the runner acts on them.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  describe('what the runner does with each of the three answers', () => {
    /**
     * [[EXT-127]] R1 — **a command the check let through is announced.**
     *
     * Before this branch existed a `destructive` command at `auto` never ran without either the
     * agent narrowing it or a person answering; now a second model can let it through on round 1,
     * where `showNegotiatedApproval` draws nothing because §5.3's consecutive counter is still
     * zero. An event the user never sees reads as the agent quietly deciding things on their
     * behalf, which is the argument the floored arm's own notice already makes.
     */
    it('announces a checker-lifted approval, naming the command', async () => {
      const result = await drive({
        calls: [{ command: PLAIN_DESTRUCTIVE }],
        ratings: ['destructive'],
        checks: [decides(ALIGNMENT_TOOL_APPROVE, { reason: 'the user asked for exactly this' })],
        userMessages: [MANDATE],
      });
      const notice = result.warnings.find((line) => line.includes('the alignment check'));
      expect(
        notice,
        `expected an alignment notice among ${JSON.stringify(result.warnings)}`
      ).toBeDefined();
      expect(notice).toContain(PLAIN_DESTRUCTIVE);
      expect(notice).toContain('without asking you');
      expect(notice).toContain('approvals is set to Auto');
      // The network clause belongs to the floored arm alone: this command reaches no host, and a
      // notice saying it did would be a false statement in the one line the user is given.
      expect(notice).not.toContain('reaches the network');
    });

    /**
     * The same renderer on the floored arm, WITH the network clause — the fact that distinguishes
     * the two, and the reason the user is asked to look at the host.
     */
    it('adds the network clause when what the check lifted was the open-world floor', async () => {
      const result = await drive({
        calls: [{ command: OPEN_WORLD }],
        ratings: ['safe'],
        checks: [decides(ALIGNMENT_TOOL_APPROVE, { reason: 'the user named this repository' })],
        userMessages: ['please clone the testing-gaunt-sloth repo'],
      });
      const notice = result.warnings.find((line) => line.includes('the alignment check'));
      expect(notice).toBeDefined();
      expect(notice).toContain(OPEN_WORLD);
      expect(notice).toContain('It reaches the network');
    });

    /**
     * **[[EXT-106]] §4.6's own notice, on the path it was written for — unchanged.**
     *
     * The carve-out's sentence ends *"the auto-rater found nothing wrong with it"*, and here that is
     * simply true: the classifier rated the command `safe`, no check was ever made, and the residual
     * risk the warning covers is the one case the rater saw nothing in. This cell is the control for
     * the one below it — without it, a fix that made the merged sentence appear everywhere would go
     * green while having quietly deleted the true sentence along with the false one.
     */
    it('leaves §4.6’s carved-host notice as it was where the CLASSIFIER is what cleared the command', async () => {
      const result = await drive({
        calls: [{ command: CARVED }],
        ratings: ['safe'],
        userMessages: [CARVED_MANDATE],
      });
      expect(result.decisions.map((d) => d.type)).toEqual(['approve']);
      expect(result.checksStarted).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(CARVED_HOST);
      expect(result.warnings[0]).toContain('The auto-rater found nothing wrong with it.');
      expect(result.warnings[0]).toContain('Check the host is the one you meant.');
    });

    /**
     * **[[EXT-127]] — a carved command the CHECK lifted gets ONE notice, and it is true.**
     *
     * §4.6's notice assumed an invariant this node deleted: *"a carved command the rater
     * independently rated `destructive` does not run, so a notice saying it did would be false"*.
     * Carving sets the floor to `null`, a `destructive` rating then maps to `reject`, and `reject`
     * is exactly what makes the check reachable — so the check can approve, the command runs, and
     * the sentence claiming the auto-rater found nothing wrong is false in the direction that
     * reassures, on a security surface, at the moment a destructive command ran with nobody asked.
     *
     * **The host has to survive the fix, which is the trap.** `reachesNetwork` keys on which FLOOR
     * stood, and on a carved command none did — so suppressing §4.6's line without moving the host
     * into the replacement drops the ONLY sentence telling the user to look at the host, on the one
     * path where their own message is what authorised the fetch. Both halves are asserted here: the
     * host is present, and the false clause is absent.
     *
     * `toHaveLength(1)` is load-bearing rather than tidy — two warnings about one event is how a
     * user learns to skim them, and it is the state this cell exists to end.
     */
    it('merges the two notices into one that names the host and does NOT claim the rater cleared it', async () => {
      const result = await drive({
        calls: [{ command: CARVED }],
        ratings: ['destructive'],
        checks: [
          decides(ALIGNMENT_TOOL_APPROVE, { reason: 'the user named this host and this file' }),
        ],
        userMessages: [CARVED_MANDATE],
      });
      expect(result.decisions.map((d) => d.type)).toEqual(['approve']);
      expect(result.records[0].preflight?.carvedHosts).toEqual([CARVED_HOST]);
      expect(result.warnings).toHaveLength(1);
      const notice = result.warnings[0];
      // What protects the user: the host, and the instruction to look at it. Asserted IN ITS OWN
      // CLAUSE and not merely `toContain(CARVED_HOST)`, which the echoed command satisfies on its
      // own — a notice that names the host only inside the command it printed has told the user
      // nothing about why it was allowed to reach it, which is the whole of what §4.6's suppressed
      // line was saying.
      expect(notice).toContain(`your own message named ${CARVED_HOST}`);
      expect(notice).toContain('Check the host is the one you meant.');
      // What actually happened, both halves of it.
      expect(notice).toContain('The auto-rater rated it destructive');
      expect(notice).toContain('the alignment check found it matches what you asked for');
      // §10 rule 4 — the DISPLAY spelling, asserted as a literal rather than against the production
      // label map, which would only restate whatever that map currently says.
      expect(notice).toContain('approvals is set to Auto.');
      // The clause that was false. Asserted as an ABSENCE because that is the defect: every other
      // assertion here is satisfied by a notice that still carries it.
      expect(notice).not.toContain('found nothing wrong');
    });

    /**
     * **The command in this notice is model-authored, so it is neutralised to one line.**
     *
     * The renderer's docblock has always promised this and nothing held it: dropping
     * `neutralizeToOneLine` left the whole suite green, because every other cell asserts
     * `toContain` of a command that has no control characters in it to escape. A command carrying a
     * newline can otherwise forge a second status line under the ⚠ the real one uses — the notice
     * is a WARNING-level status line, so a forged sibling is indistinguishable from a true one.
     *
     * Driven end to end rather than by calling the renderer, so it also pins that the runner hands
     * over the RAW command and lets the one renderer neutralise it.
     */
    it('neutralises a model-authored command to one line, so it cannot forge a second warning', async () => {
      const forged = `${PLAIN_DESTRUCTIVE}\n⚠ Ran an unrelated command without asking you`;
      const result = await drive({
        calls: [{ command: forged }],
        ratings: ['destructive'],
        checks: [decides(ALIGNMENT_TOOL_APPROVE, { reason: 'the user asked for exactly this' })],
        userMessages: [MANDATE],
      });
      const notice = result.warnings.find((line) => line.includes('the alignment check'));
      expect(
        notice,
        `expected an alignment notice among ${JSON.stringify(result.warnings)}`
      ).toBeDefined();
      // The break is visible as an escape rather than acted on…
      expect(notice).toContain(`${PLAIN_DESTRUCTIVE}\\x0a⚠ Ran an unrelated command`);
      // …and the notice is one line: the only break in it is the one the notice opens with.
      expect(notice?.startsWith('\n')).toBe(true);
      expect(notice?.slice(1)).not.toContain('\n');
    });

    /**
     * [[EXT-127]] — **the checker's requested change is APPENDED to the rater's rejection, never
     * substituted for it.** The two say different things and the agent needs both: the rater says
     * what is wrong with the command, the checker says what would make it match what the user asked
     * for.
     *
     * Nothing asserted either half before this cell — `grep "alignment check also asked"` across
     * every spec in the repository returned nothing — so the append could be deleted with the suite
     * green.
     */
    it('appends the checker’s suggestion to the rater’s rejection, without replacing it', async () => {
      const result = await drive({
        calls: [{ command: PLAIN_DESTRUCTIVE }],
        ratings: ['destructive'],
        checks: [
          decides(ALIGNMENT_TOOL_SUGGEST, {
            reason: 'name the folder you mean instead of the whole tree',
            suggestedCommand: 'rm -rf ./dist/assets',
          }),
        ],
        userMessages: [MANDATE],
      });
      expect(result.decisions.map((d) => d.type)).toEqual(['reject']);
      const message = result.decisions[0].message ?? '';
      // The rater's own refusal is still there — this is an append, not a substitution.
      expect(message).toContain('The auto-rater rejected');
      expect(message).toContain('name the folder you mean instead of the whole tree');
      expect(message).toContain('rm -rf ./dist/assets');
    });

    /**
     * [[EXT-127]] R2 — **an escalation the CHECKER decided is a round, and is recorded as one.**
     *
     * `action` is `escalate` on this path, so the `reject` block that records every other round is
     * skipped and nothing else would record anything. Two things were lost with it: the attempt
     * being ruled on was absent from the transcript the human is shown (§5.6 — the reject path
     * records first for exactly this reason), and the checker's own decision, the thing that ended
     * the argument, was carried nowhere at all.
     *
     * Both halves are asserted here: the round reaches the human's prompt, and it carries the
     * checker's decision.
     */
    it('records the round when the CHECKER escalates, carrying its decision', async () => {
      const result = await drive({
        calls: [{ command: PLAIN_DESTRUCTIVE, justification: 'the build is stale' }],
        ratings: ['destructive'],
        checks: [
          decides(ALIGNMENT_TOOL_ESCALATE, {
            reason: 'nothing the user said names this folder',
          }),
        ],
        userMessages: [MANDATE],
        human: 'reject',
      });
      expect(result.checksStarted).toBe(1);
      expect(result.escalatedAt).toEqual([0]);
      // §5.6 — the attempt being ruled on is itself on the transcript the human is shown.
      const rounds = result.prompts[0]?.negotiationRounds ?? [];
      expect(rounds.map((round) => round.command)).toEqual([PLAIN_DESTRUCTIVE]);
      expect(rounds.map((round) => round.justification)).toEqual(['the build is stale']);
      // The checker's own decision rides on it, so what ended the argument is carried rather than
      // dropped — the escalation prompt's payload, the archive and the next round all read it here.
      expect(rounds[0]?.alignment).toEqual({
        kind: 'escalate',
        reason: 'nothing the user said names this folder',
      });
      // And it reached the live panel as it happened, numbered as the round it was.
      expect(result.liveRounds.map((event) => event.round.command)).toEqual([PLAIN_DESTRUCTIVE]);
      expect(result.liveRounds[0].position).toBe(0);
    });

    /**
     * The other side of R2: a floored `escalate` the checker never lifted is the CLASSIFIER's
     * decision, not the checker's, and it opens no round. Without this the fix above would be
     * satisfied by recording a round on every escalation, which would put a round on the human's
     * transcript for an argument that never happened.
     */
    it('opens no round when the classifier escalated and the check was never made', async () => {
      const result = await drive({
        mode: 'assisted',
        calls: [{ command: PLAIN_DESTRUCTIVE }],
        ratings: ['destructive'],
        userMessages: [MANDATE],
        human: 'reject',
      });
      expect(result.checksStarted).toBe(0);
      expect(result.escalatedAt).toEqual([0]);
      expect(result.prompts[0]?.negotiationRounds ?? []).toHaveLength(0);
      expect(result.liveRounds).toHaveLength(0);
    });

    /**
     * **A check that never happened changes nothing** — the contract every caller honours, and a
     * stronger claim than "it fails closed". The classifier's action stands, so a broken or missing
     * checker leaves `auto` behaving exactly as it did before this feature existed rather than
     * quietly turning every negotiation into an interruption.
     *
     * Driven with an empty script, so the checker spends its whole turn budget without deciding —
     * the shape a real model produces when it narrates instead of calling a tool.
     */
    it('leaves the classifier’s own rejection standing when the check fails closed', async () => {
      const result = await drive({
        calls: [{ command: PLAIN_DESTRUCTIVE }],
        ratings: ['destructive'],
        checks: [[]],
        userMessages: [MANDATE],
      });
      expect(result.checksStarted).toBe(1);
      expect(result.records[0].alignment?.failClosed).toBe('no-decision');
      expect(result.decisions.map((d) => d.type)).toEqual(['reject']);
      // Not recorded on the round either: a check that did not happen is not one the next round
      // should replay as its own earlier turn.
      expect(result.liveRounds).toHaveLength(1);
      expect(result.liveRounds[0].round.alignment).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // O6 — the diagnostic record of the check.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  describe('the alignment check reaches the approvals archive', () => {
    /**
     * `record.alignment` is what makes a gate decision auditable after the fact, and it survives
     * every exit including the fail-closed ones. Nothing referenced `.alignment` on a capture in
     * any spec before this one.
     *
     * **The tool calls are the load-bearing half of a REPLAYED round.** `replayRound` emits the
     * checker's own earlier turns as assistant messages whose `content` is the empty string and
     * whose decision is the tool it called with the arguments it called it with — so a record
     * holding role and content alone tells an auditor that a round happened and refuses to say what
     * it decided, which is the one question a dump of a safety gate is opened to answer.
     *
     * Two rounds are driven because round 1 replays nothing: the shape this cell exists for does
     * not exist until a second check assembles a first one into its context.
     */
    it('records what was sent, by role, INCLUDING the tool calls a replayed round carries', async () => {
      const result = await drive({
        calls: [
          { command: PLAIN_DESTRUCTIVE, justification: 'the build is stale' },
          { command: 'rm -rf ./dist/assets', justification: 'narrowed as asked' },
        ],
        ratings: ['destructive', 'destructive'],
        checks: [
          decides(ALIGNMENT_TOOL_SUGGEST, { reason: 'name the folder you mean' }),
          decides(ALIGNMENT_TOOL_ESCALATE, { reason: 'still cannot tell' }),
        ],
        userMessages: [MANDATE],
      });

      const first = result.records[0].alignment;
      expect(first?.messages.map((m) => m.role)).toEqual(['system', 'human']);
      expect(first?.decision).toEqual({ kind: 'suggest', reason: 'name the folder you mean' });
      expect(first?.timeoutMs).toBeGreaterThan(0);
      expect(first?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const second = result.records[1].alignment;
      expect(second?.messages.map((m) => m.role)).toEqual([
        'system',
        'human',
        'ai',
        'tool',
        'ai',
        'tool',
      ]);
      // The replayed round's decision, readable from the archive alone.
      const calls = (second?.messages ?? []).flatMap((message) => message.toolCalls ?? []);
      expect(calls.map((call) => call.name)).toEqual([ALIGNMENT_TOOL_VIEW, ALIGNMENT_TOOL_SUGGEST]);
      expect(calls[1].args).toEqual({ reason: 'name the folder you mean' });
      // And every tool result says which call it answered, so a duplicated or dangling id — a hard
      // provider failure — is visible in the dump rather than only in a 400.
      const answered = (second?.messages ?? [])
        .filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId);
      expect(answered).toEqual(['gth-alignment-view-0', 'gth-alignment-decide-0']);
    });
  });
});
