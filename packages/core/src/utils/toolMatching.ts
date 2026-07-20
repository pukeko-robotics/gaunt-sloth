/**
 * Tool-name pattern matching for allow/deny lists.
 *
 * Generic over any list of tool-name patterns — used by the `allowedTools` allow-list
 * today, and reusable for other name-list gates (e.g. BATCH-10's `must_call` /
 * `must_not_call`). Depends on nothing but the standard library.
 */

/**
 * Match a single tool `name` against a single `pattern`.
 *
 * - A pattern with **no** `*` is an **exact** match (`name === pattern`), preserving the
 *   original exact-name allow-list behavior.
 * - A pattern containing `*` is treated **glob-style**: each `*` matches any run of
 *   characters (including none) and every other character is matched literally. The whole
 *   name must match — the pattern is anchored at both ends.
 *
 * Regex metacharacters in the literal segments are escaped, so a `.` or `+` in a pattern
 * matches that character literally, never as a regex class.
 *
 * @example toolNameMatchesPattern('mcp__unimarket__buy', 'mcp__unimarket__*') // true
 * @example toolNameMatchesPattern('read_file', '*_file')                       // true
 * @example toolNameMatchesPattern('abcde', 'a*c*e')                            // true
 * @example toolNameMatchesPattern('read_file', 'gh_pr')                        // false
 */
export function toolNameMatchesPattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) {
    return name === pattern;
  }
  // Split on '*' so each literal segment can be fully regex-escaped, then rejoin the
  // segments with '.*' (any run of characters) and anchor the whole thing.
  const regexBody = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${regexBody}$`).test(name);
}

/**
 * True iff `name` matches **any** of `patterns` (see {@link toolNameMatchesPattern}).
 * An empty pattern list matches nothing.
 */
export function isToolAllowed(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => toolNameMatchesPattern(name, pattern));
}
