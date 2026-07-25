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

const GATED_NOTICE = 'Shell tool (run_shell_command) enabled with per-command approval.';
const RATER_NOTICE =
  'Shell tool (run_shell_command) gated by the AI rater (approvals.mode: auto); ' +
  'risky commands are still escalated to you.';
const BYPASS_GATED_NOTICE =
  'Shell tool (run_shell_command) auto-approved by config (approvals.mode: bypass). ' +
  'Type /approvals ask to require per-command approval.';
const BYPASS_UNGATED_NOTICE =
  'Shell tool (run_shell_command) enabled in bypass mode: commands run WITHOUT confirmation.';

describe('resolveShellApprovalGate (EXT-52 shared gate policy)', () => {
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
    it('code mode by default (shell ON in code, never bypass-by-default) — CFG-26 mode auto', () => {
      // CFG-26 defaults matrix: interactive `code` defaults to `mode: auto`, so the notice names
      // the rater rather than claiming every command will be confirmed.
      expect(resolveShellApprovalGate(config({}), 'code')).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: RATER_NOTICE },
      });
      // Same for an absent config: the code-mode default is resolved downstream of it.
      expect(resolveShellApprovalGate(undefined, 'code')).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: RATER_NOTICE },
      });
    });

    it('an explicit approvals.mode: ask in code mode gates with the per-command prompt notice', () => {
      expect(resolveShellApprovalGate(config({ approvals: { mode: 'ask' } }), 'code')).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: GATED_NOTICE },
      });
    });

    it('a per-command approvals block replaces the root one', () => {
      expect(
        resolveShellApprovalGate(
          config({
            approvals: { mode: 'bypass' },
            commands: { code: { approvals: { mode: 'ask' } } },
          }),
          'code'
        )
      ).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: GATED_NOTICE },
      });
    });

    it('exec mode when the shell tool is explicitly enabled without yolo', () => {
      expect(
        resolveShellApprovalGate(config({ builtInTools: { run_shell_command: true } }), 'exec')
      ).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: GATED_NOTICE },
      });
    });

    it('reads the per-command builtInTools registry, not just the root one', () => {
      expect(
        resolveShellApprovalGate(
          config({
            builtInTools: { run_shell_command: false },
            commands: { exec: { builtInTools: { run_shell_command: true } } },
          } as Partial<PolicyConfig>),
          'exec'
        )
      ).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: GATED_NOTICE },
      });
    });
  });

  describe('bypass in INTERACTIVE code mode — still gated, so /approvals ask can restore prompting', () => {
    it('keeps the gate and announces that config pre-selected bypass', () => {
      expect(resolveShellApprovalGate(config({ approvals: { mode: 'bypass' } }), 'code')).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: BYPASS_GATED_NOTICE },
      });
    });
  });

  describe('bypass in a NON-INTERACTIVE mode — ungated, since a single-shot run drains no interrupts', () => {
    it('exec runs the command inline and warns that nothing will be confirmed', () => {
      expect(
        resolveShellApprovalGate(
          config({
            approvals: { mode: 'bypass' },
            builtInTools: { run_shell_command: { enabled: true } },
          }),
          'exec'
        )
      ).toEqual({
        gateShell: false,
        notice: { level: StatusLevel.WARNING, message: BYPASS_UNGATED_NOTICE },
      });
    });

    it('`ask --write` behaves the same as exec', () => {
      expect(
        resolveShellApprovalGate(
          config({
            askWriteMode: true,
            approvals: { mode: 'bypass' },
            builtInTools: { run_shell_command: { enabled: true } },
          }),
          'ask'
        )
      ).toEqual({
        gateShell: false,
        notice: { level: StatusLevel.WARNING, message: BYPASS_UNGATED_NOTICE },
      });
    });
  });
});
