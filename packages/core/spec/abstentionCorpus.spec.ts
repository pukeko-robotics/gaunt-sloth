/**
 * EXT-81 — **the measurement: what does the gate now do with ordinary work it cannot parse?**
 *
 * A rater suite grades one command in isolation and structurally cannot see a session, so it cannot
 * answer this. What can is a corpus of legitimate developer commands driven through the real
 * {@link GthAgentRunner} at `auto`, counting what reaches the human and what reaches the model.
 *
 * **The corpus is below, in the file, on purpose.** A number without its method is not a
 * measurement, and a corpus that lives in a report cannot be re-run by the next person.
 *
 * ## What this measures, and what it cannot
 *
 * Every arm is measured for real, by running the corpus through the runner. There is no computed
 * "before" arm: the behaviour this node replaced is gone from the tree, and a before-number derived
 * by re-implementing the retired rule here would be an arithmetic identity that agreed with itself
 * whatever the gate did.
 *
 * **The boundary, stated rather than papered over:** the rater is a stub, so this says nothing
 * about whether a real model rates these commands correctly. That is [[QA-17]]'s question and
 * [[BATCH-25]]'s sweep. What is measured here is the SHAPE of the gate around whatever the rater
 * says — who is asked, who is told, and how many model calls it costs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import { describeAbstention } from '#src/core/shell/abstention.js';
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
const DESTRUCTIVE_VERDICT = { outcome: 'destructive', reason: 'writes to the working tree' };

function raterConfig(mode: string, verdict: unknown) {
  const invoke = vi.fn().mockResolvedValue(verdict);
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  return {
    config: {
      llm: { withStructuredOutput },
      streamOutput: true,
      approvals: { mode },
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
    } as unknown as GthConfig,
    invoke,
  };
}

function streamOf(...chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** What one runner session did with `commands`: who was asked, who was told, what it cost. */
async function measure(
  commands: readonly string[],
  verdict: unknown = SAFE_VERDICT,
  mode: 'assisted' | 'auto' = 'auto'
): Promise<{ humanPrompts: number; rejections: number; ratingCalls: number }> {
  const { GthAgentRunner } = await import('#src/core/GthAgentRunner.js');
  const runner = new GthAgentRunner(vi.fn());

  let pending = mockAgent.getPendingToolInterrupts.mockReset();
  for (const command of commands) {
    pending = pending.mockResolvedValueOnce([{ name: 'run_shell_command', args: { command } }]);
  }
  pending.mockResolvedValue([]);
  const streamResume = vi.fn().mockResolvedValue(streamOf(''));
  mockAgent.streamResume.mockReset().mockImplementation(streamResume);
  mockAgent.stream.mockReset().mockResolvedValue(streamOf('x'));
  mockAgent.getRegisteredToolNames.mockReturnValue([]);

  const { config, invoke } = raterConfig(mode, verdict);
  await runner.init('code', config);
  const human = vi.fn().mockResolvedValue({ type: 'approve', scope: 'once' });
  runner.setToolApprovalCallback(human);
  await runner.processMessages([new HumanMessage('go')]);

  const rejections = streamResume.mock.calls.filter(
    (call) => call[0].decisions[0].type === 'reject'
  ).length;
  return {
    humanPrompts: human.mock.calls.length,
    rejections,
    ratingCalls: invoke.mock.calls.length,
  };
}

/** The corpus's own split, so every number below is read against a corpus that has both shapes. */
const unresolvable = LEGITIMATE_WORK_CORPUS.filter(
  (command) => classifyCommand(command, normalizeCommand) === null
);
const resolvable = LEGITIMATE_WORK_CORPUS.filter(
  (command) => classifyCommand(command, normalizeCommand) !== null
);

describe('EXT-81 measurement — what the gate does with legitimate work it cannot parse', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAgent.init.mockResolvedValue(undefined);
    mockAgent.cleanup.mockResolvedValue(undefined);
  });

  /**
   * The corpus is worth measuring only if it contains the shape under test: one made entirely of
   * resolvable commands would report flattering zeroes and mean nothing. Pinned as counts so
   * shrinking the composed half is a red test rather than a quietly better number.
   */
  it('contains both shapes, and the note is attached to exactly the unresolvable half', () => {
    expect(LEGITIMATE_WORK_CORPUS).toHaveLength(19);
    expect(unresolvable).toHaveLength(11);
    expect(resolvable).toHaveLength(8);
    for (const command of unresolvable) {
      expect(describeAbstention(command), command).not.toBeNull();
    }
    for (const command of resolvable) {
      expect(describeAbstention(command), command).toBeNull();
    }
  });

  /**
   * **THE HEADLINE.** Every command in the corpus is rated and approved: nobody is interrupted, and
   * nothing is handed back to the model to rewrite. Before this node the 11 composed commands could
   * not reach a rater at all — the first was refused to the agent and the rest escalated.
   */
  it('interrupts nobody and rejects nothing, on a rater that finds the work safe', async () => {
    const { humanPrompts, rejections } = await measure(LEGITIMATE_WORK_CORPUS);
    expect(humanPrompts).toBe(0);
    expect(rejections).toBe(0);
  });

  /**
   * **The COST REVERSAL, as a number.** The rating that was skipped for an unresolvable command is
   * now bought for every one of them: 19 commands, 19 calls. That is the price of the line above
   * and it is stated rather than left to be discovered on a bill.
   */
  it('costs one rating call per command, including the ones the parser could not read', async () => {
    const { ratingCalls } = await measure(LEGITIMATE_WORK_CORPUS);
    expect(ratingCalls).toBe(LEGITIMATE_WORK_CORPUS.length);
  });

  /**
   * **THE CONTROL, and without it the zero above means nothing.** A gate that had simply stopped
   * asking would also report zero prompts. Rate the identical corpus `destructive` and every
   * command reaches the human — so the zero is the rater's verdict, not the gate's silence.
   */
  it('CONTROL: the same corpus on a `destructive` rater interrupts on every command', async () => {
    // At `assisted`, where a `destructive` outcome goes straight to the human. This is the control
    // in its original form and it is asserted at the rung whose mapping [[EXT-29]] did not touch.
    const { humanPrompts, rejections } = await measure(
      LEGITIMATE_WORK_CORPUS,
      DESTRUCTIVE_VERDICT,
      'assisted'
    );
    expect(humanPrompts).toBe(LEGITIMATE_WORK_CORPUS.length);
    expect(rejections).toBe(0);
  });

  /**
   * **The same control at `auto`, where [[EXT-29]] §5 changed the shape of the answer but not its
   * substance.** A `destructive` verdict now opens a negotiation instead of interrupting, so the 19
   * stops are split between rejections handed back to the agent and escalations that reached a
   * person — but not one of the 19 ran, which is the property the control exists to establish.
   *
   * Both halves are asserted non-zero on purpose: "they add up to 19" would also hold if the
   * negotiation had swallowed every one of them and never reached a human, which is precisely the
   * reachability failure the second bound exists to prevent.
   */
  it('CONTROL at `auto`: all 19 are stopped, split between the agent and the human', async () => {
    const { humanPrompts, rejections } = await measure(LEGITIMATE_WORK_CORPUS, DESTRUCTIVE_VERDICT);
    expect(humanPrompts + rejections).toBe(LEGITIMATE_WORK_CORPUS.length);
    expect(rejections).toBeGreaterThan(0);
    expect(humanPrompts).toBeGreaterThan(0);
  });

  /**
   * **ORDER NO LONGER MATTERS, and that is a result rather than a tidying.** The retired design
   * spent a one-shot retry budget per consecutive run, so the same 19 commands produced a different
   * number of interruptions depending on the order they arrived in — 0 interleaved, 10 in corpus
   * order. A user cannot control that ordering and could not predict the difference. Three
   * orderings, one number.
   */
  it('reports the same number whatever order the session runs in', async () => {
    const interleaved: string[] = [];
    for (let i = 0; i < unresolvable.length; i++) {
      interleaved.push(unresolvable[i], resolvable[i % resolvable.length]);
    }

    for (const ordering of [
      LEGITIMATE_WORK_CORPUS,
      [...unresolvable, ...resolvable],
      interleaved,
    ]) {
      const { humanPrompts, rejections } = await measure(ordering);
      expect(humanPrompts, ordering.join(' | ')).toBe(0);
      expect(rejections, ordering.join(' | ')).toBe(0);
    }
  });

  /**
   * The composed half on its own, which is where the retired design was at its worst: an unbroken
   * run of composed commands spent its retry on the first and interrupted a human on every one
   * after it. It now interrupts nobody, and that is measured on the run rather than inferred from
   * the whole-corpus number, where the resolvable commands would have masked it.
   */
  it('runs an unbroken sequence of composed commands with no interruption at all', async () => {
    const { humanPrompts, rejections, ratingCalls } = await measure(unresolvable);
    expect(humanPrompts).toBe(0);
    expect(rejections).toBe(0);
    expect(ratingCalls).toBe(unresolvable.length);
  });
});
