import { describe, expect, it } from 'vitest';
import { classifyCommand, meaningfulPrefixTokens, tokenize } from '#src/core/shell/arity.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';

const classify = (cmd: string) => classifyCommand(cmd, normalizeCommand);

describe('tokenize', () => {
  it('splits on whitespace and honors quotes', () => {
    expect(tokenize('git commit -m "a b c"')).toEqual(['git', 'commit', '-m', 'a b c']);
    expect(tokenize("echo 'one two'")).toEqual(['echo', 'one two']);
  });

  it('returns null on unbalanced quotes', () => {
    expect(tokenize('echo "unterminated')).toBeNull();
  });
});

describe('meaningfulPrefixTokens', () => {
  it('skips boolean leading flags before resolving the table prefix', () => {
    // `--no-pager` takes no argument, so the subcommand still resolves correctly.
    expect(meaningfulPrefixTokens(['git', '--no-pager', 'checkout', 'main'])).toEqual([
      'git',
      'checkout',
    ]);
  });

  it('conservatively (fail-closed) does not special-case arg-taking flags', () => {
    // We do not maintain a per-flag arity table, so `-C <dir>` leaves `.` in the non-flag
    // stream and the prefix resolves to `git .` rather than `git checkout`. This does not match
    // an approved `git checkout`, so it simply re-prompts (safe) instead of mis-approving.
    expect(meaningfulPrefixTokens(['git', '-C', '.', 'checkout', 'main'])).toEqual(['git', '.']);
  });
});

describe('classifyCommand', () => {
  it('classifies git checkout variants to the same prefix', () => {
    const a = classify('git checkout main');
    const b = classify('git checkout -b foo bar');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.prefix).toBe('git checkout');
    expect(b!.prefix).toBe('git checkout');
    expect(a!.pattern).toBe('git checkout *');
  });

  it('classifies arity-3 commands (npm run dev)', () => {
    const c = classify('npm run dev --silent');
    expect(c).not.toBeNull();
    expect(c!.prefix).toBe('npm run dev');
    expect(c!.pattern).toBe('npm run dev *');
  });

  it('defaults unknown binaries to arity 0 (just the binary)', () => {
    const c = classify('frobnicate --wibble foo bar');
    expect(c).not.toBeNull();
    expect(c!.prefix).toBe('frobnicate');
    expect(c!.pattern).toBe('frobnicate *');
  });

  it('classifies a single-token utility (ls)', () => {
    const c = classify('ls -la /tmp');
    expect(c).not.toBeNull();
    expect(c!.prefix).toBe('ls');
    expect(c!.pattern).toBe('ls *');
  });

  it('fails closed on command separators and composition', () => {
    expect(classify('git checkout x; rm -rf /')).toBeNull();
    expect(classify('git checkout x && rm -rf /')).toBeNull();
    expect(classify('git checkout x || true')).toBeNull();
    expect(classify('cat foo | sh')).toBeNull();
    expect(classify('git status &')).toBeNull();
  });

  it('fails closed on command/process substitution', () => {
    expect(classify('echo $(rm -rf /)')).toBeNull();
    expect(classify('echo `rm -rf /`')).toBeNull();
    expect(classify('diff <(ls) <(ls)')).toBeNull();
    expect(classify('echo ${EVIL}')).toBeNull();
  });

  it('fails closed on redirections', () => {
    expect(classify('echo hi > /etc/passwd')).toBeNull();
    expect(classify('cat < secrets')).toBeNull();
    expect(classify('echo hi >> log')).toBeNull();
  });

  it('returns null on empty / unbalanced commands', () => {
    expect(classify('   ')).toBeNull();
    expect(classify('echo "open')).toBeNull();
  });
});
