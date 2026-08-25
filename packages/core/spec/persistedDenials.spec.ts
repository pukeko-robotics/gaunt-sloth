import { afterAll, afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import { StatusLevel } from '#src/core/types.js';
import type { PendingToolInterrupt, StatusUpdateCallback } from '#src/core/types.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE, SHELL_DENYLIST_FILE } from '#src/constants.js';

/**
 * [[EXT-107]] — **the escalation menu's *always reject* choice, persisted to a project file.**
 *
 * The asymmetry this closes: `always approve` had two stores and survived a restart, while the
 * menu's most emphatic answer had only an in-memory one and forgot itself at exit. Someone who
 * answers *always reject* has expressed a policy in the strongest words the menu offers; being
 * asked the same question tomorrow reads as the gate having forgotten rather than as a scope they
 * chose.
 *
 * The questions that belong here are the ones neither the store nor a surface can answer alone:
 *
 * 1. **Does a restart still refuse it?** Asserted end to end through a SECOND runner instance
 *    against the same project dir, because "the file was written" and "the gate consults it" are
 *    different claims and only the second one is the feature.
 * 2. **Which store wins when the two files disagree?** Deny, always — pinned so that feeding the
 *    saved refusals into the wrong list, or consulting the lists in the other order, goes red.
 * 3. **Can the user get back out?** A saved refusal nobody can find is a trap, and the person who
 *    hits it first is whoever pressed `[d]` by reflex and needed the command an hour later.
 *
 * ## Hermeticity
 *
 * Every case runs against a `mkdtemp` project dir clamped through the PRODUCTION hook
 * (`setProjectDir`, the same call config discovery makes), so the resolution under test is the real
 * one and only its input is pinned — and nothing here can read or rewrite the real
 * `.gsloth/.gsloth-settings/` of whoever runs the suite. Both files are removed between cases and
 * the whole dir is removed at the end.
 *
 * **The deny file's cleanup is load-bearing in a way the allow file's is not.** A leaked allow
 * entry makes a later case prompt less; a leaked DENY entry refuses that command outright in every
 * later case in the file, which surfaces as unrelated cells going red in a way that reads like a
 * code regression rather than a leaked fixture.
 */

const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  cleanup: vi.fn(),
};

vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class MockGthLangChainAgent {
    constructor() {
      return mockAgent;
    }
  },
  StatusUpdateCallback: vi.fn(),
}));

const projectDir = mkdtempSync(join(tmpdir(), 'gth-persisted-denials-'));
/** Built with `join`, never a POSIX literal: this comparison has to hold on win32 too. */
const denyFile = join(projectDir, SHELL_DENYLIST_FILE);
const allowFile = join(projectDir, SHELL_ALLOWLIST_FILE);

const streamOf = (...chunks: string[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk;
  },
});

/** The EXT-71 grammar, as either file holds it. */
const shellGrantFile = (patterns: string[], scope: 'always' | 'session' = 'always') =>
  JSON.stringify({
    version: 2,
    grants: patterns.map((pattern) => ({
      entry: { type: 'shell', matcher: 'exact', pattern },
      grantedAt: '2026-08-01T00:00:00.000Z',
      scope,
    })),
  });

describe('GthAgentRunner — [[EXT-107]] the persisted deny store', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdateCallback: Mock<StatusUpdateCallback>;
  let mockConfig: GthConfig;
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    rmSync(denyFile, { force: true });
    rmSync(allowFile, { force: true });
    delete (mockAgent as unknown as Record<string, unknown>).getPendingToolInterrupts;
    delete (mockAgent as unknown as Record<string, unknown>).streamResume;
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
      llm: { _llmType: vi.fn().mockReturnValue('test'), verbose: false },
    } as unknown as GthConfig;
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => setProjectDir(priorProjectDir));
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  /**
   * Drive gated shell commands through one runner instance and hand back the runner plus the
   * approval callback, so a later assertion can say whether a human was reached at all.
   */
  const runWith = async (options: {
    commands: string[];
    decide: (pending: PendingToolInterrupt) => unknown;
    approvals?: unknown;
  }) => {
    const runner = new GthAgentRunner(statusUpdateCallback);
    mockAgent.stream.mockResolvedValue(streamOf('working'));
    const getPending = vi.fn();
    getPending.mockResolvedValueOnce(
      options.commands.map((command) => ({ name: 'run_shell_command', args: { command } }))
    );
    getPending.mockResolvedValue([]);
    (mockAgent as unknown as Record<string, unknown>).getPendingToolInterrupts = getPending;
    const resume = vi.fn().mockResolvedValue(streamOf(' done'));
    (mockAgent as unknown as Record<string, unknown>).streamResume = resume;
    await runner.init('code', {
      ...mockConfig,
      // `write` gates the shell and consults no model, so a case with no verdict reaches the human
      // for the rung's reason alone.
      approvals: options.approvals ?? 'write',
    } as unknown as GthConfig);
    const decide = vi.fn(async (pending: PendingToolInterrupt) => options.decide(pending));
    runner.setToolApprovalCallback(decide as never);
    await runner.processMessages([new HumanMessage('run it')]);
    const decisions = resume.mock.calls.flatMap(
      ([value]) => (value as { decisions: Array<{ message?: string }> }).decisions
    );
    return { runner, decide, decisions };
  };

  const rejectAlways = () => ({ type: 'reject' as const, scope: 'always' as const });
  const approveOnce = () => ({ type: 'approve' as const, scope: 'once' as const });

  /**
   * **The acceptance, end to end.** Refuse a command in one runner, then drive the identical
   * command through a SECOND runner built against the same project dir — a full restart as far as
   * the gate is concerned — and the call is refused with no prompt at all.
   *
   * Asserted on the human never being reached rather than on the file's contents, because "the file
   * exists" and "the gate consults it" are different claims and only the second one is the feature.
   * A version that wrote the file and never read it back would pass a file-contents assertion.
   */
  it('refuses the same command in a NEW runner, without asking', async () => {
    const first = await runWith({ commands: ['npm publish'], decide: rejectAlways });
    expect(first.decide).toHaveBeenCalledTimes(1);

    const second = await runWith({ commands: ['npm publish'], decide: approveOnce });
    expect(second.decide).not.toHaveBeenCalled();
    expect(second.decisions[0]).toMatchObject({ type: 'reject' });
    // ...and the new session can see the refusal it inherited, which is what makes it liftable.
    expect(second.runner.getRefusals()).toEqual([
      { index: 1, description: 'npm publish', origin: 'persisted', recordedAt: expect.any(String) },
    ]);
  });

  /**
   * The file a human will open, and may commit. It has to be the EXT-71 grammar — the same shape
   * the allow file holds and the same one `approvals.deny` is written in — or "you can edit it"
   * is a claim nothing supports.
   */
  it('writes the EXT-71 grammar, readable by a human who opens the file', async () => {
    await runWith({ commands: ['npm publish'], decide: rejectAlways });
    const written: unknown = JSON.parse(readFileSync(denyFile, 'utf8'));
    expect(written).toEqual({
      version: 2,
      grants: [
        {
          entry: { type: 'shell', matcher: 'exact', pattern: 'npm publish' },
          grantedAt: expect.any(String),
          scope: 'always',
        },
      ],
    });
    // A separate file from the approvals, so a parse error in one cannot take the other down — and
    // refusing is the half that must never be lost.
    expect(existsSync(allowFile)).toBe(false);
  });

  /**
   * **Deny beats allow, and the two files are exactly where they can contradict each other.**
   *
   * The same command is in BOTH saved files, and the call is refused. This goes red if the saved
   * refusals are fed into the allow list, if the lists are consulted in the other order, or if the
   * deny store is not consulted at all — and it cannot pass by accident, because the control below
   * proves the saved ALLOW entry is live in the same session.
   */
  it('refuses a command that is in BOTH saved files — deny wins over allow', async () => {
    writeFileSync(denyFile, shellGrantFile(['npm publish']), 'utf8');
    writeFileSync(allowFile, shellGrantFile(['npm publish', 'npm test']), 'utf8');

    const { decide, decisions } = await runWith({
      commands: ['npm publish', 'npm test'],
      decide: approveOnce,
    });
    // Nobody was asked about either: one is refused by rule, the other approved by rule.
    expect(decide).not.toHaveBeenCalled();
    // The contested command is REFUSED, though an allow entry matches it just as exactly.
    expect(decisions[0]).toMatchObject({ type: 'reject' });
    expect(decisions[0].message).toContain('saved to this project');
    // CONTROL: the allow file is genuinely in force in this same session, so the refusal above is
    // precedence rather than an allow store that failed to load.
    expect(decisions[1]).toMatchObject({ type: 'approve' });
  });

  /**
   * **A saved refusal is in force at `bypass` too**, and this is deliberately NOT the allow side's
   * rule. The allow store is skipped at `bypass` so a session with the gate switched off neither
   * reads nor rewrites the project's grant file; a refusal is resolved before the `bypass` return,
   * so one that lapsed the moment someone relaxed the gate would be a promise the file stops
   * keeping exactly when it matters most.
   *
   * The control is the second command: `bypass` really is off for everything else, so the refusal
   * above is the deny store biting rather than the gate still being on.
   */
  it('still refuses at bypass, where every other check is off', async () => {
    writeFileSync(denyFile, shellGrantFile(['npm publish']), 'utf8');
    const { decide, decisions } = await runWith({
      commands: ['npm publish', 'echo hello'],
      approvals: 'bypass',
      decide: approveOnce,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(decisions[0]).toMatchObject({ type: 'reject' });
    // CONTROL: bypass is genuinely in force — an unrefused command runs with no prompt and no rating.
    expect(decisions[1]).toMatchObject({ type: 'approve', scope: 'once' });
  });

  /**
   * Reading the deny file at `bypass` must not WRITE it, which is the other half of why the v1
   * `prefixes` migration is off for this store. A file holding the retired v1 shape is read as
   * holding nothing — never migrated into refusals nobody wrote, and never rewritten — so a
   * read-only or checked-in file is left exactly as the user left it.
   */
  it('never rewrites the deny file on load, and invents no refusals from a v1-shaped one', async () => {
    const handWritten = JSON.stringify({ version: 1, prefixes: ['npm publish'] });
    writeFileSync(denyFile, handWritten, 'utf8');
    const { decide } = await runWith({
      commands: ['npm publish'],
      approvals: 'bypass',
      decide: approveOnce,
    });
    // Nothing was migrated, so nothing refuses: the command runs under bypass as it would have.
    expect(decide).not.toHaveBeenCalled();
    // And the file is byte-for-byte what was there.
    expect(readFileSync(denyFile, 'utf8')).toBe(handWritten);
  });

  /**
   * [[EXT-143]] — **a broken file tells the user, in the words of the file that broke.**
   *
   * The store is list-agnostic and stays so; the noun it prints is the one thing the caller has to
   * supply, and these are the two cases that prove each side supplies its own. Asserted through the
   * runner rather than the store, because the store passing its own tests proves nothing about a
   * runner that wired the same word into both files — which is the mistake available here, and the
   * one that would put "approvals" in front of a user whose refusals are the thing not in force.
   *
   * The fallback is asserted alongside the message every time: the human is still asked. Reporting
   * the failure is the change; failing to a re-prompt is [[EXT-107]]'s design and is not.
   */
  it('reports a deny file it cannot read — once, naming that file and the REFUSALS lost', async () => {
    writeFileSync(denyFile, '{ "version": 2, "grants": [ {"entry": ] }', 'utf8');

    const { decide } = await runWith({
      commands: ['npm publish', 'npm publish'],
      decide: approveOnce,
    });

    const notices = statusUpdateCallback.mock.calls.filter(([, message]) =>
      String(message).includes(denyFile)
    );
    // ONE notice for the session, not one per gated call: the store is loaded once per runner.
    expect(notices).toHaveLength(1);
    expect(notices[0][0]).toBe(StatusLevel.ERROR);
    expect(String(notices[0][1])).toContain('refusals');
    expect(String(notices[0][1])).not.toContain('approvals');
    // The fallback, unchanged: nothing was refused by rule, so the human was asked instead.
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it('reports an allow file it cannot read, naming that file and the APPROVALS lost', async () => {
    writeFileSync(allowFile, 'not json at all', 'utf8');

    const { decide } = await runWith({ commands: ['npm test'], decide: approveOnce });

    const notices = statusUpdateCallback.mock.calls.filter(([, message]) =>
      String(message).includes(allowFile)
    );
    expect(notices).toHaveLength(1);
    expect(notices[0][0]).toBe(StatusLevel.ERROR);
    expect(String(notices[0][1])).toContain('approvals');
    expect(String(notices[0][1])).not.toContain('refusals');
    expect(decide).toHaveBeenCalledTimes(1);
  });

  /**
   * [[EXT-143]] — **the notice may say what is certain, and a prompt is not certain.**
   *
   * The first wording promised the calls a broken file covered "will be asked about again". These
   * two cases are the configurations where that is false, and they are the ones where losing the
   * file has teeth. The mechanism is [[EXT-107]]'s precedence working as designed: the failed load
   * hands `resolveApprovalRules` an empty deny list, an empty deny list refuses nothing, and
   * whatever else covers the command decides — the `bypass` return in the first case, a saved
   * approval for the same command in the second. In both the command RUNS and the human is never
   * reached, while the notice is on screen saying it is not.
   *
   * Each case carries its intact-file control, because the claim is not that `bypass` approves —
   * it is that the SAME command, at the SAME rung, is refused when the file reads. That is what
   * makes these tests about the sentence rather than about the precedence, which is unchanged.
   *
   * The negative assertion is the load-bearing one: a wording that predicted a prompt would satisfy
   * every positive assertion here.
   */
  it('does not promise a prompt: at bypass a broken deny file lets the command run', async () => {
    writeFileSync(denyFile, '{ "version": 2, "grants": [ {"entry": ] }', 'utf8');

    const { decide, decisions } = await runWith({
      commands: ['npm publish'],
      approvals: 'bypass',
      decide: approveOnce,
    });

    // Nobody was asked, and the command the file refused ran.
    expect(decide).not.toHaveBeenCalled();
    expect(decisions[0]).toMatchObject({ type: 'approve' });

    const notices = statusUpdateCallback.mock.calls.filter(([, message]) =>
      String(message).includes(denyFile)
    );
    expect(notices).toHaveLength(1);
    expect(notices[0][0]).toBe(StatusLevel.ERROR);
    expect(String(notices[0][1])).not.toContain('asked about again');
    expect(String(notices[0][1])).toContain('may run without asking');

    // CONTROL: same command, same rung, a file that reads — refused by rule, no prompt.
    writeFileSync(denyFile, shellGrantFile(['npm publish']), 'utf8');
    const control = await runWith({
      commands: ['npm publish'],
      approvals: 'bypass',
      decide: approveOnce,
    });
    expect(control.decide).not.toHaveBeenCalled();
    expect(control.decisions[0]).toMatchObject({ type: 'reject' });
  });

  it('does not promise a prompt: a saved approval decides when the deny file breaks', async () => {
    writeFileSync(denyFile, '{ "version": 2, "grants": [ {"entry": ] }', 'utf8');
    writeFileSync(allowFile, shellGrantFile(['npm publish']), 'utf8');

    // `write`, not `bypass`: the gate is fully on and the command still runs unasked.
    const { decide, decisions } = await runWith({
      commands: ['npm publish'],
      decide: approveOnce,
    });

    expect(decide).not.toHaveBeenCalled();
    expect(decisions[0]).toMatchObject({ type: 'approve' });

    const notices = statusUpdateCallback.mock.calls.filter(([, message]) =>
      String(message).includes(denyFile)
    );
    expect(notices).toHaveLength(1);
    expect(String(notices[0][1])).not.toContain('asked about again');
    expect(String(notices[0][1])).toContain('may run without asking');

    // CONTROL: the same pair of files, the deny one readable — the saved refusal wins, so the
    // approval above is the empty deny list and not the allow store outranking anything.
    writeFileSync(denyFile, shellGrantFile(['npm publish']), 'utf8');
    const control = await runWith({ commands: ['npm publish'], decide: approveOnce });
    expect(control.decide).not.toHaveBeenCalled();
    expect(control.decisions[0]).toMatchObject({ type: 'reject' });
  });

  /**
   * §3.1 — **the entry is the command the human saw, and nothing wider.** The variant matters
   * because it is not hypothetical: on a real escalation the agent proposed `git reset --hard HEAD`
   * one round before `git reset --hard`, so the near-variant is the model's own natural next
   * attempt rather than an adversarial one.
   *
   * The saved refusal does NOT cover it, and the boundary is pinned in that direction on purpose: a
   * `[d]` that quietly stored a prefix would refuse commands the user never saw, and the prompt
   * that showed them an `exact` entry would have described something else. Un-denied is not
   * unguarded — the variant still reaches a human — which is what the control asserts.
   */
  it('refuses the exact command it was told, and asks again about a near-variant', async () => {
    const asked: string[] = [];
    const { decide } = await runWith({
      commands: ['git reset --hard', 'git reset --hard', 'git reset --hard HEAD'],
      decide: (pending) => {
        asked.push(pending.args.command as string);
        return pending.args.command === 'git reset --hard' ? rejectAlways() : approveOnce();
      },
    });
    expect(decide).toHaveBeenCalledTimes(2);
    // The repeat of the refused command never reached a person; the VARIANT did.
    expect(asked).toEqual(['git reset --hard', 'git reset --hard HEAD']);
  });

  /**
   * **The escape hatch.** Lifting a saved refusal from `/approvals` has to actually lift it — at the
   * next call, in this session — and take it out of the file, so it does not come back tomorrow.
   * Both halves are asserted, because a removal held only in memory looks identical until a restart.
   */
  it('lifts a saved refusal, in this session and in the file', async () => {
    const first = await runWith({ commands: ['npm publish'], decide: rejectAlways });
    const [refusal] = first.runner.getRefusals();
    expect(refusal).toMatchObject({ index: 1, origin: 'persisted' });

    expect(first.runner.liftRefusal(refusal.index)).toEqual({
      outcome: 'lifted',
      description: 'npm publish',
      origin: 'persisted',
      stillConfigured: false,
    });
    expect(first.runner.getRefusals()).toEqual([]);
    // The file no longer holds it, so a new session does not inherit it…
    expect(JSON.parse(readFileSync(denyFile, 'utf8'))).toEqual({ version: 2, grants: [] });
    // …and the very next call in THIS session reaches a human again, which is the claim that
    // matters: a lift that only rewrote the file would leave the in-memory copy still refusing.
    const second = await runWith({ commands: ['npm publish'], decide: approveOnce });
    expect(second.decide).toHaveBeenCalledTimes(1);
  });

  /**
   * A refusal the user wrote in `approvals.deny` is reported, never removed: rewriting their config
   * file out from under them is not a thing a session command may do, and silently no-oping would
   * be worse. The list keeps it visible so the number beside it means something.
   */
  it('reports a configured entry instead of removing it', async () => {
    const { runner } = await runWith({
      commands: [],
      approvals: {
        mode: 'write',
        deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
      },
      decide: approveOnce,
    });
    expect(runner.getRefusals()).toEqual([
      { index: 1, description: 'npm publish', origin: 'config' },
    ]);
    expect(runner.liftRefusal(1)).toEqual({
      outcome: 'configured',
      description: 'npm publish',
    });
    // Still in force, and still listed under the same number.
    expect(runner.getRefusals()).toEqual([
      { index: 1, description: 'npm publish', origin: 'config' },
    ]);
  });

  /**
   * The case a plain "removed" would misreport: a command refused by BOTH a saved entry and a
   * config line is still refused after the saved one is lifted. Telling the user they had opened
   * something that is still closed is the same failure the escalation menu is written to avoid, one
   * layer up.
   */
  it('says when a lifted refusal is still matched by the config the user wrote', async () => {
    const declared = {
      mode: 'write',
      deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
    };
    // The saved entry is planted, since a configured deny would refuse the call before any prompt.
    writeFileSync(denyFile, shellGrantFile(['npm publish']), 'utf8');
    const { runner } = await runWith({ commands: [], approvals: declared, decide: approveOnce });

    const saved = runner.getRefusals().find((refusal) => refusal.origin === 'persisted');
    expect(saved).toBeDefined();
    expect(runner.liftRefusal(saved!.index)).toEqual({
      outcome: 'lifted',
      description: 'npm publish',
      origin: 'persisted',
      stillConfigured: true,
    });
  });

  /** A number nobody listed is explained, not coerced into removing a different refusal. */
  it('answers a number that names no refusal, without removing anything', async () => {
    const { runner } = await runWith({ commands: ['npm publish'], decide: rejectAlways });
    expect(runner.liftRefusal(7)).toEqual({ outcome: 'unknown', index: 7, count: 1 });
    expect(runner.getRefusals()).toHaveLength(1);
  });
});
