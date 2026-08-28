/**
 * @packageDocumentation
 * AI Ignore utility functions for handling .aiignore files.
 * Provides functionality similar to .gitignore for filtering files.
 */

import { AIIGNORE_FILE } from '#src/constants.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { debugLog } from '#src/utils/debugUtils.js';

/**
 * Load .aiignore patterns from file
 * @param rootDir - The root directory to look for .aiignore file
 * @returns Array of ignore patterns
 */
export function loadAiignorePatterns(rootDir: string): string[] {
  const aiignorePath = path.join(rootDir, AIIGNORE_FILE);

  if (!existsSync(aiignorePath)) {
    debugLog(`No ${AIIGNORE_FILE} file found at ${aiignorePath}`);
    return [];
  }

  try {
    const content = readFileSync(aiignorePath, 'utf-8');
    const patterns = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    debugLog(`Loaded ${patterns.length} patterns from ${AIIGNORE_FILE}`);
    return patterns;
  } catch (error) {
    debugLog(
      `Error reading ${AIIGNORE_FILE}: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * Expand one `.aiignore` line into the glob patterns that implement it.
 *
 * `.aiignore` is documented as using `.gitignore` rules, and that is the contract this function
 * keeps. `path.matchesGlob` on its own does not: its `*` never crosses `/`, so a bare pattern is
 * silently root-only, and a trailing slash matches nothing at all. Both failures are silent and
 * both point the wrong way for a privacy boundary — the user writes a line, sees no error, and
 * believes a file is hidden from the agent when it is not.
 *
 * The three rules, each mapping to one arm below:
 *
 * - **A pattern with no separator applies at every depth.** `*.log` hides `app.log` and
 *   `sub/app.log` alike, so it gains a globstar prefix. That prefixed form also matches at the
 *   root, so the one arm covers both depths.
 * - **A pattern containing a separator is anchored to the root.** `build/out` hides
 *   `build/out`, never `src/build/out`. A leading `/` is an explicit spelling of the same thing and
 *   is stripped, since relative paths never carry one.
 * - **Whatever a pattern hides, it hides the subtree beneath it.** This is the `/**` arm, and it is
 *   what makes a single line hide a directory's name *and* its contents. Without it the name is
 *   withheld from a listing while every file below it stays readable — the shape of the leak this
 *   boundary exists to prevent.
 *
 * DELIBERATE DEVIATION: a trailing slash is treated as an ordinary pattern rather than as
 * "directories only", so `dist/` also hides a plain *file* named `dist`. Honouring the
 * directory-only half needs the entry's type, which a path string does not carry and which the
 * callers do not supply. Erring toward hiding costs a rare false positive the user can see and
 * rename around; erring the other way silently exposes what someone asked to be hidden.
 *
 * NOT SUPPORTED: re-inclusion (`!pattern`). A leading `!` is matched literally, so such a line
 * hides a file whose name really does start with `!` and un-hides nothing. That is the safe
 * direction, and it is stated in the user documentation rather than left to be discovered.
 *
 * @param pattern - One non-empty, non-comment line from `.aiignore` or `aiignore.patterns`
 * @returns Glob patterns to test the relative path against; empty when the line carries no pattern
 */
function expandPattern(pattern: string): string[] {
  // A trailing slash is gitignore's directory marker; strip it (see DELIBERATE DEVIATION above).
  let body = pattern.replace(/\/+$/, '');

  // A leading slash anchors to the root. Relative paths never carry one, so it must come off or
  // the pattern matches nothing.
  let anchored = false;
  if (body.startsWith('/')) {
    body = body.replace(/^\/+/, '');
    anchored = true;
  }

  // A line that was nothing but slashes carries no pattern. Returning no arms is what keeps it
  // from collapsing into `**`, which would hide the entire tree.
  if (body.length === 0) {
    return [];
  }

  // An interior separator anchors the pattern; its absence lets it apply at any depth.
  if (body.includes('/')) {
    anchored = true;
  }

  const base = anchored ? body : `**/${body}`;
  // The entry itself, then everything beneath it.
  return [base, `${base}/**`];
}

/**
 * Check if a file path should be ignored based on aiignore patterns
 *
 * Matching follows `.gitignore` rules — a bare pattern applies at every depth, a pattern with a
 * separator is anchored to `rootDir`, and either kind hides the subtree beneath whatever it
 * matches. The module-private `expandPattern` above implements that mapping and documents the two
 * deliberate departures from `.gitignore`.
 *
 * @param filePath - The file path to check
 * @param rootDir - The root directory for relative pattern matching
 * @param customPatterns - Optional custom patterns to use instead of loading from file
 * @param enabled - Whether aiignore is enabled
 * @returns True if the file should be ignored, false otherwise
 */
export function shouldIgnoreFile(
  filePath: string,
  rootDir: string,
  customPatterns: string[] | undefined = undefined,
  enabled: boolean = true
): boolean {
  if (!enabled) {
    return false;
  }

  // Get patterns from custom config or load from file
  const patterns = customPatterns ?? loadAiignorePatterns(rootDir);

  if (patterns.length === 0) {
    return false;
  }

  // Convert file path to relative path for pattern matching
  const relativePath = path.relative(rootDir, filePath);

  // Check if any pattern matches
  for (const pattern of patterns) {
    try {
      // Globs are built with `/` separators regardless of platform: win32's matchesGlob resolves a
      // backslash-separated path against them, so the relative path is passed through untouched
      // rather than rewritten (a rewrite would split a POSIX filename that legitimately contains a
      // backslash into two segments).
      if (expandPattern(pattern).some((glob) => path.matchesGlob(relativePath, glob))) {
        debugLog(`File ignored by pattern '${pattern}': ${relativePath}`);
        return true;
      }
    } catch (error) {
      debugLog(
        `Error matching pattern '${pattern}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return false;
}

/**
 * Filter an array of file paths based on aiignore patterns
 * @param filePaths - Array of file paths to filter
 * @param rootDir - The root directory for relative pattern matching
 * @param customPatterns - Optional custom patterns to use instead of loading from file
 * @param enabled - Whether aiignore is enabled
 * @returns Filtered array of file paths that should not be ignored
 */
export function filterIgnoredFiles(
  filePaths: string[],
  rootDir: string,
  customPatterns: string[] | undefined = undefined,
  enabled: boolean = true
): string[] {
  if (!enabled) {
    return filePaths;
  }

  return filePaths.filter(
    (filePath) => !shouldIgnoreFile(filePath, rootDir, customPatterns, enabled)
  );
}
