import { describe, expect, it } from 'vitest';
import {
  PASTE_START,
  PASTE_END,
  normalizePastedText,
  parsePasteChunk,
  createPasteParser,
} from '#src/tui/pasteParser.js';

const wrap = (body: string): string => PASTE_START + body + PASTE_END;

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

  it('leaves LF-only and single-line text unchanged', () => {
    expect(normalizePastedText('a\nb\nc')).toBe('a\nb\nc');
    expect(normalizePastedText('just one line')).toBe('just one line');
  });

  it('is idempotent', () => {
    const once = normalizePastedText('x\r\ny\rz');
    expect(normalizePastedText(once)).toBe(once);
  });
});

describe('tui pasteParser — parsePasteChunk (pure, single call) (TUI-C24)', () => {
  it('extracts a complete paste sequence in one chunk (markers dropped)', () => {
    const r = parsePasteChunk('', wrap('hello world'));
    expect(r.pastes).toEqual(['hello world']);
    expect(r.passthrough).toBe('');
    expect(r.pending).toBe('');
  });

  it('preserves a multiline payload', () => {
    const r = parsePasteChunk('', wrap('line one\nline two\nline three'));
    expect(r.pastes).toEqual(['line one\nline two\nline three']);
  });

  it('normalizes CRLF inside the payload to LF', () => {
    const r = parsePasteChunk('', wrap('a\r\nb\rc'));
    expect(r.pastes).toEqual(['a\nb\nc']);
  });

  it('passes typed-only input straight through', () => {
    const r = parsePasteChunk('', 'plain typed text');
    expect(r.pastes).toEqual([]);
    expect(r.passthrough).toBe('plain typed text');
    expect(r.pending).toBe('');
  });

  it('separates typed bytes before AND after a paste burst (mixed content)', () => {
    const r = parsePasteChunk('', 'before ' + wrap('PASTED') + ' after');
    expect(r.pastes).toEqual(['PASTED']);
    expect(r.passthrough).toBe('before  after');
    expect(r.pending).toBe('');
  });

  it('handles multiple pastes with interleaved typed content in one chunk', () => {
    const r = parsePasteChunk('', wrap('a') + ' mid ' + wrap('b'));
    expect(r.pastes).toEqual(['a', 'b']);
    expect(r.passthrough).toBe(' mid ');
    expect(r.pending).toBe('');
  });

  it('retains an unterminated paste as pending (end marker not yet seen)', () => {
    const r = parsePasteChunk('', PASTE_START + 'partial body so far');
    expect(r.pastes).toEqual([]);
    expect(r.passthrough).toBe('');
    expect(r.pending).toBe(PASTE_START + 'partial body so far');
  });

  it('holds back a start marker split at the tail as pending, not passthrough', () => {
    const r = parsePasteChunk('', 'typed\x1b[20');
    expect(r.passthrough).toBe('typed');
    expect(r.pending).toBe('\x1b[20');
    expect(r.pastes).toEqual([]);
  });
});

describe('tui pasteParser — createPasteParser (stateful, across chunks) (TUI-C24)', () => {
  it('assembles a start marker split across chunks', () => {
    const p = createPasteParser();
    expect(p.push('\x1b[20')).toEqual({ pastes: [], passthrough: '' });
    expect(p.pending).toBe('\x1b[20');
    expect(p.push('0~hi there\x1b[201~')).toEqual({ pastes: ['hi there'], passthrough: '' });
    expect(p.pending).toBe('');
  });

  it('assembles a body + end marker split across chunks (start in the first chunk)', () => {
    const p = createPasteParser();
    expect(p.push(PASTE_START + 'alpha\nbe')).toEqual({ pastes: [], passthrough: '' });
    expect(p.push('ta\ngamma\x1b[201~')).toEqual({
      pastes: ['alpha\nbeta\ngamma'],
      passthrough: '',
    });
  });

  it('assembles an end marker split across chunks', () => {
    const p = createPasteParser();
    expect(p.push(PASTE_START + 'payload\x1b[201')).toEqual({ pastes: [], passthrough: '' });
    expect(p.pending).toBe(PASTE_START + 'payload\x1b[201');
    expect(p.push('~')).toEqual({ pastes: ['payload'], passthrough: '' });
  });

  it('surfaces typed content that arrives before a later-chunk paste', () => {
    const p = createPasteParser();
    expect(p.push('abc')).toEqual({ pastes: [], passthrough: 'abc' });
    expect(p.push(wrap('X') + 'def')).toEqual({ pastes: ['X'], passthrough: 'def' });
  });

  it('releases a held marker prefix as passthrough when it turns out not to be a paste', () => {
    const p = createPasteParser();
    // Looks like the start of a marker...
    expect(p.push('\x1b[200')).toEqual({ pastes: [], passthrough: '' });
    expect(p.pending).toBe('\x1b[200');
    // ...but the next byte breaks the marker, so the whole run is ordinary typed input.
    expect(p.push('X')).toEqual({ pastes: [], passthrough: '\x1b[200X' });
    expect(p.pending).toBe('');
  });

  it('reset() discards retained pending', () => {
    const p = createPasteParser();
    p.push(PASTE_START + 'dangling');
    expect(p.pending).not.toBe('');
    p.reset();
    expect(p.pending).toBe('');
  });
});
