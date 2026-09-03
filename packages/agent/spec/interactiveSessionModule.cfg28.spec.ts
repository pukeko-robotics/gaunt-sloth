import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

/**
 * CFG-28 (§4.2, §6) — the readline (`--no-tui`) approval prompt must not confirm a persistence the
 * gate has already discarded.
 *
 * §4.2 makes a `catastrophic` approval NEVER sticky, and `GthAgentRunner` enforces that by clamping
 * the allow-list write. Nothing on the way to the clamp was told, so pressing `[s]`/`[a]` on a
 * `catastrophic` command still printed *"Approved for this session, future variants will not
 * re-prompt."* / *"saved to the project allow-list."* — both false, and the very next variant
 * re-prompts. §6 names this the wrong failure mode: *"a control that is offered and then refused
 * reads as a bug rather than as a policy."*
 *
 * The scope returned to the runner is deliberately UNCHANGED (core owns the clamp, so the policy
 * cannot drift per surface); what these pin is that the sentence the human reads matches what
 * happened — with a `destructive` control beside it that still promises stickiness, so a fix that
 * simply deleted the promise everywhere would go red here.
 */

// ── @gaunt-sloth/core/utils/systemUtils.js ────────────────────────────────────
const rlQuestionMock = vi.fn(async (prompt: string) => {
  // The main loop prompt ('  > ') ends the session; the approval prompt's answer is set per test
  // with mockResolvedValueOnce on top of this.
  if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
  return '';
});
const rlCloseMock = vi.fn();
// GS2-20 — the history recorder is stubbed: this spec does not test history, and with
// recording on by default a config naming no `dbPath` would resolve the user's real
// `~/.gsloth/history.db` and write to it. Plain functions, not vi.fn, so a
// `vi.resetAllMocks()` in beforeEach cannot strip their return values.
vi.mock('@gaunt-sloth/core/history/recordSession.js', () => ({
  openConversationSafe: () => null,
  recordSessionSafe: () => null,
  lookupConversationThreadSafe: () => null,
}));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: rlCloseMock })),
  error: vi.fn(),
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  getUseColour: vi.fn(() => false),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true },
}));

// ── @gaunt-sloth/core/utils/consoleUtils.js ───────────────────────────────────
const displayInfoMock = vi.fn();
const displayWarningMock = vi.fn();
const displayErrorMock = vi.fn();
/**
 * [[TUI-C26]] §6 / [[EXT-105]] — the dialog's one writer, and its TONE argument is this surface's
 * colour, so it is also the observable. A `catastrophic` escalation is painted `danger` (red) where
 * a `destructive` one is painted `warn` (yellow); captured here so the two can be told apart by
 * assertion rather than by reading.
 */
const displayDialogLineMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayDialogLine: displayDialogLineMock,
  displayError: displayErrorMock,
  displayInfo: displayInfoMock,
  displayLaunchBanner: vi.fn(),
  displayWarning: displayWarningMock,
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

// ── @gaunt-sloth/core/config.js ───────────────────────────────────────────────
// Partial mock (spread the real module): the shared slash-command registry reads the real
// approvals vocabulary (APPROVAL_RUNGS) while building the `/approvals` entry, so a bare
// stub of this barrel leaves that constant undefined and the session fails to start.
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: vi.fn().mockResolvedValue({ streamSessionInferenceLog: false }),
}));

// ── @gaunt-sloth/core/utils/fileUtils.js ──────────────────────────────────────
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null), // null -> no session logging branch
}));

// ── GthAgentRunner: capture the approval callback the module registers ─────────
type PendingLike = {
  name: string;
  args: Record<string, unknown>;
  safetyVerdict?: { outcome: string; reason: string };
  escalatedBy?: string;
  grantPreview?: string;
};
let capturedApprovalCallback:
  | ((_pending: PendingLike) => Promise<{ type: string; scope?: string; message?: string }>)
  | undefined;
/**
 * [[EXT-154]] — the return leg. A remembering answer's confirmation is no longer written where the
 * key is read, so a case that wants to see one has to play the runner's part and report what the
 * answer landed as.
 */
let capturedOutcomeCallback:
  | ((_outcome: {
      pending: PendingLike;
      decision: 'approve' | 'reject';
      lifetime: 'once' | 'session' | 'always';
    }) => void)
  | undefined;
const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: vi.fn().mockResolvedValue(undefined),
  setToolApprovalCallback: vi.fn((cb) => {
    capturedApprovalCallback = cb;
  }),
  setApprovalOutcomeCallback: vi.fn((cb) => {
    capturedOutcomeCallback = cb;
  }),
  cleanup: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

// ── langchain + agent-internal deps (kept inert) ──────────────────────────────
vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
// GS2-20 — the session's checkpointer comes from this seam. Stubbed here so the spec does not
// load the real SQLite saver (which needs more of @langchain/langgraph than the stub above
// provides, and would open a database this spec has no interest in). A plain function, not a
// vi.fn, so a `vi.resetAllMocks()` in beforeEach cannot strip its return value.
vi.mock('@gaunt-sloth/core/history/sessionCheckpointer.js', () => ({
  openSessionCheckpointerSafe: () => ({
    saver: {},
    durable: false,
    threadId: 'test-thread-id',
    close: () => {},
  }),
}));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn() }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

const CATASTROPHIC = {
  outcome: 'catastrophic',
  reason: 'destroys every managed resource; cannot be undone from inside the session',
};
const DESTRUCTIVE = { outcome: 'destructive', reason: 'deletes a build directory' };

/** The dialog lines painted in one tone, as one string. */
const inTone = (tone: string): string =>
  displayDialogLineMock.mock.calls
    .filter((call: unknown[]) => (call[1] ?? 'plain') === tone)
    .map((call: unknown[]) => String(call[0]))
    .join('\n');

/** Everything the approval callback printed in the quiet tone — the labels and confirmations. */
const printed = (): string => inTone('notice');

/** Everything painted `warn` — where the rater and escalate rows go. */
const warned = (): string => inTone('warn');

describe('interactiveSessionModule CFG-28 — the readline confirmation tells the truth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    capturedApprovalCallback = undefined;
    capturedOutcomeCallback = undefined;
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
    // [[EXT-154]] — asserted, not assumed. Without this leg the two remembering answers are silent
    // rather than wrong, and every "does not claim persistence" case below would pass for the one
    // reason that proves nothing.
    expect(capturedOutcomeCallback).toBeTypeOf('function');
    displayDialogLineMock.mockClear(); // only record what the approval callback itself prints
    displayInfoMock.mockClear();
    displayWarningMock.mockClear();
  };

  /**
   * EXT-70 §6 — production attaches the grant preview EXACTLY when a sticky grant is on offer, and
   * discards it for a `catastrophic` outcome (§4.2), so the fixture is derived from the verdict
   * rather than left off. Without that, every confirmation test here ran on a pending the runner
   * never sends, and the sticky/not-sticky assertions would have agreed with each other whatever
   * the surface did.
   */
  /** The interrupt the last {@link answer} was given, so {@link report} can name the same object. */
  let lastPending: PendingLike | undefined;

  const answer = async (key: string, safetyVerdict: PendingLike['safetyVerdict']) => {
    rlQuestionMock.mockResolvedValueOnce(key);
    const sticky = safetyVerdict?.outcome !== 'catastrophic';
    lastPending = {
      name: 'run_shell_command',
      args: { command: 'terraform destroy -auto-approve' },
      safetyVerdict,
      ...(sticky
        ? {
            grantPreview:
              '{ "type": "shell", "matcher": "exact", "pattern": "terraform destroy -auto-approve" }',
            grantSummary: 'terraform destroy -auto-approve',
          }
        : {}),
    };
    return capturedApprovalCallback!(lastPending);
  };

  /**
   * [[EXT-154]] — the runner's half: tell the surface what the answer it just gave landed as.
   *
   * The interrupt is passed by IDENTITY, which is the correlation the seam defines and the thing
   * production keys its pending set on — so a report naming some other object must be dropped, and
   * a case below proves it is.
   */
  const report = (
    decision: 'approve' | 'reject',
    lifetime: 'once' | 'session' | 'always',
    pending: PendingLike = lastPending!
  ) => capturedOutcomeCallback!({ pending, decision, lifetime });

  /**
   * [[TUI-C26]] §1.1 — on a `catastrophic` verdict the runner sends no grant preview, the menu
   * drops `[s]`/`[a]`, and **the answers go with them**: typed anyway they are unbound answers and
   * take the one-shot refusal. Confirming the keypress honestly was the smaller half — the command
   * still ran, off a control the dialog had withdrawn, and nothing downstream re-reads the verdict.
   */
  it.each([['s'], ['a']])(
    'on a catastrophic verdict, "%s" approves nothing — the answer went with the control',
    async (key) => {
      await startSession();
      const decision = await answer(key, CATASTROPHIC);
      expect(decision.type).toBe('reject');
      // The absent scope, not the type: a one-shot refusal and a standing one are both rejections.
      expect(decision.scope).toBeUndefined();

      const out = printed();
      expect(out).toContain('Command rejected.');
      // None of the approval sentences, honest or otherwise.
      expect(out).not.toContain('Approved');
      expect(out).not.toContain('will not ask again in this conversation');
      expect(out).not.toContain('saved to the project allow-list');
    }
  );

  /**
   * The control. `destructive` IS sticky — the clamp is scoped to `catastrophic` alone — so the
   * same keys must still promise it. Without this, deleting the promise outright would pass.
   */
  it('on a destructive verdict, "s" still promises the session grant sticks', async () => {
    await startSession();
    await answer('s', DESTRUCTIVE);
    // GS2-20 — the grant is kept with the conversation and comes back on a resume, and says so.
    expect(printed()).toContain(
      'Approved — this exact command will not ask again in this conversation, even if you resume it later.'
    );
  });

  /**
   * [[EXT-154]] — the same promise, now made only once the write has answered. `[a]` is the twin of
   * `[d]`: it asks for the same project file and used to make the same claim about it on the way
   * past. So the keystroke alone must say NOTHING about a file, and the sentence arrives with the
   * outcome.
   */
  it('on a destructive verdict, "a" promises the allow-list write once the runner reports it', async () => {
    await startSession();
    await answer('a', DESTRUCTIVE);
    // Nothing yet: at this instant the runner has not tried the write.
    expect(printed()).not.toContain('allow-list');
    report('approve', 'always');
    expect(printed()).toContain(
      'Approved and remembered — this exact command is saved to the project allow-list.'
    );
  });

  /**
   * The clamp stays in core: this surface must NOT start deciding persistence for itself, or the
   * policy becomes a per-surface accident (and an ACP/AG-UI client that never got the memo would
   * disagree with the CLI). Where the control IS offered, the scope it sends is the key the human
   * pressed, unchanged — the surface withdraws a control, it never quietly downgrades one.
   */
  it('still sends the pressed scope to the runner — core owns the clamp, not the surface', async () => {
    await startSession();
    expect(await answer('s', DESTRUCTIVE)).toEqual({ type: 'approve', scope: 'session' });
    expect(await answer('a', DESTRUCTIVE)).toEqual({ type: 'approve', scope: 'always' });
  });

  /**
   * EXT-71 §3.2 — an escalate match asks the human whatever the rung would have done, so the prompt
   * MUST show the entry that fired. Without it the user is asked about a command their rung would
   * have approved, with nothing on screen tying the question to the line they wrote — which reads
   * as the gate malfunctioning rather than as their own rule working.
   */
  it('shows the approvals.escalate entry that brought the call here', async () => {
    await startSession();
    rlQuestionMock.mockResolvedValueOnce('n');
    await capturedApprovalCallback!({
      name: 'run_shell_command',
      args: { command: 'terraform apply' },
      escalatedBy: 'terraform apply',
    });
    expect(warned()).toContain('approvals.escalate');
    expect(warned()).toContain('terraform apply');
  });

  it('says nothing about approvals.escalate when no such entry fired', async () => {
    await startSession();
    await answer('n', DESTRUCTIVE);
    expect(warned()).not.toContain('approvals.escalate');
    // Control: the rater row IS still printed on the same surface, so the assertion above is
    // about the escalate row rather than about warnings being suppressed altogether.
    expect(warned()).toContain('Auto-rater (destructive)');
  });

  /**
   * EXT-71 §6 — **the menu must display what it is about to store**, at the moment of the choice,
   * on every surface. Under §3.1 that is the command itself as a fully-explicit exact entry, so the
   * user is shown the thing they are agreeing to rather than a generalization of it.
   */
  it('shows what a sticky choice will store', async () => {
    await startSession();
    rlQuestionMock.mockResolvedValueOnce('n');
    await capturedApprovalCallback!({
      name: 'run_shell_command',
      args: { command: 'npm test' },
      grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "npm test" }',
      grantSummary: 'npm test',
    });
    // [[TUI-C26]] — the label is this surface's own line and the grant is FRAMED beneath it, inside
    // the line-number gutter. Asserting only that `npm test` appears somewhere would still pass with
    // the gutter dropped, which is exactly the control being kept here.
    expect(printed()).toContain('[s]/[a] will remember:');
    expect(printed()).toContain('1 │ npm test');
    expect(printed()).toContain('stored as:');
    expect(printed()).toContain(
      '1 │ { "type": "shell", "matcher": "exact", "pattern": "npm test" }'
    );
  });

  it('shows no such line when no sticky grant is on offer', async () => {
    await startSession();
    rlQuestionMock.mockResolvedValueOnce('n');
    await capturedApprovalCallback!({ name: 'run_shell_command', args: { command: 'npm test' } });
    expect(printed()).not.toContain('will remember');
    // Control: this surface still printed its own line on the same path, so the assertion above is
    // about the grant row and not about output being suppressed altogether.
    expect(printed()).toContain('Command rejected.');
  });

  /**
   * The menu, as the human read it. [[EXT-105]] — it is a dialog line like the rest, written to the
   * dialog's stream rather than handed to `rl.question`, whose output is stdout.
   */
  const asked = (): string => inTone('prompt');

  /**
   * EXT-70 §6 — **a sticky control is shown only where a sticky grant is on offer**, and is
   * ABSENT rather than disabled: "a control that is offered and then refused reads as a bug rather
   * than as a policy". Both halves are in one test, because asserting only the absence would pass
   * on a menu that never offered `[s]`/`[a]` at all.
   */
  it('offers the sticky choices with a grant and not without one', async () => {
    await startSession();
    rlQuestionMock.mockResolvedValueOnce('n');
    await capturedApprovalCallback!({
      name: 'run_shell_command',
      args: { command: 'npm test' },
      grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "npm test" }',
      grantSummary: 'npm test',
    });
    expect(asked()).toContain('[s]ession');
    expect(asked()).toContain('[a]lways');

    displayDialogLineMock.mockClear();
    rlQuestionMock.mockResolvedValueOnce('n');
    await capturedApprovalCallback!({
      name: 'run_shell_command',
      args: { command: 'ls && rm -rf build' },
    });
    expect(asked()).not.toContain('[s]ession');
    expect(asked()).not.toContain('[a]lways');
    // Still a menu: the one-shot choices remain, so the absence above is about the sticky pair and
    // not about the prompt having collapsed.
    expect(asked()).toContain('[o]nce');
    expect(asked()).toContain('[N]o');
  });
});
