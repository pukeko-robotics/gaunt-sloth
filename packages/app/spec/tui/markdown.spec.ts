import { beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

/**
 * The renderer reads the terminal width from `systemUtils.stdout` when a caller passes none.
 * Stub it so width assertions are pinned to this fixture instead of the ambient terminal.
 * Declared via `vi.hoisted` because `vi.mock`'s factory is hoisted above plain `const`s and
 * runs at first import of the module under test.
 */
const { fakeStdout } = vi.hoisted(() => ({
  fakeStdout: { columns: undefined as number | undefined },
}));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({ stdout: fakeStdout }));

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
    // Unknown width by default, so a spec that cares about it has to say so.
    fakeStdout.columns = undefined;
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

    it('renders a fenced code block with full-width rules and space indent', () => {
      const raw = renderMarkdown('```js\nconst x = 1;\n```', { columns: 40 });
      const out = stripAnsi(raw);
      const lines = out.split('\n');
      expect(out).not.toContain('```');
      // Top rule carries the language tag and fills the requested width.
      expect(lines[0]).toMatch(/^── js ─+$/);
      expect(lines[0].length).toBe(40);
      expect(lines[lines.length - 1]).toBe('─'.repeat(40));
      // Body: two-space indent + verbatim content at default foreground.
      expect(lines[1]).toBe('  const x = 1;');
      const bodyRaw = raw.split('\n')[1];
      expect(bodyRaw).toBe('  const x = 1;'); // no ANSI on the payload line
    });

    it('frames a fenced block without a language tag at full width', () => {
      const out = stripAnsi(renderMarkdown('```\nhello\n```', { columns: 24 })).split('\n');
      expect(out[0]).toBe('─'.repeat(24));
      expect(out[1]).toBe('  hello');
      expect(out[2]).toBe('─'.repeat(24));
    });

    it('does not grey fenced body lines (issue #421)', () => {
      const raw = renderMarkdown('```\nhello\n```', { columns: 20 });
      const bodyRaw = raw.split('\n')[1];
      // Payload stays default fg — no grey/dim wrap on the body line.
      expect(bodyRaw).toBe('  hello');
      expect(bodyRaw).not.toBe(chalk.gray('  hello'));
      expect(bodyRaw).not.toBe(chalk.dim('  hello'));
      expect(bodyRaw).not.toMatch(/\x1b\[90m/);
      expect(bodyRaw).not.toMatch(/\x1b\[2m/);
    });

    it('does not apply inline formatting inside a fenced block', () => {
      const out = stripAnsi(renderMarkdown('```\nthis **is not** bold\n```', { columns: 20 }));
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

    it('renders a horizontal rule at the full terminal width', () => {
      const lines = stripAnsi(renderMarkdown('text\n\n---\n\nmore', { columns: 34 })).split('\n');
      expect(lines).toContain('text');
      expect(lines).toContain('more');
      // Same bar as the fence rules, not a stubby fixed-length one.
      expect(lines).toContain('─'.repeat(34));
    });

    // `LiveTurn` renders a committed turn with no explicit width, so the no-options path is the
    // production path. Drive it off the mocked stdout rather than the real one — asserting a rule
    // length against the ambient terminal would pass under a pipe and fail in a wide TTY.
    it('defaults to the live terminal width when no columns are passed', () => {
      fakeStdout.columns = 34;
      expect(stripAnsi(renderMarkdown('---')).split('\n')).toContain('─'.repeat(34));
      fakeStdout.columns = 52;
      expect(stripAnsi(renderMarkdown('---')).split('\n')).toContain('─'.repeat(52));
    });

    it('falls back to 80 columns when the terminal width is unknown (non-TTY)', () => {
      fakeStdout.columns = undefined;
      expect(stripAnsi(renderMarkdown('---')).split('\n')).toContain('─'.repeat(80));
    });

    it('does not garble inline code containing asterisks', () => {
      const out = stripAnsi(renderMarkdown('run `a * b` here'));
      expect(out).toContain('a * b');
    });

    it('preserves spacing for code directly touching surrounding text (no stray spaces)', () => {
      // The protective sentinel must not inject padding around a code span.
      const out = stripAnsi(renderMarkdown('x`y`z is **bold**'));
      expect(out).toContain('xyz'); // no spaces leaked around the code span
      expect(out).not.toContain('x y z');
    });

    it('keeps adjacent code spans tight together', () => {
      const out = stripAnsi(renderMarkdown('a `one``two` b is **bold**'));
      // The two adjacent spans restore back-to-back, exactly as authored.
      expect(out).toContain('a onetwo b');
    });

    it('restores multiple (multi-digit) code spans to the correct contents', () => {
      const spans = Array.from({ length: 12 }, (_, i) => `\`c${i}\``).join('');
      const out = stripAnsi(renderMarkdown(`${spans} and **bold**`));
      // The 11th span (index 10, multi-digit) must restore its own contents.
      expect(out).toContain('c0c1c2c3c4c5c6c7c8c9c10c11');
      expect(out).not.toContain('CODE'); // no leaked placeholder token
    });
  });
});
