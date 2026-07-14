import { beforeEach, describe, expect, it, vi } from 'vitest';

// TUI-C21 — the pure `less`-style search model over the debug pane's shared line array. These are
// side-effect-free functions, so they are tested directly (no Ink render).

const LINES = [
  'The quick brown fox', // 0
  'jumps over the lazy dog', // 1  (has "the")
  'FOO bar baz', // 2  (case: FOO)
  'another line', // 3
  'the end', // 4  (has "the")
  'foo again', // 5  (case: foo)
];

describe('tui/debugSearch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('findMatches', () => {
    it('returns the line indices that contain the query (case-insensitive by default)', async () => {
      const { findMatches } = await import('#src/tui/debugSearch.js');
      // Substring match, case-insensitive: "The" (0), "the" (1), "ano-the-r" (3) and "the" (4).
      expect(findMatches(LINES, 'the')).toEqual([0, 1, 3, 4]);
    });

    it('is case-insensitive: an uppercase query matches lowercase content and vice-versa', async () => {
      const { findMatches } = await import('#src/tui/debugSearch.js');
      // "foo" (lower) matches "FOO bar baz" (line 2) and "foo again" (line 5).
      expect(findMatches(LINES, 'foo')).toEqual([2, 5]);
      expect(findMatches(LINES, 'FOO')).toEqual([2, 5]);
    });

    it('returns an empty list for the empty query (highlights/count clear on delete-to-empty)', async () => {
      const { findMatches } = await import('#src/tui/debugSearch.js');
      expect(findMatches(LINES, '')).toEqual([]);
    });

    it('returns an empty list when nothing matches (the no-match state)', async () => {
      const { findMatches } = await import('#src/tui/debugSearch.js');
      expect(findMatches(LINES, 'zzz-not-here')).toEqual([]);
    });
  });

  describe('stepMatch (n / N with wrap-around)', () => {
    it('steps forward through the match cursor', async () => {
      const { stepMatch } = await import('#src/tui/debugSearch.js');
      const matches = [0, 1, 4];
      expect(stepMatch(matches, 0, 1)).toBe(1);
      expect(stepMatch(matches, 1, 1)).toBe(2);
    });

    it('wraps past the last match back to the first (forward)', async () => {
      const { stepMatch } = await import('#src/tui/debugSearch.js');
      expect(stepMatch([0, 1, 4], 2, 1)).toBe(0);
    });

    it('wraps before the first match to the last (backward, N)', async () => {
      const { stepMatch } = await import('#src/tui/debugSearch.js');
      expect(stepMatch([0, 1, 4], 0, -1)).toBe(2);
    });

    it('returns -1 when there are no matches', async () => {
      const { stepMatch } = await import('#src/tui/debugSearch.js');
      expect(stepMatch([], 0, 1)).toBe(-1);
    });
  });

  describe('scrollOffsetForLine (reuse of the TUI-C11 viewport clamp to jump to a match)', () => {
    it('places the match line at the top of the window', async () => {
      const { scrollOffsetForLine } = await import('#src/tui/debugSearch.js');
      // A match at line 20 in a 40-line body with an 8-row viewport scrolls the window to top=20.
      expect(scrollOffsetForLine(20, 8, 40)).toBe(20);
    });

    it('clamps to the real maximum so a match near the end never over-scrolls past the tail', async () => {
      const { scrollOffsetForLine } = await import('#src/tui/debugSearch.js');
      // maxOffset = 40 - 8 = 32; a match at line 39 clamps to 32 (the last full page).
      expect(scrollOffsetForLine(39, 8, 40)).toBe(32);
    });

    it('never returns a negative offset', async () => {
      const { scrollOffsetForLine } = await import('#src/tui/debugSearch.js');
      expect(scrollOffsetForLine(0, 8, 3)).toBe(0);
    });
  });

  describe('highlightSegments', () => {
    it('splits a line into non-match / match runs preserving original casing', async () => {
      const { highlightSegments } = await import('#src/tui/debugSearch.js');
      // Query "foo" against "FOO bar baz" → the matched run keeps the original "FOO".
      expect(highlightSegments('FOO bar baz', 'foo')).toEqual([
        { text: 'FOO', match: true },
        { text: ' bar baz', match: false },
      ]);
    });

    it('marks every occurrence on a line (multiple matches)', async () => {
      const { highlightSegments } = await import('#src/tui/debugSearch.js');
      expect(highlightSegments('ababa', 'a')).toEqual([
        { text: 'a', match: true },
        { text: 'b', match: false },
        { text: 'a', match: true },
        { text: 'b', match: false },
        { text: 'a', match: true },
      ]);
    });

    it('returns the whole line as a single non-match run for an empty query', async () => {
      const { highlightSegments } = await import('#src/tui/debugSearch.js');
      expect(highlightSegments('hello', '')).toEqual([{ text: 'hello', match: false }]);
    });

    it('returns a single non-match run when the query is absent from the line', async () => {
      const { highlightSegments } = await import('#src/tui/debugSearch.js');
      expect(highlightSegments('hello', 'zzz')).toEqual([{ text: 'hello', match: false }]);
    });
  });
});
