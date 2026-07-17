import { describe, expect, it } from 'vitest';

describe('bindCellContent', () => {
  it('passes content through unchanged when no row is supplied', async () => {
    const { bindCellContent } = await import('#src/interpolate.js');
    expect(bindCellContent('Do the thing.', undefined)).toEqual('Do the thing.');
  });

  it('substitutes {{field}} placeholders from the row', async () => {
    const { bindCellContent } = await import('#src/interpolate.js');
    const result = bindCellContent('Translate "{{text}}" into {{lang}}.', {
      text: 'hello',
      lang: 'French',
    });
    expect(result).toEqual('Translate "hello" into French.');
  });

  it('tolerates whitespace inside the braces', async () => {
    const { bindCellContent } = await import('#src/interpolate.js');
    const result = bindCellContent('Hello {{ name }}!', { name: 'Ada' });
    expect(result).toEqual('Hello Ada!');
  });

  it('leaves a placeholder untouched when the row has no matching field', async () => {
    const { bindCellContent } = await import('#src/interpolate.js');
    const result = bindCellContent('Hello {{name}}, id {{missing}}.', { name: 'Ada' });
    expect(result).toEqual('Hello Ada, id {{missing}}.');
  });

  it('appends the row as a fenced context block when the script has no placeholders', async () => {
    const { bindCellContent } = await import('#src/interpolate.js');
    const result = bindCellContent('Summarize the attached data.', {
      id: '42',
      category: 'widgets',
    });
    expect(result).toContain('Summarize the attached data.');
    expect(result).toContain('<batch-row>');
    expect(result).toContain('id: 42');
    expect(result).toContain('category: widgets');
    expect(result).toContain('</batch-row>');
  });

  it('does not append a context block when at least one placeholder matched', async () => {
    const { bindCellContent } = await import('#src/interpolate.js');
    const result = bindCellContent('Hello {{name}}.', { name: 'Ada', extra: 'unused' });
    expect(result).not.toContain('<batch-row>');
  });
});
