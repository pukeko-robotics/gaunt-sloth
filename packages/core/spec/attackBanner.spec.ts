import { afterAll, afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { AttackHaltAnswer, StatusUpdateCallback } from '#src/core/types.js';
import { AttackHaltError } from '#src/core/shell/approvalStop.js';
import {
  attackBannerCopy,
  describeRaterOutcome,
  grantsRunAnyway,
  RUN_ANYWAY_PHRASE,
} from '#src/core/shell/escalationSeverity.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';

/**
 * [[TUI-C68]] §6.1 — **the attack banner's seam and its matcher.**
 *
 * An `attack` verdict ends the run, so before this node the only recovery was a restart. What is
 * asserted here is the runner half: that a wired surface is asked on BOTH rating paths, that an
 * unwired one is not asked at all, and — the part §3 warns is the likely defect — that a grant runs
 * exactly one command and leaves the rung, the allow-list and the halt itself untouched.
 *
 * The surfaces' own halves live where the keystrokes are: `packages/app/spec/tui/AttackBanner*`
 * (and the PTY suite, which is the only harness that can show what a key actually does) and
 * `packages/agent/spec/interactiveSessionAttackBanner.spec.ts`.
 */

const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  cleanup: vi.fn(),
};

const resolveRaterModelMock = vi.fn();
vi.mock('#src/core/shell/raterModel.js', () => ({
  resolveRaterModel: resolveRaterModelMock,
}));

vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class MockGthLangChainAgent {
    constructor() {
      return mockAgent;
    }
  },
  StatusUpdateCallback: vi.fn(),
}));

/**
 * The persisted grant store is anchored at the PROJECT DIR, so a spec driving a gated call must
 * clamp that anchor or it reads — and can rewrite — the allow-list of whoever runs the suite. It is
 * also the observable one of the assertions below rests on: "no allow-list write" is a claim about
 * this directory, so it has to be a directory the spec owns.
 */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-attack-banner-spec-'));

describe('the §6.1 attack banner', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdateCallback: Mock<StatusUpdateCallback>;
  let mockConfig: GthConfig;
  let priorProjectDir: string | undefined;

  const ATTACK = { outcome: 'attack', reason: 'reads a private key as the operation itself' };
  const SAFE = { outcome: 'safe', reason: 'manual' };
  const COMMAND = 'terraform destroy';

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    rmSync(join(projectDir, SHELL_ALLOWLIST_FILE), { force: true });
    delete (mockAgent as any).getPendingToolInterrupts;
    delete (mockAgent as any).streamResume;
    statusUpdateCallback = vi.fn();
    mockConfig = {
      streamOutput: true,
      contentSource: 'file',
      requirementSource: 'file',
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: false,
      canInterruptInferenceWithEsc: true,
      includeCurrentDateAfterGuidelines: true,
      llm: { _llmType: vi.fn().mockReturnValue('test'), verbose: false } as any,
    } as unknown as GthConfig;
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    setProjectDir(priorProjectDir);
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function streamOf(...chunks: string[]) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };
  }

  /** Suspend on the same gated command `times` times over one run, then finish. */
  function pending(command: string, times = 1) {
    const getPending = vi.fn();
    for (let i = 0; i < times; i++) {
      getPending.mockResolvedValueOnce([{ name: 'run_shell_command', args: { command } }]);
    }
    getPending.mockResolvedValue([]);
    (mockAgent as any).getPendingToolInterrupts = getPending;
    const streamResume = vi.fn().mockResolvedValue(streamOf(''));
    (mockAgent as any).streamResume = streamResume;
    mockAgent.stream.mockResolvedValue(streamOf('x'));
    return streamResume;
  }

  /**
   * A rater stub that really answers, so "the rater was consulted again" is an assertion about the
   * gate rather than about a stub that could not have replied.
   */
  function gateConfig(approvals: Record<string, unknown>, verdict: unknown = ATTACK) {
    const invoke = vi.fn().mockResolvedValue(verdict);
    const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
    return {
      withStructuredOutput,
      invoke,
      config: {
        ...mockConfig,
        llm: { withStructuredOutput } as any,
        approvals,
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as unknown as GthConfig,
    };
  }

  const RATED_GLOB = [
    { type: 'shell', matcher: 'glob', pattern: 'terraform *', rate: true },
  ] as unknown[];

  /**
   * The two paths an `attack` verdict reaches the end of the run by: the ordinary rater decision at
   * a rated rung, and the §3.2 tripwire on a rated allow match. They are separately reachable, so a
   * seam wired at one and not the other is a banner that appears in some sessions and not others —
   * which is why each is driven on its own rather than one standing in for both.
   */
  const PATHS = [
    ['the rater decision', { mode: 'auto' } as Record<string, unknown>],
    ['the allow-match tripwire', { mode: 'auto', allow: RATED_GLOB }],
  ] as const;

  describe.each(PATHS)('on %s', (_name, approvals) => {
    it('asks the wired surface, carrying the command and the rater reason', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      pending(COMMAND);
      const { config } = gateConfig(approvals);
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn());
      const banner = vi.fn<(h: unknown) => AttackHaltAnswer>().mockReturnValue('stop');
      runner.setAttackHaltCallback(banner);

      await runner
        .processMessages([new HumanMessage('go')])
        .then(() => null)
        .catch(() => null);

      expect(banner).toHaveBeenCalledTimes(1);
      expect(banner.mock.calls[0][0]).toEqual({ command: COMMAND, reason: ATTACK.reason });
    });

    it('runs exactly one command on the phrase, and nothing else runs on `stop`', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const resume = pending(COMMAND);
      const { config } = gateConfig(approvals);
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn());
      runner.setAttackHaltCallback(() => 'run-anyway');

      await runner.processMessages([new HumanMessage('go')]);

      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume.mock.calls[0][0].decisions[0]).toEqual({ type: 'approve', scope: 'once' });
    });

    it('HALTS when the banner answers `stop`', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const resume = pending(COMMAND);
      const { config } = gateConfig(approvals);
      await runner.init('code', config);
      runner.setToolApprovalCallback(vi.fn());
      runner.setAttackHaltCallback(() => 'stop');

      const error = await runner
        .processMessages([new HumanMessage('go')])
        .then(() => null)
        .catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(AttackHaltError);
      expect((error as AttackHaltError).command).toBe(COMMAND);
      expect(resume).not.toHaveBeenCalled();
    });

    /**
     * §4/§6.2 — the default, and the reason the seam is opt-in. A surface that never wires a banner
     * — CI, a server, one nobody has written yet — must halt without waiting on anything, so the
     * failure mode of forgetting is the safe one.
     */
    it('with NO banner wired, halts immediately and asks nothing', async () => {
      const runner = new GthAgentRunner(statusUpdateCallback);
      const resume = pending(COMMAND);
      const { config } = gateConfig(approvals);
      await runner.init('code', config);
      const human = vi.fn();
      runner.setToolApprovalCallback(human);

      const error = await runner
        .processMessages([new HumanMessage('go')])
        .then(() => null)
        .catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(AttackHaltError);
      // Neither the approval prompt nor anything else was consulted, and nothing resumed: there is
      // no path here that waits on input, which is what "may never block a non-interactive run"
      // means in the only terms a test can see.
      expect(human).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    });

    /**
     * §3 — **the three "never"s.** The likely defect is a well-meaning sticky grant, and a test that
     * only checked "the command ran" would miss every one of these.
     */
    describe('a grant remembers nothing', () => {
      it('leaves the session rung exactly where it was', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pending(COMMAND);
        const { config } = gateConfig(approvals);
        await runner.init('code', config);
        const before = runner.getSessionApprovals().rung;
        runner.setToolApprovalCallback(vi.fn());
        runner.setAttackHaltCallback(() => 'run-anyway');

        await runner.processMessages([new HumanMessage('go')]);

        expect(runner.getSessionApprovals().rung).toBe(before);
        expect(before).toBe('auto');
      });

      it('writes no grant — not to the session store, not to the project allow-list', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        pending(COMMAND);
        const { config } = gateConfig(approvals);
        await runner.init('code', config);
        // Read through a normaliser: the persisted half of the count is `undefined` until the
        // store is first loaded and `0` afterwards, and a grant is what this is watching for, not
        // the store waking up.
        const counts = () => {
          const c = runner.getAllowlistCounts() as { session?: number; always?: number };
          return { session: c.session ?? 0, always: c.always ?? 0 };
        };
        const before = counts();
        runner.setToolApprovalCallback(vi.fn());
        runner.setAttackHaltCallback(() => 'run-anyway');

        await runner.processMessages([new HumanMessage('go')]);

        expect(runner.getGrants()).toEqual([]);
        expect(counts()).toEqual(before);
        expect(existsSync(join(projectDir, SHELL_ALLOWLIST_FILE))).toBe(false);
      });

      /**
       * The one that a store assertion cannot make on its own: the *next* identical command is
       * rated again and halts again. A session-scoped grant would be consulted before the rater, so
       * the second call would neither be rated nor reach the banner — and it would run silently.
       */
      it('rates the SAME command again next time, and halts it again', async () => {
        const runner = new GthAgentRunner(statusUpdateCallback);
        const resume = pending(COMMAND, 2);
        const { config, invoke } = gateConfig(approvals);
        await runner.init('code', config);
        runner.setToolApprovalCallback(vi.fn());
        const banner = vi
          .fn<(h: unknown) => AttackHaltAnswer>()
          .mockReturnValueOnce('run-anyway')
          .mockReturnValue('stop');
        runner.setAttackHaltCallback(banner);

        const error = await runner
          .processMessages([new HumanMessage('go')])
          .then(() => null)
          .catch((e: unknown) => e as Error);

        expect(invoke).toHaveBeenCalledTimes(2); // rated BOTH times
        expect(banner).toHaveBeenCalledTimes(2); // and halted at the banner both times
        expect(resume).toHaveBeenCalledTimes(1); // only the granted one ran
        expect(error).toBeInstanceOf(AttackHaltError);
      });
    });
  });

  /**
   * A control for the whole seam: with no `attack` verdict there is no banner at all. Without it,
   * every assertion above would also pass on a runner that showed the banner for everything.
   */
  it('CONTROL: a `safe` verdict never reaches the banner', async () => {
    const runner = new GthAgentRunner(statusUpdateCallback);
    const resume = pending(COMMAND);
    const { config } = gateConfig({ mode: 'auto' }, SAFE);
    await runner.init('code', config);
    runner.setToolApprovalCallback(vi.fn());
    const banner = vi.fn<(h: unknown) => AttackHaltAnswer>().mockReturnValue('run-anyway');
    runner.setAttackHaltCallback(banner);

    await runner.processMessages([new HumanMessage('go')]);

    expect(banner).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  /**
   * §6.1 — the matcher. The grant is ONE exact answer and everything else is a refusal, which is
   * what puts back the property a text buffer inverts: the buffer may hold anything at all, and
   * only one value of it runs the command.
   */
  describe('grantsRunAnyway', () => {
    it.each([
      ['the phrase', 'run anyway'],
      ['upper case', 'RUN ANYWAY'],
      ['mixed case', 'Run Anyway'],
      ['surrounded by spaces', '   run anyway  '],
      ['with a trailing newline', 'run anyway\n'],
    ])('grants on %s', (_name, typed) => {
      expect(grantsRunAnyway(typed)).toBe(true);
    });

    it.each([
      ['the empty buffer (a bare Enter)', ''],
      ['whitespace alone', '   '],
      ['the leading token alone', 'run'],
      ['a PREFIX of the phrase', 'run anyw'],
      ['the phrase run together', 'runanyway'],
      ['a doubled inner space', 'run  anyway'],
      ['the phrase with more after it', 'run anyway please'],
      ['the phrase with more before it', 'please run anyway'],
      ['an initial', 'y'],
      ['an approval-menu key', 'a'],
      ['a stray letter', 'b'],
      ['the word the label is NOT', 'bypass'],
    ])('stops on %s', (_name, typed) => {
      expect(grantsRunAnyway(typed)).toBe(false);
    });
  });

  /**
   * §2 — the copy. Asserted against what it must SAY rather than against a duplicate of the
   * strings: a change that dropped the irreversibility line, or that started calling this `bypass`,
   * is the change these exist to catch.
   */
  describe('attackBannerCopy', () => {
    it('carries the unconditional irreversibility line', () => {
      expect(attackBannerCopy().irreversible.toUpperCase()).toContain('IRREVERSIBLE');
    });

    it('reuses the rater outcome heading, so one verdict is never described two ways', () => {
      expect(attackBannerCopy().heading).toBe(describeRaterOutcome('attack').heading);
    });

    it('names the phrase in the controls, and never the rung called bypass', () => {
      const copy = attackBannerCopy();
      const everything = [copy.title, copy.irreversible, ...copy.controls, copy.granted]
        .join('\n')
        .toLowerCase();
      expect(copy.controls.join('\n')).toContain(RUN_ANYWAY_PHRASE);
      expect(everything).not.toContain('bypass');
    });

    it('says the grant is one command and remembers nothing', () => {
      const granted = attackBannerCopy().granted.toLowerCase();
      expect(granted).toContain('one command');
      expect(granted).toContain('allow-list');
    });
  });
});
