import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthCommand } from '#src/core/types.js';

/**
 * CFG-26 — `resolveApprovals` is the ONE place the `approvals` block meets the defaults matrix.
 * These pin the matrix itself (interactive vs one-shot vs server), the precedence of an explicit
 * config over it, and the rule that auto-mode exists only where the rater does.
 */
const systemUtilsMock = { isTTY: vi.fn() };
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

type ApprovalsInput = Parameters<typeof import('#src/config/shell-policy.js').resolveApprovals>[0];

describe('resolveApprovals (CFG-26 defaults matrix)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.isTTY.mockReturnValue(true);
  });

  const resolve = async (
    config: ApprovalsInput,
    command: GthCommand | undefined,
    options?: { interactive?: boolean }
  ) => {
    const { resolveApprovals } = await import('#src/config/shell-policy.js');
    return resolveApprovals(config, command, options);
  };

  describe('no `approvals` key — the context defaults', () => {
    it.each(['code', 'chat'] as const)(
      'interactive %s on a TTY: mode auto, rater on (main model), standard/danger',
      async (command) => {
        expect(await resolve(undefined, command)).toEqual({
          mode: 'auto',
          rater: {
            enabled: true,
            profile: undefined,
            strictness: 'standard',
            escalate: 'danger',
          },
          allowlist: true,
          persistAllowlist: true,
        });
      }
    );

    it.each(['exec', 'ask', 'review', 'pr'] as const)(
      'one-shot %s: rater OFF and `ask` semantics (the runner then fail-closed rejects with no handler)',
      async (command) => {
        const resolved = await resolve(undefined, command);
        expect(resolved.mode).toBe('ask');
        expect(resolved.rater.enabled).toBe(false);
      }
    );

    it('AG-UI / ACP servers (api) resolve exactly like a one-shot: rater off, fail-closed ask', async () => {
      const resolved = await resolve(undefined, 'api');
      expect(resolved.mode).toBe('ask');
      expect(resolved.rater.enabled).toBe(false);
    });

    it('an interactive command with NO TTY falls back to the fail-closed row', async () => {
      systemUtilsMock.isTTY.mockReturnValue(false);
      const resolved = await resolve(undefined, 'code');
      expect(resolved.mode).toBe('ask');
      expect(resolved.rater.enabled).toBe(false);
    });

    it('the explicit `interactive` override wins over TTY detection (used by servers/tests)', async () => {
      systemUtilsMock.isTTY.mockReturnValue(true);
      expect((await resolve(undefined, 'code', { interactive: false })).mode).toBe('ask');
      expect((await resolve(undefined, 'exec', { interactive: true })).mode).toBe('auto');
    });
  });

  describe('explicit config beats the matrix', () => {
    it('a root `approvals` block applies to a one-shot command too (the matrix is defaults ONLY)', async () => {
      const resolved = await resolve({ approvals: { mode: 'auto' } } as ApprovalsInput, 'exec');
      expect(resolved.mode).toBe('auto');
      // auto-mode exists only where the rater does: it is on even though `rater` was not written.
      expect(resolved.rater.enabled).toBe(true);
    });

    it('a per-command block REPLACES the root block wholesale', async () => {
      const resolved = await resolve(
        {
          approvals: { mode: 'bypass', allowlist: false },
          commands: { code: { approvals: { mode: 'ask' } } },
        } as ApprovalsInput,
        'code'
      );
      expect(resolved.mode).toBe('ask');
      // `allowlist: false` came from the REPLACED root block, so it does not leak through.
      expect(resolved.allowlist).toBe(true);
    });

    it('carries rater profile / strictness / escalate through', async () => {
      const resolved = await resolve(
        {
          approvals: {
            mode: 'auto',
            rater: { profile: 'safety-rater', strictness: 'strict', escalate: 'caution' },
          },
        } as ApprovalsInput,
        'code'
      );
      expect(resolved.rater).toEqual({
        enabled: true,
        profile: 'safety-rater',
        strictness: 'strict',
        escalate: 'caution',
      });
    });

    it('`rater: false` disables the rater; `rater: true` enables it under ask (advisor)', async () => {
      expect(
        (await resolve({ approvals: { mode: 'ask', rater: false } } as ApprovalsInput, 'code'))
          .rater.enabled
      ).toBe(false);
      expect(
        (await resolve({ approvals: { mode: 'ask', rater: true } } as ApprovalsInput, 'code')).rater
          .enabled
      ).toBe(true);
    });

    it('an `ask` posture with no rater key does NOT pay for a rater call', async () => {
      const resolved = await resolve({ approvals: { mode: 'ask' } } as ApprovalsInput, 'code');
      expect(resolved.rater.enabled).toBe(false);
    });

    it('honours the allow-list knobs in their new home', async () => {
      const resolved = await resolve(
        { approvals: { allowlist: false, persistAllowlist: false } } as ApprovalsInput,
        'code'
      );
      expect(resolved.allowlist).toBe(false);
      expect(resolved.persistAllowlist).toBe(false);
    });
  });
});
