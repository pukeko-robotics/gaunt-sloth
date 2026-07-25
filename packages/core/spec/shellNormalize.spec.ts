import { describe, expect, it } from 'vitest';
import { normalizeCommand } from '#src/core/shell/normalize.js';

describe('normalizeCommand', () => {
  it('folds runs of HORIZONTAL whitespace and trims', () => {
    expect(normalizeCommand('  rm    -rf   /  ')).toBe('rm -rf /');
    // EXT-55: a tab is horizontal whitespace and still folds to a space, but the newline is a
    // COMMAND SEPARATOR and must survive (this assertion previously read 'echo hi there', which
    // is exactly the bug: it let `ls\nrm -rf /` be read as the single command `ls`).
    expect(normalizeCommand('echo\thi\nthere')).toBe('echo hi\nthere');
  });

  it('collapses backslash-escapes (r\\m -> rm)', () => {
    expect(normalizeCommand('r\\m -rf /')).toBe('rm -rf /');
    expect(normalizeCommand('\\r\\m -rf /')).toBe('rm -rf /');
  });

  it('drops empty-string literals that split a token', () => {
    expect(normalizeCommand("r''m -rf /")).toBe('rm -rf /');
    expect(normalizeCommand('r""m -rf /')).toBe('rm -rf /');
  });

  it('folds fullwidth Unicode to ASCII (NFKC)', () => {
    // Fullwidth "rm" -> ascii "rm"
    expect(normalizeCommand('ｒｍ -rf /')).toBe('rm -rf /');
  });

  it('strips null bytes', () => {
    expect(normalizeCommand('rm\x00 -rf /')).toBe('rm -rf /');
  });

  it('strips ANSI CSI escape sequences', () => {
    expect(normalizeCommand('\x1b[31mrm\x1b[0m -rf /')).toBe('rm -rf /');
  });

  it('leaves a benign command intact', () => {
    expect(normalizeCommand('git status')).toBe('git status');
  });
});

/**
 * EXT-55 — a line break is a command separator, exactly like `;`. Before this node
 * `normalizeCommand` folded it to a SPACE, which erased the command boundary and let every
 * consumer (allow-list classifier, ambiguity fail-close, hardline floor) read `ls\nrm -rf /`
 * as the single command `ls`.
 */
describe('normalizeCommand — line breaks are separators (EXT-55)', () => {
  it('preserves a newline instead of folding it to a space', () => {
    expect(normalizeCommand('ls -la\nrm -rf /')).toBe('ls -la\nrm -rf /');
  });

  it('canonicalises a lone CR to LF', () => {
    expect(normalizeCommand('ls -la\rrm -rf /')).toBe('ls -la\nrm -rf /');
  });

  it('canonicalises CRLF to a single LF', () => {
    expect(normalizeCommand('ls -la\r\nrm -rf /')).toBe('ls -la\nrm -rf /');
  });

  it('collapses a run of line breaks (and surrounding spaces) to a single LF', () => {
    expect(normalizeCommand('ls \n\n  \n\t rm -rf /')).toBe('ls\nrm -rf /');
    expect(normalizeCommand('ls\r\n\r\nrm -rf /')).toBe('ls\nrm -rf /');
  });

  it('still TRIMS leading/trailing line breaks (a trailing \\n must not make a command ambiguous)', () => {
    // Models routinely emit a trailing newline on the tool argument; that is one command, not two.
    expect(normalizeCommand('ls -la\n')).toBe('ls -la');
    expect(normalizeCommand('ls -la\r\n')).toBe('ls -la');
    expect(normalizeCommand('\nls -la\n')).toBe('ls -la');
    expect(normalizeCommand('ls -la\n\n')).toBe('ls -la');
    expect(normalizeCommand('\n\n')).toBe('');
  });

  it('does NOT join a backslash line-continuation (the boundary stays, fail-closed)', () => {
    // `\` + newline is a shell line continuation, but folding it would re-open the same hole for
    // `ls \<newline>rm -rf /`. EXT-55 keeps the break so the command is categorically ambiguous.
    expect(normalizeCommand('ls \\\n-la')).toContain('\n');
  });
});
