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

/**
 * EXT-55 — a line break must behave EXACTLY like `;`. Before this node `normalizeCommand`
 * folded it to a space, so `classifyCommand('ls -la\nrm -rf /')` returned `{prefix:'ls'}`
 * instead of `null` and the whole approval stack was told the command was `ls`.
 */
describe('classifyCommand — line breaks are separators (EXT-55)', () => {
  // Every separator here must produce the SAME (null) result; `;` is the reference behaviour.
  const separators: ReadonlyArray<readonly [string, string]> = [
    ['; (reference)', ';'],
    ['\\n', '\n'],
    ['\\r', '\r'],
    ['\\r\\n', '\r\n'],
  ];

  it.each(separators)('fails closed on a %s separator', (_label, sep) => {
    expect(classify(`ls -la${sep}rm -rf /`)).toBeNull();
    expect(classify(`git checkout x${sep}rm -rf /`)).toBeNull();
    expect(classify(`ls${sep}sudo rm -rf /etc${sep}ls`)).toBeNull();
  });

  it('fails closed on a backslash line-continuation (boundary is not joined)', () => {
    expect(classify('ls \\\nrm -rf /')).toBeNull();
  });

  it('still classifies a command with only a TRAILING/LEADING line break', () => {
    // A trailing newline is one command, not two — it must not cost an approval prompt.
    for (const cmd of ['ls -la\n', 'ls -la\r\n', '\nls -la', '\nls -la\n']) {
      const c = classify(cmd);
      expect(c, `expected ${JSON.stringify(cmd)} to classify`).not.toBeNull();
      expect(c!.prefix).toBe('ls');
    }
  });

  it('does not delegate the boundary question to the injected normalizer', () => {
    // `normalize` is a parameter, so the classifier must decide "is this more than one command?"
    // itself — a normalizer that folds newlines (the EXT-55 bug) must not re-open the hole.
    const foldsNewlines = (cmd: string) => cmd.replace(/\s+/g, ' ').trim();
    expect(classifyCommand('ls\nrm -rf /', foldsNewlines)).toBeNull();
    expect(classifyCommand('ls\rrm -rf /', foldsNewlines)).toBeNull();
    // …but a trailing newline still classifies under the same normalizer.
    expect(classifyCommand('ls -la\n', foldsNewlines)?.prefix).toBe('ls');
  });

  it('tokenize treats a line break as whitespace (so no token is glued across a line)', () => {
    expect(tokenize('ls\nrm -rf /')).toEqual(['ls', 'rm', '-rf', '/']);
    expect(tokenize('curl\r-o out')).toEqual(['curl', '-o', 'out']);
  });
});
