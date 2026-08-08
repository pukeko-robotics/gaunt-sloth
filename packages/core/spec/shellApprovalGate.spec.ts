import { describe, expect, it } from 'vitest';
import { resolveShellApprovalGate, type GthConfig } from '#src/config.js';
import { StatusLevel } from '#src/core/types.js';

/**
 * EXT-52 — `resolveShellApprovalGate` is the ONE shell approval-gate policy both backends read
 * (GthLangChainAgent installs `humanInTheLoopMiddleware` from it, GthDeepAgent passes deepagents
 * an `interruptOn` from it). These pin the decision AND the exact user-facing notice copy, so the
 * two backends cannot drift apart again.
 */
type PolicyConfig = Pick<GthConfig, 'commands' | 'builtInTools' | 'askWriteMode' | 'approvals'>;

const config = (partial: Partial<PolicyConfig>): PolicyConfig => partial as PolicyConfig;

const GATED_NOTICE = (rung: string) =>
  `Shell tool (run_shell_command) enabled with per-command approval (approvals: ${rung}).`;
const RATED_NOTICE = (rung: string, tail: string) =>
  `Shell tool (run_shell_command) rated by the auto-rater (approvals: ${rung}); ` +
  `anything it does not rate safe is still ${tail}`;
const BYPASS_NOTICE =
  'Shell tool (run_shell_command): commands run without asking and without rating ' +
  '(approvals: bypass). Only your deny list still applies — type /approvals assisted to ' +
  'rate commands again.';

describe('resolveShellApprovalGate (EXT-52 shared gate policy, CFG-27 ladder)', () => {
  describe('shell tool disabled — nothing gated, nothing announced', () => {
    it('a non-dev-tools command (chat) carries no shell tool at all', () => {
      expect(resolveShellApprovalGate(config({}), 'chat')).toEqual({ gateShell: false });
    });

    it('code mode with the explicit `run_shell_command: false` escape hatch', () => {
      expect(
        resolveShellApprovalGate(config({ builtInTools: { run_shell_command: false } }), 'code')
      ).toEqual({ gateShell: false });
    });

    it('exec mode without an explicit opt-in (the shell default is code-only)', () => {
      expect(resolveShellApprovalGate(config({}), 'exec')).toEqual({ gateShell: false });
    });

    it('no config at all, on a non-dev-tools command', () => {
      expect(resolveShellApprovalGate(undefined, 'chat')).toEqual({ gateShell: false });
    });
  });

  describe('gated — the per-command approval interrupt is wired', () => {
    it('code mode by default: the default rung is assisted, so the notice names the rater', () => {
      const expected = {
        gateShell: true,
        notice: {
          level: StatusLevel.INFO,
          message: RATED_NOTICE('assisted', 'refused or escalated to you.'),
        },
      };
      expect(resolveShellApprovalGate(config({}), 'code')).toEqual(expected);
      // Same for an absent config: the code-mode shell default is resolved downstream of it.
      expect(resolveShellApprovalGate(undefined, 'code')).toEqual(expected);
    });

    /**
     * **The two rated rungs get the SAME tail, and one shared assertion is what keeps it that way.**
     * *"Refused or escalated to you"* is a true disjunction at both, and it is the whole of what
     * this startup line promises: nothing the rater does not clear simply runs. The rungs reach it
     * differently — at `assisted` a `destructive` outcome goes to the human, at `auto`
     * ([[EXT-29]] §5) it is refused back to the agent first and reaches the human when a bound is
     * spent — and the tail covers both without claiming either shape.
     *
     * The line a user meets while working out what their config does is the wrong place to draw
     * that distinction: it has to hold for the whole session, and at `auto` both halves happen. A
     * per-rung expectation here is what let an earlier split in, so this asserts one tail across
     * both.
     */
    it.each(['assisted', 'auto'] as const)(
      'the rated rung %s announces the same outcome: refused or escalated to you',
      (rung) => {
        expect(resolveShellApprovalGate(config({ approvals: rung }), 'code')).toEqual({
          gateShell: true,
          notice: {
            level: StatusLevel.INFO,
            message: RATED_NOTICE(rung, 'refused or escalated to you.'),
          },
        });
      }
    );

    it.each(['manual', 'write'] as const)(
      'the unrated rung %s gates with the per-command prompt notice',
      (rung) => {
        expect(resolveShellApprovalGate(config({ approvals: rung }), 'code')).toEqual({
          gateShell: true,
          notice: { level: StatusLevel.INFO, message: GATED_NOTICE(rung) },
        });
      }
    );

    // §9.1 — the per-command value replaces the fields it NAMES, and `mode` is one of them, so the
    // gate is resolved from the command's rung. The three rule lists concatenate instead (pinned in
    // approvalsConfig.spec.ts); this gate reads only the rung, so they cannot reach it.
    it('a per-command approvals value sets the rung this gate reports', () => {
      expect(
        resolveShellApprovalGate(
          config({
            approvals: 'bypass',
            commands: { code: { approvals: 'write' } },
          } as Partial<PolicyConfig>),
          'code'
        )
      ).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: GATED_NOTICE('write') },
      });
    });

    it('exec mode when the shell tool is explicitly enabled', () => {
      expect(
        resolveShellApprovalGate(
          config({ approvals: 'write', builtInTools: { run_shell_command: true } }),
          'exec'
        )
      ).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: GATED_NOTICE('write') },
      });
    });

    it('reads the per-command builtInTools registry, not just the root one', () => {
      expect(
        resolveShellApprovalGate(
          config({
            approvals: 'write',
            builtInTools: { run_shell_command: false },
            commands: { exec: { builtInTools: { run_shell_command: true } } },
          } as Partial<PolicyConfig>),
          'exec'
        )
      ).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: GATED_NOTICE('write') },
      });
    });
  });

  /**
   * CFG-27 — `bypass` is GATED TOO, in every context. CFG-26 left the tool ungated under bypass
   * outside interactive `code`, which the ladder cannot afford: §2.5 makes the declared deny list
   * the one check `bypass` keeps, and a deny entry can only fire if the call reaches
   * `decideToolApproval` — an ungated call never does.
   */
  describe('bypass — gated in EVERY context, so the deny list can still fire', () => {
    it.each(['code', 'exec'] as const)('%s keeps the gate under bypass', (command) => {
      expect(
        resolveShellApprovalGate(
          config({ approvals: 'bypass', builtInTools: { run_shell_command: { enabled: true } } }),
          command
        )
      ).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.WARNING, message: BYPASS_NOTICE },
      });
    });

    it('`ask --write` behaves the same', () => {
      expect(
        resolveShellApprovalGate(
          config({
            askWriteMode: true,
            approvals: 'bypass',
            builtInTools: { run_shell_command: { enabled: true } },
          }),
          'ask'
        )
      ).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.WARNING, message: BYPASS_NOTICE },
      });
    });

    it('§8.1 — no notice advertises the hardline floor; the bypass one cites the deny list', () => {
      for (const rung of ['manual', 'write', 'assisted', 'auto', 'bypass'] as const) {
        const { notice } = resolveShellApprovalGate(
          config({ approvals: rung, builtInTools: { run_shell_command: true } }),
          'code'
        );
        expect(notice?.message).not.toMatch(/hardline|floor|blocklist/i);
      }
      expect(BYPASS_NOTICE).toContain('deny list');
    });
  });
});
