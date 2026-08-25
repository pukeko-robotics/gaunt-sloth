import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';
import type {
  LiveNegotiationRound,
  NegotiationDisplay,
} from '@gaunt-sloth/core/core/shell/negotiation.js';

/**
 * [[TUI-C69]] §5.4 — **the readline (`--no-tui`) surface draws the negotiation while it happens.**
 *
 * This is the half the Ink PTY suite cannot see, and `--no-tui` is a real, supported way to run a
 * session: the acceptance is that the rater's turns are told apart from the agent's on BOTH
 * surfaces, so a fix that landed only on the Ink side would be half a fix.
 *
 * What is pinned here is the TONE each voice is written in and the WORDS that carry the same
 * distinction without colour — this surface renders through core's shared `renderNegotiationRows`,
 * whose own behaviour is pinned in core, so nothing here re-asserts the rows' content beyond what
 * the mapping needs.
 */

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
  // Pinned so a row that is a row here is a row on every machine the suite runs on.
  stdout: { isTTY: true, columns: 100 },
}));

// ── @gaunt-sloth/core/utils/consoleUtils.js ───────────────────────────────────
// [[EXT-105]] — every line of a dialog goes through this one writer, which takes the severity as an
// argument instead of encoding it in the choice of channel. Here it is the call recorder, so the
// tone each voice is written in is directly observable.
const displayDialogLineMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayDialogLine: displayDialogLineMock,
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayLaunchBanner: vi.fn(),
  displayWarning: vi.fn(),
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

let capturedDisplay: NegotiationDisplay | null | undefined;
const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: vi.fn().mockResolvedValue(undefined),
  setToolApprovalCallback: vi.fn(),
  setAttackHaltCallback: vi.fn(),
  setNegotiationDisplay: vi.fn((display: NegotiationDisplay | null) => {
    capturedDisplay = display;
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

/** Every dialog line this surface wrote, as `[text, tone]`, in the order it wrote them. */
const written = (): Array<[string, string | undefined]> =>
  displayDialogLineMock.mock.calls.flatMap((call: unknown[]) =>
    String(call[0])
      .split('\n')
      .map((line) => [line, call[1] as string | undefined] as [string, string | undefined])
  );

const rejectedRound = (position: number): LiveNegotiationRound => ({
  round: {
    command: 'git reset --hard origin/main',
    justification: 'the user asked to wipe today’s commits',
    outcome: 'destructive',
    reason: 'discards every unpushed commit, not only today’s',
  },
  position,
});

/**
 * The round the rater agreed to — the one that ends the argument, and the one §5.5 holds.
 *
 * **The SAME command {@link rejectedRound} carries**, deliberately: `Agreed` is a claim about the
 * rater's opinion of this command, so a fixture that paired the label with a command the rater had
 * never seen would be modelling a state the runner does not produce.
 */
const agreedRound = (position: number): LiveNegotiationRound => ({
  round: {
    command: 'git reset --hard origin/main',
    justification: 'the user confirmed they want today’s commits gone',
    outcome: 'safe',
    reason: 'the user asked for exactly this',
  },
  position,
  agreed: true,
});

/**
 * The argument ending because the agent proposed something ELSE and the rater passed it — the
 * common shape of convergence, and the one that must not claim the rater agreed to a command it
 * never argued about.
 */
const revisedRound = (position: number): LiveNegotiationRound => ({
  round: {
    command: 'git stash',
    justification: 'saves the work first, as the rating asked',
    outcome: 'safe',
    reason: 'nothing is discarded',
  },
  position,
  agreed: true,
  revised: true,
});

describe('interactiveSessionModule — [[TUI-C69]] §5.4 the live negotiation on the readline surface', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    capturedDisplay = undefined;
    rlQuestionMock.mockImplementation(async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
      return '';
    });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue(undefined);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    runnerInstanceMock.setNegotiationDisplay.mockImplementation(
      (display: NegotiationDisplay | null) => {
        capturedDisplay = display;
      }
    );
  });

  const startSession = async () => {
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});
    displayDialogLineMock.mockClear();
  };

  /**
   * **Wiring it is the opt-in**, for the rounds AND for §5.5's hold. A session that wires nothing
   * neither draws nor sleeps, so an `exec` or CI run pays no 800 ms per approval — which makes this
   * assertion about more than a callback being registered.
   */
  it('declares a live display, which is what opts this surface into both halves of §5.4/§5.5', async () => {
    await startSession();
    expect(runnerInstanceMock.setNegotiationDisplay).toHaveBeenCalledTimes(1);
    expect(capturedDisplay?.round).toBeTypeOf('function');
  });

  /**
   * §5.4 — *"the rater's turns are coloured yellow, so the two voices are never confused"*. On this
   * surface yellow is the `warn` tone; the agent's rows carry none and the renderer's own chrome is
   * a notice.
   */
  it('writes the rater’s turn in the warn tone and the agent’s without one', async () => {
    await startSession();
    capturedDisplay!.round(rejectedRound(0));

    const lines = written();
    const rater = lines.find(([text]) => text.includes('rater answered'));
    const agent = lines.find(([text]) => text.includes('Round 1:'));
    const chrome = lines.find(([text]) => text.includes('negotiating with the auto-rater'));
    expect(rater?.[1]).toBe('warn');
    expect(agent?.[1]).toBeUndefined();
    expect(chrome?.[1]).toBe('notice');
  });

  /**
   * **The distinction has to survive a terminal with no colour at all**, so it cannot rest on the
   * tone alone: every row names its own speaker. This surface is piped and redirected constantly,
   * which is exactly where a colour-only distinction disappears.
   */
  it('names each speaker on the row, so colour is never the only signal', async () => {
    await startSession();
    capturedDisplay!.round(rejectedRound(1));

    const text = written()
      .map(([line]) => line)
      .join('\n');
    expect(text).toContain('Round 2: git reset --hard origin/main');
    expect(text).toContain('agent justified: the user asked');
    expect(text).toContain('rater answered: destructive — discards every unpushed commit');
  });

  /**
   * The rounds arrive as the gate decides them, so a converging negotiation — one that never
   * reaches a person — is drawn in full. Nothing about this waits for an escalation.
   */
  it('draws each round as it arrives, in order, with the context sentence only once', async () => {
    await startSession();
    capturedDisplay!.round(rejectedRound(0));
    capturedDisplay!.round(rejectedRound(1));

    const lines = written().map(([line]) => line);
    const contextRows = lines.filter((line) => line.includes('negotiating with the auto-rater'));
    expect(contextRows).toHaveLength(1);
    expect(lines.findIndex((l) => l.includes('Round 1:'))).toBeLessThan(
      lines.findIndex((l) => l.includes('Round 2:'))
    );
    // The escalation heading is NOT what a live round draws: nobody is being asked to rule on
    // anything yet.
    expect(lines.join('\n')).not.toContain('argued with the auto-rater');
  });

  /**
   * §5.4 — **the round the rater agreed to is labelled, not numbered, on this surface too.**
   *
   * The duplicate the label prevents lives in the shared position rather than in either renderer,
   * so `--no-tui` is no escape from it: an approved call never joins the transcript, so the number
   * it would take is the number the next rejection takes, and the escalation summary this surface
   * prints beneath the live rounds renders that transcript. The pair below is the exact
   * interleaving — a rejection, the agreed call, and the rejection that follows it.
   */
  it('labels the round the rater agreed to, so no number names two commands', async () => {
    await startSession();
    capturedDisplay!.round(rejectedRound(0));
    capturedDisplay!.round(revisedRound(1));
    capturedDisplay!.round(rejectedRound(1));

    const lines = written().map(([line]) => line);
    const text = lines.join('\n');
    expect(text).toContain('Accepted: git stash');
    expect(text).toContain('rater answered: safe — nothing is discarded');
    // Round 2 belongs to the rejection that followed the approved call, and to nothing else.
    expect(lines.filter((line) => /^\s*Round 2:/.test(line))).toHaveLength(1);
    expect(lines.find((line) => /^\s*Round 2:/.test(line))).toContain('git reset --hard');
  });

  /**
   * The rater's turn is warn-toned whatever it answered — the tone names the speaker, not the
   * verdict, so an agreeing round is as attributable as a refusing one.
   */
  it('keeps the rater’s tone on the round it agreed to', async () => {
    await startSession();
    capturedDisplay!.round(agreedRound(1));

    const lines = written();
    expect(lines.find(([text]) => text.includes('rater answered'))?.[1]).toBe('warn');
    // Found FIRST, then asserted on. `find(...)?.[1]` alone reads as a tone assertion and is not
    // one: a row that is not there yields `undefined`, which is the value the assertion wants.
    const command = lines.find(([text]) => text.includes('Agreed: git reset --hard origin/main'));
    expect(command).toBeDefined();
    expect(command?.[1]).toBeUndefined();
  });
});
