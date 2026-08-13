import { beforeEach, describe, expect, it, vi } from 'vitest';
import { frameWidthFor, STICKY_PREVIEW_MAX_ROWS } from '@gaunt-sloth/core/core/shell/framing.js';
import { maxDisplayWidth } from '@gaunt-sloth/core/utils/displayWidth.js';
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
  negotiationAttempts?: number;
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
   *
   * "Unbound" is a property of THIS PROMPT, not of the alphabet, and the fixture is what makes the
   * list say so: `DENYABLE` carries a deny entry and no grant, so its menu is the reduced one and
   * `s`/`a` are as unbound on it as `x` is. An answer that grants on a menu offering no grant is
   * §1.1's own failure — the command runs, off a control the dialog withdrew.
   *
   * **The long forms are listed as well as the letters, because they are separate spellings of the
   * same two branches.** This surface accepts `session` and `always` beside `s` and `a`; a gate
   * lost from one spelling is invisible in the other's case, so the letter alone would leave the
   * long form free to grant on a menu that offers no grant.
   */
  it.each([['n'], ['x'], [''], ['s'], ['a'], ['session'], ['always']])(
    'an unbound answer (%j) refuses once, with no scope',
    async (key) => {
      await startSession();
      const decision = await ask(key, DENYABLE);
      expect(decision.type).toBe('reject');
      expect(decision.scope).toBeUndefined();
      expect(allLines().join(LF)).toContain('Command rejected.');
    }
  );

  /**
   * The control for the pair above: on a call that DOES carry a grant, the same two answers
   * resolve. Without it, unbinding `[s]`/`[a]` outright would satisfy the fallthrough test.
   */
  it.each([
    ['s', 'session'],
    ['a', 'always'],
  ])('%j still approves at scope %j where the grant IS on offer', async (key, scope) => {
    await startSession();
    const decision = await ask(key, {
      name: 'run_shell_command',
      args: { command: 'npm test' },
      grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "npm test" }',
      grantSummary: 'npm test',
    });
    expect(decision).toMatchObject({ type: 'approve', scope });
  });

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
    expect(agentRows).toContain('  Round 1: git reset --hard origin/main');
    expect(agentRows).toContain('  Round 2: git reset --hard origin/main');
    expect(agentRows).toContain('  Round 3 (this request): git reset --hard origin/main');
    expect(agentRows).toContain('    agent justified (not shown to the rater): justification 1');
    expect(raterRows).toContain(
      '    rater answered (on the command alone): destructive — answer 1'
    );
    for (const n of [2, 3]) {
      expect(agentRows).toContain(`    agent justified: justification ${n}`);
      expect(raterRows).toContain(`    rater answered: destructive — answer ${n}`);
    }
    // Order, so "all three appear" is not satisfied by a jumble...
    expect(raterRows.filter((row) => row.includes('rater answered'))).toEqual([
      '    rater answered (on the command alone): destructive — answer 1',
      '    rater answered: destructive — answer 2',
      '    rater answered: destructive — answer 3',
    ]);
    // ...and the voices really are on different channels: no rater turn arrives on the agent's.
    expect(agentRows.some((row) => row.includes('rater answered'))).toBe(false);
  });

  /**
   * [[TUI-C75]] — **the count on the screen is the attempts made, not the rounds that survived**,
   * and this surface is where that claim reaches a person.
   *
   * §5.3 clears the transcript on an approved call, so a surface that counted the array it was
   * handed reports the attempts since the last *approval* rather than since the last *human*: the
   * measured escalation refused the same command five times, two approved calls erased the rounds
   * before them, and the human was told three.
   *
   * **The fixture has to make the two numbers DIFFER**, which is the whole of this case. Every
   * other negotiation fixture on this surface passes three rounds and either no count or a matching
   * one, so the renderer's fallback to `rounds.length` produces the identical screen and deleting
   * the pass-through below leaves them all green — the node's own defect class, a test that cannot
   * fail on the thing it names, reproduced on the surface the node exists to fix.
   */
  it('reports the attempts the agent made, not the rounds an approved call left behind', async () => {
    await startSession();
    await ask('n', {
      name: 'run_shell_command',
      args: { command: 'git reset --hard' },
      negotiationRounds: [1, 2, 3].map((n) => ({
        command: 'git reset --hard',
        justification: `justification ${n}`,
        outcome: 'destructive',
        reason: `answer ${n}`,
      })),
      // Five refused attempts; three survived the resets, which is what the surface is handed.
      negotiationAttempts: 5,
    });
    expect(linesOf(displayInfoMock)).toContain(
      'The agent argued with the auto-rater 5 times; the last 3 of them:'
    );
    // ...and the rounds carry their true attempt numbers, so the count and the rounds beneath it
    // cannot describe two different exchanges.
    const agentRows = linesOf(displayMock);
    expect(agentRows).toContain('  Round 3: git reset --hard');
    expect(agentRows).toContain('  Round 4: git reset --hard');
    expect(agentRows).toContain('  Round 5 (this request): git reset --hard');
    expect(allLines().join(LF)).not.toContain('auto-rater 3 times');
  });

  /**
   * §5.4/§3.2 — **this surface binds the transcript to the frame width**, and that is a property of
   * the SURFACE, not of the renderer. The renderer's own spec proves it can wrap when handed a
   * width; only a test here can see whether the caller hands it one. Unbound, a long justification
   * is one enormous line, the terminal wraps it itself, and the continuation lands at column 0 —
   * the flush-left forgery every other block on this dialog is framed to prevent, reached through
   * the one block that is not framed.
   *
   * The continuation gutter is the discriminator: the terminal's own wrap produces no such prefix.
   */
  it('binds the negotiation transcript to the frame width, gutter and all', async () => {
    await startSession();
    const justification = 'x'.repeat(300);
    await ask('n', {
      name: 'run_shell_command',
      args: { command: 'git reset --hard origin/main' },
      negotiationRounds: [
        {
          command: 'git reset --hard origin/main',
          justification,
          outcome: 'destructive',
          reason: 'discards uncommitted work',
        },
      ],
    });
    // The justification is an AGENT turn, so its rows — continuations included — are on the plain
    // channel. Selecting them by content keeps this about the row that had to wrap.
    const rows = linesOf(displayMock).filter((row) => row.includes('xxx'));
    expect(rows.length).toBeGreaterThan(1);
    // `      ┊ ` — the renderer's continuation gutter, which a terminal's own wrap never produces.
    expect(rows.slice(1).every((row) => row.startsWith('      ┊ '))).toBe(true);
    const width = frameWidthFor(100); // the columns this suite's stdout reports
    for (const row of rows) expect(maxDisplayWidth(row)).toBeLessThanOrEqual(width);
  });

  /**
   * §6 — **the sticky blocks are bounded on this surface too**, and it is the surface where an
   * unbounded one is worse: `--no-tui` has no managed frame, so a block that overruns does not
   * merely push the menu off a fifty-row terminal, it scrolls it out of the scrollback the user is
   * reading. All four blocks are checked separately, because each is its own call and a bound
   * dropped from one is invisible in the others.
   */
  it('bounds all four sticky blocks, and says how many rows it dropped', async () => {
    await startSession();
    // Eighteen lines, each long enough that the entry repeating them overflows too — so all four
    // blocks are over budget and a bound missing from any one of them shows up here.
    const command = Array.from(
      { length: 18 },
      (_, index) => `line ${index + 1} ${'y'.repeat(50)}`
    ).join(LF);
    await ask('n', {
      name: 'run_shell_command',
      args: { command },
      grantPreview: `{ "type": "shell", "matcher": "exact", "pattern": "${command.replace(/\n/gu, '\\n')}" }`,
      grantSummary: command,
      denyPreview: `{ "type": "shell", "matcher": "exact", "pattern": "${command.replace(/\n/gu, '\\n')}" }`,
      denySummary: command,
    });
    const info = linesOf(displayInfoMock);
    const at = (needle: string): number => {
      const index = info.indexOf(needle);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    // The four labels, in the order this surface prints them, and the line that follows the last
    // block — so every block is measured between two anchors rather than to the end of the output.
    const bounds = [
      at('[s]/[a] will remember:'),
      at('    stored as:'),
      at('[d] will refuse, for the rest of this session:'),
      at('    recorded as:'),
      at('Command rejected.'),
    ];
    for (let index = 0; index < 4; index++) {
      const block = info.slice(bounds[index] + 1, bounds[index + 1]);
      // Three rows of command plus the row that says what was dropped — never eighteen.
      expect(block.length).toBeLessThanOrEqual(STICKY_PREVIEW_MAX_ROWS);
      expect(block.some((row) => row.includes('more rows hidden'))).toBe(true);
    }
    // The command itself is NOT bounded that way: it is the thing being ruled on, and every one of
    // its lines is numbered in the frame above. Counted on the plain channel, where the command
    // frame goes — the bounded blocks above are on the info channel and are made of rows of the
    // same shape, so an unscoped count would be satisfied by their kept heads.
    expect(linesOf(displayMock).filter((row) => /^ +\d+ │ line \d+ y+$/u.test(row)).length).toBe(
      18
    );
  });
});
