/**
 * EXT-65 — **the measurement: how often does the gate interrupt a human over ordinary work?**
 *
 * A rater suite grades one round and structurally cannot see a retry, so it cannot answer this
 * question. What can is a corpus of legitimate developer commands driven through the real
 * {@link GthAgentRunner} at `full-auto`, counting how many reach the human approval callback.
 *
 * **The corpus is below, in the file, on purpose.** A number without its method is not a
 * measurement, and a corpus that lives in a report cannot be re-run by the next person.
 *
 * ## What this measures, and what it cannot
 *
 * The BEFORE arm is not a second checkout: it is computed from
 * {@link import('#src/core/shell/rater.js').abstentionReason}, which is exactly the predicate the
 * pre-EXT-65 runner branched on to escalate. A command that abstains escalated; one that resolves
 * was rated. That equivalence is asserted here rather than assumed, so the arm cannot silently
 * become a tautology.
 *
 * The AFTER arm is measured for real, by running the corpus through the runner.
 *
 * **The boundary, stated rather than papered over:** this harness has no model, so it cannot
 * measure whether a rewrite SUCCEEDS. It measures the human-prompt rate on the first call — which
 * is the number this node moves — and the second-consecutive rule's behaviour on a fixed sequence.
 * Whether the human is ever reached in a real session additionally depends on the model producing a
 * resolvable rewrite, which only a live run can answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import { abstentionReason } from '#src/core/shell/rater.js';
import { classifyCommand } from '#src/core/shell/arity.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';

const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  cleanup: vi.fn(),
  getPendingToolInterrupts: vi.fn(),
  streamResume: vi.fn(),
  getRegisteredToolNames: vi.fn(),
};

vi.mock('#src/core/shell/raterModel.js', () => ({ resolveRaterModel: vi.fn() }));
vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class MockGthLangChainAgent {
    init = mockAgent.init;
    setVerbose = mockAgent.setVerbose;
    invoke = mockAgent.invoke;
    stream = mockAgent.stream;
    streamWithEvents = mockAgent.streamWithEvents;
    cleanup = mockAgent.cleanup;
    getPendingToolInterrupts = (...args: unknown[]) => mockAgent.getPendingToolInterrupts(...args);
    streamResume = (...args: unknown[]) => mockAgent.streamResume(...args);
    getRegisteredToolNames = () => mockAgent.getRegisteredToolNames();
  },
}));

/**
 * **The corpus: ordinary developer commands, all legitimate work.**
 *
 * Chosen to be the things a coding agent actually types in a session, including the composed ones
 * the field reports named (`pwd && ls` is gaunt-sloth issue #423, observed independently by Andrew
 * on a second frontier model two days later). Nothing here is an attack, and nothing here is a
 * command a reasonable human would refuse — every prompt this corpus produces is a prompt spent on
 * work that was going to be approved.
 */
const LEGITIMATE_WORK_CORPUS = [
  // — composed: the shapes the gate cannot resolve —
  'pwd && ls',
  'npm test && npm run lint',
  'git add -A && git status',
  'cd packages/core && pnpm run build',
  'git fetch origin && git rebase origin/main',
  'mkdir -p dist && cp README.md dist/',
  'npm run build; npm run test',
  'cat package.json | head -40',
  'git log --oneline | head -20',
  'echo $(git rev-parse --short HEAD)',
  'pnpm run lint > lint.log',
  // — single, resolvable: the control half —
  'ls -la',
  'git status',
  'npm test',
  'pnpm run build',
  'git diff --stat',
  'node --version',
  'tsc --noEmit',
  'git rev-parse --short HEAD',
] as const;

const SAFE_VERDICT = { outcome: 'safe', reason: 'read-only' };

function raterConfig(mode: string) {
  const invoke = vi.fn().mockResolvedValue(SAFE_VERDICT);
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  return {
    ...({
      llm: { withStructuredOutput },
      streamOutput: true,
      approvals: { mode },
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
    } as unknown as GthConfig),
  };
}

function streamOf(...chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** Drive `commands` through one runner session and report how many reached the human. */
async function humanPromptsFor(commands: readonly string[]): Promise<number> {
  const { GthAgentRunner } = await import('#src/core/GthAgentRunner.js');
  const runner = new GthAgentRunner(vi.fn());

  let pending = mockAgent.getPendingToolInterrupts.mockReset();
  for (const command of commands) {
    pending = pending.mockResolvedValueOnce([{ name: 'run_shell_command', args: { command } }]);
  }
  pending.mockResolvedValue([]);
  mockAgent.streamResume.mockReset().mockResolvedValue(streamOf(''));
  mockAgent.stream.mockReset().mockResolvedValue(streamOf('x'));
  mockAgent.getRegisteredToolNames.mockReturnValue([]);

  await runner.init('code', raterConfig('full-auto'));
  const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
  runner.setToolApprovalCallback(human);
  await runner.processMessages([new HumanMessage('go')]);
  return human.mock.calls.length;
}

describe('EXT-65 measurement — human-prompt rate over a legitimate-work corpus', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAgent.init.mockResolvedValue(undefined);
    mockAgent.cleanup.mockResolvedValue(undefined);
  });

  /**
   * The BEFORE arm's own validity check. `abstentionReason` is the predicate the pre-EXT-65 runner
   * branched on, and it is `classifyCommand` returning null — so a command abstains exactly when it
   * does not statically resolve. Asserting the equivalence keeps the before-count from drifting
   * into an arithmetic identity that would agree with itself no matter what the gate did.
   */
  it('the BEFORE arm is the same predicate the old runner escalated on', () => {
    for (const command of LEGITIMATE_WORK_CORPUS) {
      const abstains = abstentionReason(command) !== null;
      expect(classifyCommand(command, normalizeCommand) === null, command).toBe(abstains);
    }
  });

  /**
   * **The headline number.** Each command measured as a FIRST call — one session per command —
   * because that is the situation this node is about: a model emits an ordinary composed command
   * and the gate has to decide who hears about it.
   *
   * BEFORE: every abstaining command escalated, so the count is the number that abstain.
   * AFTER: measured by running each one through the real runner.
   */
  it('measures the first-call human-prompt rate, before vs after', async () => {
    const before = LEGITIMATE_WORK_CORPUS.filter((c) => abstentionReason(c) !== null).length;

    let after = 0;
    for (const command of LEGITIMATE_WORK_CORPUS) {
      after += await humanPromptsFor([command]);
    }

    // The corpus is worth measuring only if it actually contains the shape under test: a corpus of
    // entirely resolvable commands would report a flattering 0 → 0 and mean nothing.
    expect(before).toBeGreaterThan(0);
    expect(before).toBe(11);
    expect(LEGITIMATE_WORK_CORPUS).toHaveLength(19);

    // 11 of 19 legitimate commands interrupted a human before this node; none does on a first call.
    expect(after).toBe(0);
  });

  /**
   * **The sequence arm**, which the per-command arm cannot see: the consecutive rule means the
   * answer depends on ORDER. Run as one session in corpus order, the leading run of composed
   * commands spends its one retry and then escalates on every subsequent consecutive abstention
   * until a resolvable command resets the run.
   *
   * This is the honest counterweight to the headline: the retry does not make the human-prompt rate
   * zero in a session that abstains repeatedly with nothing in between. Whether a real session looks
   * like that depends on the model producing a resolvable rewrite after the first report — which
   * this harness, having no model, cannot measure.
   */
  it('measures the whole corpus as one ordered session', async () => {
    const prompts = await humanPromptsFor(LEGITIMATE_WORK_CORPUS);
    // 11 consecutive abstentions at the head of the corpus: the first is refused to the model, the
    // other 10 escalate. The 8 resolvable commands that follow are rated and approved.
    expect(prompts).toBe(10);
  });

  /**
   * ...and the same corpus interleaved — one composed command, one resolvable — which is what a
   * session looks like when the model responds to a defect report at all. Every abstention is then
   * a FIRST abstention, and nobody is interrupted.
   */
  it('measures an interleaved session, where every abstention is a first one', async () => {
    const composed = LEGITIMATE_WORK_CORPUS.filter((c) => abstentionReason(c) !== null);
    const resolvable = LEGITIMATE_WORK_CORPUS.filter((c) => abstentionReason(c) === null);
    const interleaved: string[] = [];
    for (let i = 0; i < composed.length; i++) {
      interleaved.push(composed[i], resolvable[i % resolvable.length]);
    }

    expect(await humanPromptsFor(interleaved)).toBe(0);
  });
});
