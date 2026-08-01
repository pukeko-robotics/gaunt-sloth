import { describe, expect, it } from 'vitest';
import { DenylistStore, matchesDenylist } from '#src/core/shell/denylist.js';
import { matchesApproval } from '#src/core/shell/allowlist.js';
import { AllowlistStore } from '#src/core/shell/allowlist.js';

/**
 * CFG-27 §3 — the deny list.
 *
 * The whole reason this matcher exists separately from `matchesApproval` is the FAIL DIRECTION.
 * The allow-list resolves a command through `classifyCommand`, which returns null for anything
 * that composes / substitutes / redirects. For ALLOW that is fail-closed and right: an
 * unclassifiable command matches nothing and gets no free pass. Reuse it for DENY and the same
 * code fails OPEN — `git push --force; ls` would match no entry and sail past a declared
 * a declared deny entry for `git push --force`. The first describe block pins exactly that.
 */
describe('matchesDenylist', () => {
  const DENY = ['git push --force', 'npm publish'];

  it('matches a plain command', () => {
    expect(matchesDenylist('npm publish', DENY)).toBe('npm publish');
    expect(matchesDenylist('git push --force origin main', DENY)).toBe('git push --force');
  });

  it('returns null when nothing is declared, or nothing matches', () => {
    expect(matchesDenylist('npm publish', [])).toBeNull();
    expect(matchesDenylist('npm test', DENY)).toBeNull();
    expect(matchesDenylist('git push origin main', DENY)).toBeNull();
  });

  describe('the fail-direction that justifies a separate matcher', () => {
    const COMPOSED = [
      'git push --force; ls',
      'ls && git push --force',
      'ls; npm publish; echo done',
      'npm test || npm publish',
      'ls\nnpm publish',
      'echo $(npm publish)',
      'echo `npm publish`',
    ];

    it.each(COMPOSED)('still matches inside a composed command: %s', (command) => {
      expect(matchesDenylist(command, DENY)).not.toBeNull();
    });

    it('...where the ALLOW-list matcher deliberately would not (that is why it is not reused)', () => {
      // Documenting the contrast, not asserting a defect: `matchesApproval` returning false for
      // these is correct FOR ALLOW and catastrophic for DENY.
      const stores = { session: new AllowlistStore() };
      stores.session.add('git push');
      expect(matchesApproval('git push --force; ls', stores)).toBe(false);
    });
  });

  it('matches token-aligned only — a longer flag or command is a different command', () => {
    expect(matchesDenylist('git push --force-with-lease', ['git push --force'])).toBeNull();
    expect(matchesDenylist('npm publish-please', ['npm publish'])).toBeNull();
    expect(matchesDenylist('npm publish', ['npm publish'])).toBe('npm publish');
  });

  it('normalizes before matching, so padding/obfuscation does not evade an entry', () => {
    expect(matchesDenylist('npm   publish', ['npm publish'])).toBe('npm publish');
    expect(matchesDenylist('NPM PUBLISH', ['npm publish'])).toBe('npm publish');
    expect(matchesDenylist('npm publish', ['  npm   publish  '])).toBe('  npm   publish  ');
  });

  it('returns the entry AS DECLARED, so the refusal can quote the user back to themselves', () => {
    expect(matchesDenylist('NPM Publish --tag beta', ['npm publish'])).toBe('npm publish');
  });

  it('ignores blank entries rather than matching everything', () => {
    expect(matchesDenylist('ls -la', ['', '   '])).toBeNull();
  });
});

describe('DenylistStore', () => {
  it('seeds from the declared config list and matches through it', () => {
    const store = new DenylistStore(['npm publish']);
    expect(store.match('npm publish --tag beta')).toBe('npm publish');
    expect(store.match('npm test')).toBeNull();
  });

  it('merges runtime additions (the escalation menu\'s "always reject") idempotently', () => {
    const store = new DenylistStore(['npm publish']);
    store.add('git push --force');
    store.add('git push --force');
    store.add('  ');
    expect(store.list()).toEqual(['npm publish', 'git push --force']);
    expect(store.match('git push --force origin main')).toBe('git push --force');
  });

  it('is per-instance, so concurrent sessions cannot stomp each other', () => {
    const a = new DenylistStore(['npm publish']);
    const b = new DenylistStore();
    a.add('rm -rf');
    expect(b.list()).toEqual([]);
  });
});
