import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('toolMatching', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('toolNameMatchesPattern', () => {
    it('matches exactly when the pattern has no wildcard', async () => {
      const { toolNameMatchesPattern } = await import('#src/utils/toolMatching.js');
      expect(toolNameMatchesPattern('read_file', 'read_file')).toBe(true);
      expect(toolNameMatchesPattern('read_file', 'write_file')).toBe(false);
      // Exact match is whole-string, never a substring.
      expect(toolNameMatchesPattern('read_file_v2', 'read_file')).toBe(false);
    });

    it('matches a trailing wildcard as a prefix glob', async () => {
      const { toolNameMatchesPattern } = await import('#src/utils/toolMatching.js');
      expect(toolNameMatchesPattern('mcp__unimarket_buy', 'mcp__unimarket_*')).toBe(true);
      expect(toolNameMatchesPattern('mcp__unimarket_', 'mcp__unimarket_*')).toBe(true);
      expect(toolNameMatchesPattern('mcp__jira_getIssue', 'mcp__unimarket_*')).toBe(false);
    });

    it('matches a leading wildcard as a suffix glob', async () => {
      const { toolNameMatchesPattern } = await import('#src/utils/toolMatching.js');
      expect(toolNameMatchesPattern('read_file', '*_file')).toBe(true);
      expect(toolNameMatchesPattern('write_file', '*_file')).toBe(true);
      expect(toolNameMatchesPattern('file_reader', '*_file')).toBe(false);
    });

    it('matches mid and multiple wildcards', async () => {
      const { toolNameMatchesPattern } = await import('#src/utils/toolMatching.js');
      expect(toolNameMatchesPattern('abcde', 'a*e')).toBe(true);
      expect(toolNameMatchesPattern('abcde', 'a*c*e')).toBe(true);
      expect(toolNameMatchesPattern('mcp__jira_searchIssues', 'mcp__*_search*')).toBe(true);
      expect(toolNameMatchesPattern('abde', 'a*c*e')).toBe(false);
    });

    it('a bare "*" matches any name', async () => {
      const { toolNameMatchesPattern } = await import('#src/utils/toolMatching.js');
      expect(toolNameMatchesPattern('anything', '*')).toBe(true);
      expect(toolNameMatchesPattern('', '*')).toBe(true);
    });

    it('treats regex metacharacters in the pattern literally, not as regex', async () => {
      const { toolNameMatchesPattern } = await import('#src/utils/toolMatching.js');
      // A '.' in the pattern must match a literal dot, not "any character".
      expect(toolNameMatchesPattern('a.b', 'a.b')).toBe(true);
      expect(toolNameMatchesPattern('axb', 'a.b')).toBe(false);
      // '+' is literal too (a naive translation would treat it as a quantifier).
      expect(toolNameMatchesPattern('c++', 'c++')).toBe(true);
      expect(toolNameMatchesPattern('ccc', 'c++')).toBe(false);
      // Literal metachars are still escaped inside the segments around a wildcard.
      expect(toolNameMatchesPattern('ns.tool.read', 'ns.tool.*')).toBe(true);
      expect(toolNameMatchesPattern('nsXtoolYread', 'ns.tool.*')).toBe(false);
    });
  });

  describe('isToolAllowed', () => {
    it('is true when the name matches any pattern in the list', async () => {
      const { isToolAllowed } = await import('#src/utils/toolMatching.js');
      expect(isToolAllowed('read_file', ['write_file', 'read_file'])).toBe(true);
      expect(isToolAllowed('mcp__unimarket_buy', ['gh_pr', 'mcp__unimarket_*'])).toBe(true);
    });

    it('is false when no pattern matches', async () => {
      const { isToolAllowed } = await import('#src/utils/toolMatching.js');
      expect(isToolAllowed('read_file', ['write_file', 'mcp__unimarket_*'])).toBe(false);
    });

    it('an empty pattern list matches nothing', async () => {
      const { isToolAllowed } = await import('#src/utils/toolMatching.js');
      expect(isToolAllowed('read_file', [])).toBe(false);
    });
  });
});
