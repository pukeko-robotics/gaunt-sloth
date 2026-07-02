import { describe, expect, it } from 'vitest';
import { parseJsonc } from '#src/config/jsonc.js';

describe('parseJsonc (GS2-1 JSONC config support)', () => {
  it('parses plain JSON unchanged', () => {
    expect(parseJsonc('{"llm": {"type": "openai"}}')).toEqual({ llm: { type: 'openai' } });
  });

  it('allows line and block comments', () => {
    const text = `{
      // the provider to use
      "llm": { "type": "anthropic" },
      /* a block comment
         spanning lines */
      "streamOutput": true
    }`;
    expect(parseJsonc(text)).toEqual({ llm: { type: 'anthropic' }, streamOutput: true });
  });

  it('allows trailing commas in objects and arrays', () => {
    const text = `{
      "llm": { "type": "openai", },
      "allowDirs": ["a", "b",],
    }`;
    expect(parseJsonc(text)).toEqual({ llm: { type: 'openai' }, allowDirs: ['a', 'b'] });
  });

  it('does NOT treat // or /* inside string values as comments', () => {
    const text = '{"contentSource": "https://example.com/x", "note": "a /* b"}';
    expect(parseJsonc(text)).toEqual({
      contentSource: 'https://example.com/x',
      note: 'a /* b',
    });
  });

  it('throws a clear, located SyntaxError on malformed input', () => {
    // Missing the closing brace for llm.
    expect(() => parseJsonc('{"llm": {"type": "openai" ', '.gsloth.config.json')).toThrow(
      /Invalid JSON\/JSONC in \.gsloth\.config\.json/
    );
  });

  it('reports the offset of the first error', () => {
    try {
      parseJsonc('{"a": 1 "b": 2}');
      throw new Error('expected parseJsonc to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SyntaxError);
      expect((e as Error).message).toMatch(/at offset \d+/);
    }
  });
});
