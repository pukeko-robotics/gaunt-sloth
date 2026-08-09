import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

/**
 * [[TUI-C26]] task 2 (spec §6) — **the escalation menu and its severity, on the readline
 * (`--no-tui`) surface.**
 *
 * `--no-tui` is a real, supported way to run a session, and the whole of §6 arrives there over the
 * same seam. The half the Ink suite cannot see is the one that matters most here: this surface has
 * no colour of its own, so the CHANNEL a line is written on *is* its colour — `displayError` is
 * red, `displayWarning` is yellow — which makes "catastrophic must not be able to look like
 * destructive" an assertion about which function was called.
 */
const cp = (codePoint: number): string => String.fromCodePoint(codePoint);
const LF = cp(0x0a);

// ── @gaunt-sloth/core/utils/systemUtils.js ────────────────────────────────────
const rlQuestionMock = vi.fn(async (prompt: string) => {
  if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
  return '';
});
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  error: vi.fn(),
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  getUseColour: vi.fn(() => false),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true, columns: 100 },
}));

// ── @gaunt-sloth/core/utils/consoleUtils.js ───────────────────────────────────
const displayMock = vi.fn();
const displayInfoMock = vi.fn();
const displayWarningMock = vi.fn();
const displayErrorMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: displayMock,
  displayError: displayErrorMock,
  displayInfo: displayInfoMock,
  displayLaunchBanner: vi.fn(),
  displayWarning: displayWarningMock,
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: vi.fn().mockResolvedValue({ streamSessionInferenceLog: false }),
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

type PendingLike = {
  name: string;
  args: Record<string, unknown>;
  safetyVerdict?: { outcome: string; reason: string };
  grantPreview?: string;
  grantSummary?: string;
  denyPreview?: string;
  denySummary?: string;
  negotiationRounds?: Array<{
    command: string;
    justification?: string;
    outcome: string;
    reason: string;
  }>;
};
let capturedApprovalCallback:
  | ((_pending: PendingLike) => Promise<{ type: string; scope?: string; message?: string }>)
  | undefined;
const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: vi.fn().mockResolvedValue(undefined),
  setToolApprovalCallback: vi.fn((cb) => {
    capturedApprovalCallback = cb;
  }),
  cleanup: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn() }));
vi.mock('#src/core/gthDeepAgentFactory.js', () => ({ gthDeepAgentFactory: vi.fn() }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

/** Lines written to one channel, in order. */
const linesOf = (mock: { mock: { calls: unknown[][] } }): string[] =>
  mock.mock.calls.flatMap((call: unknown[]) => String(call[0]).split(LF));

/** Every line this surface put on the terminal, whichever channel it went to. */
const allLines = (): string[] =>
  [displayMock, displayWarningMock, displayInfoMock, displayErrorMock].flatMap((mock) =>
    linesOf(mock)
  );

/** The prompt string the human was actually asked with — the menu, as they read it. */
const asked = (): string =>
  rlQuestionMock.mock.calls.map((call: unknown[]) => String(call[0])).join(LF);

describe('interactiveSessionModule — [[TUI-C26]] §6 the menu and the severity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    capturedApprovalCallback = undefined;
    rlQuestionMock.mockImplementation(async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
      return '';
    });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue(undefined);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    runnerInstanceMock.setToolApprovalCallback.mockImplementation((cb) => {
      capturedApprovalCallback = cb;
    });
  });

  const startSession = async () => {
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});
    expect(capturedApprovalCallback).toBeTypeOf('function');
    displayMock.mockClear();
    displayInfoMock.mockClear();
    displayWarningMock.mockClear();
    displayErrorMock.mockClear();
    rlQuestionMock.mockClear();
  };

  /** Answer the prompt with `key` and hand back the decision the surface returned. */
  const ask = async (key: string, pending: PendingLike) => {
    rlQuestionMock.mockResolvedValueOnce(key);
    return capturedApprovalCallback!(pending);
  };

  const DENYABLE: PendingLike = {
    name: 'run_shell_command',
    args: { command: 'ls && rm -rf build' },
    // The runner's asymmetry as a fixture: no grant on offer (the command does not statically
    // resolve), and a deny entry that is perfectly formable.
    denyPreview: '{ "type": "shell", "matcher": "exact", "pattern": "ls && rm -rf build" }',
    denySummary: 'ls && rm -rf build',
  };

  /**
   * §1.2 — the deny control is shown where the RUNNER offered it, which is not where the grant is.
   * Both halves in one test, so an implementation that never rendered the key would fail rather
   * than satisfy the absence.
   */
  it('offers [d]eny always where no grant exists, and not where no entry can be formed', async () => {
    await startSession();
    await ask('n', DENYABLE);
    expect(asked()).toContain('[d]eny always');
    expect(asked()).toContain('[o]nce');
    expect(asked()).toContain('[N]o');
    expect(asked()).not.toContain('[s]ession');

    rlQuestionMock.mockClear();
    await ask('n', { name: 'gth_web_fetch', args: { input: 'https://x/y' } });
    expect(asked()).not.toContain('[d]eny always');
    // Still a menu: the absence above is about the control, not a prompt that collapsed.
    expect(asked()).toContain('[o]nce');
  });

  /** §6 — the menu displays what the deny choice will record, framed, and says its lifetime. */
  it('names what the deny choice records, on the row below its own label', async () => {
    await startSession();
    await ask('n', DENYABLE);
    const info = linesOf(displayInfoMock);
    const label = info.indexOf('[d] will refuse, for the rest of this session:');
    expect(label).toBeGreaterThanOrEqual(0);
    // Anchored positionally: a shell deny summary is the command byte for byte, so a bare
    // `toContain` is satisfied by the command's own frame further up and would pass with this value
    // painted raw.
    expect(info[label + 1]).toBe('  1 │ ls && rm -rf build');
    const recordedAs = info.indexOf('    recorded as:');
    expect(recordedAs).toBeGreaterThanOrEqual(0);
    expect(info[recordedAs + 1]).toBe(
      '  1 │ { "type": "shell", "matcher": "exact", "pattern": "ls && rm -rf build" }'
    );
  });

  it('answering d returns a session-scoped rejection and confirms only what happened', async () => {
    await startSession();
    expect(await ask('d', DENYABLE)).toMatchObject({ type: 'reject', scope: 'session' });
    const out = allLines().join(LF);
    expect(out).toContain('will not run for the rest of this session');
    expect(out).toContain('a new session will ask about it again');
    // No promise of a persistence there is no store for.
    expect(out).not.toContain('saved to the project allow-list');
  });

  /**
   * §1.1 — the safe action stays the FALLTHROUGH. Every unbound answer refuses ONCE, asserted on
   * the absent scope rather than on the type, which cannot tell a one-shot refusal from a standing
   * one. The empty answer is the one a human produces by pressing Enter.
   */
  it.each([['n'], ['x'], ['']])(
    'an unbound answer (%j) refuses once, with no scope',
    async (key) => {
      await startSession();
      const decision = await ask(key, DENYABLE);
      expect(decision.type).toBe('reject');
      expect(decision.scope).toBeUndefined();
      expect(allLines().join(LF)).toContain('Command rejected.');
    }
  );

  /** And `d` is unbound like any other answer where the control was never offered. */
  it('d is an ordinary unbound answer when the control was not shown', async () => {
    await startSession();
    const decision = await ask('d', { name: 'gth_web_fetch', args: { input: 'https://x/y' } });
    expect(decision.type).toBe('reject');
    expect(decision.scope).toBeUndefined();
  });

  /**
   * §2.1 — **`catastrophic` must not be able to look like `destructive`**, asserted as a difference
   * between two renders of the same command rather than as "the catastrophic one is red". On this
   * surface the channel is the colour, so the difference is which function was called — and the
   * words differ too, for the terminal that has no colour at all.
   */
  it('renders catastrophic differently from destructive, in the channel AND the words', async () => {
    await startSession();
    await ask('n', {
      name: 'run_shell_command',
      args: { command: 'rm -rf /var/data' },
      safetyVerdict: { outcome: 'destructive', reason: 'the same reason either way' },
    });
    const destructiveHeading = linesOf(displayWarningMock).find((line) =>
      line.includes('Auto-rater (destructive)')
    );
    expect(destructiveHeading).toBeDefined();
    // The yellow channel, and NOT the red one.
    expect(linesOf(displayErrorMock)).toEqual([]);

    displayWarningMock.mockClear();
    displayErrorMock.mockClear();
    await ask('n', {
      name: 'run_shell_command',
      args: { command: 'rm -rf /var/data' },
      safetyVerdict: { outcome: 'catastrophic', reason: 'the same reason either way' },
    });
    const catastrophicHeading = linesOf(displayErrorMock).find((line) =>
      line.includes('Auto-rater (catastrophic)')
    );
    // The red channel — a different function, which is this surface's whole colour vocabulary.
    expect(catastrophicHeading).toBeDefined();
    expect(linesOf(displayWarningMock).some((line) => line.includes('Auto-rater'))).toBe(false);
    // ...and the sentences differ, saying the consequence rather than repeating the adjective.
    expect(catastrophicHeading).not.toBe(destructiveHeading);
    expect(catastrophicHeading).toContain('OUTSIDE this session');
    expect(destructiveHeading).not.toContain('OUTSIDE this session');
    expect(catastrophicHeading!.startsWith('⛔')).toBe(true);
    expect(destructiveHeading!.startsWith('⚠')).toBe(true);
  });

  /**
   * §2.2 — no rating at all keeps the neutral treatment. The gate is simply asking; there is
   * nothing to be alarmed about, and a dialog that shouted at every unrated prompt would be the
   * thing this task exists to undo.
   */
  it('says nothing about severity when no rating happened', async () => {
    await startSession();
    await ask('n', { name: 'run_shell_command', args: { command: 'ls -la' } });
    expect(allLines().join(LF)).not.toContain('Auto-rater');
    expect(linesOf(displayErrorMock)).toEqual([]);
  });

  /**
   * §3/§5.4 — the two voices, told apart by channel, across all THREE rounds and in order. The
   * whole exchange used to be one `displayWarning` call, so the agent's justification and the
   * rater's answer arrived in the same colour — exactly what §5.4 forbids.
   */
  it('writes the rater’s turns and the agent’s to different channels, for every round', async () => {
    await startSession();
    await ask('n', {
      name: 'run_shell_command',
      args: { command: 'git reset --hard origin/main' },
      negotiationRounds: [1, 2, 3].map((n) => ({
        command: 'git reset --hard origin/main',
        justification: `justification ${n}`,
        outcome: 'destructive',
        reason: `answer ${n}`,
      })),
    });
    const agentRows = linesOf(displayMock);
    const raterRows = linesOf(displayWarningMock);
    for (const n of [1, 2, 3]) {
      expect(agentRows).toContain(`  Round ${n}: git reset --hard origin/main`);
      expect(agentRows).toContain(`    agent justified: justification ${n}`);
      expect(raterRows).toContain(`    rater answered: destructive — answer ${n}`);
    }
    // Order, so "all three appear" is not satisfied by a jumble...
    expect(raterRows.filter((row) => row.includes('rater answered'))).toEqual([
      '    rater answered: destructive — answer 1',
      '    rater answered: destructive — answer 2',
      '    rater answered: destructive — answer 3',
    ]);
    // ...and the voices really are on different channels: no rater turn arrives on the agent's.
    expect(agentRows.some((row) => row.includes('rater answered'))).toBe(false);
  });
});
