import { describe, expect, it } from 'vitest';
import { commandSegments } from '#src/core/shell/denylist.js';
import { resolveApprovalRules } from '#src/core/approvals/matcher.js';
import type { ApprovalEntry } from '#src/config/shell-policy.js';

/**
 * EXT-71 §3.1 — **the fail direction, and the segmentation that delivers it.**
 *
 * An allow entry never matches a command that does not statically resolve, which is what stops a
 * grant being extended with a `; rm -rf /`. A deny (or escalate) entry must do the opposite: it is
 * compared against every segment a shell would run, because a prohibition that any trailing `; ls`
 * defeats is not a prohibition.
 *
 * Both halves are asserted here through the ONE comparison engine (`resolveApprovalRules`), which
 * is the only thing that compares anything. `commandSegments` is tested directly as the input that
 * engine's restrictive side depends on.
 */
describe('commandSegments', () => {
  it.each([
    ['a; b', ['a', 'b']],
    ['a && b', ['a', 'b']],
    ['a || b', ['a', 'b']],
    ['a | b', ['a', 'b']],
    ['a\nb', ['a', 'b']],
    ['a\r\nb', ['a', 'b']],
    ['echo $(npm publish)', ['echo', 'npm publish']],
    ['echo `npm publish`', ['echo', 'npm publish']],
  ])('splits %j at every point a shell would start a new command', (command, expected) => {
    expect(commandSegments(command)).toEqual(expected);
  });

  it('normalizes, and leaves a single command as one segment', () => {
    expect(commandSegments('  npm   publish  ')).toEqual(['npm publish']);
  });

  it('preserves case, because the matcher decides per list whether to fold it', () => {
    expect(commandSegments('NPM Publish')).toEqual(['NPM Publish']);
  });
});

describe('a deny entry still bites inside a compound command (§3.1)', () => {
  const DENY: ApprovalEntry[] = [
    { type: 'shell', matcher: 'glob', pattern: 'git push --force*' },
    { type: 'shell', matcher: 'exact', pattern: 'npm publish' },
  ];
  const decide = (command: string, list: 'deny' | 'allow') =>
    resolveApprovalRules(
      { kind: 'shell', command },
      { allow: list === 'allow' ? DENY : [], deny: list === 'deny' ? DENY : [], escalate: [] }
    );

  it.each([
    'git push --force; ls',
    'ls && git push --force',
    'ls; npm publish; echo done',
    'npm test || npm publish',
    'ls\nnpm publish',
    'echo $(npm publish)',
    'echo `npm publish`',
  ])('refuses: %s', (command) => {
    expect(decide(command, 'deny')?.action).toBe('deny');
  });

  it('control — a compound command whose every segment is innocent is not refused', () => {
    expect(decide('ls && git status', 'deny')).toBeNull();
  });

  it('...where the ALLOW side deliberately refuses to match the same commands', () => {
    // Documenting the asymmetry, not a defect: a non-match on the allow side costs a prompt, and a
    // non-match on the deny side would cost an execution. Same entries, opposite fail direction.
    for (const command of ['git push --force; ls', 'echo $(npm publish)']) {
      expect(decide(command, 'allow')).toBeNull();
    }
    // Control: the plain command the entry is for DOES match on the allow side.
    expect(decide('npm publish', 'allow')?.action).toBe('allow');
  });
});
