import { describe, expect, it } from 'vitest';
import { normalizeCommand } from '#src/tools/shell/normalize.js';

describe('normalizeCommand', () => {
  it('folds runs of whitespace and trims', () => {
    expect(normalizeCommand('  rm    -rf   /  ')).toBe('rm -rf /');
    expect(normalizeCommand('echo\thi\nthere')).toBe('echo hi there');
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
