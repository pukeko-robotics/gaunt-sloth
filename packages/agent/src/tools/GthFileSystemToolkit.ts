import { BaseToolkit, StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import os from 'os';
import { createTwoFilesPatch } from 'diff';
import { displayInfo } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { shouldIgnoreFile } from '@gaunt-sloth/core/utils/aiignoreUtils.js';
import { getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import type { BinaryFormatConfig, BinaryFormatType } from '@gaunt-sloth/core/config.js';
import { getFormatForExtension, getMimeType, readBinaryFile } from '#src/tools/binaryUtils.js';

/**
 * Filesystem toolkit
 * Inspired by https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
 */

// TODO make it configurable
const IGNORED_DIRS = ['node_modules', '.git', '.idea', 'dist'];

// read_file safety envelope (GS2-39). A single large file — or a minified bundle that is one
// multi-MB line — must not consume the whole context window in one uncapped read. Defaults are
// adopted from opencode's read tool (packages/core/src/tool/read-filesystem.ts): at most
// MAX_READ_LINES lines or MAX_READ_BYTES bytes are returned, and any single line longer than
// MAX_LINE_LENGTH characters is truncated with LINE_TRUNCATED_SUFFIX. offset/limit paging is the
// escape hatch to fetch whatever the cap dropped. This bounds context, not process memory: like
// the existing head/tail helpers the file is still read whole and then trimmed.
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_LINE_LENGTH = 2000;
const LINE_TRUNCATED_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;

// Helper function to create a tool with filesystem type
function createGthTool<T extends z.ZodSchema>(
  fn: (args: z.infer<T>) => Promise<string>,
  config: {
    name: string;
    description: string;
    schema: T;
  },
  gthFileSystemType: 'read' | 'write'
): StructuredToolInterface {
  const toolInstance = tool(fn, config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (toolInstance as any).gthFileSystemType = gthFileSystemType;
  return toolInstance;
}

// Schema definitions
const ReadFileArgsSchema = z.object({
  path: z.string(),
  offset: z
    .number()
    .optional()
    .describe(
      'Start of a 1-based line window: the first line to return (inclusive). Combine with ' +
        '`limit` to page through a large file (e.g. offset 2001 continues past the default ' +
        `${MAX_READ_LINES}-line cap). Mutually exclusive with head/tail — pass a line window ` +
        '(offset/limit) OR head/tail, not both.'
    ),
  limit: z
    .number()
    .optional()
    .describe(
      'Number of lines to return starting at `offset` (defaults to and is hard-capped at ' +
        `${MAX_READ_LINES}). Use with \`offset\` to read an arbitrary window. Mutually ` +
        'exclusive with head/tail.'
    ),
  tail: z
    .number()
    .optional()
    .describe(
      'If provided, returns only the last N lines of the file. May be combined with head ' +
        '(no longer mutually exclusive): head+tail returns the first head lines, a ' +
        '`... [N lines skipped] ...` marker, then the last tail lines. Mutually exclusive ' +
        'with the offset/limit line window.'
    ),
  head: z
    .number()
    .optional()
    .describe(
      'If provided, returns only the first N lines of the file. May be combined with tail ' +
        '(no longer mutually exclusive): head+tail returns the first head lines, a ' +
        '`... [N lines skipped] ...` marker, then the last tail lines. Mutually exclusive ' +
        'with the offset/limit line window.'
    ),
});

const ReadBinaryArgsSchema = z.object({
  path: z.string().describe('Path to the binary file to read'),
  formatHint: z
    .enum(['image', 'file', 'audio', 'video'])
    .optional()
    .describe(
      'Optional hint for the format type. If not provided, determined from file extension via config.'
    ),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with'),
  replaceAll: z
    .boolean()
    .default(false)
    .describe(
      'Replace all occurrences of oldText. Default false requires a unique match: if oldText ' +
        'appears more than once the edit fails so you can add surrounding context to disambiguate; ' +
        'set true to replace every occurrence.'
    ),
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format'),
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
  path: z.string(),
  sortBy: z
    .enum(['name', 'size'])
    .optional()
    .default('name')
    .describe('Sort entries by name or size'),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const DeleteFileArgsSchema = z.object({
  path: z.string(),
});

const DeleteDirectoryArgsSchema = z.object({
  path: z.string(),
  recursive: z.boolean().default(false).describe('If true, delete directory and all its contents'),
});

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

export interface GthFileSystemToolkitOptions {
  allowedDirectories?: string[];
  aiignoreConfig?: {
    enabled?: boolean;
    patterns?: string[];
  };
  binaryFormats?: false | BinaryFormatConfig[];
}

export default class GthFileSystemToolkit extends BaseToolkit {
  tools: StructuredToolInterface[];
  private allowedDirectories: string[];
  private aiignoreConfig?: {
    enabled?: boolean;
    patterns?: string[];
  };
  private binaryFormats?: false | BinaryFormatConfig[];

  constructor(options: GthFileSystemToolkitOptions = {}) {
    super();
    const allowedDirectories = options.allowedDirectories ?? [getCurrentWorkDir()];
    this.allowedDirectories = allowedDirectories.map((dir) =>
      this.normalizePath(path.resolve(this.expandHome(dir)))
    );
    this.aiignoreConfig = options.aiignoreConfig;
    this.binaryFormats = options.binaryFormats;
    this.tools = this.createTools();
  }

  /**
   * Get tools filtered by operation type
   */
  getFilteredTools(allowedOperations: ('read' | 'write')[]): StructuredToolInterface[] {
    return this.tools.filter((tool) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolType = (tool as any).gthFileSystemType;
      return allowedOperations.includes(toolType);
    });
  }

  private normalizePath(p: string): string {
    return path.normalize(p);
  }

  private isProtectedDirectory(dirPath: string): boolean {
    const normalizedPath = this.normalizePath(path.resolve(dirPath));
    return this.allowedDirectories.some(
      (allowedDir) => this.normalizePath(allowedDir) === normalizedPath
    );
  }

  private expandHome(filepath: string): string {
    if (filepath.startsWith('~/') || filepath === '~') {
      return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
  }

  private sanitizeRequestedPath(requestedPath: string): string {
    const trimmedPath = requestedPath.trim();
    if (trimmedPath.length === 0) {
      throw new Error('Path cannot be empty');
    }

    const unquotedPath = trimmedPath.replace(/^(['"`])(.*)\1$/, '$2');
    if (path.isAbsolute(unquotedPath)) {
      return unquotedPath;
    }

    if (unquotedPath.startsWith('./') || unquotedPath.startsWith('../')) {
      return unquotedPath;
    }

    return `./${unquotedPath}`;
  }

  private async validatePath(requestedPath: string): Promise<string> {
    const sanitizedPath = this.sanitizeRequestedPath(requestedPath);
    const expandedPath = this.expandHome(sanitizedPath);
    const absolute = path.isAbsolute(expandedPath)
      ? path.resolve(expandedPath)
      : path.resolve(getCurrentWorkDir(), expandedPath);

    const normalizedRequested = this.normalizePath(absolute);

    // Helper function to check if a path is within allowed directories
    const isWithinAllowedDir = (checkPath: string): boolean => {
      return this.allowedDirectories.some((allowedDir) => checkPath.startsWith(allowedDir));
    };

    // Check if the requested path is within allowed directories
    if (!isWithinAllowedDir(normalizedRequested)) {
      throw new Error(
        `Access denied - path outside allowed directories: ${absolute} not in ${this.allowedDirectories.join(', ')}`
      );
    }

    try {
      // Try to get the real path for existing files/directories
      const realPath = await fs.realpath(absolute);
      const normalizedReal = this.normalizePath(realPath);

      // Verify the real path (after resolving symlinks) is still within allowed directories
      if (!isWithinAllowedDir(normalizedReal)) {
        throw new Error('Access denied - symlink target outside allowed directories');
      }
      return realPath;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Path doesn't exist - validate that its parent directory exists and is within allowed directories
        let currentDir = path.dirname(absolute);
        while (currentDir !== path.dirname(currentDir)) {
          try {
            const realParentPath = await fs.realpath(currentDir);
            const normalizedParent = this.normalizePath(realParentPath);

            if (!isWithinAllowedDir(normalizedParent)) {
              throw new Error('Access denied - parent directory outside allowed directories');
            }

            return absolute; // Valid parent exists, return the original absolute path
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (parentError: any) {
            if (parentError.code === 'ENOENT') {
              currentDir = path.dirname(currentDir); // Move up one level
            } else {
              throw parentError; // Some other error
            }
          }
        }

        // Could not find any existing parent in the path
        throw new Error(`Cannot determine valid parent directory for: ${absolute}`);
      }
      // Some other error
      throw error;
    }
  }

  private async getFileStats(filePath: string): Promise<FileInfo> {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      permissions: stats.mode.toString(8).slice(-3),
    };
  }

  private async searchFiles(
    rootPath: string,
    pattern: string,
    excludePatterns: string[] = []
  ): Promise<string[]> {
    const results: string[] = [];
    const aiignoreConfig = this.aiignoreConfig;
    const pendingDirs: string[] = [rootPath];

    while (pendingDirs.length > 0) {
      const currentPath = pendingDirs.pop();
      if (!currentPath) {
        continue;
      }

      let entries: Dirent[];
      try {
        entries = (await fs.readdir(currentPath, {
          withFileTypes: true,
          encoding: 'utf8',
        })) as Dirent[];
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryName = entry.name.toString();
        const fullPath = path.join(currentPath, entryName);

        try {
          await this.validatePath(fullPath);

          const relativePath = path.relative(rootPath, fullPath);
          const shouldExclude = excludePatterns.some((pattern) => {
            const globPattern = pattern.includes('*') ? pattern : `**/${pattern}/**`;
            return path.matchesGlob(relativePath, globPattern);
          });

          if (shouldExclude) {
            continue;
          }

          const shouldIgnore = shouldIgnoreFile(
            fullPath,
            getCurrentWorkDir(),
            aiignoreConfig?.patterns,
            aiignoreConfig?.enabled
          );

          if (shouldIgnore) {
            continue;
          }

          if (entryName.toLowerCase().includes(pattern.toLowerCase())) {
            results.push(fullPath);
          }

          let isDirectory = entry.isDirectory();
          if (
            !isDirectory &&
            typeof entry.isSymbolicLink === 'function' &&
            entry.isSymbolicLink()
          ) {
            try {
              const stats = await fs.stat(fullPath);
              isDirectory = stats.isDirectory();
            } catch {
              isDirectory = false;
            }
          }

          if (isDirectory) {
            pendingDirs.push(fullPath);
          }
        } catch {
          continue;
        }
      }
    }

    return results;
  }

  private normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n');
  }

  private createUnifiedDiff(
    originalContent: string,
    newContent: string,
    filepath: string = 'file'
  ): string {
    const normalizedOriginal = this.normalizeLineEndings(originalContent);
    const normalizedNew = this.normalizeLineEndings(newContent);

    return createTwoFilesPatch(
      filepath,
      filepath,
      normalizedOriginal,
      normalizedNew,
      'original',
      'modified'
    );
  }

  /**
   * Count non-overlapping exact occurrences of `search` in `content`.
   * Uses an indexOf scan (no regex) so arbitrary text is matched literally.
   */
  private countOccurrences(content: string, search: string): number {
    if (search === '') return 0;
    let count = 0;
    let offset = 0;
    let idx = content.indexOf(search, offset);
    while (idx !== -1) {
      count++;
      offset = idx + search.length;
      idx = content.indexOf(search, offset);
    }
    return count;
  }

  private async applyFileEdits(
    filePath: string,
    edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>,
    dryRun = false
  ): Promise<string> {
    const content = this.normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

    let modifiedContent = content;
    const summaries: string[] = [];
    let editIndex = 0;
    for (const edit of edits) {
      editIndex++;
      const normalizedOld = this.normalizeLineEndings(edit.oldText);
      const normalizedNew = this.normalizeLineEndings(edit.newText);

      const occurrences = this.countOccurrences(modifiedContent, normalizedOld);
      if (occurrences > 0) {
        if (occurrences > 1 && edit.replaceAll !== true) {
          // Ambiguous match: refuse rather than silently editing the first occurrence.
          throw new Error(
            `Found ${occurrences} occurrences of the oldText in ${filePath}. ` +
              'Provide more surrounding context to make it unique, or set replaceAll: true.\n' +
              edit.oldText
          );
        }
        // split/join replaces every occurrence without regex escaping and, unlike
        // String.replace, does NOT interpret `$`-patterns ($&, $`, $', $$) in the
        // replacement text; for a unique match (occurrences === 1) it replaces exactly
        // that one occurrence.
        modifiedContent = modifiedContent.split(normalizedOld).join(normalizedNew);
        summaries.push(`edit ${editIndex}: replaced ${occurrences} occurrence(s)`);
        continue;
      }

      const oldLines = normalizedOld.split('\n');
      const contentLines = modifiedContent.split('\n');
      let matchFound = false;

      for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
        const potentialMatch = contentLines.slice(i, i + oldLines.length);

        const isMatch = oldLines.every((oldLine, j) => {
          const contentLine = potentialMatch[j];
          return oldLine.trim() === contentLine.trim();
        });

        if (isMatch) {
          const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
          const newLines = normalizedNew.split('\n').map((line, j) => {
            if (j === 0) return originalIndent + line.trimStart();
            const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
            const newIndent = line.match(/^\s*/)?.[0] || '';
            if (oldIndent && newIndent) {
              const relativeIndent = newIndent.length - oldIndent.length;
              return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
            }
            return line;
          });

          contentLines.splice(i, oldLines.length, ...newLines);
          modifiedContent = contentLines.join('\n');
          matchFound = true;
          break;
        }
      }

      if (!matchFound) {
        throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
      }
      // Fuzzy (trim-based line) match applied: flag it so the model knows the edit
      // landed on a near-match, not an exact one.
      summaries.push(`edit ${editIndex}: applied via fuzzy line-match (no exact match)`);
    }

    const diff = this.createUnifiedDiff(content, modifiedContent, filePath);

    let numBackticks = 3;
    while (diff.includes('`'.repeat(numBackticks))) {
      numBackticks++;
    }
    const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

    if (!dryRun) {
      await fs.writeFile(filePath, modifiedContent, 'utf-8');
    }

    // Per-edit machine-readable summary, prepended so the diff block stays intact.
    const summaryBlock = summaries.length > 0 ? `${summaries.join('\n')}\n\n` : '';
    return summaryBlock + formattedDiff;
  }

  private formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';

    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i === 0) return `${bytes} ${units[i]}`;

    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }

  private async tailFile(filePath: string, numLines: number): Promise<string> {
    const CHUNK_SIZE = 1024;
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    if (fileSize === 0) return '';

    const fileHandle = await fs.open(filePath, 'r');
    try {
      const lines: string[] = [];
      let position = fileSize;
      let chunk = Buffer.alloc(CHUNK_SIZE);
      let linesFound = 0;
      let remainingText = '';
      let firstChunk = true;

      while (position > 0 && linesFound < numLines) {
        const size = Math.min(CHUNK_SIZE, position);
        position -= size;

        const { bytesRead } = await fileHandle.read(chunk, 0, size, position);
        if (!bytesRead) break;

        const readData = chunk.slice(0, bytesRead).toString('utf-8');
        const chunkText = readData + remainingText;

        const normalizedChunk = this.normalizeLineEndings(chunkText);
        const chunkLines = normalizedChunk.split('\n');

        // We read backward from EOF, so the file's terminating newline (if any) is only
        // ever in this first chunk. Its split yields a phantom trailing empty element that
        // must not be counted as the last line. Drop exactly one here so tail counting
        // matches head/full reads; a file without a trailing newline is untouched and a
        // genuine blank last line ("...\n\n") is preserved (only one element removed).
        if (firstChunk && normalizedChunk.endsWith('\n')) {
          chunkLines.pop();
        }
        firstChunk = false;

        if (position > 0) {
          remainingText = chunkLines[0];
          chunkLines.shift();
        }

        for (let i = chunkLines.length - 1; i >= 0 && linesFound < numLines; i--) {
          lines.unshift(chunkLines[i]);
          linesFound++;
        }
      }

      return lines.join('\n');
    } finally {
      await fileHandle.close();
    }
  }

  private async headFile(filePath: string, numLines: number): Promise<string> {
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const lines: string[] = [];
      let buffer = '';
      let bytesRead = 0;
      const chunk = Buffer.alloc(1024);

      while (lines.length < numLines) {
        const result = await fileHandle.read(chunk, 0, chunk.length, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
        buffer += chunk.slice(0, result.bytesRead).toString('utf-8');

        const newLineIndex = buffer.lastIndexOf('\n');
        if (newLineIndex !== -1) {
          const completeLines = buffer.slice(0, newLineIndex).split('\n');
          buffer = buffer.slice(newLineIndex + 1);
          for (const line of completeLines) {
            lines.push(line);
            if (lines.length >= numLines) break;
          }
        }
      }

      if (buffer.length > 0 && lines.length < numLines) {
        lines.push(buffer);
      }

      return lines.join('\n');
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Returns the first `head` lines and the last `tail` lines of a file, separated by a
   * `... [N lines skipped] ...` marker. When the two windows cover or overlap the whole
   * file (`head + tail >= total`) the entire file is returned unchanged (no marker, no
   * duplicated lines).
   */
  private async headAndTailFile(filePath: string, head: number, tail: number): Promise<string> {
    const content = await fs.readFile(filePath, 'utf-8');
    const normalized = this.normalizeLineEndings(content);
    const lines = normalized.split('\n');
    // A terminating newline yields a phantom trailing empty element that would be
    // miscounted as a real line (inflating `total`, so the true last line gets pushed
    // into the "skipped" gap and the tail comes back empty). Drop exactly one when the
    // file ends in a newline so counting/slicing matches head/full reads. Files without a
    // trailing newline are untouched, and a genuine blank last line ("...\n\n") is
    // preserved because only a single element is removed.
    if (normalized.endsWith('\n')) {
      lines.pop();
    }
    const total = lines.length;

    if (head + tail >= total) {
      return content;
    }

    const skipped = total - head - tail;
    const headContent = lines.slice(0, head).join('\n');
    const tailContent = lines.slice(total - tail).join('\n');
    return headContent + '\n... [' + skipped + ' lines skipped] ...\n' + tailContent;
  }

  /**
   * Return the file's lines from the 1-based `offset` to EOF (GS2-39 paging). Deliberately does
   * NOT apply `limit` here — the caller hands the result to capReadContent with maxLines = limit so
   * that a limit-bounded read is *observable* to the envelope (it can then tell "more file remains
   * past this window" from "reached EOF" and emit the correct resume notice). Pre-slicing to
   * exactly `limit` lines here would hide that signal and silently drop the continuation.
   *
   * Mirrors headAndTailFile's trailing-newline handling so line numbering matches head/tail/full
   * reads: a terminating newline yields a phantom trailing empty element that must not be counted
   * as a real line. Clamps rather than throwing: an offset past EOF returns a short recoverable note
   * (not an empty string, which is indistinguishable from an empty file).
   */
  private async windowFile(filePath: string, offset: number): Promise<string> {
    const content = await fs.readFile(filePath, 'utf-8');
    const normalized = this.normalizeLineEndings(content);
    const lines = normalized.split('\n');
    if (normalized.endsWith('\n')) {
      lines.pop();
    }
    const total = lines.length;
    if (total === 0) {
      return '';
    }
    const start = offset - 1; // offset is >= 1 (clamped by the caller)
    if (start >= total) {
      return `[read_file: offset ${offset} is past end of file (${total} lines total)]`;
    }
    return lines.slice(start).join('\n');
  }

  /**
   * Apply the read safety envelope (GS2-39) to already-selected file content:
   *  - any single line longer than MAX_LINE_LENGTH is truncated with LINE_TRUNCATED_SUFFIX;
   *  - emission stops once `maxLines` lines OR MAX_READ_BYTES bytes have been produced.
   *
   * When nothing exceeds the caps the content is returned verbatim (byte-identical), so normal
   * files behave exactly as before — the change only bites on pathological / huge files.
   *
   * Three truncation signals are kept deliberately separate:
   *  - a per-line cut is marked only by the inline LINE_TRUNCATED_SUFFIX (no global notice);
   *  - the BYTE cap always appends the global "output truncated" notice, because it is the hard
   *    safety envelope regardless of who asked for the read;
   *  - the LINE cap appends the global notice only when `lineCapIsHard` is true — i.e. `maxLines`
   *    is the hard MAX_READ_LINES envelope (a defaulted or clamped-down window, or the whole-file
   *    read), NOT a deliberate small explicit `limit`. This distinguishes a *capped continuation*
   *    (notify so the model can page) from a *satisfied explicit window* (stay quiet).
   *
   * `startLine` is the 1-based file line of the first line in `content`; it is used only to put a
   * concrete resume `offset` in the global notice. Pass `undefined` (head/tail paths, where the
   * first emitted line is not line `startLine` of the file) to emit a generic notice instead.
   */
  private capReadContent(
    content: string,
    maxLines: number,
    startLine: number | undefined,
    lineCapIsHard: boolean
  ): string {
    const lines = content.split('\n');
    const withinBytes = Buffer.byteLength(content, 'utf-8') <= MAX_READ_BYTES;
    const withinLines = lines.length <= maxLines;
    const noLongLine = lines.every((line) => line.length <= MAX_LINE_LENGTH);
    if (withinBytes && withinLines && noLongLine) {
      return content;
    }

    const out: string[] = [];
    let bytes = 0;
    let stoppedByLine = false;
    let stoppedByByte = false;
    for (const rawLine of lines) {
      if (out.length >= maxLines) {
        stoppedByLine = true;
        break;
      }
      const line =
        rawLine.length > MAX_LINE_LENGTH
          ? rawLine.slice(0, MAX_LINE_LENGTH) + LINE_TRUNCATED_SUFFIX
          : rawLine;
      // +1 accounts for the '\n' that re-joins this line to the previous one. Always emit at
      // least one (already per-line-truncated) line so the result is never empty.
      const size = Buffer.byteLength(line, 'utf-8') + (out.length > 0 ? 1 : 0);
      if (out.length > 0 && bytes + size > MAX_READ_BYTES) {
        stoppedByByte = true;
        break;
      }
      out.push(line);
      bytes += size;
    }

    let result = out.join('\n');
    // The byte cap is a hard envelope and always warrants a notice; the line cap warrants one only
    // when it represents the hard MAX_READ_LINES envelope, not a deliberate explicit `limit`.
    if (stoppedByByte || (stoppedByLine && lineCapIsHard)) {
      const nextOffset = startLine !== undefined ? startLine + out.length : undefined;
      const resume =
        nextOffset !== undefined
          ? `resume with offset:${nextOffset} (and an optional limit)`
          : 'use offset/limit to page through the rest';
      result += `\n... [read_file: output truncated at the ${MAX_READ_LINES}-line / ${
        MAX_READ_BYTES / 1024
      } KB read cap — ${resume}] ...`;
    }
    return result;
  }

  private createReadBinaryTool(): StructuredToolInterface {
    return createGthTool(
      async (args: z.infer<typeof ReadBinaryArgsSchema>): Promise<string> => {
        if (!this.binaryFormats || !Array.isArray(this.binaryFormats)) {
          return 'Binary formats are not configured. Add binaryFormats to your config to enable this feature.';
        }

        displayInfo(`\n📁 Reading binary file: ${args.path}\n`);
        let validPath: string;
        try {
          validPath = await this.validatePath(args.path);
        } catch {
          return 'Path is not within allowed directories or is blocked by .aiignore';
        }

        const aiignoreConfig = this.aiignoreConfig;
        const shouldIgnore = shouldIgnoreFile(
          validPath,
          getCurrentWorkDir(),
          aiignoreConfig?.patterns,
          aiignoreConfig?.enabled
        );
        if (shouldIgnore) {
          return 'Path is not within allowed directories or is blocked by .aiignore';
        }

        const ext = path.extname(validPath).toLowerCase().slice(1);
        let formatType: BinaryFormatType | null = null;
        let formatConfig: BinaryFormatConfig | null = null;

        if (args.formatHint) {
          const hintedConfig = this.binaryFormats.find(
            (config) => config.type === args.formatHint && config.extensions.includes(ext)
          );
          if (hintedConfig) {
            formatType = hintedConfig.type;
            formatConfig = hintedConfig;
          }
        } else {
          const formatMatch = getFormatForExtension(validPath, this.binaryFormats);
          if (formatMatch) {
            formatType = formatMatch.type;
            formatConfig = formatMatch.config;
          }
        }

        if (!formatType || !formatConfig) {
          return `Extension '.${ext}' is not configured for any binary format type. Configure it in binaryFormats.`;
        }

        const maxSize = formatConfig.maxSize ?? 10 * 1024 * 1024;
        const mimeType = getMimeType(ext, formatConfig);

        try {
          const result = await readBinaryFile(validPath, maxSize, mimeType);

          // Return special format string that middleware will parse and process:
          // Format: gth_read_binary;type:${type};path:${encodedPath};data:${media_type};base64,${data}
          // Path is URL-encoded to handle special characters like semicolons
          const encodedPath = encodeURIComponent(validPath);
          return `gth_read_binary;type:${formatType};path:${encodedPath};data:${mimeType};base64,${result.data}`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `Error reading binary file: ${message}`;
        }
      },
      {
        name: 'gth_read_binary',
        description:
          'Read a binary file (image, file, audio, video) and return its base64-encoded content. ' +
          'Only works for file types configured in binaryFormats.',
        schema: ReadBinaryArgsSchema,
      },
      'read'
    );
  }

  private createTools(): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [
      createGthTool(
        async (args: z.infer<typeof ReadFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Reading file: ${args.path}\n`);

          const hasWindow = args.offset !== undefined || args.limit !== undefined;
          const hasHeadTail = Boolean(args.head) || Boolean(args.tail);

          // Argument guard first (pure, no filesystem access): the line window (offset/limit) and
          // head/tail are two different slice mechanisms, so combining them is ambiguous. Return a
          // recoverable string the model can act on rather than throwing — a thrown tool result
          // aborts the whole agent run (the GS2-36 anti-pattern).
          if (hasWindow && hasHeadTail) {
            return (
              'read_file: pass a line window (offset/limit) OR head/tail, not both. ' +
              'Use offset/limit to read an arbitrary range (offset = 1-based first line, ' +
              'limit = number of lines); use head/tail for the first/last N lines.'
            );
          }

          const validPath = await this.validatePath(args.path);

          // Line window (offset/limit). offset defaults to 1; limit defaults to and is hard-capped
          // at MAX_READ_LINES. windowFile returns from offset to EOF and capReadContent (maxLines =
          // limit) does the slicing, so a limit-bounded read that leaves more file behind is
          // *observable* and gets a resume notice. That notice fires only when the limit is the
          // hard envelope — defaulted, or an explicit limit clamped down to MAX_READ_LINES — so a
          // deliberately small explicit window (fully satisfied) stays quiet.
          if (hasWindow) {
            const offset = args.offset !== undefined ? Math.max(1, Math.trunc(args.offset)) : 1;
            const limitWasDefaulted = args.limit === undefined;
            const limitWasClamped =
              args.limit !== undefined && Math.trunc(args.limit) > MAX_READ_LINES;
            const limit = limitWasDefaulted
              ? MAX_READ_LINES
              : Math.min(Math.max(1, Math.trunc(args.limit as number)), MAX_READ_LINES);
            const lineCapIsHard = limitWasDefaulted || limitWasClamped;
            const windowed = await this.windowFile(validPath, offset);
            return this.capReadContent(windowed, limit, offset, lineCapIsHard);
          }

          // head/tail paths respect the explicit line count the model asked for (maxLines =
          // Infinity, so the line cap never fires — lineCapIsHard is moot), but still get the
          // per-line and byte safety envelope — e.g. a `tail 1` that returns one multi-MB minified
          // line is still truncated. No resume offset is emitted for these paths because the first
          // emitted line is not line 1 of the file.
          if (args.head && args.tail) {
            return this.capReadContent(
              await this.headAndTailFile(validPath, args.head, args.tail),
              Number.POSITIVE_INFINITY,
              undefined,
              false
            );
          }

          if (args.tail) {
            return this.capReadContent(
              await this.tailFile(validPath, args.tail),
              Number.POSITIVE_INFINITY,
              undefined,
              false
            );
          }

          if (args.head) {
            return this.capReadContent(
              await this.headFile(validPath, args.head),
              Number.POSITIVE_INFINITY,
              undefined,
              false
            );
          }

          // Default whole-file read: capped at MAX_READ_LINES / MAX_READ_BYTES with per-line
          // truncation (the line cap here IS the hard envelope). Files under the caps come back
          // byte-identical to the old uncapped read.
          return this.capReadContent(
            await fs.readFile(validPath, 'utf-8'),
            MAX_READ_LINES,
            1,
            true
          );
        },
        {
          name: 'read_file',
          description:
            'Read the complete contents of a file from the file system. ' +
            'Handles various text encodings and provides detailed error messages ' +
            'if the file cannot be read. Use this tool when you need to examine ' +
            'the contents of a single file. ' +
            `Large reads are capped for safety: at most ${MAX_READ_LINES} lines or ` +
            `${MAX_READ_BYTES / 1024} KB are returned, and any line longer than ${MAX_LINE_LENGTH} ` +
            'characters is truncated with a `... (line truncated to N chars)` marker; when a read ' +
            'is capped a `... [read_file: output truncated ...] ...` notice is appended. ' +
            'To read past the cap or fetch an arbitrary range, use `offset` (1-based first line) ' +
            'and `limit` (number of lines). ' +
            "Alternatively use the 'head' parameter to read only the first N lines of a file, or " +
            "the 'tail' parameter to read only the last N lines; 'head' and 'tail' may be combined " +
            'to get the first N lines, a `... [N lines skipped] ...` marker, and the last M lines. ' +
            'The offset/limit line window and head/tail are mutually exclusive — pass one or the ' +
            'other, not both. Only works within allowed directories.',
          schema: ReadFileArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof ReadMultipleFilesArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Reading ${args.paths.length} files\n`);
          const results = await Promise.all(
            args.paths.map(async (filePath: string) => {
              try {
                const validPath = await this.validatePath(filePath);
                const content = await fs.readFile(validPath, 'utf-8');
                // Apply the same whole-file read safety envelope as read_file's default path
                // (GS2-39/GS2-52): a single oversized file — or a one-line minified bundle — in a
                // multi-file read must not blow the context window. maxLines = MAX_READ_LINES,
                // startLine = 1, lineCapIsHard = true mirror read_file's whole-file read, so a
                // capped file carries the "resume with offset:N" notice; the model pages the rest
                // with read_file on that path. Sub-cap files come back byte-identical (verbatim
                // fast-path). There is no offset/limit here on purpose — read_file is the pager.
                const capped = this.capReadContent(content, MAX_READ_LINES, 1, true);
                return `${filePath}:\n${capped}\n`;
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return `${filePath}: Error - ${errorMessage}`;
              }
            })
          );
          return results.join('\n---\n');
        },
        {
          name: 'read_multiple_files',
          description:
            'Read the contents of multiple files simultaneously. This is more ' +
            'efficient than reading files one by one when you need to analyze ' +
            "or compare multiple files. Each file's content is returned with its " +
            "path as a reference. Failed reads for individual files won't stop " +
            'the entire operation. ' +
            `Each file is subject to the same per-file read cap as read_file: at most ${MAX_READ_LINES} ` +
            `lines or ${MAX_READ_BYTES / 1024} KB are returned and any line longer than ` +
            `${MAX_LINE_LENGTH} characters is truncated; when a file is capped a ` +
            '`... [read_file: output truncated ...] ...` notice is appended — page past it by ' +
            'reading that file individually with read_file (offset/limit). ' +
            'Only works within allowed directories.',
          schema: ReadMultipleFilesArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof WriteFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Writing file: ${args.path}\n`);
          try {
            const validPath = await this.validatePath(args.path);
            // Create any missing parent directories (mkdir -p) so a write into a
            // not-yet-created subdirectory succeeds instead of throwing ENOENT. The
            // model expects the near-universal agent-tool `mkdir -p` semantics and
            // routinely writes a new file before creating its dir. validatePath has
            // already confirmed the nearest existing ancestor is inside the sandbox,
            // so the new directories are created within an allowed root.
            await fs.mkdir(path.dirname(validPath), { recursive: true });
            await fs.writeFile(validPath, args.content, 'utf-8');
            return `Successfully wrote to ${args.path}`;
          } catch (error) {
            // Surface the failure to the model as a recoverable tool result rather
            // than throwing, which would abort the entire agent run (GS2-36). The
            // model can read the message and adjust (e.g. the path is a directory,
            // or is denied by the sandbox) instead of the session dying.
            const message = error instanceof Error ? error.message : String(error);
            return `Error writing file ${args.path}: ${message}`;
          }
        },
        {
          name: 'write_file',
          description:
            'Create a new file or completely overwrite an existing file with new content. ' +
            'Missing parent directories are created automatically. ' +
            'Use with caution as it will overwrite existing files without warning. ' +
            'Handles text content with proper encoding. Only works within allowed directories.',
          schema: WriteFileArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof EditFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Editing file: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          return await this.applyFileEdits(validPath, args.edits, args.dryRun);
        },
        {
          name: 'edit_file',
          description:
            'Make line-based edits to a text file. Each edit replaces exact line sequences ' +
            'with new content. Returns a git-style diff showing the changes made. ' +
            'Only works within allowed directories.' +
            'Always present diff returned by this tool back to the user.' +
            'Prefer applying small edits, eg. one function at a time, one block or one condition.' +
            'Fall back to using the "write_file" tool if you need to make large edits.' +
            'or of the "edit_file" fails for some reason.' +
            'Always read file before every edit to ensure that the file is not corrupted.',
          schema: EditFileArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof CreateDirectoryArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Creating directory: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          await fs.mkdir(validPath, { recursive: true });
          return `Successfully created directory ${args.path}`;
        },
        {
          name: 'create_directory',
          description:
            'Create a new directory or ensure a directory exists. Can create multiple ' +
            'nested directories in one operation. If the directory already exists, ' +
            'this operation will succeed silently. Perfect for setting up directory ' +
            'structures for projects or ensuring required paths exist. Only works within allowed directories.',
          schema: CreateDirectoryArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof ListDirectoryArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Listing directory: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          const aiignoreConfig = this.aiignoreConfig;
          const filteredEntries = entries.filter((entry) => {
            const fullPath = path.join(validPath, entry.name);
            return !shouldIgnoreFile(
              fullPath,
              getCurrentWorkDir(),
              aiignoreConfig?.patterns,
              aiignoreConfig?.enabled
            );
          });
          return filteredEntries
            .map((entry) => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`)
            .join('\n');
        },
        {
          name: 'list_directory',
          description:
            'Get a detailed listing of all files and directories in a specified path. ' +
            'Results clearly distinguish between files and directories with [FILE] and [DIR] ' +
            'prefixes. This tool is essential for understanding directory structure and ' +
            'finding specific files within a directory. Only works within allowed directories.',
          schema: ListDirectoryArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Listing directory with sizes: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          const aiignoreConfig = this.aiignoreConfig;
          const filteredEntries = entries.filter((entry) => {
            const fullPath = path.join(validPath, entry.name);
            return !shouldIgnoreFile(
              fullPath,
              getCurrentWorkDir(),
              aiignoreConfig?.patterns,
              aiignoreConfig?.enabled
            );
          });

          const detailedEntries = await Promise.all(
            filteredEntries.map(async (entry) => {
              const entryPath = path.join(validPath, entry.name);
              try {
                const stats = await fs.stat(entryPath);
                return {
                  name: entry.name,
                  isDirectory: entry.isDirectory(),
                  size: stats.size,
                  mtime: stats.mtime,
                };
              } catch {
                return {
                  name: entry.name,
                  isDirectory: entry.isDirectory(),
                  size: 0,
                  mtime: new Date(0),
                };
              }
            })
          );

          const sortedEntries = [...detailedEntries].sort((a, b) => {
            if (args.sortBy === 'size') {
              return b.size - a.size;
            }
            return a.name.localeCompare(b.name);
          });

          const formattedEntries = sortedEntries.map(
            (entry) =>
              `${entry.isDirectory ? '[DIR]' : '[FILE]'} ${entry.name.padEnd(30)} ${
                entry.isDirectory ? '' : this.formatSize(entry.size).padStart(10)
              }`
          );

          const totalFiles = detailedEntries.filter((e) => !e.isDirectory).length;
          const totalDirs = detailedEntries.filter((e) => e.isDirectory).length;
          const totalSize = detailedEntries.reduce(
            (sum, entry) => sum + (entry.isDirectory ? 0 : entry.size),
            0
          );

          const summary = [
            '',
            `Total: ${totalFiles} files, ${totalDirs} directories`,
            `Combined size: ${this.formatSize(totalSize)}`,
          ];

          return [...formattedEntries, ...summary].join('\n');
        },
        {
          name: 'list_directory_with_sizes',
          description:
            'Get a detailed listing of all files and directories in a specified path, including sizes. ' +
            'Results clearly distinguish between files and directories with [FILE] and [DIR] ' +
            'prefixes. This tool is useful for understanding directory structure and ' +
            'finding specific files within a directory. Only works within allowed directories.',
          schema: ListDirectoryWithSizesArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof DirectoryTreeArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Building directory tree: ${args.path}\n`);

          interface TreeEntry {
            name: string;
            type: 'file' | 'directory';
            children?: TreeEntry[];
            ignored?: boolean;
          }

          const buildTree = async (currentPath: string): Promise<TreeEntry[]> => {
            const validPath = await this.validatePath(currentPath);
            const entries = await fs.readdir(validPath, { withFileTypes: true });
            const result: TreeEntry[] = [];
            const aiignoreConfig = this.aiignoreConfig;

            for (const entry of entries) {
              const entryData: TreeEntry = {
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
              };
              if (IGNORED_DIRS.indexOf(entry.name) >= 0) {
                entryData.ignored = true;
              }

              // Check if file should be ignored by aiignore
              const fullPath = path.join(currentPath, entry.name);
              const shouldIgnore = shouldIgnoreFile(
                fullPath,
                getCurrentWorkDir(),
                aiignoreConfig?.patterns,
                aiignoreConfig?.enabled
              );

              if (shouldIgnore) {
                entryData.ignored = true;
              }

              if (entry.isDirectory() && !entryData.ignored) {
                const subPath = path.join(currentPath, entry.name);
                entryData.children = await buildTree(subPath);
              }

              result.push(entryData);
            }

            return result;
          };

          const treeData = await buildTree(args.path);
          return JSON.stringify(treeData, null, 2);
        },
        {
          name: 'directory_tree',
          description:
            'Get a recursive tree view of files and directories as a JSON structure. ' +
            "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
            'Files have no children array, while directories always have a children array (which may be empty). ' +
            'The output is formatted with 2-space indentation for readability. Only works within allowed directories.',
          schema: DirectoryTreeArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof MoveFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Moving ${args.source} to ${args.destination}\n`);
          const validSourcePath = await this.validatePath(args.source);
          const validDestPath = await this.validatePath(args.destination);
          await fs.rename(validSourcePath, validDestPath);
          return `Successfully moved ${args.source} to ${args.destination}`;
        },
        {
          name: 'move_file',
          description:
            'Move or rename files and directories. Can move files between directories ' +
            'and rename them in a single operation. If the destination exists, the ' +
            'operation will fail. Works across different directories and can be used ' +
            'for simple renaming within the same directory. Both source and destination must be within allowed directories.',
          schema: MoveFileArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof SearchFilesArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Searching for '${args.pattern}' in ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const results = await this.searchFiles(validPath, args.pattern, args.excludePatterns);
          return results.length > 0 ? results.join('\n') : 'No matches found';
        },
        {
          name: 'search_files',
          description:
            'Recursively search for files and directories matching a pattern. ' +
            'Searches through all subdirectories from the starting path. The search ' +
            'is case-insensitive and matches partial names. Returns full paths to all ' +
            "matching items. Great for finding files when you don't know their exact location. " +
            'Only searches within allowed directories.',
          schema: SearchFilesArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof GetFileInfoArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Getting file info: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const info = await this.getFileStats(validPath);
          return Object.entries(info)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');
        },
        {
          name: 'get_file_info',
          description:
            'Retrieve detailed metadata about a file or directory. Returns comprehensive ' +
            'information including size, creation time, last modified time, permissions, ' +
            'and type. This tool is perfect for understanding file characteristics ' +
            'without reading the actual content. Only works within allowed directories.',
          schema: GetFileInfoArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof DeleteFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Deleting file: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const stats = await fs.stat(validPath);
          if (stats.isDirectory()) {
            throw new Error(
              `Cannot delete directory: ${args.path}. Use rmdir or a recursive delete tool for directories.`
            );
          }
          await fs.unlink(validPath);
          return `Successfully deleted file: ${args.path}`;
        },
        {
          name: 'delete_file',
          description:
            'Delete a file from the filesystem. This operation cannot be undone. ' +
            'Only works for files, not directories. Use with caution. ' +
            'Only works within allowed directories.',
          schema: DeleteFileArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof DeleteDirectoryArgsSchema>): Promise<string> => {
          displayInfo(
            `\n📁 Deleting directory: ${args.path}${args.recursive ? ' (recursive)' : ''}\n`
          );
          const validPath = await this.validatePath(args.path);

          // Check if this is a protected directory
          if (this.isProtectedDirectory(validPath)) {
            throw new Error(
              `Cannot delete protected directory: ${args.path}. This is one of the allowed root directories.`
            );
          }

          const stats = await fs.stat(validPath);
          if (!stats.isDirectory()) {
            throw new Error(`Not a directory: ${args.path}. Use delete_file for files.`);
          }

          if (args.recursive) {
            await fs.rm(validPath, { recursive: true, force: true });
            return `Successfully deleted directory and all contents: ${args.path}`;
          } else {
            // For non-recursive delete, check if directory is empty
            const entries = await fs.readdir(validPath);
            if (entries.length > 0) {
              throw new Error(
                `Directory not empty: ${args.path}. Use recursive: true to delete non-empty directories.`
              );
            }
            await fs.rmdir(validPath);
            return `Successfully deleted empty directory: ${args.path}`;
          }
        },
        {
          name: 'delete_directory',
          description:
            'Delete a directory from the filesystem. Can delete empty directories or recursively delete ' +
            'directories with contents. Cannot delete protected directories (allowed root directories). ' +
            'This operation cannot be undone. Use with extreme caution. ' +
            'Only works within allowed directories.',
          schema: DeleteDirectoryArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (): Promise<string> => {
          return `Allowed directories:\n${this.allowedDirectories.join('\n')}`;
        },
        {
          name: 'list_allowed_directories',
          description:
            'Returns the list of directories that this server is allowed to access. ' +
            'Use this to understand which directories are available before trying to access files.',
          schema: z.object({}),
        },
        'read'
      ),
    ];

    if (this.binaryFormats && Array.isArray(this.binaryFormats) && this.binaryFormats.length > 0) {
      tools.push(this.createReadBinaryTool());
    }

    return tools;
  }
}
