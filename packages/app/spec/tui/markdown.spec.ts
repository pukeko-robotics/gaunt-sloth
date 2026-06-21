import { beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { renderMarkdown, looksLikeMarkdown } from '#src/tui/markdown.js';

/**
 * Strip ANSI escape codes so assertions can check the rendered *text* structure
 * (bullets, carets, heading content) independently of the colour codes — which are
 * separately asserted by forcing a colour-capable chalk level.
 */
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

describe('tui markdown renderer', () => {
  beforeEach(() => {
    // Force colour so we can assert ANSI is emitted; tests run without a TTY (level 0).
    chalk.level = 3;
  });

  describe('looksLikeMarkdown', () => {
    it('detects markdown-meaningful syntax', () => {
      expect(looksLikeMarkdown('# Heading')).toBe(true);
      expect(looksLikeMarkdown('- a list item')).toBe(true);
      expect(looksLikeMarkdown('1. ordered')).toBe(true);
      expect(looksLikeMarkdown('> quote')).toBe(true);
      expect(looksLikeMarkdown('text with **bold**')).toBe(true);
      expect(looksLikeMarkdown('text with `code`')).toBe(true);
      expect(looksLikeMarkdown('a [link](http://x)')).toBe(true);
      expect(looksLikeMarkdown('```\ncode\n```')).toBe(true);
    });

    it('returns false for plain prose', () => {
      expect(looksLikeMarkdown('Just a normal sentence.')).toBe(false);
      expect(looksLikeMarkdown('Cost is 3 * 4 = 12 maybe')).toBe(false);
      expect(looksLikeMarkdown('')).toBe(false);
    });
  });

  describe('renderMarkdown — plain-text fallback', () => {
    it('returns plain prose unchanged (no styling, no garble)', () => {
      const input = 'This is a plain sentence with no markup.';
      expect(renderMarkdown(input)).toBe(input);
    });

    it('returns empty string unchanged', () => {
      expect(renderMarkdown('')).toBe('');
    });

    it('preserves the full text content even when styled', () => {
      const out = renderMarkdown('# Title\nbody text here');
      expect(stripAnsi(out)).toContain('Title');
      expect(stripAnsi(out)).toContain('body text here');
    });
  });

  describe('renderMarkdown — element types', () => {
    it('renders a heading with ANSI styling', () => {
      const out = renderMarkdown('# Hello');
      expect(stripAnsi(out)).toBe('Hello');
      expect(out).not.toBe('Hello'); // ANSI codes present
      expect(out).toContain('['); // escape sequences emitted
    });

    it('renders bold and italic', () => {
      const bold = renderMarkdown('a **strong** word');
      expect(stripAnsi(bold)).toBe('a strong word');
      expect(bold).toContain('[1m'); // bold open code

      const italic = renderMarkdown('a *soft* word');
      expect(stripAnsi(italic)).toBe('a soft word');
      expect(italic).toContain('[3m'); // italic open code
    });

    it('renders inline code', () => {
      const out = renderMarkdown('use `npm run build` now');
      expect(stripAnsi(out)).toBe('use npm run build now');
      expect(out).toContain('['); // styled
    });

    it('renders an unordered list with bullets', () => {
      const out = stripAnsi(renderMarkdown('- one\n- two'));
      expect(out).toContain('• one');
      expect(out).toContain('• two');
    });

    it('renders an ordered list keeping the numbers', () => {
      const out = stripAnsi(renderMarkdown('1. first\n2. second'));
      expect(out).toContain('1. first');
      expect(out).toContain('2. second');
    });

    it('renders a fenced code block verbatim, dropping the fences', () => {
      const out = stripAnsi(renderMarkdown('```js\nconst x = 1;\n```'));
      expect(out).toContain('const x = 1;');
      expect(out).not.toContain('```');
    });

    it('does not apply inline formatting inside a fenced block', () => {
      const out = stripAnsi(renderMarkdown('```\nthis **is not** bold\n```'));
      expect(out).toContain('**is not**'); // markers preserved literally
    });

    it('renders a link keeping label and url', () => {
      const out = stripAnsi(renderMarkdown('see [docs](https://example.com)'));
      expect(out).toContain('docs');
      expect(out).toContain('https://example.com');
    });

    it('renders a blockquote', () => {
      const out = stripAnsi(renderMarkdown('> a quoted line'));
      expect(out).toContain('a quoted line');
    });

    it('renders a horizontal rule', () => {
      const out = stripAnsi(renderMarkdown('text\n\n---\n\nmore'));
      expect(out).toContain('text');
      expect(out).toContain('more');
      expect(out).toContain('───');
    });

    it('does not garble inline code containing asterisks', () => {
      const out = stripAnsi(renderMarkdown('run `a * b` here'));
      expect(out).toContain('a * b');
    });
  });
});
