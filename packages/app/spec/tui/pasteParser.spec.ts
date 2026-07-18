import { describe, expect, it } from 'vitest';
import { normalizePastedText } from '#src/tui/pasteParser.js';

describe('tui pasteParser — normalizePastedText (TUI-C24)', () => {
  it('collapses CRLF to LF', () => {
    expect(normalizePastedText('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('collapses a lone CR to LF', () => {
    expect(normalizePastedText('a\rb\rc')).toBe('a\nb\nc');
  });

  it('handles a mix of CRLF, CR and LF consistently', () => {
    expect(normalizePastedText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('preserves an already-normalized multiline payload', () => {
    expect(normalizePastedText('line one\nline two\nline three')).toBe(
      'line one\nline two\nline three'
    );
  });

  it('leaves single-line text unchanged', () => {
    expect(normalizePastedText('just one line')).toBe('just one line');
  });

  it('is idempotent', () => {
    const once = normalizePastedText('x\r\ny\rz');
    expect(normalizePastedText(once)).toBe(once);
  });
});
