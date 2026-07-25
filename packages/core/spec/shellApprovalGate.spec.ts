import { describe, expect, it } from 'vitest';
import { resolveShellApprovalGate, type GthConfig } from '#src/config.js';
import { StatusLevel } from '#src/core/types.js';

/**
 * EXT-52 — `resolveShellApprovalGate` is the ONE shell approval-gate policy both backends read
 * (GthLangChainAgent installs `humanInTheLoopMiddleware` from it, GthDeepAgent passes deepagents
 * an `interruptOn` from it). These pin the decision AND the exact user-facing notice copy, so the
 * two backends cannot drift apart again.
 */
type PolicyConfig = Pick<GthConfig, 'commands' | 'builtInTools' | 'askWriteMode'>;

const config = (partial: Partial<PolicyConfig>): PolicyConfig => partial as PolicyConfig;

const GATED_NOTICE = 'Shell tool (run_shell_command) enabled with per-command approval.';
const AUTO_APPROVED_NOTICE =
  'Shell tool (run_shell_command) auto-approved by config (shellYolo). Type /auto-approve off to require per-command approval.';
const YOLO_NOTICE =
  'Shell tool (run_shell_command) enabled in YOLO mode: commands run WITHOUT confirmation.';

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
    it('code mode by default (shell ON in code, and never yolo-by-default)', () => {
      expect(resolveShellApprovalGate(config({}), 'code')).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: GATED_NOTICE },
      });
      // Same for an absent config: the code-mode default is resolved downstream of it.
      expect(resolveShellApprovalGate(undefined, 'code')).toEqual({
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

  describe('yolo in INTERACTIVE code mode — still gated, so /auto-approve off can restore prompting', () => {
    it('keeps the gate and announces that config pre-enabled auto-approval', () => {
      expect(
        resolveShellApprovalGate(
          config({ builtInTools: { run_shell_command: { yolo: true } } }),
          'code'
        )
      ).toEqual({
        gateShell: true,
        notice: { level: StatusLevel.INFO, message: AUTO_APPROVED_NOTICE },
      });
    });
  });

  describe('yolo in a NON-INTERACTIVE mode — ungated, since a single-shot run drains no interrupts', () => {
    it('exec runs the command inline and warns that nothing will be confirmed', () => {
      expect(
        resolveShellApprovalGate(
          config({ builtInTools: { run_shell_command: { enabled: true, yolo: true } } }),
          'exec'
        )
      ).toEqual({
        gateShell: false,
        notice: { level: StatusLevel.WARNING, message: YOLO_NOTICE },
      });
    });

    it('`ask --write` behaves the same as exec', () => {
      expect(
        resolveShellApprovalGate(
          config({
            askWriteMode: true,
            builtInTools: { run_shell_command: { enabled: true, yolo: true } },
          }),
          'ask'
        )
      ).toEqual({
        gateShell: false,
        notice: { level: StatusLevel.WARNING, message: YOLO_NOTICE },
      });
    });
  });
});
