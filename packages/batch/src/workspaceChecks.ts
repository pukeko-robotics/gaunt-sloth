/**
 * BATCH-59 — the pure half of a `command` case's workspace assertions: the parse-time path guard
 * that `file_contains` keys and `must_not_exist` globs share, and the glob matcher. The half that
 * touches the disk and runs `after` steps is `commandWorkspaceChecks.ts` in the app package.
 *
 * ## Paths are relative to the workspace, and written with `/`
 *
 * {@link findWorkspacePathProblem} refuses, at parse, every spelling that could name something
 * outside the workspace: an absolute path in either platform's form, a drive letter, a `..`
 * segment, and any backslash (which on Windows is a separator, so `..\x` and `\x` would escape,
 * and on POSIX is an ordinary character that a portable suite should not depend on). Both
 * platforms' rules apply on every platform, so a suite that loads on Linux loads on Windows too,
 * and the Linux cells test the Windows forms. This mirrors the `judge_profile` guard in
 * `evalSuite.ts`. It is not the only guard: the run-time check resolves each `file_contains` path
 * through its symbolic links and refuses to read one that lands outside the workspace, because a
 * link the agent made can lead anywhere a string cannot.
 *
 * ## The glob dialect, and why it is not Node's
 *
 * Node 24 has `fs.globSync` and `path.matchesGlob`, and neither will do: both skip dot-entries
 * under `*`, with no option to change it, so `must_not_exist: ["notes/*"]` would pass with a
 * `notes/.hidden` left behind. An assertion about what the agent must NOT leave is exactly where a
 * hidden file matters. So the dialect is small and owned here:
 *
 * - `/` separates segments. Matching is on the workspace-relative path with `/` on every platform.
 * - `*` matches any run of characters inside one segment, **including a leading dot**.
 * - `?` matches one character inside one segment, a dot included.
 * - `**` as a whole segment matches zero or more whole segments, so `notes/**` matches `notes`
 *   itself and everything below it. Inside a segment (`a**b`) it is refused.
 * - Every other character is literal, and matching is case-sensitive everywhere.
 * - `[`, `]`, `{` and `}` are refused, as is a leading `!`. Other glob dialects give them meaning
 *   (classes, alternatives, negation), and read literally here they would make a pattern that
 *   silently never matches, which is a `must_not_exist` that always passes.
 *
 * A glob matches any kind of entry: a file, a directory or a symbolic link (dangling or not). The
 * walk that feeds it does not follow links, so a link to `/` is one entry, not the filesystem.
 *
 * @module
 */
import { posix, win32 } from 'node:path';

/**
 * Why `path` cannot name an entry inside the workspace, or `undefined` when it can. The message is
 * a clause that follows the path (`"…" is absolute`).
 */
export function findWorkspacePathProblem(path: string): string | undefined {
  if (path.trim().length === 0) return 'is empty';
  if (path.includes('\\')) {
    return (
      'contains a backslash. Write paths with "/", which works on every platform; a backslash is ' +
      'a separator on Windows, where "..\\x" or "\\x" would leave the workspace'
    );
  }
  if (/^[A-Za-z]:/.test(path)) return 'starts with a drive letter';
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) return 'is absolute';
  const segments = path.split('/');
  if (segments.includes('..')) return 'has a ".." segment, which would leave the workspace';
  if (segments.some((segment) => segment === '' || segment === '.')) {
    return 'has an empty or "." segment. Write it relative to the workspace, as in "src/a.mjs"';
  }
  return undefined;
}

/**
 * Compile one `must_not_exist` glob into per-segment matchers. Throws with a clause naming the
 * problem (an escaping path, or syntax this dialect refuses); the caller adds where it was.
 */
export function compileWorkspaceGlob(pattern: string): Array<RegExp | '**'> {
  const problem = findWorkspacePathProblem(pattern);
  if (problem !== undefined) throw new Error(problem);
  if (pattern.startsWith('!')) {
    throw new Error(
      'starts with "!", which other glob dialects read as negation. A must_not_exist entry ' +
        'cannot be negated; list only what must not exist'
    );
  }
  const unsupported = /[[\]{}]/.exec(pattern);
  if (unsupported) {
    throw new Error(
      `uses "${unsupported[0]}", which this glob dialect does not support (only *, ? and ** ` +
        'are special). Read literally, it would make a pattern that never matches'
    );
  }
  return pattern.split('/').map((segment) => {
    if (segment === '**') return '**';
    if (segment.includes('**')) {
      throw new Error(`has "**" inside the segment "${segment}"; "**" must be a whole segment`);
    }
    const source = [...segment]
      .map((ch) => {
        if (ch === '*') return '.*';
        if (ch === '?') return '.';
        return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      })
      .join('');
    // The `s` flag lets `.` match any character; segments never contain `/`, so `.*` cannot cross.
    return new RegExp(`^${source}$`, 's');
  });
}

/**
 * Whether the workspace-relative `path` (segments joined with `/`) matches the compiled glob.
 */
export function matchesWorkspaceGlob(
  segments: ReadonlyArray<RegExp | '**'>,
  path: string
): boolean {
  const parts = path.split('/');
  // Memoised on (segment, part): several `**` in one pattern would otherwise revisit the same
  // states exponentially often on a deep path.
  const seen = new Map<number, boolean>();
  const match = (si: number, pi: number): boolean => {
    if (si === segments.length) return pi === parts.length;
    const key = si * (parts.length + 1) + pi;
    const known = seen.get(key);
    if (known !== undefined) return known;
    const segment = segments[si];
    const result =
      segment === '**'
        ? // Zero segments, or consume one and stay on `**`.
          match(si + 1, pi) || (pi < parts.length && match(si, pi + 1))
        : pi < parts.length && segment.test(parts[pi]) && match(si + 1, pi + 1);
    seen.set(key, result);
    return result;
  };
  return match(0, 0);
}
