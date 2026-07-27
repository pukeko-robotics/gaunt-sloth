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
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: rlCloseMock })),
  error: vi.fn(),
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true },
}));

// ── @gaunt-sloth/core/utils/consoleUtils.js ───────────────────────────────────
const displayInfoMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayInfo: displayInfoMock,
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

// ── @gaunt-sloth/core/config.js ───────────────────────────────────────────────
vi.mock('@gaunt-sloth/core/config.js', () => ({
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

// ── langchain + agent-internal deps (kept inert) ──────────────────────────────
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

const CATASTROPHIC = {
  outcome: 'catastrophic',
  reason: 'destroys every managed resource; cannot be undone from inside the session',
};
const DESTRUCTIVE = { outcome: 'destructive', reason: 'deletes a build directory' };

/** Everything printed by the approval callback, as one string. */
const printed = (): string =>
  displayInfoMock.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

describe('interactiveSessionModule CFG-28 — the readline confirmation tells the truth', () => {
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
    displayInfoMock.mockClear(); // only record what the approval callback itself prints
  };

  const answer = async (key: string, safetyVerdict: PendingLike['safetyVerdict']) => {
    rlQuestionMock.mockResolvedValueOnce(key);
    return capturedApprovalCallback!({
      name: 'run_shell_command',
      args: { command: 'terraform destroy -auto-approve' },
      safetyVerdict,
    });
  };

  it.each([['s'], ['a']])(
    'on a catastrophic verdict, "%s" promises NO stickiness — it says the next one asks again',
    async (key) => {
      await startSession();
      await answer(key, CATASTROPHIC);

      const out = printed();
      // The falsehoods the clamp created. Neither may be printed.
      expect(out).not.toContain('future variants will not re-prompt');
      expect(out).not.toContain('saved to the project allow-list');
      expect(out).not.toContain('Approved and remembered');
      // And the honest sentence in their place.
      expect(out).toContain('Approved this once');
      expect(out).toContain('will ask again');
    }
  );

  /**
   * The control. `destructive` IS sticky — the clamp is scoped to `catastrophic` alone — so the
   * same keys must still promise it. Without this, deleting the promise outright would pass.
   */
  it('on a destructive verdict, "s" still promises the session grant sticks', async () => {
    await startSession();
    await answer('s', DESTRUCTIVE);
    expect(printed()).toContain('Approved for this session, future variants will not re-prompt.');
  });

  it('on a destructive verdict, "a" still promises the allow-list write', async () => {
    await startSession();
    await answer('a', DESTRUCTIVE);
    expect(printed()).toContain('Approved and remembered, saved to the project allow-list.');
  });

  /**
   * The clamp stays in core: this surface must NOT start deciding persistence for itself, or the
   * policy becomes a per-surface accident (and an ACP/AG-UI client that never got the memo would
   * disagree with the CLI). The scope it sends is the key the human pressed, unchanged.
   */
  it('still sends the pressed scope to the runner — core owns the clamp, not the surface', async () => {
    await startSession();
    expect(await answer('s', CATASTROPHIC)).toEqual({ type: 'approve', scope: 'session' });
    expect(await answer('a', CATASTROPHIC)).toEqual({ type: 'approve', scope: 'always' });
  });
});
