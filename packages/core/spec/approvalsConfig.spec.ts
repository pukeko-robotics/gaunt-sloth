import { describe, expect, it } from 'vitest';
import {
  APPROVAL_RUNG_DESCRIPTIONS,
  APPROVAL_RUNG_LABELS,
  APPROVAL_RUNGS,
  DEFAULT_APPROVAL_RUNG,
  isApprovalRung,
  isRatedRung,
  resolveApprovals,
} from '#src/config/shell-policy.js';
import type { GthCommand } from '#src/core/types.js';

/**
 * CFG-27 — `resolveApprovals` is the ONE place the `approvals` value is turned into a posture.
 *
 * There is deliberately NO context matrix left to pin: §1.1 makes `auto-safe` the default in
 * EVERY context, interactive or not, and it does not vary with the configured model. What varies
 * without a human is what an escalation DOES (§6.2 — the runner exits instead of prompting), not
 * which rung the session starts on. So the resolver neither detects nor accepts a "context", and
 * these tests pin that absence as hard as they pin the precedence rules.
 */
type ApprovalsInput = Parameters<typeof resolveApprovals>[0];

const ALL_COMMANDS: readonly GthCommand[] = ['code', 'chat', 'exec', 'ask', 'review', 'pr', 'api'];

describe('resolveApprovals (CFG-27 ladder)', () => {
  describe('§1.1 — the default rung is auto-safe, everywhere', () => {
    it.each(ALL_COMMANDS)('%s with no `approvals` key resolves to auto-safe', (command) => {
      expect(resolveApprovals(undefined, command)).toEqual({
        rung: 'auto-safe',
        rater: undefined,
        allow: [],
        deny: [],
      });
    });

    it('is auto-safe for an unknown/absent command too', () => {
      expect(resolveApprovals(undefined, undefined).rung).toBe('auto-safe');
      expect(DEFAULT_APPROVAL_RUNG).toBe('auto-safe');
    });

    it('takes no context/TTY argument at all — there is no second default to disagree with', () => {
      // The resolver's arity is (config, command). A third "interactive" parameter is exactly the
      // hidden branching the ladder exists to remove.
      expect(resolveApprovals.length).toBe(2);
    });
  });

  describe('§9.1 — the scalar form is exactly sugar for { mode: <value> }', () => {
    it.each(APPROVAL_RUNGS)(
      '"%s" resolves identically written as a scalar or an object',
      (rung) => {
        const scalar = resolveApprovals({ approvals: rung } as ApprovalsInput, 'code');
        const object = resolveApprovals({ approvals: { mode: rung } } as ApprovalsInput, 'code');
        expect(scalar).toEqual(object);
        expect(scalar.rung).toBe(rung);
      }
    );
  });

  describe('precedence', () => {
    it('a per-command value REPLACES the root one wholesale', () => {
      const resolved = resolveApprovals(
        {
          approvals: { mode: 'bypass', allow: ['npm test'], deny: ['npm publish'] },
          commands: { pr: { approvals: 'read-only' } },
        } as unknown as ApprovalsInput,
        'pr'
      );
      expect(resolved.rung).toBe('read-only');
      // The root value's lists came from the REPLACED value, so they do not leak through.
      expect(resolved.allow).toEqual([]);
      expect(resolved.deny).toEqual([]);
    });

    it('a per-command scalar override resolves wholesale (the §9 example)', () => {
      const config = {
        approvals: 'full-auto',
        commands: { pr: { approvals: 'read-only' }, review: { approvals: 'read-only' } },
      } as unknown as ApprovalsInput;
      expect(resolveApprovals(config, 'pr').rung).toBe('read-only');
      expect(resolveApprovals(config, 'review').rung).toBe('read-only');
      expect(resolveApprovals(config, 'code').rung).toBe('full-auto');
    });

    it('a root value applies to a one-shot command too — the default is defaults ONLY', () => {
      expect(resolveApprovals({ approvals: 'bypass' } as ApprovalsInput, 'exec').rung).toBe(
        'bypass'
      );
    });
  });

  describe('§9.1 — rater is a bare profile name; allow/deny are read-only input', () => {
    it('carries the rater profile through as a plain string', () => {
      const resolved = resolveApprovals(
        { approvals: { mode: 'auto-safe', rater: 'safety-rater' } } as ApprovalsInput,
        'code'
      );
      expect(resolved.rater).toBe('safety-rater');
    });

    it('carries the declared allow and deny lists through', () => {
      const resolved = resolveApprovals(
        {
          approvals: {
            mode: 'auto-safe',
            allow: ['npm test', 'git status'],
            deny: ['git push --force', 'npm publish'],
          },
        } as ApprovalsInput,
        'code'
      );
      expect(resolved.allow).toEqual(['npm test', 'git status']);
      expect(resolved.deny).toEqual(['git push --force', 'npm publish']);
    });
  });

  describe('the rung vocabulary', () => {
    it('is exactly the five ordered rungs', () => {
      expect([...APPROVAL_RUNGS]).toEqual([
        'read-only',
        'write',
        'auto-safe',
        'full-auto',
        'bypass',
      ]);
    });

    it('rates at auto-safe and full-auto only — rungs 1, 2 and 5 consult no model', () => {
      expect(APPROVAL_RUNGS.filter(isRatedRung)).toEqual(['auto-safe', 'full-auto']);
    });

    it('recognises only the five kebab-case identifiers (the retired ones are not aliases)', () => {
      for (const rung of APPROVAL_RUNGS) expect(isApprovalRung(rung)).toBe(true);
      for (const retired of ['auto', 'ask', 'yolo', 'Read only', '']) {
        expect(isApprovalRung(retired)).toBe(false);
      }
    });

    it('§9.1 — identifiers are kebab-case and survive a shell; labels keep their spaces', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(rung).toMatch(/^[a-z]+(-[a-z]+)*$/);
        expect(APPROVAL_RUNG_LABELS[rung]).toBeTruthy();
      }
      expect(APPROVAL_RUNG_LABELS['read-only']).toBe('Read only');
      expect(APPROVAL_RUNG_LABELS['auto-safe']).toBe('Auto safe');
      expect(APPROVAL_RUNG_LABELS['full-auto']).toBe('Full auto');
    });
  });

  /**
   * §10 — the five descriptions are copied verbatim from the specification and their wording is
   * constrained by four normative rules plus §8.1. These pin the CONSTRAINTS, not the prose, so a
   * well-meaning edit that breaks one of them fails here rather than in review.
   */
  describe('§10 — the user-facing descriptions', () => {
    it('rule 1: auto-safe states that files are STILL rewritten and deleted without asking', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['auto-safe'];
      expect(text).toContain('rewrite and delete files in your working folder without asking');
      expect(text).toContain('not that nothing changes');
    });

    it('rule 2: every rung that asks for approval states the always-allow carve-out', () => {
      for (const rung of ['read-only', 'write'] as const) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).toContain(
          'until you tell it to always allow a command'
        );
      }
    });

    it('rule 3: full-auto is safer than bypass and explicitly NOT safe, and points at real gates', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['full-auto'];
      expect(text).toContain('safer than bypass');
      expect(text).toContain('it is not safe');
      expect(text).toContain('deployment approvals, two-factor, branch protection');
    });

    /**
     * Rule 3 again, on the half that went stale: what this rung claims the rater still DOES has to
     * be a claim the rater is specified to keep. It names the four structural `attack` tests (§4.1.1)
     * and the §6.1 irreversibility question — not an outcome. The clause it replaced promised a halt
     * on "anything that would send your secrets off the machine", which §11.1b's narrowing made
     * false: a secret handed to a working tool rates `destructive`, so it comes to the user rather
     * than ending the run. A description may only promise what the scale actually delivers.
     */
    it('rule 3: full-auto describes what the rater tests for, not an outcome it cannot guarantee', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['full-auto'];
      expect(text).toContain('brings anything it cannot undo to you');
      expect(text).toContain('reads your keys or passwords');
    });

    it('§8.1: no description advertises the hardline floor — only the deny list is cited', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).not.toMatch(/hardline|floor|blocklist/i);
      }
      expect(APPROVAL_RUNG_DESCRIPTIONS.bypass).toContain('deny list');
      expect(APPROVAL_RUNG_DESCRIPTIONS['full-auto']).toContain('deny list');
    });

    it('rule 4: the kebab-case identifiers never appear in the prose', () => {
      for (const rung of APPROVAL_RUNGS) {
        for (const identifier of ['read-only', 'auto-safe', 'full-auto']) {
          expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).not.toContain(identifier);
        }
      }
    });

    it('every rung has one', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung].length).toBeGreaterThan(40);
      }
    });
  });
});
