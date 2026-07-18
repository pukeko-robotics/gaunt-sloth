/**
 * @module gthGrepTool
 * The `gth_grep` content-search tool — a structured, permission-light regex search over file
 * CONTENTS. Complements `search_files` (which only matches file NAMES) and gives the lean agent a
 * grep primitive without falling back to the shell-approval-gated `run_shell_command`. Being a
 * built-in (not a dev tool) it is available in every mode, unlike `run_shell_command`.
 *
 * Two execution paths, ONE output shape:
 *  - shell out to ripgrep (`rg`) when it is on PATH;
 *  - fall back to an in-process JS scanner when `rg` is absent (CI machines may not have ripgrep).
 * Both sandbox to the current work-dir boundary ({@link getCurrentWorkDir}), bound each matching
 * line's preview, and cap the total match count.
 *
 * Named `gth_grep`, NOT `grep`: the experimental deep backend (deepagents) registers its own `grep`
 * built-in and `createDeepAgent` throws on a name collision because both backends share the resolved
 * toolset — the same reason {@link file://./gthChecklistTool.ts} is not called `write_todos`.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { GthConfig } from '@gaunt-sloth/core/config.js';
import { getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';

export const GREP_TOOL_NAME = 'gth_grep';

/** Default cap on the number of matches returned when the caller does not pass `limit`. */
const DEFAULT_LIMIT = 100;
/** Noise directories both paths skip: the JS fallback walk, and rg via `--glob !<dir>` excludes. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', '.idea']);
/** Longest matching-line preview kept before truncation, so one minified line can't blow context. */
const MAX_LINE_LENGTH = 250;
const TRUNCATION_MARKER = ' … (line truncated)';
/** Ceiling on rg stdout we buffer (matches are sliced to `limit` anyway). */
const RG_MAX_BUFFER = 32 * 1024 * 1024;

/** A single content match. `path` is relative to the search root; `line` is 1-based. */
export interface GrepMatch {
  path: string;
  line: number;
  /** The matching line's text, untruncated (bounded at format time). */
  text: string;
}

const schema = z.object({
  pattern: z.string().min(1).describe('Regular expression to search file CONTENTS for.'),
  path: z
    .string()
    .optional()
    .describe(
      'Relative directory or file to search, within the working directory. Defaults to the ' +
        'current working directory.'
    ),
  include: z
    .string()
    .optional()
    .describe('Optional file glob to filter matched files, e.g. "*.ts" or "*.{ts,tsx}".'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum number of matches to return (default ${DEFAULT_LIMIT}).`),
});

type GrepArgs = z.infer<typeof schema>;

const description = [
  'Search file CONTENTS by regular expression (ripgrep-backed, with an in-process fallback).',
  'Use this to find WHERE a symbol, string, or pattern appears across files — unlike search_files,',
  'which matches file NAMES only. Returns matching files with 1-based line numbers and a bounded',
  'preview of each matching line.',
  '',
  'Args: pattern (regex, required); path (relative dir/file, defaults to the working directory);',
  'include (file glob such as "*.ts" or "*.{ts,tsx}"); limit (max matches). Searches are confined',
  'to the working directory.',
].join('\n');

/** Error whose message is safe to return to the model as the tool observation. */
class GrepError extends Error {}
/** Sentinel: `rg` is not installed — the orchestrator must use the JS fallback. */
class RipgrepUnavailableError extends Error {}

/** Truncate an over-long matching-line preview with a clear marker. */
function truncateLine(text: string): string {
  if (text.length <= MAX_LINE_LENGTH) return text;
  return text.slice(0, MAX_LINE_LENGTH) + TRUNCATION_MARKER;
}

/**
 * Render matches in the concise, opencode-style grouped form. Shared by BOTH execution paths so
 * the rg and JS-fallback outputs are provably identical.
 */
export function formatGrepOutput(matches: GrepMatch[]): string {
  if (matches.length === 0) return 'No matches found';
  const lines: string[] = [`Found ${matches.length} matches`];
  let currentPath = '';
  for (const m of matches) {
    if (m.path !== currentPath) {
      if (currentPath) lines.push('');
      currentPath = m.path;
      lines.push(`${m.path}:`);
    }
    lines.push(`  Line ${m.line}: ${truncateLine(m.text)}`);
  }
  return lines.join('\n');
}

/** rg prints `./foo` for the cwd root; normalise to bare relative paths to match the JS scanner. */
function normalizeRelPath(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

/** Escape the literal parts of a glob for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile an include glob (matched against a file's basename in the JS fallback) to a RegExp.
 * Supports `*`, `?`, and `{a,b,c}` brace alternation, e.g. `*.ts`, `*.{ts,tsx}`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const options = glob
          .slice(i + 1, end)
          .split(',')
          .map(escapeRegExp);
        re += '(?:' + options.join('|') + ')';
        i = end + 1;
        continue;
      }
    } else {
      re += escapeRegExp(c);
    }
    i++;
  }
  return new RegExp('^' + re + '$');
}

interface ResolvedTarget {
  /** Absolute directory rg / the scanner runs from; also the root for relative output paths. */
  searchRoot: string;
  /** For a single-file search: the file's basename relative to searchRoot; undefined for a dir. */
  file?: string;
}

/**
 * Resolve `path` under the working directory and refuse anything that escapes it. The whole tool
 * is sandboxed to this boundary.
 */
async function resolveTarget(
  inputPath: string | undefined,
  workDir: string
): Promise<ResolvedTarget> {
  const absWorkDir = path.resolve(workDir);
  const requested = path.resolve(absWorkDir, inputPath ?? '.');
  const rel = path.relative(absWorkDir, requested);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new GrepError(
      `Refusing to search '${inputPath}': path escapes the working directory (${absWorkDir}).`
    );
  }
  let stat;
  try {
    stat = await fs.stat(requested);
  } catch {
    throw new GrepError(`Path not found: ${inputPath ?? '.'}`);
  }
  if (stat.isDirectory()) {
    return { searchRoot: requested };
  }
  return { searchRoot: path.dirname(requested), file: path.basename(requested) };
}

/** Parse ripgrep's `path:line:text` output (with `--with-filename --line-number --no-heading`). */
function parseRipgrepOutput(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const first = raw.indexOf(':');
    if (first < 0) continue;
    const second = raw.indexOf(':', first + 1);
    if (second < 0) continue;
    const lineNum = Number(raw.slice(first + 1, second));
    if (!Number.isInteger(lineNum)) continue;
    matches.push({
      path: normalizeRelPath(raw.slice(0, first)),
      line: lineNum,
      text: raw.slice(second + 1),
    });
  }
  return matches;
}

function buildRipgrepArgs(pattern: string, target: ResolvedTarget, include?: string): string[] {
  const args = ['--line-number', '--no-heading', '--with-filename', '--color=never'];
  // Exclude the same noise dirs the JS fallback skips, so the two paths stay consistent. rg only
  // auto-skips node_modules etc. when a .gitignore says so; outside a git repo it descends into
  // them, so we exclude them explicitly here.
  for (const dir of IGNORED_DIRS) {
    args.push('--glob', `!${dir}`);
  }
  if (include) {
    args.push('--glob', include);
  }
  args.push('-e', pattern, '--', target.file ?? '.');
  return args;
}

/**
 * Run ripgrep. Resolves to matches (empty on rg exit 1 = "no matches"). Rejects with
 * {@link RipgrepUnavailableError} when `rg` is not on PATH, or {@link GrepError} on a real rg error
 * (e.g. an invalid regex → rg exit 2).
 */
function runRipgrep(
  pattern: string,
  target: ResolvedTarget,
  include: string | undefined
): Promise<GrepMatch[]> {
  const args = buildRipgrepArgs(pattern, target, include);
  return new Promise((resolve, reject) => {
    execFile(
      'rg',
      args,
      { cwd: target.searchRoot, maxBuffer: RG_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const code: string | number | undefined = (error as unknown as { code?: string | number })
            .code;
          if (code === 'ENOENT') {
            reject(new RipgrepUnavailableError('ripgrep (rg) not found on PATH'));
            return;
          }
          // rg exit code 1 == no matches (execFile surfaces the non-zero exit as an error).
          if (code === 1) {
            resolve([]);
            return;
          }
          const detail = (stderr ?? '').toString().trim();
          reject(new GrepError(`Search failed: ${detail || error.message}`));
          return;
        }
        resolve(parseRipgrepOutput(stdout.toString()));
      }
    );
  });
}

/** Recursively collect regular files under `dir`, skipping {@link IGNORED_DIRS}. */
async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await collectFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/**
 * In-process fallback used when `rg` is absent: walk files under the target (respecting `include`
 * and the ignore list) and apply the regex per line. Produces the identical {@link GrepMatch} shape
 * as the ripgrep path.
 */
async function runJsScanner(
  pattern: string,
  target: ResolvedTarget,
  include: string | undefined,
  limit: number
): Promise<GrepMatch[]> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    throw new GrepError(`Search failed: invalid regular expression: ${(e as Error).message}`);
  }
  const includeRe = include ? globToRegExp(include) : undefined;

  const files: string[] = [];
  if (target.file) {
    files.push(path.join(target.searchRoot, target.file));
  } else {
    await collectFiles(target.searchRoot, files);
  }

  const matches: GrepMatch[] = [];
  for (const file of files) {
    if (matches.length >= limit) break;
    if (includeRe && !includeRe.test(path.basename(file))) continue;
    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue; // unreadable / non-text; skip
    }
    const rel = normalizeRelPath(path.relative(target.searchRoot, file));
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= limit) break;
      if (regex.test(lines[i])) {
        matches.push({ path: rel, line: i + 1, text: lines[i] });
      }
    }
  }
  return matches;
}

async function grepImpl(args: GrepArgs, workDir: string): Promise<string> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  let target: ResolvedTarget;
  try {
    target = await resolveTarget(args.path, workDir);
  } catch (e) {
    if (e instanceof GrepError) return e.message;
    throw e;
  }

  let matches: GrepMatch[];
  try {
    matches = await runRipgrep(args.pattern, target, args.include);
  } catch (e) {
    if (e instanceof RipgrepUnavailableError) {
      try {
        matches = await runJsScanner(args.pattern, target, args.include, limit);
      } catch (inner) {
        if (inner instanceof GrepError) return inner.message;
        throw inner;
      }
    } else if (e instanceof GrepError) {
      return e.message;
    } else {
      throw e;
    }
  }

  // ripgrep has no total-match cap of its own; bound the count here so both paths agree.
  if (matches.length > limit) matches = matches.slice(0, limit);
  return formatGrepOutput(matches);
}

export function get(_config: GthConfig) {
  const impl = async (args: GrepArgs): Promise<string> => grepImpl(args, getCurrentWorkDir());
  return tool(impl, { name: GREP_TOOL_NAME, description, schema });
}
